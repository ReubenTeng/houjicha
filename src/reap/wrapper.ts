import { randomUUID } from "node:crypto";
import type {
  BasketLine,
  Capabilities,
  CardSummary,
  Checkout,
  CheckoutInput,
  DataMode,
  Enrollment,
  FeatureEvidence,
  Id,
  MerchantDiscovery,
  Money,
  MutationContext,
  Operation,
  Page,
  PageInput,
  ProductDetailsResult,
  ProductSearchInput,
  ProductSummary,
  Quote,
  QuoteInput,
  ReapWrapper,
  Result,
  SearchContext,
  ShippingAddress,
  Store,
  Variant,
  WalletDebit,
  WalletDebitInput,
  WalletSnapshot,
  WrapperError,
} from "./contract.js";
import {
  validateReapConfig,
  type ManagedReapWrapper,
  type ReapWrapperOptions,
  type UserBinding,
} from "./config.js";
import {
  FileJournalStore,
  canonicalJson,
  emptyJournal,
  own,
  sha256Hex,
  type CheckoutRecord,
  type DebitRecord,
  type JournalScope,
  type JournalState,
  type JournalStore,
  type OperationRecord,
  type QuoteRecord,
  type QuoteTerms,
} from "./journal.js";
import {
  MoneyError,
  currencyExponent,
  decimalToInteger,
  decimalUnitsToInteger,
  isCanonicalMinor,
  isExactRateOne,
  isRawNumberToken,
  minorToUnits,
  normalizeDecimalToken,
  rawNumberToken,
} from "./money.js";
import {
  MalformedResponseError,
  ProviderHttpError,
  ReapTransport,
  TransportFailure,
  providerPath,
  sanitizeProviderCode,
} from "./transport.js";
import {
  ProviderShapeError,
  asObject,
  decimalUnitsString,
  hostedAction,
  moneyField,
  optArray,
  optBool,
  optMoneyField,
  optObject,
  optString,
  reqArray,
  reqBool,
  reqInt,
  reqRawAmount,
  reqString,
} from "./normalize.js";

const EMAIL_PATTERN = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
const MAX_QUOTE_LINES = 20;
const MAX_DETAILS_BATCH = 10;
const SEARCH_DEFAULT_LIMIT = 20;
const MAX_QUANTITY = Number.MAX_SAFE_INTEGER;
const PENDING_DEBIT = "PENDING" as WalletDebit["state"];

class Fail extends Error {
  readonly error: WrapperError;

  constructor(error: WrapperError) {
    super(error.message);
    this.name = "Fail";
    this.error = error;
  }
}

class AliasResult extends Error {
  readonly out: { data: unknown; warnings: string[] };

  constructor(out: { data: unknown; warnings: string[] }) {
    super("alias");
    this.name = "AliasResult";
    this.out = out;
  }
}

function werr(
  code: string,
  message: string,
  overrides: Partial<WrapperError> = {},
): Fail {
  return new Fail({
    code,
    message,
    providerCode: null,
    operationId: null,
    outcome: "NOT_SUBMITTED",
    recovery: "FIX_INPUT",
    retryAfterSeconds: null,
    ...overrides,
  });
}

interface ImplOut<T> {
  data: T;
  warnings: string[];
}

interface InternalOptions {
  journal?: JournalStore;
  minIntervalMs?: number;
  timeoutMs?: number;
}

interface AccountState {
  status: "ACTIVE" | "RESTRICTED" | "UNKNOWN";
  providerStatus: string;
}

interface BalanceState {
  currency: string;
  totalAssetValue: Money;
  totalLiabilities: Money;
  availableBalanceMinor: string;
}

interface AssetEligibility {
  virtualAssetId: string;
  units: string;
  withdrawableUnits: string;
  decimals: number;
  currency: string;
  reason: string | null;
}

interface PreparedMutation<T> {
  requestBody: unknown;
  apply?: () => void;
  interpret: (data: unknown) => {
    data: T;
    resourceId: string | null;
    applyResult?: () => void;
    warnings?: string[];
  };
}

interface DispatchSpec<T> {
  ctx: MutationContext;
  method: string;
  resourceType: OperationRecord["resourceType"];
  path: string;
  simulateCheckout?: boolean;
  noDispatch?: boolean;
  input: unknown;
  prepare: () => Promise<PreparedMutation<T>>;
  onFailure?: (failure: Fail) => void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneInput<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw werr("VALIDATION_ERROR", "Input must be a cloneable value.");
  }
}

function callerObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw werr("VALIDATION_ERROR", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw werr("VALIDATION_ERROR", `${field} must be a non-empty string.`);
  }
  return value;
}

function safeInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw werr("VALIDATION_ERROR", `${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function moneyInput(value: unknown, field: string): Money {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw werr("VALIDATION_ERROR", `${field} must be a money object.`);
  }
  const money = value as Record<string, unknown>;
  if (typeof money.currency !== "string" || money.currency === "") {
    throw werr("VALIDATION_ERROR", `${field}.currency is required.`);
  }
  try { currencyExponent(money.currency); } catch { throw werr("VALIDATION_ERROR", `${field}.currency is not supported.`); }
  if (typeof money.minor !== "string" || !isCanonicalMinor(money.minor) || money.minor === "-0") {
    throw werr("VALIDATION_ERROR", `${field}.minor must be a canonical integer string.`);
  }
  return { currency: money.currency, minor: money.minor };
}

function sameMoney(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

function inputCurrency(value: unknown, field: string): string {
  const currency = nonEmptyId(value, field);
  try {
    currencyExponent(currency);
  } catch {
    throw werr("UNSUPPORTED_CURRENCY", `${field} is not a supported currency.`);
  }
  return currency;
}

function isLikelyAbsoluteHttps(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "";
}

export function createReapWrapperInternal(
  options: ReapWrapperOptions,
  internal: InternalOptions = {},
): ManagedReapWrapper {
  return new ReapService(options, internal);
}

class ReapService implements ManagedReapWrapper {
  private readonly config: ReturnType<typeof validateReapConfig>;
  private readonly mock: boolean;
  private readonly mode: DataMode;
  private readonly users: Map<string, UserBinding>;
  private readonly validateReturnUrl: ReapWrapperOptions["validateReturnUrl"];
  private readonly validateConsent: ReapWrapperOptions["validateConsent"];
  private readonly nowFn: () => Date;
  private readonly transport: ReapTransport;
  private readonly store: JournalStore;
  private readonly state: JournalState;
  private tail: Promise<unknown> = Promise.resolve();
  private poisoned: WrapperError | null = null;
  private closed = false;
  private closing = false;

  constructor(options: ReapWrapperOptions, internal: InternalOptions) {
    if (typeof options !== "object" || options === null) {
      throw werr("VALIDATION_ERROR", "Wrapper options are required.");
    }
    this.mock = options.mode === "LOCAL_MOCK";
    if (options.mode !== undefined && options.mode !== "LOCAL_MOCK") {
      throw werr("VALIDATION_ERROR", "Unsupported wrapper mode.");
    }
    if (this.mock && options.fetch === undefined) {
      throw werr("VALIDATION_ERROR", "LOCAL_MOCK mode requires an injected fetch implementation.");
    }
    this.config = validateReapConfig(clone(options.config), options.mode);
    if (typeof options.journalPath !== "string" || options.journalPath.trim() === "") {
      throw werr("VALIDATION_ERROR", "journalPath is required.");
    }
    if (!Array.isArray(options.users)) {
      throw werr("VALIDATION_ERROR", "users must be an array of bindings.");
    }
    const users = new Map<string, UserBinding>();
    const seenReapUsers = new Set<string>();
    const seenAccounts = new Set<string>();
    const seenOwners = new Set<string>();
    for (const rawBinding of options.users) {
      if (typeof rawBinding !== "object" || rawBinding === null) {
        throw werr("VALIDATION_ERROR", "Each user binding must be an object.");
      }
      const binding = rawBinding as unknown as Record<string, unknown>;
      for (const field of ["userId", "reapUserId", "accountId", "enrollmentOwnerId"] as const) {
        if (typeof binding[field] !== "string" || (binding[field] as string).trim() === "") {
          throw werr("VALIDATION_ERROR", `Binding field ${field} must be a non-empty string.`);
        }
        if (!this.mock && (binding[field] as string).startsWith("mock_")) {
          throw werr("VALIDATION_ERROR", `Mock identifier ${field} cannot be used outside LOCAL_MOCK mode.`);
        }
      }
      const normalized: UserBinding = {
        userId: binding.userId as string,
        reapUserId: binding.reapUserId as string,
        accountId: binding.accountId as string,
        enrollmentOwnerId: binding.enrollmentOwnerId as string,
      };
      if (users.has(normalized.userId) || seenReapUsers.has(normalized.reapUserId) || seenAccounts.has(normalized.accountId) || seenOwners.has(normalized.enrollmentOwnerId)) {
        throw werr("VALIDATION_ERROR", "Duplicate user binding field.");
      }
      users.set(normalized.userId, normalized);
      seenReapUsers.add(normalized.reapUserId);
      seenAccounts.add(normalized.accountId);
      seenOwners.add(normalized.enrollmentOwnerId);
    }
    this.users = users;
    if (typeof options.validateReturnUrl !== "function") {
      throw werr("VALIDATION_ERROR", "validateReturnUrl callback is required.");
    }
    if (typeof options.validateConsent !== "function") {
      throw werr("VALIDATION_ERROR", "validateConsent callback is required.");
    }
    this.validateReturnUrl = options.validateReturnUrl;
    this.validateConsent = options.validateConsent;
    this.nowFn = typeof options.now === "function" ? options.now : () => new Date();
    this.mode = this.mock
      ? "LOCAL_MOCK"
      : this.config.environment === "PRODUCTION"
        ? "LIVE"
        : this.config.simulateCheckout
          ? "SANDBOX_SIMULATED"
          : "SANDBOX";
    const fetchImpl = options.fetch ?? globalThis.fetch;
    this.transport = new ReapTransport({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      reapVersion: this.config.reapVersion,
      fetchImpl,
      bypassThrottle: this.mock || internal.minIntervalMs === 0,
      ...(internal.minIntervalMs !== undefined ? { minIntervalMs: internal.minIntervalMs } : {}),
      ...(internal.timeoutMs !== undefined ? { timeoutMs: internal.timeoutMs } : {}),
    });
    const sortedUsers = [...users.values()].sort((a, b) => (a.userId < b.userId ? -1 : 1));
    const scope: JournalScope = {
      projectRef: this.config.projectRef,
      environment: this.config.environment,
      baseUrl: this.config.baseUrl,
      reapVersion: this.config.reapVersion,
      fundingModel: this.config.fundingModel,
      authorizationMode: this.config.authorizationMode,
      billingCurrency: this.config.billingCurrency,
      walletAssetId: this.config.walletAssetId,
      simulateCheckout: this.config.simulateCheckout,
      dataMode: this.mode,
      users: sortedUsers.map((user) => ({ ...user })),
    };
    this.store = internal.journal ?? new FileJournalStore(options.journalPath);
    this.store.acquire();
    try {
      const loaded = this.store.load();
      if (loaded === null) {
        this.state = emptyJournal(scope);
        this.persist();
      } else {
        if (canonicalJson(loaded.scope) !== canonicalJson(scope)) {
          throw werr("JOURNAL_SCOPE_MISMATCH", "Journal scope does not match the configured project, environment, mode, asset or user bindings.", {
            recovery: "MANUAL_RECONCILIATION",
          });
        }
        this.state = loaded;
      }
    } catch (error) {
      this.store.release();
      throw error;
    }
    try {
      this.convertPendingOperations();
    } catch (error) {
      this.store.release();
      throw error;
    }
  }

  private now(): string {
    return this.nowFn().toISOString();
  }

  private convertPendingOperations(): void {
    let changed = false;
    for (const operation of Object.values(this.state.operations)) {
      if (operation.state === "PENDING") {
        operation.state = "UNKNOWN";
        operation.error = {
          code: "OUTCOME_UNKNOWN",
          message: "Operation outcome is unknown after reopening the journal.",
          providerCode: null,
          operationId: operation.operationId,
          outcome: "UNKNOWN",
          recovery: "MANUAL_RECONCILIATION",
          retryAfterSeconds: null,
        };
        operation.updatedAt = this.now();
        changed = true;
      }
    }
    for (const debit of Object.values(this.state.debits)) {
      if (debit.state === PENDING_DEBIT) {
        debit.state = "UNKNOWN";
        changed = true;
      }
      for (const attempt of debit.attempts) {
        if (attempt.outcome === "PENDING") {
          attempt.outcome = "UNKNOWN";
          changed = true;
        }
      }
    }
    if (changed) {
      this.persist();
    }
  }

  private persist(): void {
    try {
      this.store.save(this.state);
    } catch {
      this.poisoned = {
        code: "JOURNAL_PERSISTENCE_FAILED",
        message: "Journal persistence failed; the instance is closed for further work.",
        providerCode: null,
        operationId: null,
        outcome: "UNKNOWN",
        recovery: "MANUAL_RECONCILIATION",
        retryAfterSeconds: null,
      };
      throw werr("JOURNAL_PERSISTENCE_FAILED", "Journal persistence failed.", {
        outcome: "UNKNOWN",
        recovery: "MANUAL_RECONCILIATION",
      });
    }
  }

  private requestId(): string {
    return `req_${randomUUID()}`;
  }

  private ok<T>(data: T, warnings: string[] = []): Result<T> {
    return { ok: true, data: clone(data), requestId: this.requestId(), mode: this.mode, warnings };
  }

  private bad(error: WrapperError): Result<never> {
    return { ok: false, error: clone(error), requestId: this.requestId(), mode: this.mode };
  }

  private enqueue<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.closing) return Promise.resolve(this.bad({ code: "WRAPPER_CLOSED", message: "Wrapper is closing.", providerCode: null, operationId: null, outcome: "NOT_SUBMITTED", recovery: "FIX_INPUT", retryAfterSeconds: null }));
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async guard<T>(fn: () => Promise<ImplOut<T>>): Promise<Result<T>> {
    if (this.closed) {
      return this.bad({
        code: "WRAPPER_CLOSED",
        message: "Wrapper is closed.",
        providerCode: null,
        operationId: null,
        outcome: "NOT_SUBMITTED",
        recovery: "FIX_INPUT",
        retryAfterSeconds: null,
      });
    }
    if (this.poisoned !== null) {
      return this.bad(this.poisoned);
    }
    try {
      const out = await fn();
      return this.ok(out.data, out.warnings);
    } catch (error) {
      if (error instanceof AliasResult) {
        return this.ok(error.out.data as T, error.out.warnings);
      }
      if (error instanceof Fail) {
        return this.bad(error.error);
      }
      if (error instanceof ProviderShapeError || error instanceof MoneyError) {
        return this.bad({
          code: "MALFORMED_RESPONSE",
          message: "Provider returned a malformed response.",
          providerCode: null,
          operationId: null,
          outcome: "REJECTED",
          recovery: "CONTACT_PROVIDER",
          retryAfterSeconds: null,
        });
      }
      return this.bad({
        code: "INTERNAL_ERROR",
        message: "Unexpected wrapper error.",
        providerCode: null,
        operationId: null,
        outcome: "UNKNOWN",
        recovery: "MANUAL_RECONCILIATION",
        retryAfterSeconds: null,
      });
    }
  }

  private async readRequest(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    try {
      return (await this.transport.request({ method: "GET", path, ...(query !== undefined ? { query } : {}) })).data;
    } catch (error) {
      throw this.classifyReadError(error);
    }
  }

  private async readRequestPost(path: string, body: unknown): Promise<unknown> {
    try {
      return (await this.transport.request({ method: "POST", path, body })).data;
    } catch (error) {
      throw this.classifyReadError(error);
    }
  }

  private classifyReadError(error: unknown): Fail {
    if (error instanceof Fail) {
      return error;
    }
    if (error instanceof ProviderHttpError) {
      if (error.status === 429) {
        return werr("RATE_LIMITED", "Provider rate limit reached.", {
          outcome: "NOT_SUBMITTED",
          recovery: "RETRY_SAME_OPERATION",
          providerCode: error.providerCode,
          retryAfterSeconds: error.retryAfterSeconds,
        });
      }
      if (error.status >= 400 && error.status < 500) {
        return werr("PROVIDER_REJECTED", "Provider rejected the request.", {
          outcome: "REJECTED",
          recovery: "FIX_INPUT",
          providerCode: error.providerCode,
          retryAfterSeconds: error.retryAfterSeconds,
        });
      }
      return werr("PROVIDER_UNAVAILABLE", "Provider request failed.", {
        outcome: "NOT_SUBMITTED",
        recovery: "RETRY_SAME_OPERATION",
        providerCode: error.providerCode,
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }
    if (error instanceof TransportFailure) {
      return werr(error.kind === "timeout" ? "TIMEOUT" : "TRANSPORT_ERROR", "Provider request failed.", {
        outcome: "NOT_SUBMITTED",
        recovery: "RETRY_SAME_OPERATION",
      });
    }
    if (error instanceof MalformedResponseError || error instanceof ProviderShapeError) {
      return werr("MALFORMED_RESPONSE", "Provider returned a malformed response.", {
        outcome: "REJECTED",
        recovery: "CONTACT_PROVIDER",
      });
    }
    return werr("INTERNAL_ERROR", "Unexpected wrapper error.", {
      outcome: "NOT_SUBMITTED",
      recovery: "MANUAL_RECONCILIATION",
    });
  }

  private classifyMutationError(error: unknown, operationId: string): Fail {
    if (error instanceof Fail) {
      error.error.operationId ??= operationId;
      return error;
    }
    if (error instanceof ProviderHttpError) {
      if (error.providerCode === "IDEMPOTENCY_REQUEST_IN_PROGRESS") {
        return werr("IDEMPOTENCY_REQUEST_IN_PROGRESS", "A request with this idempotency key is still in progress.", {
          outcome: "UNKNOWN",
          recovery: "POLL_RESOURCE",
          providerCode: error.providerCode,
          operationId,
          retryAfterSeconds: error.retryAfterSeconds,
        });
      }
      if (error.status === 429) {
        return werr("RATE_LIMITED", "Provider rate limit reached.", {
          outcome: "NOT_SUBMITTED",
          recovery: "RETRY_SAME_OPERATION",
          providerCode: error.providerCode,
          operationId,
          retryAfterSeconds: error.retryAfterSeconds,
        });
      }
      if (error.status === 401 || error.status === 422) {
        return werr("PROVIDER_REJECTED", "Provider rejected the request.", {
          outcome: "NOT_SUBMITTED",
          recovery: "FIX_INPUT",
          providerCode: error.providerCode,
          operationId,
        });
      }
      if (error.status === 408 || error.status === 409) {
        return werr("PROVIDER_UNAVAILABLE", "Provider request outcome is unknown after dispatch.", {
          outcome: "UNKNOWN",
          recovery: "MANUAL_RECONCILIATION",
          providerCode: error.providerCode,
          operationId,
          retryAfterSeconds: error.retryAfterSeconds,
        });
      }
      if (error.status >= 400 && error.status < 500) {
        return werr("PROVIDER_REJECTED", "Provider rejected the request.", {
          outcome: "REJECTED",
          recovery: "FIX_INPUT",
          providerCode: error.providerCode,
          operationId,
        });
      }
      return werr("PROVIDER_UNAVAILABLE", "Provider request failed after dispatch.", {
        outcome: "UNKNOWN",
        recovery: "MANUAL_RECONCILIATION",
        providerCode: error.providerCode,
        operationId,
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }
    if (error instanceof TransportFailure) {
      return werr(error.kind === "timeout" ? "TIMEOUT" : "TRANSPORT_ERROR", "Provider request failed after dispatch.", {
        outcome: "UNKNOWN",
        recovery: "MANUAL_RECONCILIATION",
        operationId,
      });
    }
    return werr("INTERNAL_ERROR", "Unexpected wrapper error.", {
      outcome: "UNKNOWN",
      recovery: "MANUAL_RECONCILIATION",
      operationId,
    });
  }

  private bindingFor(userId: unknown): UserBinding {
    const id = nonEmptyId(userId, "userId");
    const binding = this.users.get(id);
    if (binding === undefined) {
      throw werr("USER_NOT_FOUND", "No Reap binding exists for this user.");
    }
    return binding;
  }

  private async fetchAccount(binding: UserBinding): Promise<AccountState> {
    const data = asObject(await this.readRequest(providerPath("accounts", binding.accountId)));
    const id = reqString(data, "id");
    if (id !== binding.accountId) {
      throw werr("MALFORMED_RESPONSE", "Provider returned a mismatched account.", {
        outcome: "REJECTED",
        recovery: "CONTACT_PROVIDER",
      });
    }
    const ownerType = reqString(data, "ownerType");
    const ownerId = optString(data, "ownerId");
    if (ownerType !== "USER" || ownerId !== binding.reapUserId) {
      throw werr("OWNERSHIP_MISMATCH", "Configured account is not owned by the mapped Reap user.", {
        outcome: "REJECTED",
        recovery: "CONTACT_PROVIDER",
      });
    }
    const status = reqString(data, "status");
    return {
      status: status === "ACTIVE" || status === "RESTRICTED" ? status : "UNKNOWN",
      providerStatus: status,
    };
  }

  private amountField(data: Record<string, unknown>, key: string, currency: string): string {
    const token = reqRawAmount(data, key);
    const normalized = normalizeDecimalToken(token);
    return decimalToInteger(normalized, currencyExponent(currency)).toString();
  }

  private async fetchBalance(binding: UserBinding): Promise<BalanceState> {
    const data = asObject(await this.readRequest(providerPath("accounts", binding.accountId, "balance")));
    const currency = reqString(data, "currency");
    currencyExponent(currency);
    const totalAssetValue = { currency, minor: this.amountField(data, "totalAssetValue", currency) };
    const totalLiabilities = { currency, minor: this.amountField(data, "totalLiabilities", currency) };
    const availableBalanceMinor = this.amountField(data, "availableBalance", currency);
    return { currency, totalAssetValue, totalLiabilities, availableBalanceMinor };
  }

  private async fetchAssetItems(binding: UserBinding): Promise<Record<string, unknown>[]> {
    const data = asObject(await this.readRequest(providerPath("accounts", binding.accountId, "assets")));
    return reqArray(data, "items").map((item) => asObject(item, "items[]"));
  }

  private async fetchAssetDefinition(): Promise<Record<string, unknown> | null> {
    if (this.config.walletAssetId === null) {
      return null;
    }
    return asObject(await this.readRequest(providerPath("virtual-assets", this.config.walletAssetId)));
  }

  private noAsset(reason: string): AssetEligibility {
    return { virtualAssetId: "", units: "", withdrawableUnits: "", decimals: 0, currency: "", reason };
  }

  private computeEligibleAsset(
    balance: BalanceState,
    items: Record<string, unknown>[],
    definition: Record<string, unknown> | null,
  ): AssetEligibility {
    const configuredId = this.config.walletAssetId;
    if (configuredId === null) {
      return this.noAsset("No wallet asset configured.");
    }
    if (this.config.billingCurrency === null || balance.currency !== this.config.billingCurrency) {
      return this.noAsset("Billing currency does not match the balance currency.");
    }
    const item = items.find(
      (candidate) => optString(candidate, "type") === "VIRTUAL" && optString(candidate, "virtualAssetId") === configuredId,
    );
    if (item === undefined) {
      return this.noAsset("Configured virtual asset is not present on the account.");
    }
    const decimals = reqInt(item, "decimals");
    const exponent = currencyExponent(balance.currency);
    if (decimals !== exponent) {
      return this.noAsset("Virtual asset decimals do not match the billing currency exponent.");
    }
    const units = decimalUnitsString(item, "amount");
    const withdrawableUnits = decimalUnitsString(item, "withdrawable");
    const rateToken = reqRawAmount(item, "rate");
    if (!isExactRateOne(rateToken)) {
      return this.noAsset("Virtual asset item rate is not exactly 1.");
    }
    if (definition === null) {
      return this.noAsset("Virtual asset definition could not be read.");
    }
    if (reqString(definition, "id") !== configuredId) {
      return this.noAsset("Virtual asset definition id mismatch.");
    }
    if (reqString(definition, "status") !== "ACTIVE") {
      return this.noAsset("Virtual asset is not ACTIVE.");
    }
    if (reqString(definition, "rateSource") !== "FIXED") {
      return this.noAsset("Virtual asset rate source is not FIXED.");
    }
    const currentRateToken = definition.currentRate === undefined || definition.currentRate === null ? null : reqRawAmount(definition, "currentRate");
    if (currentRateToken === null || !isExactRateOne(currentRateToken)) {
      return this.noAsset("Virtual asset current rate is not exactly 1.");
    }
    return { virtualAssetId: configuredId, units, withdrawableUnits, decimals, currency: balance.currency, reason: null };
  }

  private fundingEligible(): boolean {
    return this.config.fundingModel === "PROGRAM_FUNDED" && this.config.authorizationMode === "MANAGED";
  }

  private walletSpendable(): boolean {
    return (
      this.config.fundingModel === "USER_FUNDED" ||
      (this.config.fundingModel === "PROGRAM_FUNDED" && this.config.authorizationMode === "MANAGED")
    );
  }

  private async implGetWallet(userId: unknown): Promise<ImplOut<WalletSnapshot>> {
    const binding = this.bindingFor(userId);
    const account = await this.fetchAccount(binding);
    const balance = await this.fetchBalance(binding);
    const items = await this.fetchAssetItems(binding);
    const definition = await this.fetchAssetDefinition();
    const eligible = this.computeEligibleAsset(balance, items, definition);
    const feature = this.config.features.virtualAssetDebit;
    let debitEligibility: FeatureEvidence;
    if (feature.state !== "VERIFIED") {
      debitEligibility = { ...feature };
    } else if (!this.fundingEligible()) {
      debitEligibility = {
        state: "DISABLED",
        reason: "Funding model is not PROGRAM_FUNDED with MANAGED authorization.",
        checkedAt: this.now(),
        evidenceRef: null,
      };
    } else if (account.status !== "ACTIVE") {
      debitEligibility = {
        state: "DISABLED",
        reason: "Provider account is not ACTIVE.",
        checkedAt: this.now(),
        evidenceRef: null,
      };
    } else if (eligible.reason === null) {
      debitEligibility = {
        state: "VERIFIED",
        reason: "Configured virtual asset is ACTIVE, FIXED and at exact rate 1 in the billing currency.",
        checkedAt: this.now(),
        evidenceRef: feature.evidenceRef,
      };
    } else {
      debitEligibility = {
        state: "DISABLED",
        reason: eligible.reason,
        checkedAt: this.now(),
        evidenceRef: null,
      };
    }
    const snapshot: WalletSnapshot = {
      userId: binding.userId,
      accountId: binding.accountId,
      accountStatus: account.status,
      providerAccountStatus: account.providerStatus,
      fundingModel: this.config.fundingModel,
      authorizationMode: this.config.authorizationMode,
      availableBalance: this.walletSpendable()
        ? { currency: balance.currency, minor: balance.availableBalanceMinor }
        : null,
      totalAssetValue: balance.totalAssetValue,
      totalLiabilities: balance.totalLiabilities,
      eligibleAsset:
        eligible.reason === null
          ? {
              virtualAssetId: eligible.virtualAssetId,
              units: eligible.units,
              withdrawableUnits: eligible.withdrawableUnits,
              decimals: eligible.decimals,
              rate: "1",
              currency: eligible.currency,
              enabled: true,
            }
          : null,
      debitEligibility,
      observedAt: this.now(),
    };
    return { data: snapshot, warnings: [] };
  }

  private featureGate(key: keyof Capabilities["features"], requireVerified: boolean): void {
    const evidence = this.config.features[key];
    if (evidence.state === "DISABLED") {
      throw werr("FEATURE_DISABLED", `Feature ${key} is disabled: ${evidence.reason}`, {
        recovery: "CONTACT_PROVIDER",
      });
    }
    if (requireVerified && evidence.state !== "VERIFIED") {
      throw werr("FEATURE_UNVERIFIED", `Feature ${key} is not verified for this configuration.`, {
        recovery: "CONTACT_PROVIDER",
      });
    }
  }

  private storeFor(storeId: string, requireVerified: boolean): Store {
    const store =
      this.config.stores.find((candidate) => candidate.storeId === storeId) ??
      own(this.state.discoveredStores, storeId);
    if (store === undefined) {
      throw werr("STORE_UNKNOWN", "Unknown store identifier.");
    }
    if (requireVerified && store.eligibility.state !== "VERIFIED") {
      throw werr("STORE_UNVERIFIED", "Store mapping is not verified for purchase.", {
        recovery: "CONTACT_PROVIDER",
      });
    }
    return store;
  }

  private mapMerchant(name: string, country: string, currency: string): { storeId: string | null; verified: boolean } {
    const matches = this.config.stores.filter((store) => store.providerMerchantName === name);
    if (matches.length > 1) {
      return { storeId: null, verified: false };
    }
    if (matches.length === 1) {
      const store = matches[0]!;
      if (store.country === country && store.currencies.includes(currency)) {
        return { storeId: store.storeId, verified: store.eligibility.state === "VERIFIED" };
      }
      return { storeId: null, verified: false };
    }
    if (country === "" || currency === "") {
      return { storeId: null, verified: false };
    }
    const storeId = `reap_merchant_${sha256Hex(canonicalJson([name, country, currency])).slice(0, 24)}`;
    if (own(this.state.discoveredStores, storeId) === undefined) {
      this.state.discoveredStores[storeId] = {
        storeId,
        providerMerchantName: name,
        country,
        currencies: [currency],
        eligibility: {
          state: "UNVERIFIED",
          reason: "Observed in Reap product search; purchase eligibility not verified.",
          checkedAt: this.now(),
          evidenceRef: null,
        },
      };
    }
    return { storeId, verified: false };
  }

  private queryHash(descriptor: Record<string, unknown>): string {
    return sha256Hex(canonicalJson(descriptor));
  }

  private resolveCursor(token: string, descriptor: Record<string, unknown>): string {
    const record = own(this.state.cursors, token);
    if (record === undefined) {
      throw werr("CURSOR_INVALID", "Unknown pagination cursor.");
    }
    if (record.queryHash !== this.queryHash(descriptor)) {
      throw werr("CURSOR_INVALID", "Pagination cursor is bound to a different query.");
    }
    return record.upstreamCursor;
  }

  private mintCursor(descriptor: Record<string, unknown>, upstreamCursor: string | null): string | null {
    if (upstreamCursor === null || upstreamCursor === "") {
      return null;
    }
    const token = `cur_${randomUUID()}`;
    this.state.cursors[token] = {
      queryHash: this.queryHash(descriptor),
      upstreamCursor,
      createdAt: this.now(),
    };
    return token;
  }

  private normalizeEnrollment(item: unknown, binding: UserBinding): Enrollment {
    const obj = asObject(item, "enrollment");
    const owner = asObject(obj.owner, "owner");
    const ownerType = reqString(owner, "type");
    const ownerId = reqString(owner, "id");
    if (ownerType !== "CLIENT_REFERENCE" || ownerId !== binding.enrollmentOwnerId) {
      throw werr("OWNERSHIP_MISMATCH", "Provider returned an enrollment owned by someone else.", {
        outcome: "REJECTED",
        recovery: "CONTACT_PROVIDER",
      });
    }
    const status = reqString(obj, "status");
    const paymentRaw = optObject(obj, "paymentMethod");
    let paymentMethod: Enrollment["paymentMethod"] = null;
    if (paymentRaw !== null) {
      paymentMethod = {
        network: optString(paymentRaw, "network"),
        last4: optString(paymentRaw, "last4"),
        expiryMonth: paymentRaw.expiryMonth === undefined || paymentRaw.expiryMonth === null ? null : reqInt(paymentRaw, "expiryMonth"),
        expiryYear: paymentRaw.expiryYear === undefined || paymentRaw.expiryYear === null ? null : reqInt(paymentRaw, "expiryYear"),
      };
    }
    return {
      enrollmentId: reqString(obj, "id"),
      userId: binding.userId,
      status:
        status === "REQUIRES_ACTION" || status === "ACTIVE" || status === "FAILED" || status === "EXPIRED" || status === "REVOKED"
          ? status
          : "UNKNOWN",
      providerStatus: status,
      paymentMethod,
      externalCardAvailableBalance: null,
      nextAction: hostedAction(obj.nextAction),
      observedAt: this.now(),
    };
  }

  private async implListCards(userId: unknown, page?: PageInput): Promise<ImplOut<Page<CardSummary>>> {
    const binding = this.bindingFor(userId);
    await this.fetchAccount(binding);
    const descriptor = { kind: "cards", userId: binding.userId };
    const query: Record<string, string | number | undefined> = { accountId: binding.accountId };
    if (page?.limit !== undefined) {
      query.limit = safeInteger(page.limit, "limit", 1, 100);
    }
    if (page?.cursor !== undefined) {
      query.cursor = this.resolveCursor(nonEmptyId(page.cursor, "cursor"), descriptor);
    }
    const data = asObject(await this.readRequest("/cards/", query));
    const items = reqArray(data, "items").map((raw) => {
      const item = asObject(raw, "items[]");
      const accountId = reqString(item, "accountId");
      if (accountId !== binding.accountId) {
        throw werr("MALFORMED_RESPONSE", "Provider returned a card outside the requested account.", {
          outcome: "REJECTED",
          recovery: "CONTACT_PROVIDER",
        });
      }
      const status = reqString(item, "status");
      const mapped: CardSummary = {
        cardId: reqString(item, "id"),
        accountId,
        status:
          status === "ACTIVE" || status === "FROZEN" || status === "BLOCKED" || status === "EXPIRED"
            ? status
            : "UNKNOWN",
        providerStatus: status,
        last4: reqString(item, "last4"),
      };
      return mapped;
    });
    const nextCursor = this.mintCursor(descriptor, optString(data, "nextCursor"));
    this.persist();
    return { data: { items, nextCursor }, warnings: [] };
  }

  private async implListEnrollments(userId: unknown, page?: PageInput): Promise<ImplOut<Page<Enrollment>>> {
    const binding = this.bindingFor(userId);
    const descriptor = { kind: "enrollments", userId: binding.userId };
    const query: Record<string, string | number | undefined> = {
      ownerType: "CLIENT_REFERENCE",
      ownerId: binding.enrollmentOwnerId,
    };
    if (page?.limit !== undefined) {
      query.limit = safeInteger(page.limit, "limit", 1, 100);
    }
    if (page?.cursor !== undefined) {
      query.cursor = this.resolveCursor(nonEmptyId(page.cursor, "cursor"), descriptor);
    }
    const data = asObject(await this.readRequest("/agentic/enrollments", query));
    const items = reqArray(data, "items").map((item) => this.normalizeEnrollment(item, binding));
    const nextCursor = this.mintCursor(descriptor, optString(data, "nextCursor"));
    this.persist();
    return { data: { items, nextCursor }, warnings: [] };
  }

  private async implGetEnrollment(userId: unknown, enrollmentId: unknown): Promise<ImplOut<Enrollment>> {
    const binding = this.bindingFor(userId);
    const id = nonEmptyId(enrollmentId, "enrollmentId");
    const data = await this.readRequest(providerPath("agentic", "enrollments", id));
    const enrollment = this.normalizeEnrollment(data, binding);
    if (enrollment.enrollmentId !== id) {
      throw werr("MALFORMED_RESPONSE", "Provider returned a mismatched enrollment.", {
        outcome: "REJECTED",
        recovery: "CONTACT_PROVIDER",
      });
    }
    this.state.enrollments[enrollment.enrollmentId] = {
      enrollmentId: enrollment.enrollmentId,
      userId: binding.userId,
      ownerId: binding.enrollmentOwnerId,
      status: enrollment.status,
      createdAt: this.now(),
    };
    this.persist();
    return { data: enrollment, warnings: [] };
  }

  private validateEmail(value: unknown): string {
    if (typeof value !== "string" || !EMAIL_PATTERN.test(value)) {
      throw werr("VALIDATION_ERROR", "email is not a valid email address.");
    }
    return value;
  }

  private async validateReturn(input: { userId: string; returnUrl: unknown; operationId: string; purchaseAttemptId?: string }): Promise<string> {
    if (typeof input.returnUrl !== "string" || !isLikelyAbsoluteHttps(input.returnUrl)) {
      throw werr("INVALID_URL", "returnUrl must be an https URL without credentials.");
    }
    const binding: { userId: string; operationId: string; purchaseAttemptId?: string } = {
      userId: input.userId,
      operationId: input.operationId,
    };
    if (input.purchaseAttemptId !== undefined) {
      binding.purchaseAttemptId = input.purchaseAttemptId;
    }
    const allowed = await this.validateReturnUrl(input.returnUrl, binding);
    if (allowed !== true) {
      throw werr("URL_REJECTED", "returnUrl was rejected by the application validator.");
    }
    return input.returnUrl;
  }

  private mutationContext(context: unknown): MutationContext {
    if (typeof context !== "object" || context === null) {
      throw werr("VALIDATION_ERROR", "Mutation context is required.");
    }
    const ctx = context as Record<string, unknown>;
    return {
      operationId: nonEmptyId(ctx.operationId, "context.operationId"),
      idempotencyKey: nonEmptyId(ctx.idempotencyKey, "context.idempotencyKey"),
    };
  }

  private replayOutcome<T>(record: OperationRecord): ImplOut<T> {
    if (record.state === "SUCCEEDED") {
      return { data: clone(record.result) as T, warnings: [] };
    }
    if (record.state === "REJECTED" && record.error !== null) {
      throw new Fail(clone(record.error));
    }
    const error: WrapperError = record.error !== null ? clone(record.error) : {
      code: "OUTCOME_UNKNOWN",
      message: "Operation outcome is unknown.",
      providerCode: null,
      operationId: record.operationId,
      outcome: "UNKNOWN",
      recovery: "MANUAL_RECONCILIATION",
      retryAfterSeconds: null,
    };
    error.outcome = "UNKNOWN";
    error.recovery = "MANUAL_RECONCILIATION";
    error.operationId ??= record.operationId;
    throw new Fail(error);
  }

  private checkOperationReuse(ctx: MutationContext, method: string, requestHash: string): OperationRecord | null {
    const existing = own(this.state.operations, ctx.operationId);
    if (existing !== undefined) {
      if (existing.method !== method || existing.requestHash !== requestHash || existing.idempotencyKey !== ctx.idempotencyKey) {
        throw werr("OPERATION_CONFLICT", "operationId was already used with a different command.", {
          outcome: "NOT_SUBMITTED",
          recovery: "FIX_INPUT",
        });
      }
      return existing;
    }
    const keyRecord = own(this.state.idempotencyKeys, ctx.idempotencyKey);
    if (keyRecord !== undefined && keyRecord.operationId !== ctx.operationId) {
      throw werr("IDEMPOTENCY_CONFLICT", "idempotencyKey was already used for a different operation.", {
        outcome: "NOT_SUBMITTED",
        recovery: "FIX_INPUT",
      });
    }
    return null;
  }

  private aliasResult<T>(spec: {
    ctx: MutationContext;
    method: string;
    resourceType: OperationRecord["resourceType"];
    input: unknown;
    resourceId: string;
    data: T;
  }): never {
    const operation: OperationRecord = {
      operationId: spec.ctx.operationId,
      method: spec.method,
      requestHash: sha256Hex(canonicalJson({ method: spec.method, input: spec.input })),
      idempotencyKey: spec.ctx.idempotencyKey,
      resourceType: spec.resourceType,
      resourceId: spec.resourceId,
      state: "SUCCEEDED",
      error: null,
      requestBody: null,
      result: spec.data,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.state.operations[spec.ctx.operationId] = operation;
    this.state.idempotencyKeys[spec.ctx.idempotencyKey] = {
      operationId: spec.ctx.operationId,
      method: spec.method,
    };
    this.persist();
    throw new AliasResult({ data: spec.data, warnings: [] });
  }

  private async dispatch<T>(spec: DispatchSpec<T>): Promise<ImplOut<T>> {
    const requestHash = sha256Hex(canonicalJson({ method: spec.method, input: spec.input }));
    const existing = this.checkOperationReuse(spec.ctx, spec.method, requestHash);
    if (existing !== null) {
      return this.replayOutcome<T>(existing);
    }
    const prepared = await spec.prepare();
    const operation: OperationRecord = {
      operationId: spec.ctx.operationId,
      method: spec.method,
      requestHash,
      idempotencyKey: spec.ctx.idempotencyKey,
      resourceType: spec.resourceType,
      resourceId: null,
      state: "PENDING",
      error: null,
      requestBody: prepared.requestBody,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.state.operations[spec.ctx.operationId] = operation;
    this.state.idempotencyKeys[spec.ctx.idempotencyKey] = {
      operationId: spec.ctx.operationId,
      method: spec.method,
    };
    try {
      prepared.apply?.();
    } catch (error) {
      delete this.state.operations[spec.ctx.operationId];
      delete this.state.idempotencyKeys[spec.ctx.idempotencyKey];
      throw error;
    }
    this.persist();
    if (spec.noDispatch === true) {
      const out = prepared.interpret(undefined);
      operation.state = "SUCCEEDED";
      operation.resourceId = out.resourceId;
      operation.result = out.data;
      operation.updatedAt = this.now();
      out.applyResult?.();
      this.persist();
      return { data: out.data, warnings: out.warnings ?? [] };
    }
    let response: unknown;
    try {
      response = (await this.transport.request({
        method: "POST",
        path: spec.path,
        body: prepared.requestBody,
        idempotencyKey: spec.ctx.idempotencyKey,
        ...(spec.simulateCheckout === true ? { simulateCheckout: true } : {}),
      })).data;
    } catch (error) {
      const failure = this.classifyMutationError(error, spec.ctx.operationId);
      operation.state = failure.error.outcome === "UNKNOWN" ? "UNKNOWN" : "REJECTED";
      operation.error = clone(failure.error);
      operation.updatedAt = this.now();
      try {
        if (spec.resourceType === "WALLET_DEBIT") {
          for (const debit of Object.values(this.state.debits)) {
            const attempt = debit.attempts.find(item => item.operationId === spec.ctx.operationId);
            if (attempt) {
              debit.state = operation.state;
              attempt.outcome = debit.state;
              debit.observedAt = this.now();
              operation.resourceId = debit.debitId;
            }
          }
        }
        spec.onFailure?.(failure);
      } finally {
        this.persist();
      }
      throw failure;
    }
    try {
      const out = prepared.interpret(response);
      operation.state = "SUCCEEDED";
      operation.resourceId = out.resourceId;
      operation.result = out.data;
      operation.updatedAt = this.now();
      out.applyResult?.();
      this.persist();
      return { data: out.data, warnings: out.warnings ?? [] };
    } catch (error) {
      const failure = error instanceof Fail
        ? error
        : werr("MALFORMED_RESPONSE", "Provider returned an unusable mutation response.", {
            outcome: "UNKNOWN",
            recovery: "MANUAL_RECONCILIATION",
            operationId: spec.ctx.operationId,
          });
      if (failure.error.outcome !== "UNKNOWN") {
        failure.error.outcome = "UNKNOWN";
        failure.error.recovery = "MANUAL_RECONCILIATION";
      }
      failure.error.operationId ??= spec.ctx.operationId;
      operation.state = "UNKNOWN";
      operation.error = clone(failure.error);
      operation.updatedAt = this.now();
      try {
        if (spec.resourceType === "WALLET_DEBIT") {
          for (const debit of Object.values(this.state.debits)) {
            const attempt = debit.attempts.find(item => item.operationId === spec.ctx.operationId);
            if (attempt) {
              debit.state = "UNKNOWN";
              attempt.outcome = debit.state;
              debit.observedAt = this.now();
              operation.resourceId = debit.debitId;
            }
          }
        }
        spec.onFailure?.(failure);
      } finally {
        this.persist();
      }
      throw failure;
    }
  }

  private async implCreateEnrollment(input: unknown, context: unknown): Promise<ImplOut<Enrollment>> {
    const ctx = this.mutationContext(context);
    const obj = callerObject(input, "input");
    const userId = nonEmptyId(obj.userId, "userId");
    const binding = this.bindingFor(userId);
    const email = this.validateEmail(obj.email);
    const returnUrl = obj.returnUrl;
    return this.dispatch<Enrollment>({
      ctx,
      method: "createEnrollment",
      resourceType: "ENROLLMENT",
      path: "/agentic/enrollments",
      input: { userId, email, returnUrl },
      prepare: async () => {
        this.featureGate("externalEnrollment", true);
        const url = await this.validateReturn({ userId, returnUrl, operationId: ctx.operationId });
        const requestBody = {
          source: "EXTERNAL",
          owner: { type: "CLIENT_REFERENCE", id: binding.enrollmentOwnerId, email },
          presentation: { type: "REDIRECT", returnUrl: url },
        };
        return {
          requestBody,
          interpret: (data) => {
            const enrollment = this.normalizeEnrollment(data, binding);
            return {
              data: enrollment,
              resourceId: enrollment.enrollmentId,
              applyResult: () => {
                this.state.enrollments[enrollment.enrollmentId] = {
                  enrollmentId: enrollment.enrollmentId,
                  userId: binding.userId,
                  ownerId: binding.enrollmentOwnerId,
                  status: enrollment.status,
                  createdAt: this.now(),
                };
              },
            };
          },
        };
      },
    });
  }

  private async implRevokeEnrollment(userId: unknown, enrollmentId: unknown, context: unknown): Promise<ImplOut<Enrollment>> {
    const ctx = this.mutationContext(context);
    const binding = this.bindingFor(userId);
    const id = nonEmptyId(enrollmentId, "enrollmentId");
    return this.dispatch<Enrollment>({
      ctx,
      method: "revokeEnrollment",
      resourceType: "ENROLLMENT",
      path: providerPath("agentic", "enrollments", id, "revoke"),
      input: { userId, enrollmentId: id },
      prepare: async () => {
        await this.implGetEnrollment(userId, id);
        return {
          requestBody: {},
          interpret: (data) => {
            const enrollment = this.normalizeEnrollment(data, binding);
            return {
              data: enrollment,
              resourceId: enrollment.enrollmentId,
              applyResult: () => {
                this.state.enrollments[enrollment.enrollmentId] = {
                  enrollmentId: enrollment.enrollmentId,
                  userId: binding.userId,
                  ownerId: binding.enrollmentOwnerId,
                  status: enrollment.status,
                  createdAt: this.now(),
                };
              },
            };
          },
        };
      },
    });
  }

  private normalizeSearchResponse(data: unknown): { products: Record<string, unknown>[]; nextUpstreamCursor: string | null } {
    const obj = asObject(data, "search");
    const products = reqArray(obj, "products").map((item) => asObject(item, "products[]"));
    const pagination = asObject(obj.pagination, "pagination");
    return { products, nextUpstreamCursor: optString(pagination, "nextCursor") };
  }

  private normalizeProductSummary(
    item: Record<string, unknown>,
    country: string,
    currency: string,
    warnings: string[],
  ): ProductSummary | null {
    let productId: string;
    let merchantName: string;
    let name: string;
    try {
      productId = reqString(item, "id");
      const merchant = asObject(item.merchant, "merchant");
      merchantName = reqString(merchant, "name");
      name = reqString(item, "name");
    } catch {
      warnings.push("DROPPED_MALFORMED_PRODUCT");
      return null;
    }
    const mapping = this.mapMerchant(merchantName, country, currency);
    let priceRange: ProductSummary["priceRange"] = null;
    try {
      const range = optObject(item, "priceRange");
      if (range !== null) {
        const min = moneyField(range.min, "priceRange.min");
        const max = moneyField(range.max, "priceRange.max");
        if (min.currency === currency && max.currency === currency) {
          priceRange = { min, max };
        } else {
          warnings.push("PRODUCT_CURRENCY_MISMATCH");
        }
      }
    } catch {
      warnings.push("PRODUCT_PRICE_UNREADABLE");
    }
    let previewVariant: ProductSummary["previewVariant"] = null;
    try {
      const preview = optObject(item, "previewVariant");
      if (preview !== null) {
        const price = moneyField(preview.price, "previewVariant.price");
        if (price.currency === currency) {
          previewVariant = {
            variantId: reqString(preview, "id"),
            name: optString(preview, "name"),
            price,
            available: optBool(preview, "available"),
          };
        } else {
          warnings.push("PRODUCT_CURRENCY_MISMATCH");
        }
      }
    } catch {
      warnings.push("PRODUCT_VARIANT_UNREADABLE");
    }
    const existing = own(this.state.products, productId);
    if (existing !== undefined && existing.merchantName !== merchantName) {
      throw werr("MALFORMED_RESPONSE", "Provider changed the merchant for a known product.", {
        outcome: "REJECTED",
        recovery: "CONTACT_PROVIDER",
      });
    }
    this.state.products[productId] = {
      productId,
      merchantName,
      storeId: mapping.storeId,
      country,
      currency,
      observedAt: this.now(),
    };
    if (previewVariant !== null) {
      this.state.variants[previewVariant.variantId] = {
        variantId: previewVariant.variantId,
        productId,
        storeId: mapping.storeId,
        currency,
        observedAt: this.now(),
      };
    }
    return {
      productId,
      storeId: mapping.storeId,
      providerMerchantName: merchantName,
      name,
      imageUrl: optString(item, "imageUrl"),
      available: optBool(item, "available"),
      priceRange,
      previewVariant,
    };
  }

  private validateSearchInput(input: unknown): {
    query: string;
    country: string;
    currency: string;
    page?: PageInput;
    storeId?: string;
    minPrice?: Money;
    maxPrice?: Money;
    availableOnly?: boolean;
  } {
    const obj = callerObject(input, "input");
    const query = nonEmptyId(obj.query, "query");
    const country = nonEmptyId(obj.country, "country");
    const currency = inputCurrency(obj.currency, "currency");
    const out: ReturnType<ReapService["validateSearchInput"]> = { query, country, currency };
    if (obj.page !== undefined) {
      out.page = obj.page as PageInput;
    }
    if (obj.storeId !== undefined && obj.storeId !== null) {
      out.storeId = nonEmptyId(obj.storeId, "storeId");
    }
    if (obj.minPrice !== undefined) {
      const minPrice = moneyInput(obj.minPrice, "minPrice");
      if (minPrice.currency !== currency) {
        throw werr("VALIDATION_ERROR", "minPrice.currency must match the search currency.");
      }
      out.minPrice = minPrice;
    }
    if (obj.maxPrice !== undefined) {
      const maxPrice = moneyInput(obj.maxPrice, "maxPrice");
      if (maxPrice.currency !== currency) {
        throw werr("VALIDATION_ERROR", "maxPrice.currency must match the search currency.");
      }
      out.maxPrice = maxPrice;
    }
    if (out.minPrice !== undefined && out.maxPrice !== undefined && BigInt(out.minPrice.minor) > BigInt(out.maxPrice.minor)) {
      throw werr("VALIDATION_ERROR", "minPrice must not exceed maxPrice.");
    }
    if (obj.availableOnly === true) {
      out.availableOnly = true;
    }
    return out;
  }

  private searchBody(input: {
    query: string;
    country: string;
    currency: string;
    store?: Store;
    minPrice?: Money;
    maxPrice?: Money;
    availableOnly?: boolean;
    limit: number;
    upstreamCursor?: string;
  }): Record<string, unknown> {
    const body: Record<string, unknown> = {
      query: input.query,
      context: { country: input.country, currency: input.currency },
      pagination: { limit: input.limit, ...(input.upstreamCursor !== undefined ? { cursor: input.upstreamCursor } : {}) },
    };
    if (input.store !== undefined) {
      body.merchantPreference = { mode: "ONLY", merchantName: input.store.providerMerchantName };
    }
    const filters: Record<string, unknown> = {};
    if (input.minPrice !== undefined || input.maxPrice !== undefined) {
      const price: Record<string, unknown> = {};
      if (input.minPrice !== undefined) {
        price.min = minorToUnits(input.minPrice.minor, input.currency);
      }
      if (input.maxPrice !== undefined) {
        price.max = minorToUnits(input.maxPrice.minor, input.currency);
      }
      filters.price = price;
    }
    if (input.availableOnly === true) {
      filters.availability = "AVAILABLE_ONLY";
    }
    if (Object.keys(filters).length > 0) {
      body.filters = filters;
    }
    return body;
  }

  private async implDiscoverMerchants(input: unknown): Promise<ImplOut<MerchantDiscovery>> {
    this.featureGate("productSearch", false);
    const context = this.validateSearchInput(input);
    const descriptor = { kind: "merchants", query: context.query, country: context.country, currency: context.currency };
    const limit = context.page?.limit !== undefined ? safeInteger(context.page.limit, "page.limit", 1, 50) : SEARCH_DEFAULT_LIMIT;
    let upstreamCursor: string | undefined;
    if (context.page?.cursor !== undefined) {
      upstreamCursor = this.resolveCursor(nonEmptyId(context.page.cursor, "page.cursor"), descriptor);
    }
    const body = this.searchBody({
      query: context.query,
      country: context.country,
      currency: context.currency,
      limit,
      ...(upstreamCursor !== undefined ? { upstreamCursor } : {}),
    });
    const response = await this.readRequestPost("/agentic/products/search", body);
    const parsed = this.normalizeSearchResponse(response);
    const warnings: string[] = ["DISCOVERY_PARTIAL_COVERAGE"];
    const byMerchant = new Map<string, { storeId: string | null; verified: boolean; productIds: string[] }>();
    for (const item of parsed.products) {
      const summary = this.normalizeProductSummary(item, context.country, context.currency, warnings);
      if (summary === null) {
        continue;
      }
      const entry = byMerchant.get(summary.providerMerchantName) ?? {
        storeId: summary.storeId,
        verified: this.mapMerchant(summary.providerMerchantName, context.country, context.currency).verified,
        productIds: [],
      };
      entry.productIds.push(summary.productId);
      byMerchant.set(summary.providerMerchantName, entry);
    }
    const nextCursor = this.mintCursor(descriptor, parsed.nextUpstreamCursor);
    this.persist();
    return {
      data: {
        items: [...byMerchant.entries()].map(([providerMerchantName, entry]) => ({
          storeId: entry.storeId,
          providerMerchantName,
          evidenceProductIds: entry.productIds,
          storeMappingVerified: entry.verified,
        })),
        nextCursor,
        source: "PRODUCT_SEARCH",
        coverage: "PARTIAL",
      },
      warnings: [...new Set(warnings)],
    };
  }

  private async implSearchProducts(input: unknown): Promise<ImplOut<Page<ProductSummary>>> {
    this.featureGate("productSearch", false);
    const context = this.validateSearchInput(input);
    let store: Store | undefined;
    if (context.storeId !== undefined) {
      const candidate = this.storeFor(context.storeId, false);
      if (candidate.country !== context.country || !candidate.currencies.includes(context.currency)) {
        throw werr("STORE_CONTEXT_MISMATCH", "Store is not configured for this country and currency.");
      }
      store = candidate;
    }
    const descriptor = {
      kind: "search",
      query: context.query,
      country: context.country,
      currency: context.currency,
      storeId: store?.storeId ?? null,
      minPrice: context.minPrice ?? null,
      maxPrice: context.maxPrice ?? null,
      availableOnly: context.availableOnly === true,
    };
    const limit = context.page?.limit !== undefined ? safeInteger(context.page.limit, "page.limit", 1, 50) : SEARCH_DEFAULT_LIMIT;
    let upstreamCursor: string | undefined;
    if (context.page?.cursor !== undefined) {
      upstreamCursor = this.resolveCursor(nonEmptyId(context.page.cursor, "page.cursor"), descriptor);
    }
    const body = this.searchBody({
      query: context.query,
      country: context.country,
      currency: context.currency,
      ...(store !== undefined ? { store } : {}),
      ...(context.minPrice !== undefined ? { minPrice: context.minPrice } : {}),
      ...(context.maxPrice !== undefined ? { maxPrice: context.maxPrice } : {}),
      availableOnly: context.availableOnly === true,
      limit,
      ...(upstreamCursor !== undefined ? { upstreamCursor } : {}),
    });
    const response = await this.readRequestPost("/agentic/products/search", body);
    const parsed = this.normalizeSearchResponse(response);
    const warnings: string[] = ["RESULTS_NOT_A_GUARANTEED_QUOTE"];
    const items: ProductSummary[] = [];
    for (const item of parsed.products) {
      const summary = this.normalizeProductSummary(item, context.country, context.currency, warnings);
      if (summary !== null) {
        items.push(summary);
      }
    }
    const nextCursor = this.mintCursor(descriptor, parsed.nextUpstreamCursor);
    this.persist();
    return { data: { items, nextCursor }, warnings: [...new Set(warnings)] };
  }

  private async implGetProductDetails(productIds: unknown): Promise<ImplOut<ProductDetailsResult>> {
    if (!Array.isArray(productIds)) {
      throw werr("VALIDATION_ERROR", "productIds must be an array.");
    }
    const ids = productIds.map((id) => nonEmptyId(id, "productIds[]"));
    if (ids.length < 1 || ids.length > MAX_DETAILS_BATCH || new Set(ids).size !== ids.length) {
      throw werr("VALIDATION_ERROR", `productIds must contain 1..${MAX_DETAILS_BATCH} unique ids.`);
    }
    const response = await this.readRequestPost("/agentic/products/details", { productIds: ids });
    const obj = asObject(response, "details");
    const productsRaw = reqArray(obj, "products").map((item) => asObject(item, "products[]"));
    const errorsRaw = reqArray(obj, "errors").map((item) => asObject(item, "errors[]"));
    const warnings: string[] = [];
    const requested = new Set(ids);
    const products: ProductDetailsResult["products"] = [];
    const returned = new Set<string>();
    for (const product of productsRaw) {
      const productId = reqString(product, "id");
      if (!requested.has(productId) || returned.has(productId)) {
        throw werr("MALFORMED_RESPONSE", "Provider returned an unrequested product id.", {
          outcome: "REJECTED",
          recovery: "CONTACT_PROVIDER",
        });
      }
      returned.add(productId);
      const merchant = asObject(product.merchant, "merchant");
      const merchantName = reqString(merchant, "name");
      const options = reqArray(product, "options").map((rawOption) => {
        const option = asObject(rawOption, "options[]");
        return {
          name: reqString(option, "name"),
          values: reqArray(option, "values").map((rawValue) => {
            const value = asObject(rawValue, "values[]");
            return {
              optionId: reqString(value, "optionId"),
              label: reqString(value, "label"),
              available: optBool(value, "available"),
            };
          }),
        };
      });
      const media = (optArray(product, "media") ?? []).map((rawMedia) => {
        const item = asObject(rawMedia, "media[]");
        return { url: reqString(item, "url"), type: optString(item, "type"), altText: optString(item, "altText") };
      });
      const existing = own(this.state.products, productId);
      if (existing !== undefined && existing.merchantName !== merchantName) {
        throw werr("MALFORMED_RESPONSE", "Provider changed the merchant for a known product.", {
          outcome: "REJECTED",
          recovery: "CONTACT_PROVIDER",
        });
      }
      const mapping = this.mapMerchant(merchantName, existing?.country ?? "", existing?.currency ?? "");
      const provenanceStoreId = existing !== undefined ? existing.storeId : mapping.storeId;
      let defaultVariant: Variant | null = null;
      const variantRaw = optObject(product, "defaultVariant");
      if (variantRaw !== null) {
        const price = moneyField(variantRaw.price, "defaultVariant.price");
        if (existing !== undefined && existing.currency !== null && price.currency !== existing.currency) {
          throw werr("MALFORMED_RESPONSE", "Provider returned a variant in a different currency.", {
            outcome: "REJECTED",
            recovery: "CONTACT_PROVIDER",
          });
        }
        const variantId = reqString(variantRaw, "id");
        defaultVariant = {
          variantId,
          productId,
          name: optString(variantRaw, "name"),
          options: (optArray(variantRaw, "options") ?? []).map((rawOption) => {
            const option = asObject(rawOption, "options[]");
            return { name: reqString(option, "name"), value: reqString(option, "value") };
          }),
          catalogPrice: price,
          available: optBool(variantRaw, "available"),
          requiresShipping: optBool(variantRaw, "requiresShipping"),
          observedAt: this.now(),
        };
        this.state.variants[variantId] = {
          variantId,
          productId,
          storeId: provenanceStoreId,
          currency: price.currency,
          observedAt: this.now(),
        };
      }
      if (this.state.products[productId] === undefined) {
        this.state.products[productId] = {
          productId,
          merchantName,
          storeId: provenanceStoreId,
          country: existing?.country ?? null,
          currency: existing?.currency ?? defaultVariant?.catalogPrice.currency ?? null,
          observedAt: this.now(),
        };
      }
      products.push({
        productId,
        name: reqString(product, "name"),
        description: optString(product, "description"),
        options,
        media,
        defaultVariant,
      });
    }
    const errors: ProductDetailsResult["errors"] = [];
    const errored = new Set<string>();
    for (const rawError of errorsRaw) {
      const productId = reqString(rawError, "productId");
      if (!requested.has(productId) || returned.has(productId) || errored.has(productId)) {
        throw werr("MALFORMED_RESPONSE", "Provider returned a conflicting product entry.", {
          outcome: "REJECTED",
          recovery: "CONTACT_PROVIDER",
        });
      }
      errored.add(productId);
      errors.push({
        productId,
        code: sanitizeProviderCode(rawError.code) ?? "PROVIDER_ERROR",
        message: "Provider reported a product error.",
      });
    }
    for (const id of ids) {
      if (!returned.has(id) && !errored.has(id)) {
        errors.push({ productId: id, code: "MISSING_PRODUCT", message: "Product was not returned by the provider." });
        warnings.push("PARTIAL_PRODUCT_DETAILS");
      }
    }
    if (errored.size > 0) {
      warnings.push("PARTIAL_PRODUCT_DETAILS");
    }
    this.persist();
    return { data: { products, errors }, warnings: [...new Set(warnings)] };
  }

  private async implResolveVariant(productId: unknown, optionIds: unknown): Promise<ImplOut<Variant>> {
    const id = nonEmptyId(productId, "productId");
    if (!Array.isArray(optionIds) || optionIds.length === 0) {
      throw werr("VALIDATION_ERROR", "optionIds must be a non-empty array.");
    }
    const options = optionIds.map((optionId) => nonEmptyId(optionId, "optionIds[]"));
    const product = own(this.state.products, id);
    if (product === undefined) {
      throw werr("UNKNOWN_PRODUCT", "Product is not in the persisted catalog provenance.");
    }
    const response = await this.readRequestPost("/agentic/products/variant", { productId: id, optionIds: options });
    const obj = asObject(response, "variant");
    const price = moneyField(obj.price, "price");
    if (product.currency !== null && price.currency !== product.currency) {
      throw werr("MALFORMED_RESPONSE", "Provider returned a variant in a different currency.", {
        outcome: "REJECTED",
        recovery: "CONTACT_PROVIDER",
      });
    }
    const variantId = reqString(obj, "id");
    const variant: Variant = {
      variantId,
      productId: id,
      name: optString(obj, "name"),
      options: (optArray(obj, "options") ?? []).map((rawOption) => {
        const option = asObject(rawOption, "options[]");
        return { name: reqString(option, "name"), value: reqString(option, "value") };
      }),
      catalogPrice: price,
      available: optBool(obj, "available"),
      requiresShipping: optBool(obj, "requiresShipping"),
      observedAt: this.now(),
    };
    this.state.variants[variantId] = {
      variantId,
      productId: id,
      storeId: product.storeId,
      currency: price.currency,
      observedAt: this.now(),
    };
    this.persist();
    return { data: variant, warnings: variant.available === null ? ["AVAILABILITY_UNKNOWN"] : [] };
  }

  private validateAddress(value: unknown): ShippingAddress {
    const address = callerObject(value, "shippingAddress");
    const firstName = nonEmptyId(address.firstName, "shippingAddress.firstName");
    const lastName = nonEmptyId(address.lastName, "shippingAddress.lastName");
    const phone = nonEmptyId(address.phone, "shippingAddress.phone");
    if (!E164_PATTERN.test(phone)) {
      throw werr("VALIDATION_ERROR", "shippingAddress.phone must be E.164.");
    }
    const addressLine1 = nonEmptyId(address.addressLine1, "shippingAddress.addressLine1");
    const city = nonEmptyId(address.city, "shippingAddress.city");
    const country = nonEmptyId(address.country, "shippingAddress.country");
    const optional = (key: string): string | undefined => {
      const field = address[key];
      if (field === undefined) {
        return undefined;
      }
      return nonEmptyId(field, `shippingAddress.${key}`);
    };
    const out: ShippingAddress = { firstName, lastName, phone, addressLine1, city, country };
    const addressLine2 = optional("addressLine2");
    if (addressLine2 !== undefined) {
      out.addressLine2 = addressLine2;
    }
    const region = optional("region");
    if (region !== undefined) {
      out.region = region;
    }
    const postalCode = optional("postalCode");
    if (postalCode !== undefined) {
      out.postalCode = postalCode;
    }
    return out;
  }

  private consolidateLines(value: unknown): BasketLine[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw werr("VALIDATION_ERROR", "lines must be a non-empty array.");
    }
    const consolidated = new Map<string, number>();
    for (const rawLine of value) {
      const line = callerObject(rawLine, "lines[]");
      const variantId = nonEmptyId(line.variantId, "lines[].variantId");
      const quantity = safeInteger(line.quantity, "lines[].quantity", 1, MAX_QUANTITY);
      const merged = (consolidated.get(variantId) ?? 0) + quantity;
      if (!Number.isSafeInteger(merged)) {
        throw werr("VALIDATION_ERROR", "Consolidated quantity overflows a safe integer.");
      }
      consolidated.set(variantId, merged);
    }
    if (consolidated.size > MAX_QUOTE_LINES) {
      throw werr("TOO_MANY_LINES", `Baskets consolidate to at most ${MAX_QUOTE_LINES} distinct variants.`);
    }
    return [...consolidated.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
  }

  private quoteError(message: string): Fail {
    return werr("QUOTE_INCONSISTENT", message, {
      outcome: "UNKNOWN",
      recovery: "MANUAL_RECONCILIATION",
    });
  }

  private normalizeQuoteResponse(data: unknown, expectedCurrency: string): { quoteId: string; terms: QuoteTerms } {
    const obj = asObject(data, "quote");
    const quoteId = reqString(obj, "id");
    const expiresAt = reqString(obj, "expiresAt");
    if (!Number.isFinite(Date.parse(expiresAt))) {
      throw this.quoteError("Quote expiry is not a valid timestamp.");
    }
    const shippingIds = new Set<string>();
    let selectedCount = 0;
    const shippingOptions = reqArray(obj, "shippingOptions").map((rawOption) => {
      const option = asObject(rawOption, "shippingOptions[]");
      const price = moneyField(option.price, "shippingOption.price");
      if (price.currency !== expectedCurrency) {
        throw this.quoteError("Quote mixes currencies.");
      }
      const optionId = reqString(option, "id");
      const selected = reqBool(option, "selected");
      if (shippingIds.has(optionId)) {
        throw this.quoteError("Quote contains duplicate shipping option ids.");
      }
      shippingIds.add(optionId);
      if (selected) {
        selectedCount += 1;
      }
      return {
        id: optionId,
        name: reqString(option, "name"),
        selected,
        price,
        details: (optArray(option, "details") ?? []).map((rawDetail) => {
          const detail = asObject(rawDetail, "details[]");
          return { key: reqString(detail, "key"), value: reqString(detail, "value") };
        }),
      };
    });
    if (selectedCount > 1) {
      throw this.quoteError("Quote has more than one selected shipping option.");
    }
    const breakdown = asObject(obj.amountBreakdown, "amountBreakdown");
    const itemsSubtotal = moneyField(breakdown.itemsSubtotal, "itemsSubtotal");
    const shipping = optMoneyField(breakdown.shipping, "shipping");
    const taxRaw = optObject(breakdown, "tax");
    let tax: { amount: Money; includedInPrices: boolean } | null = null;
    if (taxRaw !== null) {
      const included = taxRaw.includedInPrices;
      if (typeof included !== "boolean") {
        throw this.quoteError("Quote tax is missing an explicit includedInPrices flag.");
      }
      tax = { amount: moneyField(taxRaw.amount, "tax.amount"), includedInPrices: included };
    }
    const discounts = (optArray(breakdown, "discounts") ?? []).map((rawDiscount) => {
      const discount = asObject(rawDiscount, "discounts[]");
      return { name: reqString(discount, "name"), amount: moneyField(discount.amount, "discounts[].amount") };
    });
    const additionalCharges = (optArray(breakdown, "additionalCharges") ?? []).map((rawCharge) => {
      const charge = asObject(rawCharge, "additionalCharges[]");
      return { name: reqString(charge, "name"), amount: moneyField(charge.amount, "additionalCharges[].amount") };
    });
    const finalAmount = moneyField(breakdown.finalAmount, "finalAmount");
    const monies = [
      itemsSubtotal,
      finalAmount,
      ...(shipping !== null ? [shipping] : []),
      ...(tax !== null ? [tax.amount] : []),
      ...discounts.map((discount) => discount.amount),
      ...additionalCharges.map((charge) => charge.amount),
    ];
    for (const money of monies) {
      if (money.currency !== expectedCurrency) {
        throw this.quoteError("Quote mixes currencies.");
      }
      if (BigInt(money.minor) < 0n) {
        throw this.quoteError("Quote contains a negative amount.");
      }
    }
    let expected = BigInt(itemsSubtotal.minor);
    if (shipping !== null) {
      expected += BigInt(shipping.minor);
    }
    if (tax !== null && !tax.includedInPrices) {
      expected += BigInt(tax.amount.minor);
    }
    for (const charge of additionalCharges) {
      expected += BigInt(charge.amount.minor);
    }
    for (const discount of discounts) {
      expected -= BigInt(discount.amount.minor);
    }
    if (expected !== BigInt(finalAmount.minor)) {
      throw this.quoteError("Quote breakdown does not sum to the final amount.");
    }
    return {
      quoteId,
      terms: {
        shippingOptions,
        amountBreakdown: { itemsSubtotal, shipping, tax, discounts, additionalCharges, finalAmount },
        expiresAt,
      },
    };
  }

  private quoteFingerprint(quoteId: string, revision: number, input: unknown, terms: QuoteTerms): string {
    return sha256Hex(canonicalJson({ v: 1, quoteId, revision, input, terms }));
  }

  private quoteFromRecord(record: QuoteRecord): Quote {
    return {
      quoteId: record.quoteId,
      groupOrderId: record.groupOrderId,
      basketRevision: record.basketRevision,
      storeId: record.storeId,
      revision: record.revision,
      fingerprint: record.fingerprint,
      expiresAt: record.terms.expiresAt,
      shippingOptions: clone(record.terms.shippingOptions),
      amountBreakdown: clone(record.terms.amountBreakdown),
      itemPricing: "AGGREGATE_ONLY",
      verifiedLines: null,
      observedAt: record.observedAt,
    };
  }

  private async refreshQuoteTerms(record: QuoteRecord): Promise<QuoteTerms> {
    const data = await this.readRequest(providerPath("agentic", "quotes", record.quoteId));
    try {
      const normalized = this.normalizeQuoteResponse(data, record.currency);
      if (normalized.quoteId !== record.quoteId) {
        throw this.quoteError("Provider returned a mismatched quote id.");
      }
      return normalized.terms;
    } catch {
      throw werr("MALFORMED_RESPONSE", "Provider returned an inconsistent quote.", {
        outcome: "REJECTED",
        recovery: "CONTACT_PROVIDER",
      });
    }
  }

  private async implCreateQuote(input: unknown, context: unknown): Promise<ImplOut<Quote>> {
    const ctx = this.mutationContext(context);
    const obj = callerObject(input, "input");
    const groupOrderId = nonEmptyId(obj.groupOrderId, "groupOrderId");
    const basketRevision = safeInteger(obj.basketRevision, "basketRevision", 0, MAX_QUANTITY);
    const storeId = nonEmptyId(obj.storeId, "storeId");
    const currency = inputCurrency(obj.currency, "currency");
    const email = this.validateEmail(obj.email);
    const shippingAddress = this.validateAddress(obj.shippingAddress);
    const lines = this.consolidateLines(obj.lines);
    return this.dispatch<Quote>({
      ctx,
      method: "createQuote",
      resourceType: "QUOTE",
      path: "/agentic/quotes",
      input: { groupOrderId, basketRevision, storeId, currency, email, shippingAddress, lines },
      prepare: async () => {
        const store = this.storeFor(storeId, false);
        if (!store.currencies.includes(currency)) {
          throw werr("STORE_CONTEXT_MISMATCH", "Store is not configured for this currency.");
        }
        if (store.country !== shippingAddress.country) {
          throw werr("STORE_CONTEXT_MISMATCH", "Shipping country does not match the store country.");
        }
        for (const line of lines) {
          const variant = this.state.variants[line.variantId];
          if (variant === undefined) {
            throw werr("VARIANT_UNKNOWN", "Variant lacks persisted catalog provenance.");
          }
          if (variant.storeId !== storeId) {
            throw werr("VARIANT_PROVENANCE_MISMATCH", "Variant does not belong to the quote store.");
          }
        }
        const requestBody = {
          email,
          shippingAddress,
          items: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
        };
        return {
          requestBody,
          interpret: (data) => {
            const { quoteId, terms } = this.normalizeQuoteResponse(data, currency);
            const recordInput = { email, shippingAddress, items: lines };
            const revision = 1;
            const fingerprint = this.quoteFingerprint(quoteId, revision, recordInput, terms);
            const record: QuoteRecord = {
              quoteId,
              groupOrderId,
              basketRevision,
              storeId,
              currency,
              revision,
              fingerprint,
              usable: true,
              frozen: false,
              selectedShippingOptionId: terms.shippingOptions.find((option) => option.selected)?.id ?? null,
              input: recordInput,
              terms,
              observedAt: this.now(),
            };
            return {
              data: this.quoteFromRecord(record),
              resourceId: quoteId,
              applyResult: () => {
                this.state.quotes[quoteId] = record;
              },
            };
          },
        };
      },
    });
  }

  private async implGetQuote(quoteId: unknown): Promise<ImplOut<Quote>> {
    const id = nonEmptyId(quoteId, "quoteId");
    const record = own(this.state.quotes, id);
    if (record === undefined) {
      throw werr("QUOTE_NOT_FOUND", "Quote is not in the journal.");
    }
    const terms = await this.refreshQuoteTerms(record);
    if (this.quoteFingerprint(id, record.revision, record.input, terms) !== record.fingerprint) {
      record.revision += 1;
      record.terms = terms;
      record.selectedShippingOptionId = terms.shippingOptions.find((option) => option.selected)?.id ?? null;
      record.fingerprint = this.quoteFingerprint(id, record.revision, record.input, terms);
    }
    record.observedAt = this.now();
    this.persist();
    return { data: this.quoteFromRecord(record), warnings: [] };
  }

  private async implSelectShippingOption(input: unknown, context: unknown): Promise<ImplOut<Quote>> {
    const ctx = this.mutationContext(context);
    const obj = callerObject(input, "input");
    const quoteId = nonEmptyId(obj.quoteId, "quoteId");
    const expectedFingerprint = nonEmptyId(obj.expectedFingerprint, "expectedFingerprint");
    const shippingOptionId = nonEmptyId(obj.shippingOptionId, "shippingOptionId");
    return this.dispatch<Quote>({
      ctx,
      method: "selectShippingOption",
      resourceType: "QUOTE",
      path: providerPath("agentic", "quotes", quoteId, "shipping-option"),
      input: { quoteId, expectedFingerprint, shippingOptionId },
      prepare: async () => {
        const record = own(this.state.quotes, quoteId);
        if (record === undefined) {
          throw werr("QUOTE_NOT_FOUND", "Quote is not in the journal.");
        }
        if (!record.usable) {
          throw werr("QUOTE_UNUSABLE", "Quote cannot be used until it is reconciled.", {
            recovery: "MANUAL_RECONCILIATION",
          });
        }
        if (record.frozen) {
          throw werr("QUOTE_FROZEN", "Quote is frozen by an in-flight checkout attempt.");
        }
        const terms = await this.refreshQuoteTerms(record);
        const refreshed = this.quoteFingerprint(quoteId, record.revision, record.input, terms);
        if (refreshed !== expectedFingerprint) {
          throw werr("QUOTE_CHANGED", "Quote terms changed since the expected fingerprint was issued.", {
            recovery: "REQUOTE",
          });
        }
        if (Date.parse(terms.expiresAt) <= this.nowFn().getTime()) {
          throw werr("QUOTE_EXPIRED", "Quote has expired.", { recovery: "REQUOTE" });
        }
        if (!terms.shippingOptions.some((option) => option.id === shippingOptionId)) {
          throw werr("VALIDATION_ERROR", "shippingOptionId is not an option on this quote.");
        }
        return {
          requestBody: { shippingOptionId },
          interpret: (data) => {
            const { quoteId: responseId, terms: nextTerms } = this.normalizeQuoteResponse(data, record.currency);
            if (responseId !== quoteId) {
              throw werr("MALFORMED_RESPONSE", "Provider returned a mismatched quote.", {
                outcome: "UNKNOWN",
                recovery: "MANUAL_RECONCILIATION",
              });
            }
            const selected = nextTerms.shippingOptions.find((option) => option.selected);
            if (selected === undefined || selected.id !== shippingOptionId) {
              throw werr("MALFORMED_RESPONSE", "Provider did not select the requested shipping option.", {
                outcome: "UNKNOWN",
                recovery: "MANUAL_RECONCILIATION",
              });
            }
            const unchangedFingerprint = this.quoteFingerprint(quoteId, record.revision, record.input, nextTerms);
            if (unchangedFingerprint === record.fingerprint) {
              return {
                data: this.quoteFromRecord(record),
                resourceId: quoteId,
                applyResult: () => {
                  record.observedAt = this.now();
                },
              };
            }
            const nextRevision = record.revision + 1;
            const nextFingerprint = this.quoteFingerprint(quoteId, nextRevision, record.input, nextTerms);
            const updated: QuoteRecord = {
              ...record,
              terms: nextTerms,
              revision: nextRevision,
              fingerprint: nextFingerprint,
              selectedShippingOptionId: nextTerms.shippingOptions.find((option) => option.selected)?.id ?? null,
            };
            return {
              data: this.quoteFromRecord(updated),
              resourceId: quoteId,
              applyResult: () => {
                record.terms = nextTerms;
                record.revision = nextRevision;
                record.fingerprint = nextFingerprint;
                record.selectedShippingOptionId = updated.selectedShippingOptionId;
                record.observedAt = this.now();
              },
            };
          },
        };
      },
      onFailure: () => {
        const record = own(this.state.quotes, quoteId);
        if (record !== undefined) {
          record.usable = false;
        }
      },
    });
  }

  private async implCreateCheckout(input: unknown, context: unknown): Promise<ImplOut<Checkout>> {
    const ctx = this.mutationContext(context);
    const obj = callerObject(input, "input");
    const groupOrderId = nonEmptyId(obj.groupOrderId, "groupOrderId");
    const purchaseAttemptId = nonEmptyId(obj.purchaseAttemptId, "purchaseAttemptId");
    const quoteId = nonEmptyId(obj.quoteId, "quoteId");
    const expectedFingerprint = nonEmptyId(obj.expectedFingerprint, "expectedFingerprint");
    const purchaserUserId = nonEmptyId(obj.purchaserUserId, "purchaserUserId");
    const enrollmentId = nonEmptyId(obj.enrollmentId, "enrollmentId");
    const approvedTotal = moneyInput(obj.approvedTotal, "approvedTotal");
    const returnUrl = obj.returnUrl;
    return this.dispatch<Checkout>({
      ctx,
      method: "createCheckout",
      resourceType: "CHECKOUT",
      path: "/agentic/checkouts",
      simulateCheckout: this.config.simulateCheckout,
      input: { groupOrderId, purchaseAttemptId, quoteId, expectedFingerprint, purchaserUserId, enrollmentId, approvedTotal, returnUrl },
      prepare: async () => {
        this.featureGate("agenticCheckout", true);
        const binding = this.bindingFor(purchaserUserId);
        const url = await this.validateReturn({
          userId: purchaserUserId,
          returnUrl,
          operationId: ctx.operationId,
          purchaseAttemptId,
        });
        const priorAttempt = Object.values(this.state.checkouts).find(
          (checkout) => checkout.purchaseAttemptId === purchaseAttemptId,
        );
        if (priorAttempt !== undefined) {
          const priorInput = priorAttempt.input as Record<string, unknown>;
          const priorTotal = priorInput.approvedTotal as Money;
          const same =
            priorInput.quoteId === quoteId &&
            priorInput.enrollmentId === enrollmentId &&
            priorInput.purchaserUserId === purchaserUserId &&
            priorInput.returnUrl === url &&
            priorInput.groupOrderId === groupOrderId &&
            priorInput.expectedFingerprint === expectedFingerprint &&
            priorTotal !== null &&
            priorTotal !== undefined &&
            priorTotal.minor === approvedTotal.minor &&
            priorTotal.currency === approvedTotal.currency;
          if (!same) {
            throw werr("ATTEMPT_CONFLICT", "purchaseAttemptId was already used with different checkout input.", {
              recovery: "FIX_INPUT",
            });
          }
          this.aliasResult({
            ctx,
            method: "createCheckout",
            resourceType: "CHECKOUT",
            input: { groupOrderId, purchaseAttemptId, quoteId, expectedFingerprint, purchaserUserId, enrollmentId, approvedTotal, returnUrl },
            resourceId: priorAttempt.checkoutId,
            data: this.checkoutFromRecord(priorAttempt),
          });
        }
        const groupCheckouts = Object.values(this.state.checkouts).filter(
          (checkout) => checkout.groupOrderId === groupOrderId,
        );
        const active = groupCheckouts.find((checkout) =>
          checkout.status === "REQUIRES_ACTION" || checkout.status === "PROCESSING" || checkout.status === "COMPLETED" || checkout.status === "UNKNOWN",
        );
        if (active !== undefined) {
          throw werr("GROUP_CHECKOUT_ACTIVE", "Group already has a checkout that is not definitively failed or expired.", {
            recovery: "POLL_RESOURCE",
          });
        }
        if (groupCheckouts.some((checkout) => checkout.quoteId === quoteId)) {
          throw werr("QUOTE_ALREADY_USED", "A new purchase attempt requires a new quote.", {
            recovery: "REQUOTE",
          });
        }
        for (const operation of Object.values(this.state.operations)) {
          if (operation.method !== "createCheckout" || operation.state !== "UNKNOWN") {
            continue;
          }
          const body = operation.requestBody as Record<string, unknown> | null;
          const opQuoteId = typeof body?.quoteId === "string" ? body.quoteId : null;
          const opQuote = opQuoteId !== null ? this.state.quotes[opQuoteId] : undefined;
          if (opQuote !== undefined && opQuote.groupOrderId === groupOrderId) {
            throw werr("GROUP_CHECKOUT_UNKNOWN", "A previous checkout for this group has an unknown outcome.", {
              outcome: "UNKNOWN",
              recovery: "MANUAL_RECONCILIATION",
            });
          }
        }
        const quote = own(this.state.quotes, quoteId);
        if (quote === undefined) {
          throw werr("QUOTE_NOT_FOUND", "Quote is not in the journal.");
        }
        this.storeFor(quote.storeId, true);
        if (!quote.usable) {
          throw werr("QUOTE_UNUSABLE", "Quote cannot be used until it is reconciled.", {
            recovery: "MANUAL_RECONCILIATION",
          });
        }
        if (quote.frozen) {
          throw werr("QUOTE_FROZEN", "Quote is frozen by an in-flight checkout attempt.");
        }
        if (quote.groupOrderId !== groupOrderId) {
          throw werr("VALIDATION_ERROR", "Quote does not belong to this group order.");
        }
        const enrollment = await this.implGetEnrollment(purchaserUserId, enrollmentId);
        if (enrollment.data.status !== "ACTIVE") {
          throw werr("ENROLLMENT_NOT_ACTIVE", "Enrollment is not ACTIVE.", { recovery: "REAUTHORIZE" });
        }
        const terms = await this.refreshQuoteTerms(quote);
        const refreshed = this.quoteFingerprint(quoteId, quote.revision, quote.input, terms);
        if (refreshed !== expectedFingerprint) {
          throw werr("QUOTE_CHANGED", "Quote terms changed since the expected fingerprint was issued.", {
            recovery: "REQUOTE",
          });
        }
        if (Date.parse(terms.expiresAt) <= this.nowFn().getTime()) {
          throw werr("QUOTE_EXPIRED", "Quote has expired.", { recovery: "REQUOTE" });
        }
        const finalAmount = terms.amountBreakdown.finalAmount;
        if (!sameMoney(finalAmount, approvedTotal)) {
          throw werr("APPROVED_TOTAL_MISMATCH", "Approved total does not equal the refreshed quote final amount.", {
            recovery: "REAUTHORIZE",
          });
        }
        const requestBody = {
          quoteId,
          enrollmentId,
          presentation: { type: "REDIRECT", returnUrl: url },
        };
        return {
          requestBody,
          apply: () => {
            quote.frozen = true;
          },
          interpret: (data) => {
            const response = asObject(data, "checkout");
            const checkoutId = reqString(response, "id");
            const status = reqString(response, "status");
            const responseQuoteId = reqString(response, "quoteId");
            if (responseQuoteId !== quoteId) {
              throw werr("MALFORMED_RESPONSE", "Checkout response references a different quote.", {
                outcome: "UNKNOWN",
                recovery: "MANUAL_RECONCILIATION",
              });
            }
            const responseEnrollment = optString(response, "enrollmentId");
            if (responseEnrollment !== null && responseEnrollment !== enrollmentId) {
              throw werr("MALFORMED_RESPONSE", "Checkout response references a different enrollment.", {
                outcome: "UNKNOWN",
                recovery: "MANUAL_RECONCILIATION",
              });
            }
            const record: CheckoutRecord = {
              checkoutId,
              groupOrderId,
              purchaseAttemptId,
              quoteId,
              enrollmentId: responseEnrollment,
              purchaserUserId,
              approvedTotal,
              status:
                status === "REQUIRES_ACTION" || status === "PROCESSING" || status === "COMPLETED" || status === "FAILED" || status === "EXPIRED"
                  ? status
                  : "UNKNOWN",
              providerStatus: status,
              orderId: null,
              finalAmount: null,
              nextAction: hostedAction(response.nextAction),
              reconciliationReady: false,
              input: { groupOrderId, purchaseAttemptId, quoteId, expectedFingerprint, enrollmentId, purchaserUserId, approvedTotal, returnUrl: url },
              observedAt: this.now(),
            };
            return {
              data: this.checkoutFromRecord(record),
              resourceId: checkoutId,
              applyResult: () => {
                this.state.checkouts[checkoutId] = record;
              },
            };
          },
        };
      },
    });
  }

  private checkoutFromRecord(record: CheckoutRecord): Checkout {
    return {
      checkoutId: record.checkoutId,
      groupOrderId: record.groupOrderId,
      purchaseAttemptId: record.purchaseAttemptId,
      quoteId: record.quoteId,
      enrollmentId: record.enrollmentId,
      status: record.status as Checkout["status"],
      providerStatus: record.providerStatus,
      orderId: record.orderId,
      finalAmount: record.finalAmount === null ? null : clone(record.finalAmount),
      nextAction: record.nextAction === null ? null : clone(record.nextAction),
      reconciliationReady: record.reconciliationReady,
      observedAt: record.observedAt,
    };
  }

  private async implGetCheckout(checkoutId: unknown): Promise<ImplOut<Checkout>> {
    const id = nonEmptyId(checkoutId, "checkoutId");
    const record = own(this.state.checkouts, id);
    if (record === undefined) {
      throw werr("CHECKOUT_NOT_FOUND", "Checkout is not in the journal.");
    }
    const data = await this.readRequest(providerPath("agentic", "checkouts", id));
    const response = asObject(data, "checkout");
    if (reqString(response, "id") !== id) {
      throw werr("MALFORMED_RESPONSE", "Provider returned a mismatched checkout.", {
        outcome: "REJECTED",
        recovery: "CONTACT_PROVIDER",
      });
    }
    const responseQuoteId = optString(response, "quoteId");
    if (responseQuoteId !== null && responseQuoteId !== record.quoteId) {
      throw werr("CONFLICTING_PROVIDER_STATE", "Provider checkout references a different quote.", {
        outcome: "REJECTED",
        recovery: "MANUAL_RECONCILIATION",
      });
    }
    const responseEnrollment = optString(response, "enrollmentId");
    if (responseEnrollment !== null && record.enrollmentId !== null && responseEnrollment !== record.enrollmentId) {
      throw werr("CONFLICTING_PROVIDER_STATE", "Provider checkout references a different enrollment.", {
        outcome: "REJECTED",
        recovery: "MANUAL_RECONCILIATION",
      });
    }
    const status = reqString(response, "status");
    const mapped =
      status === "REQUIRES_ACTION" || status === "PROCESSING" || status === "COMPLETED" || status === "FAILED" || status === "EXPIRED"
        ? status
        : "UNKNOWN";
    if (record.status === "COMPLETED" && (mapped === "FAILED" || mapped === "EXPIRED")) {
      throw werr("CONFLICTING_PROVIDER_STATE", "Provider regressed a completed checkout to a failed state.", {
        outcome: "REJECTED",
        recovery: "MANUAL_RECONCILIATION",
      });
    }
    const warnings: string[] = [];
    const orderId = optString(response, "orderId");
    const finalAmount = optMoneyField(response.finalAmount, "finalAmount");
    record.status = mapped;
    record.providerStatus = status;
    record.orderId = orderId;
    record.finalAmount = finalAmount;
    record.nextAction = hostedAction(response.nextAction);
    record.observedAt = this.now();
    if (mapped === "COMPLETED") {
      if (orderId === null || finalAmount === null) {
        record.reconciliationReady = false;
        warnings.push("FINAL_DATA_MISSING");
      } else if (!sameMoney(finalAmount, record.approvedTotal)) {
        record.reconciliationReady = false;
        warnings.push("FINAL_AMOUNT_MISMATCH");
      } else {
        record.reconciliationReady = true;
      }
    } else {
      record.reconciliationReady = false;
    }
    this.persist();
    return { data: this.checkoutFromRecord(record), warnings };
  }

  private debitFromRecord(record: DebitRecord): WalletDebit {
    const first = record.attempts[0];
    return {
      debitId: record.debitId,
      operationId: first !== undefined ? first.operationId : "",
      groupOrderId: record.groupOrderId,
      participantId: record.participantId,
      amount: clone(record.amount),
      state: record.state === PENDING_DEBIT ? "UNKNOWN" : record.state,
      postingId: record.postingId,
      balanceAfter: record.balanceAfter === null ? null : clone(record.balanceAfter as WalletSnapshot),
      observedAt: record.observedAt,
    };
  }

  private reservedForCheckout(checkoutId: string, excludingDebitId?: string): bigint {
    let reserved = 0n;
    for (const debit of Object.values(this.state.debits)) {
      if (debit.checkoutId !== checkoutId || debit.debitId === excludingDebitId) {
        continue;
      }
      if (debit.state === "APPLIED" || debit.state === "NOOP" || debit.state === "UNKNOWN" || debit.state === PENDING_DEBIT) {
        reserved += BigInt(debit.amount.minor);
      }
    }
    return reserved;
  }

  private async walletPreflight(userId: string, amount: Money): Promise<{ binding: UserBinding; wallet: WalletSnapshot; asset: NonNullable<WalletSnapshot["eligibleAsset"]>; unitsInteger: bigint }> {
    const binding = this.bindingFor(userId);
    const wallet = (await this.implGetWallet(userId)).data;
    if (wallet.accountStatus !== "ACTIVE") {
      throw werr("ACCOUNT_NOT_ACTIVE", "Account is not ACTIVE.", { recovery: "CONTACT_PROVIDER" });
    }
    if (wallet.eligibleAsset === null || wallet.debitEligibility.state !== "VERIFIED") {
      throw werr("ASSET_INELIGIBLE", "No eligible virtual asset for this debit.", {
        recovery: "CONTACT_PROVIDER",
      });
    }
    const asset = wallet.eligibleAsset;
    const units = minorToUnits(amount.minor, amount.currency);
    const unitsInteger = decimalUnitsToInteger(units, asset.decimals);
    const reservedMinor = Object.values(this.state.debits)
      .filter(debit => debit.accountId === binding.accountId && (debit.state === "UNKNOWN" || debit.state === PENDING_DEBIT))
      .reduce((sum, debit) => sum + BigInt(debit.amount.minor), 0n);
    const reservedUnits = decimalUnitsToInteger(minorToUnits(reservedMinor.toString(), amount.currency), asset.decimals);
    const balanceUnits = decimalUnitsToInteger(asset.units, asset.decimals) - reservedUnits;
    const withdrawableUnits = decimalUnitsToInteger(asset.withdrawableUnits, asset.decimals) - reservedUnits;
    if (unitsInteger > balanceUnits || unitsInteger > withdrawableUnits) {
      throw werr("INSUFFICIENT_FUNDS", "Eligible asset balance is below the debit amount.", {
        recovery: "FIX_INPUT",
      });
    }
    if (wallet.availableBalance !== null && BigInt(wallet.availableBalance.minor) - reservedMinor < BigInt(amount.minor)) {
      throw werr("INSUFFICIENT_FUNDS", "Account available balance is below the debit amount.", {
        recovery: "FIX_INPUT",
      });
    }
    if (asset.currency !== amount.currency) {
      throw werr("CURRENCY_MISMATCH", "Debit currency does not match the asset currency.");
    }
    return { binding, wallet, asset, unitsInteger };
  }

  private async completedCheckoutOrFail(checkoutId: string, groupOrderId: string): Promise<Checkout> {
    const record = this.state.checkouts[checkoutId];
    if (record === undefined || record.groupOrderId !== groupOrderId) {
      throw werr("CHECKOUT_NOT_FOUND", "Checkout is not in the journal for this group order.");
    }
    const fresh = (await this.implGetCheckout(checkoutId)).data;
    if (fresh.status !== "COMPLETED" || !fresh.reconciliationReady || fresh.finalAmount === null) {
      throw werr("CHECKOUT_NOT_READY", "Checkout is not completed and reconciliation-ready.", {
        recovery: "POLL_RESOURCE",
      });
    }
    return fresh;
  }

  private postingMatches(
    response: Record<string, unknown>,
    accountId: string,
    virtualAssetId: string,
    unitsInteger: bigint,
    decimals: number,
  ): boolean {
    const entries = reqArray(response, "entries");
    if (entries.length !== 1) {
      return false;
    }
    const entry = asObject(entries[0], "entries[]");
    return (
      reqString(response, "accountId") === accountId &&
      reqString(response, "type") === "WITHDRAWAL" &&
      reqString(entry, "virtualAssetId") === virtualAssetId &&
      isExactRateOne(reqRawAmount(response, "rate")) &&
      reqString(response, "currency") === this.config.billingCurrency &&
      decimalUnitsToInteger(decimalUnitsString(entry, "amount"), decimals) === unitsInteger
    );
  }

  private async refreshBalanceAfter(record: DebitRecord): Promise<WalletSnapshot | null> {
    try {
      return (await this.implGetWallet(record.userId)).data;
    } catch {
      return null;
    }
  }

  private async implDebitWallet(input: unknown, context: unknown): Promise<ImplOut<WalletDebit>> {
    const ctx = this.mutationContext(context);
    const obj = callerObject(input, "input");
    const groupOrderId = nonEmptyId(obj.groupOrderId, "groupOrderId");
    const checkoutId = nonEmptyId(obj.checkoutId, "checkoutId");
    const participantId = nonEmptyId(obj.participantId, "participantId");
    const userId = nonEmptyId(obj.userId, "userId");
    const allocationId = nonEmptyId(obj.allocationId, "allocationId");
    const consentRef = nonEmptyId(obj.consentRef, "consentRef");
    const approvedAmount = moneyInput(obj.approvedAmount, "approvedAmount");
    const amount = moneyInput(obj.amount, "amount");
    if (!sameMoney(approvedAmount, amount)) {
      throw werr("VALIDATION_ERROR", "amount must equal approvedAmount.");
    }
    if (BigInt(amount.minor) < 0n) {
      throw werr("VALIDATION_ERROR", "amount must not be negative.");
    }
    const zeroAmount = BigInt(amount.minor) === 0n;
    const dispatchInput = { groupOrderId, checkoutId, participantId, userId, allocationId, consentRef, amount };
    const out = await this.dispatch<WalletDebit>({
      ctx,
      method: "debitWallet",
      resourceType: "WALLET_DEBIT",
      path: "/postings/",
      input: dispatchInput,
      ...(zeroAmount ? { noDispatch: true } : {}),
      prepare: async () => {
        this.featureGate("virtualAssetDebit", true);
        if (this.config.environment !== "SANDBOX") {
          throw werr("FEATURE_DISABLED", "Wallet debits are enabled for sandbox configuration only.", {
            recovery: "CONTACT_PROVIDER",
          });
        }
        const tupleKey = JSON.stringify([groupOrderId, participantId]);
        const existingDebitId = this.state.participants[tupleKey];
        if (existingDebitId !== undefined) {
          const existing = this.state.debits[existingDebitId];
          if (existing !== undefined) {
            const same =
              existing.userId === userId &&
              existing.checkoutId === checkoutId &&
              existing.allocationId === allocationId &&
              existing.consentRef === consentRef &&
              existing.amount.currency === amount.currency &&
              existing.amount.minor === amount.minor;
            if (!same) {
              throw werr("DEBIT_INPUT_CONFLICT", "A different debit already exists for this participant and group order.", {
                recovery: "FIX_INPUT",
              });
            }
            existing.aliasOperationIds.push(ctx.operationId);
            this.aliasResult({
              ctx,
              method: "debitWallet",
              resourceType: "WALLET_DEBIT",
              input: dispatchInput,
              resourceId: existing.debitId,
              data: this.debitFromRecord(existing),
            });
          }
        }
        const consent = await this.validateConsent({
          groupOrderId,
          checkoutId,
          participantId,
          userId,
          allocationId,
          consentRef,
          approvedAmount,
          amount,
        });
        if (consent !== true) {
          throw werr("CONSENT_REJECTED", "Participant consent validation failed.", {
            recovery: "REAUTHORIZE",
          });
        }
        const fresh = await this.completedCheckoutOrFail(checkoutId, groupOrderId);
        if (fresh.finalAmount === null || fresh.finalAmount.currency !== amount.currency) {
          throw werr("CURRENCY_MISMATCH", "Debit currency does not match the checkout currency.");
        }
        const finalMinor = BigInt(fresh.finalAmount.minor);
        const { binding, asset, unitsInteger } = await this.walletPreflight(userId, amount);
        const units = minorToUnits(amount.minor, amount.currency);
        const requestBody = {
          accountId: binding.accountId,
          type: "WITHDRAWAL",
          entries: [{ virtualAssetId: asset.virtualAssetId, amount: units }],
        };
        let createdDebitId: string | null = null;
        return {
          requestBody,
          apply: () => {
            const reserved = this.reservedForCheckout(checkoutId);
            if (reserved + BigInt(amount.minor) > finalMinor) {
              throw werr("CAPACITY_EXCEEDED", "Debits would exceed the checkout final amount.", {
                recovery: "FIX_INPUT",
              });
            }
            const debitId = `debit_${randomUUID()}`;
            createdDebitId = debitId;
            this.state.debits[debitId] = {
              debitId,
              groupOrderId,
              participantId,
              checkoutId,
              userId,
              accountId: binding.accountId,
              allocationId,
              consentRef,
              amount: { ...amount },
              assetDecimals: asset.decimals,
              state: PENDING_DEBIT,
              postingId: null,
              balanceAfter: null,
              attempts: [
                {
                  operationId: ctx.operationId,
                  idempotencyKey: ctx.idempotencyKey,
                  postingId: null,
                  outcome: "PENDING",
                  at: this.now(),
                },
              ],
              aliasOperationIds: [],
              observedAt: this.now(),
            };
            this.state.participants[tupleKey] = debitId;
          },
          interpret: (data) => {
            const record = createdDebitId !== null ? this.state.debits[createdDebitId] : undefined;
            if (record === undefined) {
              throw werr("INTERNAL_ERROR", "Debit record missing after dispatch.", {
                outcome: "UNKNOWN",
                recovery: "MANUAL_RECONCILIATION",
              });
            }
            if (zeroAmount) {
              record.state = "NOOP";
              record.attempts[record.attempts.length - 1]!.outcome = "APPLIED";
              record.observedAt = this.now();
              return { data: this.debitFromRecord(record), resourceId: record.debitId };
            }
            const response = asObject(data, "posting");
            const postingId = reqString(response, "id");
            const matches = this.postingMatches(response, binding.accountId, asset.virtualAssetId, unitsInteger, asset.decimals);
            if (!matches) {
              throw werr("MALFORMED_RESPONSE", "Provider returned a posting that does not match the request.", {
                outcome: "UNKNOWN",
                recovery: "MANUAL_RECONCILIATION",
              });
            }
            return {
              data: this.debitFromRecord({ ...record, state: "APPLIED", postingId }),
              resourceId: record.debitId,
              applyResult: () => {
                record.state = "APPLIED";
                record.postingId = postingId;
                const attempt = record.attempts[record.attempts.length - 1];
                if (attempt !== undefined) {
                  attempt.outcome = "APPLIED";
                  attempt.postingId = postingId;
                }
                record.observedAt = this.now();
              },
            };
          },
        };
      },
    });
    const applied = Object.values(this.state.debits).find(
      (debit) => debit.attempts[debit.attempts.length - 1]?.operationId === ctx.operationId && debit.state === "APPLIED",
    );
    if (applied === undefined || applied.postingId === null) {
      return out;
    }
    const balanceAfter = await this.refreshBalanceAfter(applied);
    const warnings = [...out.warnings];
    if (balanceAfter === null) {
      warnings.push("BALANCE_REFRESH_FAILED");
      this.persist();
      return { data: this.debitFromRecord(applied), warnings };
    }
    applied.balanceAfter = balanceAfter;
    this.persist();
    return { data: this.debitFromRecord(applied), warnings };
  }

  private async implGetWalletDebit(debitId: unknown): Promise<ImplOut<WalletDebit>> {
    const id = nonEmptyId(debitId, "debitId");
    const record = this.state.debits[id];
    if (record === undefined) {
      throw werr("DEBIT_NOT_FOUND", "Debit is not in the journal.");
    }
    if (record.postingId !== null) {
      const data = await this.readRequest(providerPath("postings", record.postingId));
      const response = asObject(data, "posting");
      if (reqString(response, "id") !== record.postingId) {
        throw werr("CONFLICTING_PROVIDER_STATE", "Provider posting id does not match the recorded debit.", {
          outcome: "REJECTED",
          recovery: "MANUAL_RECONCILIATION",
        });
      }
      const expectedUnits = minorToUnits(record.amount.minor, record.amount.currency);
      const expectedInteger = decimalUnitsToInteger(expectedUnits, record.assetDecimals);
      if (!this.postingMatches(response, record.accountId, this.config.walletAssetId ?? "", expectedInteger, record.assetDecimals)) {
        throw werr("CONFLICTING_PROVIDER_STATE", "Provider posting does not match the recorded debit.", {
          outcome: "REJECTED",
          recovery: "MANUAL_RECONCILIATION",
        });
      }
    }
    return { data: this.debitFromRecord(record), warnings: [] };
  }

  private async implRetryWalletDebit(debitId: unknown, context: unknown): Promise<ImplOut<WalletDebit>> {
    const ctx = this.mutationContext(context);
    const id = nonEmptyId(debitId, "debitId");
    const out = await this.dispatch<WalletDebit>({
      ctx,
      method: "retryWalletDebit",
      resourceType: "WALLET_DEBIT",
      path: "/postings/",
      input: { debitId: id },
      prepare: async () => {
        const record = this.state.debits[id];
        if (record === undefined) {
          throw werr("DEBIT_NOT_FOUND", "Debit is not in the journal.");
        }
        if (record.state === "APPLIED" || record.state === "NOOP") {
          this.aliasResult({
            ctx,
            method: "retryWalletDebit",
            resourceType: "WALLET_DEBIT",
            input: { debitId: id },
            resourceId: record.debitId,
            data: this.debitFromRecord(record),
          });
        }
        if (record.state !== "REJECTED") {
          throw werr("DEBIT_OUTCOME_UNKNOWN", "Debit outcome is unknown and requires reconciliation, not retry.", {
            outcome: "UNKNOWN",
            recovery: "MANUAL_RECONCILIATION",
          });
        }
        this.featureGate("virtualAssetDebit", true);
        if (this.config.environment !== "SANDBOX") {
          throw werr("FEATURE_DISABLED", "Wallet debits are enabled for sandbox configuration only.", {
            recovery: "CONTACT_PROVIDER",
          });
        }
        const consent = await this.validateConsent({
          groupOrderId: record.groupOrderId,
          checkoutId: record.checkoutId,
          participantId: record.participantId,
          userId: record.userId,
          allocationId: record.allocationId,
          consentRef: record.consentRef,
          approvedAmount: record.amount,
          amount: record.amount,
        });
        if (consent !== true) {
          throw werr("CONSENT_REJECTED", "Participant consent validation failed.", {
            recovery: "REAUTHORIZE",
          });
        }
        const fresh = await this.completedCheckoutOrFail(record.checkoutId, record.groupOrderId);
        if (fresh.finalAmount === null) {
          throw werr("CHECKOUT_NOT_READY", "Checkout is not completed and reconciliation-ready.", {
            recovery: "POLL_RESOURCE",
          });
        }
        const finalMinor = BigInt(fresh.finalAmount.minor);
        const { binding, asset, unitsInteger } = await this.walletPreflight(record.userId, record.amount);
        const units = minorToUnits(record.amount.minor, record.amount.currency);
        const requestBody = {
          accountId: binding.accountId,
          type: "WITHDRAWAL",
          entries: [{ virtualAssetId: asset.virtualAssetId, amount: units }],
        };
        return {
          requestBody,
          apply: () => {
            const reserved = this.reservedForCheckout(record.checkoutId, record.debitId);
            if (reserved + BigInt(record.amount.minor) > finalMinor) {
              throw werr("CAPACITY_EXCEEDED", "Debits would exceed the checkout final amount.", {
                recovery: "FIX_INPUT",
              });
            }
            record.attempts.push({
              operationId: ctx.operationId,
              idempotencyKey: ctx.idempotencyKey,
              postingId: null,
              outcome: "PENDING",
              at: this.now(),
            });
            record.state = PENDING_DEBIT;
            record.postingId = null;
            record.observedAt = this.now();
          },
          interpret: (data) => {
            const response = asObject(data, "posting");
            const postingId = reqString(response, "id");
            const matches = this.postingMatches(response, binding.accountId, asset.virtualAssetId, unitsInteger, asset.decimals);
            if (!matches) {
              throw werr("MALFORMED_RESPONSE", "Provider returned a posting that does not match the request.", {
                outcome: "UNKNOWN",
                recovery: "MANUAL_RECONCILIATION",
              });
            }
            return {
              data: this.debitFromRecord({ ...record, state: "APPLIED", postingId }),
              resourceId: record.debitId,
              applyResult: () => {
                record.state = "APPLIED";
                record.postingId = postingId;
                const attempt = record.attempts[record.attempts.length - 1];
                if (attempt !== undefined) {
                  attempt.outcome = "APPLIED";
                  attempt.postingId = postingId;
                }
                record.observedAt = this.now();
              },
            };
          },
        };
      },
    });
    const record = this.state.debits[id];
    if (record === undefined || record.postingId === null || record.state !== "APPLIED") {
      return out;
    }
    const balanceAfter = await this.refreshBalanceAfter(record);
    const warnings = [...out.warnings];
    if (balanceAfter === null) {
      warnings.push("BALANCE_REFRESH_FAILED");
      this.persist();
      return { data: this.debitFromRecord(record), warnings };
    }
    record.balanceAfter = balanceAfter;
    this.persist();
    return { data: this.debitFromRecord(record), warnings };
  }

  private async implGetOperation(operationId: unknown): Promise<ImplOut<Operation>> {
    const id = nonEmptyId(operationId, "operationId");
    const record = this.state.operations[id];
    if (record === undefined) {
      throw werr("OPERATION_NOT_FOUND", "Operation is not in the journal.");
    }
    return {
      data: {
        operationId: record.operationId,
        state: record.state,
        resourceType: record.resourceType,
        resourceId: record.resourceId,
        error: record.error === null ? null : clone(record.error),
        updatedAt: record.updatedAt,
      },
      warnings: [],
    };
  }

  private async implGetCapabilities(): Promise<ImplOut<Capabilities>> {
    return {
      data: {
        environment: this.config.environment,
        reapVersion: this.config.reapVersion,
        fundingModel: this.config.fundingModel,
        authorizationMode: this.config.authorizationMode,
        billingCurrency: this.config.billingCurrency,
        walletAssetId: this.config.walletAssetId,
        features: clone(this.config.features),
        stores: clone([
          ...this.config.stores,
          ...Object.values(this.state.discoveredStores).filter(
            (store) => !this.config.stores.some((candidate) => candidate.storeId === store.storeId),
          ),
        ]),
        maxQuoteLines: MAX_QUOTE_LINES,
        maxProductDetailsBatch: MAX_DETAILS_BATCH,
      },
      warnings: [],
    };
  }

  getCapabilities(): Promise<Result<Capabilities>> {
    return this.enqueue(() => this.guard(() => this.implGetCapabilities()));
  }

  getWallet(userId: Id): Promise<Result<WalletSnapshot>> {
    const cloned = clone(userId);
    return this.enqueue(() => this.guard(() => this.implGetWallet(cloned)));
  }

  listCards(userId: Id, page?: PageInput): Promise<Result<Page<CardSummary>>> {
    const cloned = clone({ userId, page });
    return this.enqueue(() => this.guard(() => this.implListCards(cloned.userId, cloned.page)));
  }

  listEnrollments(userId: Id, page?: PageInput): Promise<Result<Page<Enrollment>>> {
    const cloned = clone({ userId, page });
    return this.enqueue(() => this.guard(() => this.implListEnrollments(cloned.userId, cloned.page)));
  }

  getEnrollment(userId: Id, enrollmentId: Id): Promise<Result<Enrollment>> {
    const cloned = clone({ userId, enrollmentId });
    return this.enqueue(() => this.guard(() => this.implGetEnrollment(cloned.userId, cloned.enrollmentId)));
  }

  createEnrollment(
    input: { userId: Id; email: string; returnUrl: string },
    context: MutationContext,
  ): Promise<Result<Enrollment>> {
    const cloned = clone({ input, context });
    return this.enqueue(() => this.guard(() => this.implCreateEnrollment(cloned.input, cloned.context)));
  }

  revokeEnrollment(userId: Id, enrollmentId: Id, context: MutationContext): Promise<Result<Enrollment>> {
    const cloned = clone({ userId, enrollmentId, context });
    return this.enqueue(() =>
      this.guard(() => this.implRevokeEnrollment(cloned.userId, cloned.enrollmentId, cloned.context)),
    );
  }

  discoverMerchants(input: SearchContext): Promise<Result<MerchantDiscovery>> {
    const cloned = clone(input);
    return this.enqueue(() => this.guard(() => this.implDiscoverMerchants(cloned)));
  }

  searchProducts(input: ProductSearchInput): Promise<Result<Page<ProductSummary>>> {
    const cloned = clone(input);
    return this.enqueue(() => this.guard(() => this.implSearchProducts(cloned)));
  }

  getProductDetails(productIds: Id[]): Promise<Result<ProductDetailsResult>> {
    const cloned = clone(productIds);
    return this.enqueue(() => this.guard(() => this.implGetProductDetails(cloned)));
  }

  resolveVariant(productId: Id, optionIds: Id[]): Promise<Result<Variant>> {
    const cloned = clone({ productId, optionIds });
    return this.enqueue(() => this.guard(() => this.implResolveVariant(cloned.productId, cloned.optionIds)));
  }

  createQuote(input: QuoteInput, context: MutationContext): Promise<Result<Quote>> {
    const cloned = clone({ input, context });
    return this.enqueue(() => this.guard(() => this.implCreateQuote(cloned.input, cloned.context)));
  }

  getQuote(quoteId: Id): Promise<Result<Quote>> {
    const cloned = clone(quoteId);
    return this.enqueue(() => this.guard(() => this.implGetQuote(cloned)));
  }

  selectShippingOption(
    input: { quoteId: Id; expectedFingerprint: string; shippingOptionId: Id },
    context: MutationContext,
  ): Promise<Result<Quote>> {
    const cloned = clone({ input, context });
    return this.enqueue(() => this.guard(() => this.implSelectShippingOption(cloned.input, cloned.context)));
  }

  createCheckout(input: CheckoutInput, context: MutationContext): Promise<Result<Checkout>> {
    const cloned = clone({ input, context });
    return this.enqueue(() => this.guard(() => this.implCreateCheckout(cloned.input, cloned.context)));
  }

  getCheckout(checkoutId: Id): Promise<Result<Checkout>> {
    const cloned = clone(checkoutId);
    return this.enqueue(() => this.guard(() => this.implGetCheckout(cloned)));
  }

  debitWallet(input: WalletDebitInput, context: MutationContext): Promise<Result<WalletDebit>> {
    const cloned = clone({ input, context });
    return this.enqueue(() => this.guard(() => this.implDebitWallet(cloned.input, cloned.context)));
  }

  getWalletDebit(debitId: Id): Promise<Result<WalletDebit>> {
    const cloned = clone(debitId);
    return this.enqueue(() => this.guard(() => this.implGetWalletDebit(cloned)));
  }

  retryWalletDebit(debitId: Id, context: MutationContext): Promise<Result<WalletDebit>> {
    const cloned = clone({ debitId, context });
    return this.enqueue(() => this.guard(() => this.implRetryWalletDebit(cloned.debitId, cloned.context)));
  }

  getOperation(operationId: Id): Promise<Result<Operation>> {
    const cloned = clone(operationId);
    return this.enqueue(() => this.guard(() => this.implGetOperation(cloned)));
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.tail;
    this.closed = true;
    this.store.release();
  }
}

const _wrapperCheck: ReapWrapper = null as unknown as ReapService;
void _wrapperCheck;
