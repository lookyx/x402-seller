import "dotenv/config";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";

const rawKey = process.env.BUYER_PRIVATE_KEY;
if (!rawKey) { console.error("Missing BUYER_PRIVATE_KEY in .env"); process.exit(1); }

const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
const signer = privateKeyToAccount(privateKey);
console.log("Buyer wallet address:", signer.address);

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

const url = "https://x402-seller.onrender.com/oil/price?benchmark=brent";

console.log("Requesting:", url);

const response = await fetchWithPayment(url, { method: "GET" });

// Clone before anything reads the body, so the hash is computed over the exact
// bytes that arrived on the wire.
const rawBytes = Buffer.from(await response.clone().arrayBuffer());

console.log("\n=== RAW RESPONSE HEADERS ===");
console.log("  status:", response.status);
for (const [k, v] of [...response.headers.entries()].sort()) {
  console.log(`  ${k}: ${v.length > 80 ? `${v.slice(0, 80)}…(${v.length} bytes)` : v}`);
}

const advertised = response.headers.get("x-response-hash");
const recomputed = `sha256:${createHash("sha256").update(rawBytes).digest("hex")}`;
console.log("\n=== x-response-hash CHECK ===");
console.log("  advertised :", advertised);
console.log("  recomputed :", recomputed);
console.log("  MATCH      :", advertised === recomputed ? "YES" : "NO  <-- BUG");

console.log("\n=== RECEIPT MIRROR CHECK ===");
const unprefixed = response.headers.get("payment-response");
const prefixed = response.headers.get("x-payment-response");
console.log("  PAYMENT-RESPONSE   :", unprefixed ? `present (${unprefixed.length} bytes)` : "ABSENT");
console.log("  X-PAYMENT-RESPONSE :", prefixed ? `present (${prefixed.length} bytes)` : "ABSENT");
console.log("  identical          :", unprefixed && unprefixed === prefixed ? "YES" : "NO");
console.log("  x-request-id       :", response.headers.get("x-request-id") || "ABSENT");
console.log("  x-payment-network  :", response.headers.get("x-payment-network") || "ABSENT");

const result = await httpClient.processResponse(response);

console.log("\nResponse body:", JSON.stringify(result.body, null, 2));
console.log("Payment status:", result.paymentStatus);
if (result.header) console.log("\nDecoded payment header:", JSON.stringify(result.header, null, 2));
