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
import { ReapCatalog } from "./catalog.js";
import { GroupBuyTool, type GroupBackend } from "./tool.js";

export function groupSettings(config: Config, env: NodeJS.ProcessEnv) {
  if (!env.GROUP_BUY_ENABLED || env.GROUP_BUY_ENABLED === "false") return null;
  if (env.GROUP_BUY_ENABLED !== "true" || config.mode !== "sandbox") throw new AppError("CONFIG_ERROR", "Group backend wiring requires explicit GROUP_BUY_ENABLED=true in sandbox mode. Mock groups are not used.");
  const country = env.GROUP_BUY_COUNTRY;
  const currency = env.GROUP_BUY_CURRENCY;
  if (!country || !currency || !config.countries.includes(country) || !config.currencies.includes(currency)) throw new AppError("CONFIG_ERROR", "Set GROUP_BUY_COUNTRY and GROUP_BUY_CURRENCY to explicitly allowed values.");
  return { country, currency, schema: `orchestration_${hash(JSON.stringify([config.namespace, country, currency])).slice(0, 24)}` };
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

export function createGroupRuntime(commerce: Commerce, env: NodeJS.ProcessEnv = process.env) {
  let runtime: ReturnType<typeof composeGroupBackend> | undefined;
  try {
    const settings = groupSettings(commerce.config, env);
    if (settings) {
      const store = new PostgresStore(supabaseConfig(env), settings.schema);
      const catalog = new ReapCatalog(commerce.db, commerce.provider, commerce.config, settings.country, settings.currency);
      runtime = composeGroupBackend(store, catalog);
    }
  } catch { log("group_backend_unavailable", { code: "CONFIG_ERROR" }); }
  return { tool: new GroupBuyTool(commerce.config, commerce.db, runtime?.backend), async close() { await runtime?.close(); } };
}
