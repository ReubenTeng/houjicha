import type { Capabilities, FeatureEvidence, ReapWrapper, Store, WalletDebitInput } from "./contract.js";
import { CURRENCY_EXPONENTS } from "./money.js";

export interface UserBinding {
  userId: string;
  reapUserId: string;
  accountId: string;
  enrollmentOwnerId: string;
}

export interface ReapConfig {
  apiKey: string;
  baseUrl: string;
  reapVersion: "2025-02-14";
  projectRef: string;
  environment: "SANDBOX" | "PRODUCTION";
  fundingModel: Capabilities["fundingModel"];
  authorizationMode: Capabilities["authorizationMode"];
  billingCurrency: string | null;
  walletAssetId: string | null;
  features: Capabilities["features"];
  stores: Store[];
  simulateCheckout: boolean;
}

export interface ReapWrapperOptions {
  config: ReapConfig;
  journalPath: string;
  users: UserBinding[];
  validateReturnUrl: (url: string, binding: { userId: string; operationId: string; purchaseAttemptId?: string }) => boolean | Promise<boolean>;
  validateConsent: (input: WalletDebitInput) => boolean | Promise<boolean>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  mode?: "LOCAL_MOCK";
}

export interface ManagedReapWrapper extends ReapWrapper {
  close(): Promise<void>;
}

export class ReapConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReapConfigError";
  }
}

export const REAP_VERSION = "2025-02-14" as const;

const SANDBOX_HOSTS = new Set([
  "sg.sandbox.api.reap.global",
  "mx.sandbox.api.reap.global",
  "sandbox.api.reap.global",
]);
const PRODUCTION_HOSTS = new Set([
  "sg.prod.api.reap.global",
  "mx.prod.api.reap.global",
  "prod.api.reap.global",
]);
const DEFAULT_SANDBOX_BASE_URL = "https://sg.sandbox.api.reap.global";
const FEATURE_KEYS = [
  "agenticCheckout",
  "externalEnrollment",
  "productSearch",
  "virtualAssetDebit",
  "externalCheckoutUrl",
  "merchantOrderTracking",
  "merchantOrderCancellation",
  "merchantRefunds",
] as const;
const UNIMPLEMENTED_FEATURE_KEYS = new Set<string>([
  "externalCheckoutUrl",
  "merchantOrderTracking",
  "merchantOrderCancellation",
  "merchantRefunds",
]);

export function parseReapBaseUrl(raw: string, environment: "SANDBOX" | "PRODUCTION"): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ReapConfigError("REAP_BASE_URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new ReapConfigError("REAP_BASE_URL must use https.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ReapConfigError("REAP_BASE_URL must not contain credentials.");
  }
  if (url.port !== "") {
    throw new ReapConfigError("REAP_BASE_URL must not specify a port.");
  }
  if (url.search !== "" || url.hash !== "" || (url.pathname !== "" && url.pathname !== "/")) {
    throw new ReapConfigError("REAP_BASE_URL must be an origin without path, query or fragment.");
  }
  const allowed = environment === "PRODUCTION" ? PRODUCTION_HOSTS : SANDBOX_HOSTS;
  if (!allowed.has(url.hostname)) {
    throw new ReapConfigError(
      `REAP_BASE_URL host is not a documented Reap ${environment === "PRODUCTION" ? "production" : "sandbox"} host.`,
    );
  }
  return url.origin;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validateEvidence(value: unknown, field: string): FeatureEvidence {
  if (typeof value !== "object" || value === null) {
    throw new ReapConfigError(`${field} must be an object.`);
  }
  const evidence = value as Record<string, unknown>;
  const state = evidence.state;
  if (state !== "VERIFIED" && state !== "DISABLED" && state !== "UNVERIFIED") {
    throw new ReapConfigError(`${field}.state must be VERIFIED, DISABLED or UNVERIFIED.`);
  }
  const reason = evidence.reason;
  const checkedAt = evidence.checkedAt;
  const evidenceRef = evidence.evidenceRef;
  if (!isNonBlank(reason)) {
    throw new ReapConfigError(`${field}.reason is required.`);
  }
  if (checkedAt !== null && !isNonBlank(checkedAt)) {
    throw new ReapConfigError(`${field}.checkedAt must be a string or null.`);
  }
  if (evidenceRef !== null && !isNonBlank(evidenceRef)) {
    throw new ReapConfigError(`${field}.evidenceRef must be a string or null.`);
  }
  if (state === "VERIFIED" && (checkedAt === null || evidenceRef === null)) {
    throw new ReapConfigError(`${field} VERIFIED requires checkedAt and evidenceRef.`);
  }
  return {
    state,
    reason: reason.trim(),
    checkedAt: checkedAt === null ? null : checkedAt.trim(),
    evidenceRef: evidenceRef === null ? null : evidenceRef.trim(),
  };
}

export function validateReapConfig(config: ReapConfig, mode?: "LOCAL_MOCK"): ReapConfig {
  if (typeof config !== "object" || config === null) {
    throw new ReapConfigError("Reap configuration is required.");
  }
  if (!isNonBlank(config.apiKey)) {
    throw new ReapConfigError("config.apiKey is required.");
  }
  if (mode !== "LOCAL_MOCK" && config.apiKey.startsWith("mock_")) {
    throw new ReapConfigError("Mock credentials cannot be used outside LOCAL_MOCK mode.");
  }
  const baseUrl = parseReapBaseUrl(config.baseUrl, config.environment);
  if (config.reapVersion !== REAP_VERSION) {
    throw new ReapConfigError(`config.reapVersion must be ${REAP_VERSION}.`);
  }
  if (!isNonBlank(config.projectRef)) {
    throw new ReapConfigError("config.projectRef is required.");
  }
  if (config.environment !== "SANDBOX" && config.environment !== "PRODUCTION") {
    throw new ReapConfigError("config.environment must be SANDBOX or PRODUCTION.");
  }
  if (!["PROGRAM_FUNDED", "USER_FUNDED", "UNKNOWN"].includes(config.fundingModel)) {
    throw new ReapConfigError("config.fundingModel is invalid.");
  }
  if (!["MANAGED", "EXTERNAL", "UNKNOWN"].includes(config.authorizationMode)) {
    throw new ReapConfigError("config.authorizationMode is invalid.");
  }
  if (config.billingCurrency !== null) {
    if (!isNonBlank(config.billingCurrency) || CURRENCY_EXPONENTS[config.billingCurrency] === undefined) {
      throw new ReapConfigError("config.billingCurrency is not a supported currency.");
    }
  }
  if (config.walletAssetId !== null && !isNonBlank(config.walletAssetId)) {
    throw new ReapConfigError("config.walletAssetId must be a non-empty string or null.");
  }
  if (typeof config.simulateCheckout !== "boolean") {
    throw new ReapConfigError("config.simulateCheckout must be boolean.");
  }
  if (config.simulateCheckout && config.environment !== "SANDBOX") {
    throw new ReapConfigError("config.simulateCheckout is only permitted in SANDBOX.");
  }
  if (typeof config.features !== "object" || config.features === null) {
    throw new ReapConfigError("config.features is required.");
  }
  const features = {} as Capabilities["features"];
  for (const key of FEATURE_KEYS) {
    const evidence = validateEvidence((config.features as Record<string, unknown>)[key], `features.${key}`);
    if (mode !== "LOCAL_MOCK" && evidence.evidenceRef !== null && evidence.evidenceRef.startsWith("fixture:")) {
      throw new ReapConfigError(`features.${key} cannot use fixture evidence outside LOCAL_MOCK mode.`);
    }
    features[key] = evidence;
  }
  if (!Array.isArray(config.stores)) {
    throw new ReapConfigError("config.stores must be an array.");
  }
  const stores: Store[] = [];
  for (const [index, raw] of config.stores.entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new ReapConfigError(`stores[${index}] must be an object.`);
    }
    const store = raw as unknown as Record<string, unknown>;
    if (!isNonBlank(store.storeId) || !isNonBlank(store.providerMerchantName) || !isNonBlank(store.country)) {
      throw new ReapConfigError(`stores[${index}] requires storeId, providerMerchantName and country.`);
    }
    if (!Array.isArray(store.currencies) || store.currencies.length === 0) {
      throw new ReapConfigError(`stores[${index}].currencies must be a non-empty array.`);
    }
    const currencies: string[] = [];
    for (const currency of store.currencies) {
      if (!isNonBlank(currency) || CURRENCY_EXPONENTS[currency] === undefined) {
        throw new ReapConfigError(`stores[${index}] has an unsupported currency.`);
      }
      currencies.push(currency);
    }
    const eligibility = validateEvidence(store.eligibility, `stores[${index}].eligibility`);
    if (mode !== "LOCAL_MOCK" && eligibility.evidenceRef !== null && eligibility.evidenceRef.startsWith("fixture:")) {
      throw new ReapConfigError(`stores[${index}] cannot use fixture evidence outside LOCAL_MOCK mode.`);
    }
    if (mode !== "LOCAL_MOCK" && store.storeId.startsWith("mock_")) {
      throw new ReapConfigError("Mock store identifiers cannot be used outside LOCAL_MOCK mode.");
    }
    stores.push({
      storeId: store.storeId,
      providerMerchantName: store.providerMerchantName,
      country: store.country,
      currencies,
      eligibility,
    });
  }
  return {
    apiKey: config.apiKey,
    baseUrl,
    reapVersion: config.reapVersion,
    projectRef: config.projectRef,
    environment: config.environment,
    fundingModel: config.fundingModel,
    authorizationMode: config.authorizationMode,
    billingCurrency: config.billingCurrency === null ? null : config.billingCurrency,
    walletAssetId: config.walletAssetId,
    features,
    stores,
    simulateCheckout: config.simulateCheckout,
  };
}

export function loadReapConfig(env: NodeJS.ProcessEnv): ReapConfig {
  const apiKey = env.REAP_API_KEY;
  if (!isNonBlank(apiKey)) {
    throw new ReapConfigError("REAP_API_KEY is required.");
  }
  const projectRef = env.REAP_PROJECT_REF;
  if (!isNonBlank(projectRef)) {
    throw new ReapConfigError("REAP_PROJECT_REF is required.");
  }
  const environmentRaw = env.REAP_ENVIRONMENT;
  let environment: "SANDBOX" | "PRODUCTION" = "SANDBOX";
  if (isNonBlank(environmentRaw)) {
    if (environmentRaw !== "SANDBOX" && environmentRaw !== "PRODUCTION") {
      throw new ReapConfigError("REAP_ENVIRONMENT must be SANDBOX or PRODUCTION.");
    }
    environment = environmentRaw;
  }
  const baseUrlRaw = isNonBlank(env.REAP_BASE_URL) ? env.REAP_BASE_URL.trim() : DEFAULT_SANDBOX_BASE_URL;
  const baseUrl = parseReapBaseUrl(baseUrlRaw, environment);
  const fundingModelRaw = env.REAP_FUNDING_MODEL;
  let fundingModel: Capabilities["fundingModel"] = "UNKNOWN";
  if (isNonBlank(fundingModelRaw)) {
    if (fundingModelRaw !== "PROGRAM_FUNDED" && fundingModelRaw !== "USER_FUNDED" && fundingModelRaw !== "UNKNOWN") {
      throw new ReapConfigError("REAP_FUNDING_MODEL is invalid.");
    }
    fundingModel = fundingModelRaw;
  }
  const authorizationModeRaw = env.REAP_AUTHORIZATION_MODE;
  let authorizationMode: Capabilities["authorizationMode"] = "UNKNOWN";
  if (isNonBlank(authorizationModeRaw)) {
    if (authorizationModeRaw !== "MANAGED" && authorizationModeRaw !== "EXTERNAL" && authorizationModeRaw !== "UNKNOWN") {
      throw new ReapConfigError("REAP_AUTHORIZATION_MODE is invalid.");
    }
    authorizationMode = authorizationModeRaw;
  }
  const billingCurrencyRaw = env.REAP_BILLING_CURRENCY;
  const billingCurrency = isNonBlank(billingCurrencyRaw) ? billingCurrencyRaw.trim() : null;
  const walletAssetIdRaw = env.REAP_WALLET_ASSET_ID;
  const walletAssetId = isNonBlank(walletAssetIdRaw) ? walletAssetIdRaw.trim() : null;
  const simulateCheckout = env.REAP_SIMULATE_CHECKOUT === "true";
  const unverified = (reason: string): FeatureEvidence => ({
    state: "UNVERIFIED",
    reason,
    checkedAt: null,
    evidenceRef: null,
  });
  const disabled = (reason: string): FeatureEvidence => ({
    state: "DISABLED",
    reason,
    checkedAt: null,
    evidenceRef: null,
  });
  const features = {} as Capabilities["features"];
  for (const key of FEATURE_KEYS) {
    features[key] = UNIMPLEMENTED_FEATURE_KEYS.has(key)
      ? disabled("No implemented provider operation for this feature.")
      : unverified("Feature not yet demonstrated for this environment and configuration.");
  }
  return validateReapConfig({
    apiKey: apiKey.trim(),
    baseUrl,
    reapVersion: REAP_VERSION,
    projectRef: projectRef.trim(),
    environment,
    fundingModel,
    authorizationMode,
    billingCurrency,
    walletAssetId,
    features,
    stores: [],
    simulateCheckout,
  });
}
