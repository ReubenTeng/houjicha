import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoWorld } from "../orchestration/demo-fixture.js";
import { loadConfig, scopes } from "../mcp/config.js";
import type { Database } from "../mcp/db.js";
import type { Identity } from "../mcp/domain.js";
import { groupInputSchema } from "./schemas.js";
import { GroupBuyTool } from "./tool.js";

const config = loadConfig({ DATABASE_URL: "postgresql://test@127.0.0.1/test", DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), PURCHASE_CAPS: '{"USD":"100"}' });
const identity: Identity = { issuer: "test", subject: "alice", scopes: [...scopes], email: null, emailVerified: false };
const worlds: ReturnType<typeof demoWorld>[] = [];
afterEach(async () => { for (const world of worlds.splice(0)) await world.close(); });
function fixture(enabled = true) {
  const world = demoWorld(":memory:");
  worlds.push(world);
  const db = { actor: vi.fn(async (id: Identity) => ({ ...id, id: id.subject, ownerReference: id.subject })), rateLimit: vi.fn(async () => {}), audit: vi.fn(async () => {}) } satisfies Pick<Database, "actor" | "rateLimit" | "audit">;
  const tool = new GroupBuyTool(config, db, { app: world.app, capabilities: { catalog: true, payments: enabled, consent: enabled } });
  return { world, db, tool };
}

describe("group_buy boundary", () => {
  it("rejects model-controlled identity and service-only actions", () => {
    expect(groupInputSchema.safeParse({ action: "get_my_updates", userId: "someone" }).success).toBe(false);
    for (const action of ["tick", "reconcile", "getPaymentAuthorization"]) expect(groupInputSchema.safeParse({ action }).success).toBe(false);
  });
  it("calls the unchanged core and retains command idempotency and versions", async () => {
    const { world, tool } = fixture();
    const command = { action: "create_group_buy", metadata: { commandId: "create-1", expectedVersion: 0 }, input: world.input("alice", "HOST") };
    const created = await tool.call(command, identity);
    expect(created.ok).toBe(true);
    expect(await tool.call(command, identity)).toEqual(created);
    const group = (created.data?.result as { group: { id: string; version: number } }).group;
    const read = await tool.call({ action: "get_group_buy", groupBuyId: group.id }, identity);
    expect(read.ok).toBe(true);
    const stale = await tool.call({ action: "close_group_buy", groupBuyId: group.id, metadata: { commandId: "close", expectedVersion: 0 } }, identity);
    expect(stale.error?.code).toBe("VERSION_CONFLICT");
    expect(stale.data?.currentVersion).toBe(group.version);
  });
  it("routes the complete public lifecycle and keeps outsider views private", async () => {
    const { world, tool } = fixture();
    const bob = { ...identity, subject: "bob" };
    const call = (raw: unknown, actor = identity) => tool.call(raw, actor);
    expect((await call({ action: "search_catalog", query: "tea" })).ok).toBe(true);
    const created = await call({ action: "create_group_buy", input: world.input("alice", "HOST"), metadata: { commandId: "create", expectedVersion: 0 } });
    const groupBuyId = (created.data?.result as { group: { id: string } }).group.id;
    const outsider = await call({ action: "get_group_buy", groupBuyId }, bob);
    expect(outsider.data?.result).toMatchObject({ ownParticipant: null, approvals: [], collection: { point: { address: "" } } });
    expect((await call({ action: "get_payment_status", groupBuyId }, bob)).error?.code).toBe("FORBIDDEN");
    const basket = world.basket("bob", "3000");
    const discovered = await call({ action: "find_group_buys", merchantId: "merchant", lines: basket.lines, constraints: basket.constraints }, bob);
    expect(discovered.data?.result).toHaveLength(1);
    const mutate = async (action: string, extra = {}, actor = identity) => {
      const version = (await world.app.getGroupBuy({ userId: actor.subject }, groupBuyId)).version;
      const result = await call({ action, groupBuyId, metadata: { commandId: `${action}-${version}`, expectedVersion: version }, ...extra }, actor);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return result;
    };
    await mutate("join_group_buy", { input: basket }, bob);
    const own = await world.app.getGroupBuy({ userId: "alice" }, groupBuyId);
    const approvalRequestId = own.approvals.find(approval => approval.state === "PENDING")!.id;
    await mutate("respond_to_price_change", { approvalRequestId, decision: "ACCEPT" });
    expect((await call({ action: "get_my_updates" })).ok).toBe(true);
    expect((await call({ action: "get_payment_status", groupBuyId })).data?.freshness).toBe("STORED");
    await mutate("leave_group_buy", {}, bob);
    await mutate("close_group_buy");
    await mutate("cancel_group_buy");
    expect((await world.app.getGroupBuy({ userId: "alice" }, groupBuyId)).status).toBe("CANCELLED");
  });
  it("does not fabricate consent", async () => {
    const { world, tool } = fixture();
    const input = { ...world.input("alice", "HOST"), authorizationRef: "fabricated" };
    expect((await tool.call({ action: "create_group_buy", input, metadata: { commandId: "create", expectedVersion: 0 } }, identity)).error?.code).toBe("FORBIDDEN");
    expect(await world.store.groups()).toEqual([]);
  });
  it("reports missing dependencies before discovery or writes", async () => {
    const { world, tool } = fixture(false);
    const input = world.input("alice", "HOST");
    expect((await tool.call({ action: "find_group_buys", merchantId: input.merchantId, lines: input.lines, constraints: input.constraints }, identity)).error?.code).toBe("GROUP_PAYMENT_UNAVAILABLE");
    expect((await tool.call({ action: "create_group_buy", input, metadata: { commandId: "create", expectedVersion: 0 } }, identity)).error?.code).toBe("GROUP_CONSENT_UNAVAILABLE");
    expect(await world.store.groups()).toEqual([]);
  });
  it("enforces action scopes before resolving an actor", async () => {
    const { tool, db } = fixture();
    const result = await tool.call({ action: "get_my_updates" }, { ...identity, scopes: [] });
    expect(result.error?.code).toBe("FORBIDDEN");
    expect(db.actor).not.toHaveBeenCalled();
  });
  it("reports database failures without leaking connection details", async () => {
    const { world, tool } = fixture();
    vi.spyOn(world.store, "groups").mockRejectedValueOnce(new Error("secret database credentials"));
    const result = await tool.call({ action: "get_my_updates" }, identity);
    expect(result.error?.code).toBe("GROUP_BACKEND_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("secret database credentials");
  });
  it("keeps opaque command IDs intact and rejects unknown nested fields", () => {
    const valid = { action: "cancel_group_buy", groupBuyId: "group", metadata: { commandId: " command ", expectedVersion: 1 } };
    expect(groupInputSchema.parse(valid)).toEqual(valid);
    expect(groupInputSchema.safeParse({ ...valid, metadata: { ...valid.metadata, userId: "someone" } }).success).toBe(false);
    expect(groupInputSchema.safeParse({ ...valid, user_approved: true }).success).toBe(false);
  });
  it("is callable without a configured backend and reports why", async () => {
    const { db } = fixture();
    const tool = new GroupBuyTool(config, db);
    expect((await tool.call({ action: "get_my_updates" }, identity)).error?.code).toBe("GROUP_BACKEND_UNAVAILABLE");
  });
});
