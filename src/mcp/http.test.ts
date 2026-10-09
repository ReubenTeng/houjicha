import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, test, vi } from "vitest";
import type { Commerce } from "./commerce.js";
import { loadConfig, scopes } from "./config.js";
import type { Database } from "./db.js";
import type { Identity } from "./domain.js";
import { AppError } from "./errors.js";
import { createHttpApp } from "./http.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function fixture(remote = true) {
  const config = loadConfig({ DATABASE_URL: "postgresql://test@127.0.0.1/test", DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), PURCHASE_CAPS: '{"USD":"100"}' });
  const identity: Identity = { issuer: "test", subject: "alice", scopes: [...scopes], email: null, emailVerified: false };
  const db = { actor: vi.fn(async () => ({ ...identity, id: "alice-id", ownerReference: "owner" })), rateLimit: vi.fn(async () => {}), audit: vi.fn(async () => {}) } as unknown as Database;
  const commerce = { config, db, provider: {}, call: vi.fn() } as unknown as Commerce;
  const http = createHttpApp(commerce, { remote, verifier: { async verify(token) { if (token !== "test-token") throw new AppError("AUTH_REQUIRED", "Invalid test token"); return identity; } } });
  const server = http.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  config.publicUrl.port = String(address.port);
  config.oauth.audience = new URL("/mcp", config.publicUrl).href;
  closes.push(async () => { await http.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { url: new URL("/mcp", config.publicUrl), identity, db };
}

test("authenticated HTTP uses the same six-tool registry and group dispatcher", async () => {
  const { url } = await fixture();
  const client = new Client({ name: "http-test", version: "1" });
  closes.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer test-token" } } }));
  expect((await client.listTools()).tools).toHaveLength(6);
  const result = await client.callTool({ name: "group_buy", arguments: { action: "get_my_updates" } });
  expect(result.structuredContent).toMatchObject({ status: "GROUP_BACKEND_UNAVAILABLE" });
});

test("HTTP rejects unauthenticated callers and missing action scopes before domain access", async () => {
  const { url, identity, db } = await fixture();
  expect((await fetch(url, { method: "POST" })).status).toBe(401);
  identity.scopes = ["commerce:read"];
  const denied = await fetch(url, { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "group_buy", arguments: { action: "close_group_buy", groupBuyId: "g", metadata: { commandId: "close", expectedVersion: 1 } } } }) });
  expect(denied.status).toBe(403);
  expect(denied.headers.get("www-authenticate")).toContain("commerce:prepare");
  expect(db.actor).not.toHaveBeenCalled();
});

test("stdio's page server does not expose an unauthenticated remote MCP endpoint", async () => {
  const { url } = await fixture(false);
  expect((await fetch(url, { method: "POST" })).status).toBe(503);
});
