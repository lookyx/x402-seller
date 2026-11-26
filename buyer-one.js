import "dotenv/config";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";

// Pays ONE route once, at its live price: the single-route version of
// buyer-all.js, for checking a new or changed endpoint without paying for all
// of them.
//
//   node buyer-one.js                                   -> /sentiment ($0.002)
//   node buyer-one.js "/currency/rate?from=USD&to=JPY"  -> any other route
//
// Sends the same self-test User-Agent as buyer-all.js, so these calls stay
// filterable in the [REQ]/[PAY] logs. SELLER_BASE_URL overrides the target
// (e.g. a local server); the default is production.

const rawKey = process.env.BUYER_PRIVATE_KEY;
if (!rawKey) { console.error("Missing BUYER_PRIVATE_KEY in .env"); process.exit(1); }
const signer = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`);
console.log("Buyer wallet address:", signer.address);

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

// Same string as buyer-all.js (not imported: importing that file runs the full suite).
const SELFTEST_UA =
  "x402-seller-selftest/1.0 (+https://x402-seller.onrender.com; own regression suite, not a buyer)";
const BASE = (process.env.SELLER_BASE_URL || "https://x402-seller.onrender.com").replace(/\/$/, "");
const DEFAULT_ROUTE = "/sentiment?text=Bitcoin%20surges%20past%20%24100k%20as%20ETF%20inflows%20hit%20a%20record%20high";
const route = process.argv[2] || DEFAULT_ROUTE;
const url = BASE + (route.startsWith("/") ? route : `/${route}`);

console.log(`Paying for ${url}\n`);
try {
  const response = await fetchWithPayment(url, { method: "GET", headers: { "user-agent": SELFTEST_UA } });

  // Clone before anything consumes the body, so the hash covers exactly what arrived.
  const bytes = Buffer.from(await response.clone().arrayBuffer());
  const advertised = response.headers.get("x-response-hash");
  const recomputed = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const unprefixed = response.headers.get("payment-response");
  const prefixed = response.headers.get("x-payment-response");

  const result = await httpClient.processResponse(response);
  const tx = result.header?.transaction || null;

  console.log(`HTTP ${response.status}`);
  console.log(bytes.toString("utf8"));
  console.log(`\npayment       : ${result.paymentStatus}`);
  // A refused payment comes back as another 402 whose body is just {}; the
  // reason (low balance, amount too low, ...) is only in the payment-required header.
  if (response.status === 402) {
    try {
      const required = JSON.parse(Buffer.from(response.headers.get("payment-required") || "", "base64").toString("utf8"));
      if (required.error) console.log(`refused       : ${required.error}`);
    } catch { /* header absent or not JSON */ }
  }
  if (tx) console.log(`transaction   : ${tx}\n                https://basescan.org/tx/${tx}`);
  console.log(`response hash : ${!advertised ? "missing" : advertised === recomputed ? "ok" : "MISMATCH"}`);
  console.log(`receipt mirror: ${!unprefixed ? "no receipt" : unprefixed === prefixed ? "ok" : "NOT MIRRORED"}`);
  console.log(`request id    : ${response.headers.get("x-request-id") || "missing"}`);
  process.exit(result.paymentStatus === "settled" ? 0 : 1);
} catch (err) {
  console.error("ERROR:", err.message);
  process.exit(1);
}
