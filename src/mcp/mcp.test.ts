import { randomBytes } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, test, vi } from "vitest";
import { GroupBuyTool } from "../group-buy/tool.js";
import type { Commerce } from "./commerce.js";
import { loadConfig, scopes } from "./config.js";
import type { Database } from "./db.js";
import type { Identity } from "./domain.js";
import { buildMcpServer, requiredToolScopes } from "./mcp.js";

const identity: Identity = { issuer: "test", subject: "alice", scopes: [...scopes], email: null, emailVerified: false };
const config = loadConfig({ DATABASE_URL: "postgresql://test@127.0.0.1/test", DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), PURCHASE_CAPS: '{"USD":"100"}' });
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });

async function clientFixture() {
  const db = { actor: vi.fn(async () => ({ ...identity, id: "alice-id", ownerReference: "alice-owner" })), rateLimit: vi.fn(async () => {}), audit: vi.fn(async () => {}) } as unknown as Database;
  const commerce = { config, db, call: vi.fn(async () => ({ ok: false, mode: "mock", simulated: true, status: "TEST", data: null, next_action: null })) } as unknown as Commerce;
  const groups = new GroupBuyTool(config, db);
  const server = buildMcpServer(commerce, identity, groups);
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  closes.push(async () => { await client.close(); await server.close(); });
  await server.connect(right);
  await client.connect(left);
  return { client, commerce };
}

test("the MCP handshake advertises exactly five preserved commerce tools plus group_buy", async () => {
  const { client } = await clientFixture();
  const { tools } = await client.listTools();
  expect(tools.map(tool => tool.name)).toEqual(["connect_payment_method", "search_products", "prepare_purchase", "request_purchase", "get_purchase_status", "group_buy"]);
  expect(tools[5]?.inputSchema.type).toBe("object");
  expect(tools[5]?.outputSchema?.type).toBe("object");
  expect(tools[5]?.annotations?.readOnlyHint).toBe(false);
});

test("group calls reach the adapter, not the single-purchase payment implementation", async () => {
  const { client, commerce } = await clientFixture();
  const result = await client.callTool({ name: "group_buy", arguments: { action: "get_my_updates" } });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ status: "GROUP_BACKEND_UNAVAILABLE" });
  expect(commerce.call).not.toHaveBeenCalled();
  await client.callTool({ name: "search_products", arguments: { query: "tea", country: "US", currency: "USD" } });
  expect(commerce.call).toHaveBeenCalledWith("search_products", { query: "tea", country: "US", currency: "USD" }, identity);
});

test("the transport permission resolver is action-aware", () => {
  expect(requiredToolScopes("group_buy", { action: "get_my_updates" })).toEqual(["commerce:read"]);
  expect(requiredToolScopes("group_buy", { action: "close_group_buy", groupBuyId: "g", metadata: { commandId: "close", expectedVersion: 1 } })).toEqual(["commerce:prepare", "commerce:checkout"]);
  expect(requiredToolScopes("request_purchase", {})).toEqual(["commerce:checkout"]);
});
