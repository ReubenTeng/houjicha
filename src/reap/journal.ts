import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  Money,
  Store,
  WalletDebit,
  WrapperError,
} from "./contract.js";
import type { UserBinding } from "./config.js";
import { isCanonicalMinor } from "./money.js";

export const JOURNAL_VERSION = 2;

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalError";
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface JournalScope {
  projectRef: string;
  environment: string;
  baseUrl: string;
  reapVersion: string;
  fundingModel: string;
  authorizationMode: string;
  billingCurrency: string | null;
  walletAssetId: string | null;
  simulateCheckout: boolean;
  dataMode: string;
  users: UserBinding[];
}

export interface OperationRecord {
  operationId: string;
  method: string;
  requestHash: string;
  idempotencyKey: string;
  resourceType: "ENROLLMENT" | "QUOTE" | "CHECKOUT" | "WALLET_DEBIT";
  resourceId: string | null;
  state: "PENDING" | "SUCCEEDED" | "REJECTED" | "UNKNOWN";
  error: WrapperError | null;
  requestBody: unknown;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface EnrollmentRecord {
  enrollmentId: string;
  userId: string;
  ownerId: string;
  status: string;
  createdAt: string;
}

export interface QuoteTerms {
  shippingOptions: {
    id: string;
    name: string;
    selected: boolean;
    price: Money;
    details: { key: string; value: string }[];
  }[];
  amountBreakdown: {
    itemsSubtotal: Money;
    shipping: Money | null;
    tax: { amount: Money; includedInPrices: boolean } | null;
    discounts: { name: string; amount: Money }[];
    additionalCharges: { name: string; amount: Money }[];
    finalAmount: Money;
  };
  expiresAt: string;
}

export interface QuoteRecord {
  quoteId: string;
  groupOrderId: string;
  basketRevision: number;
  storeId: string;
  currency: string;
  revision: number;
  fingerprint: string;
  usable: boolean;
  frozen: boolean;
  selectedShippingOptionId: string | null;
  input: unknown;
  terms: QuoteTerms;
  observedAt: string;
}

export interface ProductRecord {
  productId: string;
  merchantName: string;
  storeId: string | null;
  country: string | null;
  currency: string | null;
  observedAt: string;
}

export interface VariantRecord {
  variantId: string;
  productId: string;
  storeId: string | null;
  currency: string | null;
  observedAt: string;
}

export interface CursorRecord {
  queryHash: string;
  upstreamCursor: string;
  createdAt: string;
}

export interface CheckoutRecord {
  checkoutId: string;
  groupOrderId: string;
  purchaseAttemptId: string;
  quoteId: string;
  enrollmentId: string | null;
  purchaserUserId: string;
  approvedTotal: Money;
  status: string;
  providerStatus: string;
  orderId: string | null;
  finalAmount: Money | null;
  nextAction: { type: "REDIRECT"; url: string; expiresAt: string | null } | null;
  reconciliationReady: boolean;
  input: unknown;
  observedAt: string;
}

export interface DebitAttempt {
  operationId: string;
  idempotencyKey: string;
  postingId: string | null;
  outcome: "PENDING" | "APPLIED" | "REJECTED" | "UNKNOWN";
  at: string;
}

export interface DebitRecord {
  debitId: string;
  groupOrderId: string;
  participantId: string;
  checkoutId: string;
  userId: string;
  accountId: string;
  allocationId: string;
  consentRef: string;
  amount: Money;
  assetDecimals: number;
  state: WalletDebit["state"];
  postingId: string | null;
  balanceAfter: unknown;
  attempts: DebitAttempt[];
  aliasOperationIds: string[];
  observedAt: string;
}

export interface JournalState {
  version: number;
  scope: JournalScope;
  operations: Record<string, OperationRecord>;
  idempotencyKeys: Record<string, { operationId: string; method: string }>;
  enrollments: Record<string, EnrollmentRecord>;
  quotes: Record<string, QuoteRecord>;
  products: Record<string, ProductRecord>;
  variants: Record<string, VariantRecord>;
  cursors: Record<string, CursorRecord>;
  checkouts: Record<string, CheckoutRecord>;
  debits: Record<string, DebitRecord>;
  participants: Record<string, string>;
  discoveredStores: Record<string, Store>;
}

export function emptyJournal(scope: JournalScope): JournalState {
  return {
    version: JOURNAL_VERSION,
    scope,
    operations: Object.create(null),
    idempotencyKeys: Object.create(null),
    enrollments: Object.create(null),
    quotes: Object.create(null),
    products: Object.create(null),
    variants: Object.create(null),
    cursors: Object.create(null),
    checkouts: Object.create(null),
    debits: Object.create(null),
    participants: Object.create(null),
    discoveredStores: Object.create(null),
  };
}

export function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isMoney(value: unknown): value is Money {
  return (
    isRecord(value) &&
    typeof value.currency === "string" &&
    value.currency.length > 0 &&
    typeof value.minor === "string" &&
    isCanonicalMinor(value.minor)
  );
}

function checkMap(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key];
  if (!isRecord(value)) {
    throw new JournalError(`Journal collection ${key} is missing or invalid.`);
  }
  for (const mapKey of Object.keys(value)) {
    if (mapKey === "__proto__" || mapKey === "constructor" || mapKey === "prototype") {
      throw new JournalError(`Journal collection ${key} contains a reserved key.`);
    }
  }
  return value;
}

function checkWrapperError(value: unknown, field: string): void {
  if (value === null) {
    return;
  }
  if (!isRecord(value) || !isNonEmptyString(value.code) || typeof value.message !== "string") {
    throw new JournalError(`Journal field ${field} is invalid.`);
  }
  if (value.providerCode !== null && typeof value.providerCode !== "string") {
    throw new JournalError(`Journal field ${field}.providerCode is invalid.`);
  }
  if (value.operationId !== null && !isNonEmptyString(value.operationId)) {
    throw new JournalError(`Journal field ${field}.operationId is invalid.`);
  }
  if (!["NOT_SUBMITTED", "REJECTED", "UNKNOWN"].includes(value.outcome as string)) {
    throw new JournalError(`Journal field ${field}.outcome is invalid.`);
  }
  if (!["FIX_INPUT", "REAUTHORIZE", "REQUOTE", "RETRY_SAME_OPERATION", "POLL_RESOURCE", "CONTACT_PROVIDER", "MANUAL_RECONCILIATION"].includes(value.recovery as string)) {
    throw new JournalError(`Journal field ${field}.recovery is invalid.`);
  }
  if (value.retryAfterSeconds !== null && typeof value.retryAfterSeconds !== "number") {
    throw new JournalError(`Journal field ${field}.retryAfterSeconds is invalid.`);
  }
}

function checkEvidence(value: unknown, field: string): void {
  if (!isRecord(value) || !["VERIFIED", "DISABLED", "UNVERIFIED"].includes(value.state as string) || typeof value.reason !== "string" || (value.checkedAt !== null && (typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)))) || (value.evidenceRef !== null && typeof value.evidenceRef !== "string")) {
    throw new JournalError(`Journal field ${field} is invalid.`);
  }
}

function checkStore(value: unknown, field: string): void {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.storeId) ||
    !isNonEmptyString(value.providerMerchantName) ||
    !isNonEmptyString(value.country) ||
    !Array.isArray(value.currencies) ||
    !value.currencies.every((currency) => isNonEmptyString(currency))
  ) {
    throw new JournalError(`Journal field ${field} is invalid.`);
  }
  checkEvidence(value.eligibility, `${field}.eligibility`);
}

function checkMoneyMap(value: unknown, field: string): void {
  if (!isMoney(value)) {
    throw new JournalError(`Journal field ${field} is invalid.`);
  }
}

function checkQuoteTerms(value: unknown, field: string): void {
  if (!isRecord(value) || !Array.isArray(value.shippingOptions) || !isRecord(value.amountBreakdown) || !isNonEmptyString(value.expiresAt)) {
    throw new JournalError(`Journal field ${field} is invalid.`);
  }
  const breakdown = value.amountBreakdown;
  checkMoneyMap(breakdown.itemsSubtotal, `${field}.itemsSubtotal`);
  if (breakdown.shipping !== null) {
    checkMoneyMap(breakdown.shipping, `${field}.shipping`);
  }
  if (breakdown.tax !== null) {
    if (!isRecord(breakdown.tax) || typeof breakdown.tax.includedInPrices !== "boolean") {
      throw new JournalError(`Journal field ${field}.tax is invalid.`);
    }
    checkMoneyMap(breakdown.tax.amount, `${field}.tax.amount`);
  }
  if (!Array.isArray(breakdown.discounts) || !breakdown.discounts.every((item) => isRecord(item) && isMoney(item.amount) && typeof item.name === "string")) {
    throw new JournalError(`Journal field ${field}.discounts is invalid.`);
  }
  if (!Array.isArray(breakdown.additionalCharges) || !breakdown.additionalCharges.every((item) => isRecord(item) && isMoney(item.amount) && typeof item.name === "string")) {
    throw new JournalError(`Journal field ${field}.additionalCharges is invalid.`);
  }
  checkMoneyMap(breakdown.finalAmount, `${field}.finalAmount`);
  for (const option of value.shippingOptions) {
    if (!isRecord(option) || !isNonEmptyString(option.id) || typeof option.selected !== "boolean") {
      throw new JournalError(`Journal field ${field}.shippingOptions is invalid.`);
    }
    checkMoneyMap(option.price, `${field}.shippingOptions.price`);
  }
}

function validateJournal(raw: unknown): JournalState {
  if (!isRecord(raw)) {
    throw new JournalError("Journal is missing or corrupt.");
  }
  if (raw.version !== JOURNAL_VERSION) {
    throw new JournalError("Journal is an unsupported version; reconcile or remove the journal manually.");
  }
  if (!isRecord(raw.scope)) {
    throw new JournalError("Journal scope is missing.");
  }
  const scope = raw.scope;
  for (const key of ["projectRef", "environment", "baseUrl", "reapVersion", "fundingModel", "authorizationMode", "dataMode"]) {
    if (!isNonEmptyString(scope[key])) {
      throw new JournalError(`Journal scope.${key} is invalid.`);
    }
  }
  if (scope.billingCurrency !== null && typeof scope.billingCurrency !== "string") {
    throw new JournalError("Journal scope.billingCurrency is invalid.");
  }
  if (scope.walletAssetId !== null && !isNonEmptyString(scope.walletAssetId)) {
    throw new JournalError("Journal scope.walletAssetId is invalid.");
  }
  if (typeof scope.simulateCheckout !== "boolean" || !Array.isArray(scope.users)) {
    throw new JournalError("Journal scope is invalid.");
  }

  const operations = checkMap(raw, "operations");
  for (const [id, operation] of Object.entries(operations)) {
    if (!isRecord(operation) || operation.operationId !== id) {
      throw new JournalError(`Journal operation ${id} is invalid.`);
    }
    if (!isNonEmptyString(operation.method) || !isNonEmptyString(operation.requestHash) || !isNonEmptyString(operation.idempotencyKey)) {
      throw new JournalError(`Journal operation ${id} is invalid.`);
    }
    if (!["ENROLLMENT", "QUOTE", "CHECKOUT", "WALLET_DEBIT"].includes(operation.resourceType as string)) {
      throw new JournalError(`Journal operation ${id}.resourceType is invalid.`);
    }
    if (!["PENDING", "SUCCEEDED", "REJECTED", "UNKNOWN"].includes(operation.state as string)) {
      throw new JournalError(`Journal operation ${id}.state is invalid.`);
    }
    if (operation.state === "SUCCEEDED" && !isNonEmptyString(operation.resourceId)) {
      throw new JournalError(`Journal operation ${id}.resourceId is invalid.`);
    }
    if (operation.resourceId !== null && !isNonEmptyString(operation.resourceId)) {
      throw new JournalError(`Journal operation ${id}.resourceId is invalid.`);
    }
    if (!isNonEmptyString(operation.createdAt) || !isNonEmptyString(operation.updatedAt)) {
      throw new JournalError(`Journal operation ${id} timestamps are invalid.`);
    }
    checkWrapperError(operation.error, `operations.${id}.error`);
  }

  const keys = checkMap(raw, "idempotencyKeys");
  for (const [key, record] of Object.entries(keys)) {
    if (!isRecord(record) || !isNonEmptyString(record.operationId) || !isNonEmptyString(record.method)) {
      throw new JournalError(`Journal idempotency key ${key} is invalid.`);
    }
    const operation = operations[record.operationId];
    if (!isRecord(operation) || operation.idempotencyKey !== key) {
      throw new JournalError(`Journal idempotency key ${key} does not match its operation.`);
    }
  }

  const enrollments = checkMap(raw, "enrollments");
  for (const [id, enrollment] of Object.entries(enrollments)) {
    if (!isRecord(enrollment) || enrollment.enrollmentId !== id || !isNonEmptyString(enrollment.userId) || !isNonEmptyString(enrollment.ownerId) || !isNonEmptyString(enrollment.status)) {
      throw new JournalError(`Journal enrollment ${id} is invalid.`);
    }
  }

  const quotes = checkMap(raw, "quotes");
  for (const [id, quote] of Object.entries(quotes)) {
    if (
      !isRecord(quote) ||
      quote.quoteId !== id ||
      !isNonEmptyString(quote.groupOrderId) ||
      !Number.isSafeInteger(quote.basketRevision) ||
      !isNonEmptyString(quote.storeId) ||
      !isNonEmptyString(quote.currency) ||
      !Number.isSafeInteger(quote.revision) ||
      (quote.revision as number) < 1 ||
      !isNonEmptyString(quote.fingerprint) ||
      typeof quote.usable !== "boolean" ||
      typeof quote.frozen !== "boolean" ||
      (quote.selectedShippingOptionId !== null && typeof quote.selectedShippingOptionId !== "string")
    ) {
      throw new JournalError(`Journal quote ${id} is invalid.`);
    }
    checkQuoteTerms(quote.terms, `quotes.${id}.terms`);
  }

  const products = checkMap(raw, "products");
  for (const [id, product] of Object.entries(products)) {
    if (!isRecord(product) || product.productId !== id || !isNonEmptyString(product.merchantName)) {
      throw new JournalError(`Journal product ${id} is invalid.`);
    }
    if ((product.storeId !== null && !isNonEmptyString(product.storeId)) || (product.country !== null && !isNonEmptyString(product.country)) || (product.currency !== null && !isNonEmptyString(product.currency))) {
      throw new JournalError(`Journal product ${id} is invalid.`);
    }
  }

  const variants = checkMap(raw, "variants");
  for (const [id, variant] of Object.entries(variants)) {
    if (!isRecord(variant) || variant.variantId !== id || !isNonEmptyString(variant.productId)) {
      throw new JournalError(`Journal variant ${id} is invalid.`);
    }
    if ((variant.storeId !== null && !isNonEmptyString(variant.storeId)) || (variant.currency !== null && !isNonEmptyString(variant.currency))) {
      throw new JournalError(`Journal variant ${id} is invalid.`);
    }
  }

  const cursors = checkMap(raw, "cursors");
  for (const [id, cursor] of Object.entries(cursors)) {
    if (!isRecord(cursor) || !isNonEmptyString(cursor.queryHash) || !isNonEmptyString(cursor.upstreamCursor)) {
      throw new JournalError(`Journal cursor ${id} is invalid.`);
    }
  }

  const checkouts = checkMap(raw, "checkouts");
  for (const [id, checkout] of Object.entries(checkouts)) {
    if (
      !isRecord(checkout) ||
      checkout.checkoutId !== id ||
      !isNonEmptyString(checkout.groupOrderId) ||
      !isNonEmptyString(checkout.purchaseAttemptId) ||
      !isNonEmptyString(checkout.quoteId) ||
      !isNonEmptyString(checkout.purchaserUserId) ||
      (checkout.enrollmentId !== null && !isNonEmptyString(checkout.enrollmentId)) ||
      (checkout.orderId !== null && !isNonEmptyString(checkout.orderId)) ||
      typeof checkout.reconciliationReady !== "boolean"
    ) {
      throw new JournalError(`Journal checkout ${id} is invalid.`);
    }
    checkMoneyMap(checkout.approvedTotal, `checkouts.${id}.approvedTotal`);
    if (checkout.finalAmount !== null) {
      checkMoneyMap(checkout.finalAmount, `checkouts.${id}.finalAmount`);
    }
    if (!isNonEmptyString(checkout.status) || typeof checkout.providerStatus !== "string") {
      throw new JournalError(`Journal checkout ${id} status is invalid.`);
    }
  }

  const debits = checkMap(raw, "debits");
  for (const [id, debit] of Object.entries(debits)) {
    if (
      !isRecord(debit) ||
      debit.debitId !== id ||
      !isNonEmptyString(debit.groupOrderId) ||
      !isNonEmptyString(debit.participantId) ||
      !isNonEmptyString(debit.checkoutId) ||
      !isNonEmptyString(debit.userId) ||
      !isNonEmptyString(debit.accountId) ||
      !isNonEmptyString(debit.allocationId) ||
      !isNonEmptyString(debit.consentRef) ||
      !Number.isSafeInteger(debit.assetDecimals) ||
      !["APPLIED", "NOOP", "REJECTED", "UNKNOWN", "PENDING"].includes(debit.state as string) ||
      (debit.postingId !== null && !isNonEmptyString(debit.postingId)) ||
      !Array.isArray(debit.attempts) ||
      debit.attempts.length === 0 ||
      !Array.isArray(debit.aliasOperationIds)
    ) {
      throw new JournalError(`Journal debit ${id} is invalid.`);
    }
    checkMoneyMap(debit.amount, `debits.${id}.amount`);
    for (const attempt of debit.attempts as unknown[]) {
      if (!isRecord(attempt) || !isNonEmptyString(attempt.operationId) || !isNonEmptyString(attempt.idempotencyKey) || !["PENDING", "APPLIED", "REJECTED", "UNKNOWN"].includes(attempt.outcome as string)) {
        throw new JournalError(`Journal debit ${id} attempt is invalid.`);
      }
      const attemptOperation = operations[attempt.operationId as string];
      if (!isRecord(attemptOperation) || attemptOperation.resourceType !== "WALLET_DEBIT") {
        throw new JournalError(`Journal debit ${id} references a missing attempt operation.`);
      }
    }
    for (const aliasId of debit.aliasOperationIds as unknown[]) {
      if (!isNonEmptyString(aliasId) || !isRecord(operations[aliasId])) {
        throw new JournalError(`Journal debit ${id} references a missing alias operation.`);
      }
    }
  }

  const participants = checkMap(raw, "participants");
  for (const [tupleKey, debitId] of Object.entries(participants)) {
    if (!isNonEmptyString(debitId)) {
      throw new JournalError(`Journal participant entry ${tupleKey} is invalid.`);
    }
    const debit = debits[debitId];
    if (!isRecord(debit) || JSON.stringify([debit.groupOrderId, debit.participantId]) !== tupleKey) {
      throw new JournalError(`Journal participant entry ${tupleKey} does not match its debit.`);
    }
  }

  const discoveredStores = checkMap(raw, "discoveredStores");
  for (const [id, store] of Object.entries(discoveredStores)) {
    if (!isRecord(store) || store.storeId !== id) {
      throw new JournalError(`Journal discovered store ${id} is invalid.`);
    }
    checkStore(store, `discoveredStores.${id}`);
  }

  const timestamp = (value: unknown): boolean => typeof value === "string" && Number.isFinite(Date.parse(value));
  for (const user of scope.users) {
    if (!isRecord(user) || !["userId", "reapUserId", "accountId", "enrollmentOwnerId"].every(key => isNonEmptyString(user[key]))) throw new JournalError("Journal user binding is invalid.");
  }
  for (const [collection, fields] of Object.entries({ operations: ["createdAt", "updatedAt"], enrollments: ["createdAt"], quotes: ["observedAt"], products: ["observedAt"], variants: ["observedAt"], cursors: ["createdAt"], checkouts: ["observedAt"], debits: ["observedAt"] })) {
    for (const record of Object.values(raw[collection] as Record<string, Record<string, unknown>>)) {
      if (!fields.every(field => timestamp(record[field]))) throw new JournalError(`Journal ${collection} timestamp is invalid.`);
    }
  }
  for (const value of Object.values(quotes)) {
    const quote = value as unknown as QuoteRecord;
    if (!timestamp(quote.terms.expiresAt) || quote.basketRevision < 0 || quote.terms.shippingOptions.filter(option => option.selected).length > 1) throw new JournalError("Journal quote terms are invalid.");
    for (const option of quote.terms.shippingOptions) {
      if (typeof option.name !== "string" || !Array.isArray(option.details) || !option.details.every(item => isRecord(item) && typeof item.key === "string" && typeof item.value === "string")) throw new JournalError("Journal shipping option is invalid.");
    }
  }
  for (const value of Object.values(checkouts)) {
    const action = (value as Record<string, unknown>).nextAction;
    if (action !== null && (!isRecord(action) || action.type !== "REDIRECT" || !isNonEmptyString(action.url) || (action.expiresAt !== null && !timestamp(action.expiresAt)))) throw new JournalError("Journal checkout action is invalid.");
  }
  for (const value of Object.values(debits)) {
    const debit = value as unknown as DebitRecord;
    if (debit.assetDecimals < 0 || debit.assetDecimals > 18 || BigInt(debit.amount.minor) < 0n) throw new JournalError("Journal debit amount is invalid.");
    for (const attempt of debit.attempts) {
      if (!timestamp(attempt.at) || (attempt.postingId !== null && !isNonEmptyString(attempt.postingId))) throw new JournalError("Journal debit attempt is invalid.");
    }
    if (debit.balanceAfter !== null && (!isRecord(debit.balanceAfter) || debit.balanceAfter.userId !== debit.userId || debit.balanceAfter.accountId !== debit.accountId || !isMoney(debit.balanceAfter.totalAssetValue) || !isMoney(debit.balanceAfter.totalLiabilities))) throw new JournalError("Journal debit balance is invalid.");
  }
  for (const key of ["operations", "idempotencyKeys", "enrollments", "quotes", "products", "variants", "cursors", "checkouts", "debits", "participants", "discoveredStores"]) {
    raw[key] = Object.assign(Object.create(null), raw[key]);
  }
  return raw as unknown as JournalState;
}

export interface JournalStore {
  acquire(): void;
  load(): JournalState | null;
  save(state: JournalState): void;
  release(): void;
}

export class FileJournalStore implements JournalStore {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly lockToken = randomUUID();
  private lockFd: number | null = null;

  constructor(path: string) {
    this.path = resolve(path);
    this.lockPath = `${this.path}.lock`;
  }

  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      this.lockFd = openSync(this.lockPath, "wx", 0o600);
    } catch {
      throw new JournalError(
        "Journal is locked by another writer. Confirm the previous process is stopped, then remove the stale lock file before reopening.",
      );
    }
    try {
      writeFileSync(this.lockFd, this.lockToken);
    } catch (error) {
      this.release();
      throw error;
    }
  }

  load(): JournalState | null {
    if (!existsSync(this.path)) {
      return null;
    }
    const text = readFileSync(this.path, "utf8");
    try {
      return validateJournal(JSON.parse(text));
    } catch (error) {
      if (error instanceof JournalError) {
        throw error;
      }
      throw new JournalError("Journal file is not valid JSON.");
    }
  }

  save(state: JournalState): void {
    const tmpPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    let fd: number | null = null;
    try {
      fd = openSync(tmpPath, "w", 0o600);
      writeFileSync(fd, JSON.stringify(state));
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmpPath, this.path);
      const dirFd = openSync(dirname(this.path), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
      try {
        unlinkSync(tmpPath);
      } catch {}
      throw error instanceof JournalError ? error : new JournalError("Journal persistence failed.");
    }
  }

  release(): void {
    if (this.lockFd !== null) {
      try {
        closeSync(this.lockFd);
      } catch {}
      this.lockFd = null;
      let owned = false;
      try {
        owned = statSync(this.lockPath).isFile() && readFileSync(this.lockPath, "utf8") === this.lockToken;
      } catch {}
      if (owned) {
        try {
          unlinkSync(this.lockPath);
        } catch {}
      }
    }
  }
}

export class MemoryJournalStore implements JournalStore {
  private saved: string | null = null;

  acquire(): void {}

  load(): JournalState | null {
    if (this.saved === null) {
      return null;
    }
    return validateJournal(JSON.parse(this.saved));
  }

  save(state: JournalState): void {
    this.saved = JSON.stringify(state);
  }

  release(): void {}
}
