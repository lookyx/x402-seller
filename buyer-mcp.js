import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402MCPClient } from "@x402/mcp";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const rawKey = process.env.BUYER_PRIVATE_KEY;
if (!rawKey) { console.error("Missing BUYER_PRIVATE_KEY in .env"); process.exit(1); }

const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
const signer = privateKeyToAccount(privateKey);
console.log("Buyer wallet address:", signer.address);

const paymentClient = new x402Client();
paymentClient.register("eip155:*", new ExactEvmScheme(signer));

const mcpClient = new Client({ name: "buyer-mcp-test", version: "1.0.0" }, { capabilities: {} });
const x402Mcp = new x402MCPClient(mcpClient, paymentClient, {
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }) => {
    const accept = paymentRequired.accepts[0];
    console.log(`\nPayment requested: ${accept.amount} of ${accept.asset} on ${accept.network} -> ${accept.payTo}`);
    return true;
  },
});

const transport = new StreamableHTTPClientTransport(new URL("https://x402-seller.onrender.com/mcp"));
await x402Mcp.connect(transport);

const toolName = "treasury_debt";
console.log("Calling tool:", toolName);

const result = await x402Mcp.callTool(toolName, {});

console.log("\nisError:", result.isError);
console.log("paymentMade:", result.paymentMade);
if (result.paymentResponse) console.log("paymentResponse:", JSON.stringify(result.paymentResponse, null, 2));
console.log("\nContent:", result.content?.[0]?.text);

await x402Mcp.close();
