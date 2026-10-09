import { randomBytes } from "node:crypto";
import { expect, test, vi } from "vitest";
import { FakeCatalog, FakeClock, DemoAuthorization, FakePayment } from "../orchestration/fakes.js";
import { SqliteStore } from "../orchestration/sqlite-fixture-store.js";
import { loadConfig } from "../reap/config.js";
import { composeGroupBackend, groupSettings } from "./runtime.js";

const config = loadConfig({ DATABASE_URL: "postgresql://test@127.0.0.1/test", DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), PURCHASE_CAPS: '{"USD":"100"}' });
test("group wiring is opt-in, sandbox-only and explicitly region-bound", () => {
  expect(groupSettings(config, {})).toBeNull();
  expect(() => groupSettings(config, { GROUP_BUY_ENABLED: "true" })).toThrow(/sandbox/);
  const sandbox = { ...config, mode: "sandbox" as const, namespace: "sandbox:project:host:v1" };
  expect(() => groupSettings(sandbox, { GROUP_BUY_ENABLED: "true" })).toThrow(/COUNTRY/);
  const env = { GROUP_BUY_ENABLED: "true", GROUP_BUY_COUNTRY: "US", GROUP_BUY_CURRENCY: "USD" };
  const settings = groupSettings(sandbox, env)!;
  expect(settings.schema).toMatch(/^orchestration_[a-f0-9]{24}$/);
  expect(groupSettings({ ...sandbox, namespace: "sandbox:other:host:v1" }, env)?.schema).not.toBe(settings.schema);
  expect(groupSettings(sandbox, env)).toEqual(settings);
  expect(() => groupSettings(sandbox, { ...env, GROUP_BUY_COUNTRY: "SG" })).toThrow();
});

test("missing payment/consent ports never start a state-mutating worker", async () => {
  const store = new SqliteStore(":memory:");
  const reads = vi.spyOn(store, "groups");
  const close = vi.spyOn(store, "close");
  const runtime = composeGroupBackend(store, new FakeCatalog());
  expect(runtime.backend.capabilities).toEqual({ catalog: true, payments: false, consent: false });
  await Promise.resolve();
  expect(reads).not.toHaveBeenCalled();
  await runtime.close();
  expect(close).toHaveBeenCalledOnce();
});

test("a fully injected backend owns and stops its worker", async () => {
  const store = new SqliteStore(":memory:");
  const reads = vi.spyOn(store, "groups");
  const clock = new FakeClock();
  const payments = new FakePayment(":memory:", clock);
  const runtime = composeGroupBackend(store, new FakeCatalog(), { payments, consent: new DemoAuthorization(), clock });
  try {
    expect(runtime.backend.capabilities.payments).toBe(true);
    expect(reads).toHaveBeenCalled();
  } finally { await runtime.close(); payments.close(); }
});
