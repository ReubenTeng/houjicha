import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ReapCatalog } from "../group-buy/catalog.js";
import { Commerce } from "./commerce.js";
import { loadConfig, scopes } from "./config.js";
import { Database } from "./db.js";
import type { Identity } from "./domain.js";
import { MockProvider } from "./providers/mock.js";

const url = process.env.REAP_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../", import.meta.url));
const key = randomBytes(32).toString("base64");
const environment = { REAP_ENV_FILE: "", APP_MODE: "mock", DATABASE_URL: url ?? "postgresql://postgres@127.0.0.1/test", DATA_ENCRYPTION_KEY: key, PURCHASE_CAPS: '{"USD":"100.00"}', GROUP_BUY_ENABLED: "false" };

async function unusedPort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

describe.skipIf(!url)("explicit disposable PostgreSQL integration", () => {
  let db: Database;
  let commerce: Commerce;
  let provider: MockProvider;
  const config = loadConfig(environment);
  const identity: Identity = { issuer: "test", subject: randomUUID(), scopes: [...scopes], email: "test@example.invalid", emailVerified: true };
  beforeAll(async () => {
    if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("REAP_TEST_DATABASE_URL must name a disposable loopback PostgreSQL database.");
    db = new Database(config);
    await db.migrate();
    provider = new MockProvider(db, config);
    commerce = new Commerce(db, provider, config);
  });
  afterAll(async () => { await db?.close(); });

  test("migrations replay safely and issuer/subject mapping is durable", async () => {
    await db.migrate();
    expect((await db.query("SELECT name FROM schema_migrations ORDER BY name")).map(row => row.name)).toEqual(["001_initial.sql", "002_group_catalog.sql"]);
    const actor = await db.actor(identity);
    expect((await db.actor(identity)).id).toBe(actor.id);
    expect((await db.actor({ ...identity, issuer: "other-issuer" })).id).not.toBe(actor.id);
  });

  test("all five imported commerce tools retain approval-gated, deduplicated behavior", async () => {
    const call = (name: Parameters<Commerce["call"]>[0], input: unknown) => commerce.call(name, input, identity);
    const setup = await call("connect_payment_method", {});
    expect(setup.ok).toBe(true);
    const methodId = setup.data?.payment_method_id;
    await provider.consent(new URL(String(setup.data?.setup_url)).pathname.split("/").at(-1)!, "enrollment", true);
    expect((await call("connect_payment_method", { payment_method_id: methodId })).status).toBe("ACTIVE");
    const found = await call("search_products", { query: "coffee", country: "US", currency: "USD" });
    expect(found.ok).toBe(true);
    const products = found.data?.products as { product_id: string }[];
    const prepared = await call("prepare_purchase", { action: "create", product_id: products[0]!.product_id, option_ids: ["whole"], quantity: 1, country: "US", currency: "USD", operation_key: "test-purchase", shipping_address: { recipient_name: "Test", line1: "Test address", city: "Test", postal_code: "10000", country: "US" } });
    expect(prepared.status).toBe("READY");
    const request = { purchase_id: prepared.data?.purchase_id, expected_revision: prepared.data?.revision, payment_method_id: methodId };
    const requested = await call("request_purchase", request);
    expect(requested.status).toBe("REQUIRES_ACTION");
    expect((await call("request_purchase", request)).data?.purchase_id).toBe(request.purchase_id);
    expect(await db.query("SELECT id FROM operations WHERE purchase_id=$1 AND kind='checkout'", [request.purchase_id])).toHaveLength(1);
    const foreign = await commerce.call("get_purchase_status", { purchase_id: request.purchase_id }, { ...identity, subject: randomUUID() });
    expect(foreign.error?.code).toBe("FORBIDDEN");
    await provider.consent(new URL(String(requested.data?.approval_url)).pathname.split("/").at(-1)!, "checkout", true);
    await call("get_purchase_status", { purchase_id: request.purchase_id });
    const done = await call("get_purchase_status", { purchase_id: request.purchase_id });
    expect(done.status).toBe("COMPLETED");
    expect(done.simulated).toBe(true);
  });

  test("real catalog persistence retains shared IDs and context-bound cursors", async () => {
    const catalog = new ReapCatalog(db, provider, config, "US", "USD");
    const first = await catalog.search("coffee");
    const second = await catalog.search("coffee");
    expect(second.items.map(item => item.variantId)).toEqual(first.items.map(item => item.variantId));
    expect((await catalog.get(first.items[0]!.variantId))?.indicativePrice).toEqual(first.items[0]!.indicativePrice);
    const other = new ReapCatalog(db, provider, { ...config, namespace: "other-project" }, "US", "USD");
    expect(await other.get(first.items[0]!.variantId)).toBeNull();
    const paged = new ReapCatalog(db, { details: id => provider.details(id), search: async input => ({ ...await provider.search(input), next_cursor: "provider-next-page" }) }, config, "US", "USD");
    const page = await paged.search("coffee");
    expect(page.nextCursor).toBeTruthy();
    await expect(paged.search("different", undefined, page.nextCursor!)).rejects.toThrow(/criteria/);
    await db.query("UPDATE group_catalog_cursors SET expires_at=now()-interval '1 second' WHERE id=$1", [page.nextCursor]);
    await expect(paged.search("coffee", undefined, page.nextCursor!)).rejects.toThrow(/expired/);
  });

  test.each(["source", "compiled"])("%s stdio process initializes and exposes six tools without reading .env", async mode => {
    const port = await unusedPort();
    const client = new Client({ name: "stdio-test", version: "1" });
    const env = { PATH: process.env.PATH ?? "", ...environment, PORT: String(port), PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, LOCAL_DEMO_SUBJECT: randomUUID() };
    if (mode === "compiled") await promisify(execFile)(process.execPath, ["dist/reap/migrate.js"], { cwd: root, env });
    const transport = new StdioClientTransport({ command: process.execPath, args: mode === "source" ? ["--import", "tsx", "src/reap/stdio-main.ts"] : ["dist/reap/stdio-main.js"], cwd: root, env, stderr: "pipe" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(6);
      const result = await client.callTool({ name: "group_buy", arguments: { action: "get_my_updates" } });
      expect(result.structuredContent).toMatchObject({ status: "GROUP_BACKEND_UNAVAILABLE" });
    } finally { await client.close(); }
  }, 20000);
});
