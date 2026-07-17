import "dotenv/config";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const rawKey = process.env.BUYER_PRIVATE_KEY;
if (!rawKey) {
  console.error("Missing BUYER_PRIVATE_KEY in .env");
  process.exit(1);
}

const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
const signer = privateKeyToAccount(privateKey);
console.log("Buyer wallet address:", signer.address);

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

const url = "https://x402-seller.onrender.com/gas/price";

console.log("Requesting:", url);

const response = await fetchWithPayment(url, { method: "GET" });
const result = await httpClient.processResponse(response);

console.log("\nResponse body:", result.body);
console.log("Payment status:", result.paymentStatus);
