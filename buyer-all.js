import "dotenv/config";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";

// Settles a real payment against every HTTP paid route once, at whatever price
// is currently live (used to refresh each route's stale catalog pricing after
// a price change — the Bazaar catalog reflects the price as of the last real
// settlement, not the current server config).
//
// Also checks the verifiability headers added in `e9c37e9` on every route:
// x-response-hash must match a hash recomputed from the received bytes, and
// PAYMENT-RESPONSE must be mirrored to X-PAYMENT-RESPONSE. Note the hash is over
// the DECOMPRESSED body — Cloudflare applies `content-encoding: br`, and fetch
// decompresses transparently, so hashing what fetch hands back is correct.

const rawKey = process.env.BUYER_PRIVATE_KEY;
if (!rawKey) { console.error("Missing BUYER_PRIVATE_KEY in .env"); process.exit(1); }

const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
const signer = privateKeyToAccount(privateKey);
console.log("Buyer wallet address:", signer.address);

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

const BASE = "https://x402-seller.onrender.com";
const ROUTES = [
  "/geo/lookup?address=Tokyo",
  "/geo/reverse?lat=35.6762&lng=139.6503",
  "/oil/price?benchmark=wti",
  "/gas/price",
  "/electricity/price?state=US",
  "/weather/forecast?lat=38.8894&lng=-77.0352",
  "/nuclear/outages",
  "/earthquakes/recent?minmagnitude=4.5&limit=5",
  "/currency/rate?from=USD&to=JPY",
  // Los Angeles, not San Francisco: AirNow currently reports zero monitors near
  // SF at any radius (verified 0 readings at 25/50/100 miles), so the route
  // correctly 404s there and the run shows a phantom FAIL. LA reports 3.
  "/air/quality?lat=34.0522&lng=-118.2437",
  "/space/asteroids",
  // No params needed and NOAA always publishes a current Kp, so this cannot
  // produce the phantom "no data" FAIL that the old San Francisco /air/quality
  // fixture did.
  "/space/weather",
  // Any routable US pair works as a fixture: zero fires and zero alerts are a
  // valid 200, not an error, so this cannot produce the phantom FAIL that the
  // old San Francisco /air/quality fixture did.
  "/route/hazards?from=34.0522,-118.2437&to=32.7157,-117.1611&corridorKm=50",
  "/chain/balance?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "/treasury/debt",
  "/ocean/tides?station=9414290",
  "/water/streamflow?site=09380000",
  // Potomac at Little Falls - deliberately NOT Lees Ferry (09380000), which is
  // reservoir-controlled, has no official NWS flood stages, and correctly
  // returns 422 without settling. It would read as a regression here.
  "/water/flood-risk?site=01646500",
  // Any US coordinate is a safe fixture here: zero nearby fires is a valid 200,
  // not an error, so this cannot produce the phantom failure that the old San
  // Francisco /air/quality fixture did.
  "/fire/risk?lat=34.0522&lng=-118.2437",
  "/payments/history?hours=24",
  "/census/demographics?zip=10001",
  "/sec/filings-search?q=chip%20shortage&forms=10-K",
];

const results = [];

for (const path of ROUTES) {
  const url = BASE + path;
  process.stdout.write(`\n${path} ... `);
  try {
    const response = await fetchWithPayment(url, { method: "GET" });

    // Clone before anything consumes the body, so the hash covers exactly what arrived.
    const bytes = Buffer.from(await response.clone().arrayBuffer());
    const advertised = response.headers.get("x-response-hash");
    const recomputed = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const unprefixed = response.headers.get("payment-response");
    const prefixed = response.headers.get("x-payment-response");
    const hdr = {
      hash: !advertised ? "missing" : advertised === recomputed ? "ok" : "MISMATCH",
      mirror: !unprefixed ? "no-receipt" : unprefixed === prefixed ? "ok" : "NOT-MIRRORED",
      rid: response.headers.get("x-request-id") ? "ok" : "missing",
      net: response.headers.get("x-payment-network") || "missing",
    };

    const result = await httpClient.processResponse(response);
    // The decoded receipt carries the settle tx + payer. Printing it is what makes
    // each route individually attributable to an on-chain tx -- without it the
    // twelve $0.001 routes are indistinguishable from each other by amount alone.
    const tx = result.header?.transaction || null;
    const payer = result.header?.payer || null;
    console.log(`${result.paymentStatus}  [hash=${hdr.hash} mirror=${hdr.mirror} rid=${hdr.rid}]${tx ? `  tx=${tx}` : ""}`);
    results.push({ path, status: result.paymentStatus, ok: result.paymentStatus === "settled", hdr, tx, payer, rid: response.headers.get("x-request-id") });
  } catch (err) {
    console.log("ERROR:", err.message);
    results.push({ path, status: `error: ${err.message}`, ok: false, hdr: null });
  }
  await new Promise((r) => setTimeout(r, 500));
}

console.log("\n--- Summary ---");
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "OK" : "FAIL"}  ${r.path}  (${r.status})`);
console.log(`\n${results.length - failed.length}/${results.length} settled`);
if (failed.length) console.log("Failed:", failed.map((r) => r.path).join(", "));

console.log("\n--- Verifiability headers (e9c37e9) ---");
const settled = results.filter((r) => r.hdr);
const bad = settled.filter((r) => r.hdr.hash !== "ok" || r.hdr.mirror !== "ok" || r.hdr.rid !== "ok");
console.log(`hash ok      : ${settled.filter((r) => r.hdr.hash === "ok").length}/${settled.length}`);
console.log(`mirror ok    : ${settled.filter((r) => r.hdr.mirror === "ok").length}/${settled.length}`);
console.log(`request-id ok: ${settled.filter((r) => r.hdr.rid === "ok").length}/${settled.length}`);
const nets = [...new Set(settled.map((r) => r.hdr.net))];
console.log(`networks     : ${nets.join(", ")}`);
if (bad.length) {
  console.log("\nHEADER PROBLEMS:");
  for (const r of bad) console.log(`  ${r.path}  hash=${r.hdr.hash} mirror=${r.hdr.mirror} rid=${r.hdr.rid}`);
} else {
  console.log("all clean");
}

// Route -> tx -> request-id map. Cross-check these against an eth_getLogs scan of
// PAY_TO rather than trusting the summary above; that cross-check is what proved a
// failed handler never settles. Routes sharing the $0.001 price are only
// distinguishable here, not by on-chain amount.
console.log("\n--- Route / tx / request-id map ---");
for (const r of results) {
  console.log(`  ${r.ok ? "OK  " : "FAIL"} ${r.path}`);
  console.log(`        tx=${r.tx || "(none - not settled)"}  rid=${r.rid || "-"}`);
}
const txs = results.map((r) => r.tx).filter(Boolean);
console.log(`\nsettled txs: ${txs.length}   unique: ${new Set(txs).size}${txs.length !== new Set(txs).size ? "   <-- DUPLICATE TX, investigate" : ""}`);
const payers = [...new Set(results.map((r) => r.payer).filter(Boolean))];
console.log(`payer(s): ${payers.join(", ") || "-"}${payers.length > 1 ? "   <-- unexpected, should be one buyer wallet" : ""}`);
