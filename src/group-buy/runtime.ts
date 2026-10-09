import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReapWithMockUsers } from "../reap/mock-users.js";
import { loadReapConfig } from "../reap/config.js";
import { createReapOrchestrationPorts } from "../reap/orchestration.js";
import { Orchestration } from "../orchestration/application.js";
import { DomainError, type AuthorizationPort, type CatalogPort, type Clock, type GroupPaymentPort } from "../orchestration/contract.js";
import { PostgresStore } from "../orchestration/postgres-store.js";
import type { Store } from "../orchestration/store.js";
import { supabaseConfig } from "../orchestration/supabase.js";
import { runWorker } from "../orchestration/worker.js";
import type { Commerce } from "../mcp/commerce.js";
import type { Config } from "../mcp/config.js";
import { AppError, log } from "../mcp/errors.js";
import { hash } from "../mcp/security.js";
import { GroupBuyTool, type GroupBackend } from "./tool.js";

export function groupSettings(config: Config, env: NodeJS.ProcessEnv) {
  if (!env.GROUP_BUY_ENABLED || env.GROUP_BUY_ENABLED === "false") return null;
  if (env.GROUP_BUY_ENABLED !== "true" || config.mode !== "sandbox") throw new AppError("CONFIG_ERROR", "Group backend wiring requires explicit GROUP_BUY_ENABLED=true in sandbox mode. Mock groups are not used.");
  const country = env.GROUP_BUY_COUNTRY;
  const currency = env.GROUP_BUY_CURRENCY;
  if (!country || !currency || !config.countries.includes(country) || !config.currencies.includes(currency)) throw new AppError("CONFIG_ERROR", "Set GROUP_BUY_COUNTRY and GROUP_BUY_CURRENCY to explicitly allowed values.");
  return { country, currency, schema: `orchestration_${hash(JSON.stringify(["reap-wrapper-v2", config.namespace, country, currency])).slice(0, 24)}` };
}

const unavailablePayments: GroupPaymentPort = {
  async quoteGroupOrder() { throw new DomainError("PROVIDER_UNAVAILABLE"); },
  async startGroupPayment() { throw new DomainError("PROVIDER_UNAVAILABLE"); },
  async getGroupPayment() { throw new DomainError("PROVIDER_UNAVAILABLE"); },
  async requestRecovery() { throw new DomainError("PROVIDER_UNAVAILABLE"); },
};
const unavailableConsent: AuthorizationPort = { async resolve() { return null; } };

export function composeGroupBackend(store: Store, catalog: CatalogPort, options: { payments?: GroupPaymentPort; consent?: AuthorizationPort; clock?: Clock } = {}) {
  const app = new Orchestration(store, catalog, options.payments ?? unavailablePayments, options.consent ?? unavailableConsent, options.clock ?? { now: () => new Date().toISOString() });
  const capabilities = { catalog: true, payments: Boolean(options.payments), consent: Boolean(options.consent) };
  const controller = new AbortController();
  const work = capabilities.payments && capabilities.consent ? runWorker(app, { signal: controller.signal, onError: () => log("group_worker_unavailable") }) : Promise.resolve();
  const backend: GroupBackend = { app, capabilities };
  return { backend, async close() { controller.abort(); await work; await store.close(); } };
}

export async function createGroupRuntime(commerce: Pick<Commerce, "config" | "db">, env: NodeJS.ProcessEnv = process.env,
  dependencies: { store?: Store; fetch?: typeof globalThis.fetch } = {}) {
  const settings = groupSettings(commerce.config, env);
  if (!settings) return { tool: new GroupBuyTool(commerce.config, commerce.db), async close() {} };
  const root = env.GROUP_BUY_REAP_DATA_DIR ?? fileURLToPath(new URL("../../.reap/groups/", import.meta.url));
  const directory = resolve(root, settings.schema);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const wrapper = createReapWithMockUsers({
    config: loadReapConfig({ REAP_API_KEY: commerce.config.reap.apiKey, REAP_BASE_URL: commerce.config.reap.baseUrl,
      REAP_PROJECT_REF: commerce.config.namespace, REAP_ENVIRONMENT: "SANDBOX", REAP_SIMULATE_CHECKOUT: "false" }),
    journalPath: join(directory, "journal.json"), validateConsent: () => false, validateReturnUrl: () => false,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });
  let ports: ReturnType<typeof createReapOrchestrationPorts> | undefined;
  let store: Store | undefined;
  try {
    ports = createReapOrchestrationPorts({ wrapper, mappingPath: join(directory, "variants.sqlite"),
      country: settings.country, currency: settings.currency,
      fulfillment: () => { throw new DomainError("PROVIDER_UNAVAILABLE"); },
    });
    store = dependencies.store ?? new PostgresStore(supabaseConfig(env), settings.schema);
    // Catalogue is usable now. Aggregate Reap quotes do not satisfy verified
    // participant pricing, so payment/consent gates deliberately remain closed.
    const runtime = composeGroupBackend(store, ports.catalog);
    let closed = false;
    return { tool: new GroupBuyTool(commerce.config, commerce.db, runtime.backend), async close() {
      if (closed) return;
      closed = true;
      try { await runtime.close(); } finally { try { ports!.close(); } finally { await wrapper.close(); } }
    } };
  } catch (error) {
    try { await store?.close(); } finally { try { ports?.close(); } finally { await wrapper.close(); } }
    throw error;
  }
}
