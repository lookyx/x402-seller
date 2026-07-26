import "dotenv/config";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

// Settles a real payment against every HTTP paid route once, at whatever price
// is currently live (used to refresh each route's stale catalog pricing after
// a price change — the Bazaar catalog reflects the price as of the last real
// settlement, not the current server config).

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
  "/chain/balance?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "/treasury/debt",
  "/ocean/tides?station=9414290",
  "/water/streamflow?site=09380000",
  // Potomac at Little Falls - deliberately NOT Lees Ferry (09380000), which is
  // reservoir-controlled, has no official NWS flood stages, and correctly
  // returns 422 without settling. It would read as a regression here.
  "/water/flood-risk?site=01646500",
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
    const result = await httpClient.processResponse(response);
    console.log(result.paymentStatus);
    results.push({ path, status: result.paymentStatus, ok: result.paymentStatus === "settled" });
  } catch (err) {
    console.log("ERROR:", err.message);
    results.push({ path, status: `error: ${err.message}`, ok: false });
  }
  await new Promise((r) => setTimeout(r, 500));
}

console.log("\n--- Summary ---");
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "OK" : "FAIL"}  ${r.path}  (${r.status})`);
console.log(`\n${results.length - failed.length}/${results.length} settled`);
if (failed.length) console.log("Failed:", failed.map((r) => r.path).join(", "));
