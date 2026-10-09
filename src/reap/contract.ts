/**
 * PROPOSED GroupCart boundary, v0.1 — not the Reap SDK or upstream schema.
 * Read reap-wrapper-api.md for validation, ownership and recovery requirements.
 * No implementation or live-provider verification is implied by these types.
 */
export type Id = string;
export type Timestamp = string; // RFC 3339 UTC
export type DecimalUnits = string; // exact decimal asset units, never JS float math
export type Money = { currency: string; minor: string }; // signed integer string
export type DataMode = "LIVE" | "SANDBOX" | "SANDBOX_SIMULATED" | "LOCAL_MOCK";
export type Recovery =
  | "FIX_INPUT" | "REAUTHORIZE" | "REQUOTE" | "RETRY_SAME_OPERATION"
  | "POLL_RESOURCE" | "CONTACT_PROVIDER" | "MANUAL_RECONCILIATION";

export interface WrapperError {
  code: string; // wrapper code, e.g. QUOTE_CHANGED; do not assume a closed enum
  message: string; // safe for private display; no provider secrets/PII
  providerCode: string | null;
  operationId: Id | null;
  outcome: "NOT_SUBMITTED" | "REJECTED" | "UNKNOWN";
  recovery: Recovery;
  retryAfterSeconds: number | null;
}
export type Success<T> = { ok: true; data: T; requestId: Id; mode: DataMode; warnings: string[] };
export type Failure = { ok: false; error: WrapperError; requestId: Id; mode: DataMode };
export type Result<T> = Success<T> | Failure;

/** A supplies these before dispatch. B journals an immutable request hash. */
export interface MutationContext {
  operationId: Id;
  idempotencyKey: string; // stable for retries of the identical command
}
export interface PageInput { cursor?: string; limit?: number }
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface HostedAction {
  type: "REDIRECT";
  url: string; // secret-like; private recipient only
  expiresAt: Timestamp | null; // absent upstream expiry must not be invented
}
export interface FeatureEvidence {
  state: "VERIFIED" | "DISABLED" | "UNVERIFIED";
  reason: string;
  checkedAt: Timestamp | null;
  evidenceRef: string | null;
}
export interface Store {
  storeId: Id; // internal registry identity, not a Reap merchant ID
  providerMerchantName: string;
  country: string;
  currencies: string[];
  eligibility: FeatureEvidence;
}
export interface Capabilities {
  environment: "SANDBOX" | "PRODUCTION";
  reapVersion: string;
  fundingModel: "PROGRAM_FUNDED" | "USER_FUNDED" | "UNKNOWN";
  authorizationMode: "MANAGED" | "EXTERNAL" | "UNKNOWN";
  billingCurrency: string | null;
  walletAssetId: Id | null;
  features: Record<
    "agenticCheckout" | "externalEnrollment" | "productSearch"
    | "virtualAssetDebit" | "externalCheckoutUrl" | "merchantOrderTracking"
    | "merchantOrderCancellation" | "merchantRefunds", FeatureEvidence>;
  stores: Store[];
  maxQuoteLines: 20;
  maxProductDetailsBatch: 10;
}
export interface WalletSnapshot {
  userId: Id;
  accountId: Id;
  accountStatus: "ACTIVE" | "RESTRICTED" | "UNKNOWN";
  providerAccountStatus: string;
  fundingModel: Capabilities["fundingModel"];
  authorizationMode: Capabilities["authorizationMode"];
  availableBalance: Money | null; // null when not a spendable provider figure
  totalAssetValue: Money;
  totalLiabilities: Money;
  eligibleAsset: {
    virtualAssetId: Id;
    units: DecimalUnits;
    withdrawableUnits: DecimalUnits;
    decimals: number;
    rate: string;
    currency: string;
    enabled: boolean;
  } | null;
  debitEligibility: FeatureEvidence;
  observedAt: Timestamp;
}
export interface CardSummary {
  cardId: Id;
  accountId: Id;
  status: "ACTIVE" | "FROZEN" | "BLOCKED" | "EXPIRED" | "UNKNOWN";
  providerStatus: string;
  last4: string;
}
export interface Enrollment {
  enrollmentId: Id;
  userId: Id; // verified local owner mapping
  status: "REQUIRES_ACTION" | "ACTIVE" | "FAILED" | "EXPIRED" | "REVOKED" | "UNKNOWN";
  providerStatus: string;
  paymentMethod: {
    network: string | null;
    last4: string | null;
    expiryMonth: number | null;
    expiryYear: number | null;
  } | null;
  externalCardAvailableBalance: null; // no verified provider operation for this
  nextAction: HostedAction | null;
  observedAt: Timestamp;
}
export interface SearchContext {
  query: string;
  country: string;
  currency: string;
  page?: PageInput; // search limit 1..50
}
export interface ProductSearchInput extends SearchContext {
  storeId?: Id; // maps to upstream merchantPreference.mode ONLY
  minPrice?: Money;
  maxPrice?: Money;
  availableOnly?: boolean;
}
export interface MerchantCandidate {
  storeId: Id | null;
  providerMerchantName: string;
  evidenceProductIds: Id[];
  storeMappingVerified: boolean;
}
export interface MerchantDiscovery extends Page<MerchantCandidate> {
  source: "PRODUCT_SEARCH";
  coverage: "PARTIAL";
}
export interface Variant {
  variantId: Id;
  productId: Id;
  name: string | null;
  options: { name: string; value: string }[];
  catalogPrice: Money;
  available: boolean | null;
  requiresShipping: boolean | null;
  observedAt: Timestamp;
}
export interface ProductSummary {
  productId: Id;
  storeId: Id | null;
  providerMerchantName: string;
  name: string;
  imageUrl: string | null;
  available: boolean | null;
  priceRange: { min: Money; max: Money } | null;
  previewVariant: {
    variantId: Id; name: string | null; price: Money; available: boolean | null;
  } | null;
}
export interface ProductDetails {
  productId: Id;
  name: string;
  description: string | null;
  options: {
    name: string;
    values: { optionId: Id; label: string; available: boolean | null }[];
  }[];
  media: { url: string; type: string | null; altText: string | null }[];
  defaultVariant: Variant | null;
}
export interface ProductDetailsResult {
  products: ProductDetails[];
  errors: { productId: Id; code: string; message: string }[];
}
export interface ShippingAddress {
  firstName: string;
  lastName: string;
  phone: string; // E.164
  addressLine1: string;
  addressLine2?: string;
  city: string;
  region?: string;
  postalCode?: string; // require where necessary for the selected country/store
  country: string;
}
export interface BasketLine { variantId: Id; quantity: number } // positive safe integer
export interface QuoteInput {
  groupOrderId: Id;
  basketRevision: number;
  storeId: Id;
  currency: string;
  email: string;
  shippingAddress: ShippingAddress;
  lines: BasketLine[]; // 1..20 consolidated distinct variants, one verified store
}
export interface Quote {
  quoteId: Id;
  groupOrderId: Id;
  basketRevision: number;
  storeId: Id;
  revision: number; // wrapper version, monotonically increases on changed terms
  fingerprint: string; // produced/persisted by B; passed unchanged by A
  expiresAt: Timestamp;
  shippingOptions: {
    id: Id; name: string; selected: boolean; price: Money;
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
  itemPricing: "AGGREGATE_ONLY" | "VERIFIED_LINES";
  verifiedLines: {
    variantId: Id; quantity: number; itemSubtotal: Money; evidenceRef: string;
  }[] | null; // unsupported by base quote schema; requires additional evidence
  observedAt: Timestamp;
}
export interface CheckoutInput {
  groupOrderId: Id;
  purchaseAttemptId: Id;
  quoteId: Id;
  expectedFingerprint: string;
  purchaserUserId: Id;
  enrollmentId: Id;
  approvedTotal: Money;
  returnUrl: string;
}
export interface Checkout {
  checkoutId: Id;
  groupOrderId: Id;
  purchaseAttemptId: Id;
  quoteId: Id;
  enrollmentId: Id | null;
  status: "REQUIRES_ACTION" | "PROCESSING" | "COMPLETED" | "FAILED" | "EXPIRED" | "UNKNOWN";
  providerStatus: string;
  orderId: string | null;
  finalAmount: Money | null;
  nextAction: HostedAction | null;
  reconciliationReady: boolean;
  observedAt: Timestamp;
}
export interface WalletDebitInput {
  groupOrderId: Id;
  checkoutId: Id;
  participantId: Id;
  userId: Id;
  allocationId: Id;
  consentRef: Id;
  approvedAmount: Money;
  amount: Money; // must equal approvedAmount; positive except explicit zero NOOP
}
export interface WalletDebit {
  debitId: Id;
  operationId: Id;
  groupOrderId: Id;
  participantId: Id;
  amount: Money;
  state: "APPLIED" | "NOOP" | "REJECTED" | "UNKNOWN";
  postingId: Id | null;
  balanceAfter: WalletSnapshot | null;
  observedAt: Timestamp;
}
export interface Operation {
  operationId: Id;
  state: "PENDING" | "SUCCEEDED" | "REJECTED" | "UNKNOWN";
  resourceType: "ENROLLMENT" | "QUOTE" | "CHECKOUT" | "WALLET_DEBIT";
  resourceId: Id | null;
  error: WrapperError | null;
  updatedAt: Timestamp;
}

/** Internal service interface. Preconditions and recovery rules are in reap-wrapper-api.md. */
export interface ReapWrapper {
  getCapabilities(): Promise<Result<Capabilities>>;
  getWallet(userId: Id): Promise<Result<WalletSnapshot>>;
  listCards(userId: Id, page?: PageInput): Promise<Result<Page<CardSummary>>>;
  listEnrollments(userId: Id, page?: PageInput): Promise<Result<Page<Enrollment>>>;
  getEnrollment(userId: Id, enrollmentId: Id): Promise<Result<Enrollment>>;
  createEnrollment(input: {
    userId: Id; email: string; returnUrl: string;
  }, context: MutationContext): Promise<Result<Enrollment>>;
  revokeEnrollment(userId: Id, enrollmentId: Id, context: MutationContext): Promise<Result<Enrollment>>;
  discoverMerchants(input: SearchContext): Promise<Result<MerchantDiscovery>>;
  searchProducts(input: ProductSearchInput): Promise<Result<Page<ProductSummary>>>;
  getProductDetails(productIds: Id[]): Promise<Result<ProductDetailsResult>>;
  resolveVariant(productId: Id, optionIds: Id[]): Promise<Result<Variant>>;
  createQuote(input: QuoteInput, context: MutationContext): Promise<Result<Quote>>;
  getQuote(quoteId: Id): Promise<Result<Quote>>;
  selectShippingOption(input: {
    quoteId: Id; expectedFingerprint: string; shippingOptionId: Id;
  }, context: MutationContext): Promise<Result<Quote>>;
  createCheckout(input: CheckoutInput, context: MutationContext): Promise<Result<Checkout>>;
  getCheckout(checkoutId: Id): Promise<Result<Checkout>>;
  debitWallet(input: WalletDebitInput, context: MutationContext): Promise<Result<WalletDebit>>;
  getWalletDebit(debitId: Id): Promise<Result<WalletDebit>>;
  retryWalletDebit(debitId: Id, context: MutationContext): Promise<Result<WalletDebit>>;
  getOperation(operationId: Id): Promise<Result<Operation>>;
}
