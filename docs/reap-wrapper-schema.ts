/** Generated from ReapWrapper function signatures. Do not edit. */
import type { Id, Timestamp, DecimalUnits, Money, DataMode, Recovery, WrapperError, Success, Failure, Result, MutationContext, PageInput, Page, HostedAction, FeatureEvidence, Store, Capabilities, WalletSnapshot, CardSummary, Enrollment, SearchContext, ProductSearchInput, MerchantCandidate, MerchantDiscovery, Variant, ProductSummary, ProductDetails, ProductDetailsResult, ShippingAddress, BasketLine, QuoteInput, Quote, CheckoutInput, Checkout, WalletDebitInput, WalletDebit, Operation, ReapWrapper } from './reap-wrapper-contract.js';
export interface ServiceSchemas {
  getCapabilitiesArguments: {  };
  getCapabilitiesReturn: Result<Capabilities>;
  getWalletArguments: { userId: Id };
  getWalletReturn: Result<WalletSnapshot>;
  listCardsArguments: { userId: Id; page?: PageInput };
  listCardsReturn: Result<Page<CardSummary>>;
  listEnrollmentsArguments: { userId: Id; page?: PageInput };
  listEnrollmentsReturn: Result<Page<Enrollment>>;
  getEnrollmentArguments: { userId: Id; enrollmentId: Id };
  getEnrollmentReturn: Result<Enrollment>;
  createEnrollmentArguments: { input: {
    userId: Id; email: string; returnUrl: string;
  }; context: MutationContext };
  createEnrollmentReturn: Result<Enrollment>;
  revokeEnrollmentArguments: { userId: Id; enrollmentId: Id; context: MutationContext };
  revokeEnrollmentReturn: Result<Enrollment>;
  discoverMerchantsArguments: { input: SearchContext };
  discoverMerchantsReturn: Result<MerchantDiscovery>;
  searchProductsArguments: { input: ProductSearchInput };
  searchProductsReturn: Result<Page<ProductSummary>>;
  getProductDetailsArguments: { productIds: Id[] };
  getProductDetailsReturn: Result<ProductDetailsResult>;
  resolveVariantArguments: { productId: Id; optionIds: Id[] };
  resolveVariantReturn: Result<Variant>;
  createQuoteArguments: { input: QuoteInput; context: MutationContext };
  createQuoteReturn: Result<Quote>;
  getQuoteArguments: { quoteId: Id };
  getQuoteReturn: Result<Quote>;
  selectShippingOptionArguments: { input: {
    quoteId: Id; expectedFingerprint: string; shippingOptionId: Id;
  }; context: MutationContext };
  selectShippingOptionReturn: Result<Quote>;
  createCheckoutArguments: { input: CheckoutInput; context: MutationContext };
  createCheckoutReturn: Result<Checkout>;
  getCheckoutArguments: { checkoutId: Id };
  getCheckoutReturn: Result<Checkout>;
  debitWalletArguments: { input: WalletDebitInput; context: MutationContext };
  debitWalletReturn: Result<WalletDebit>;
  getWalletDebitArguments: { debitId: Id };
  getWalletDebitReturn: Result<WalletDebit>;
  retryWalletDebitArguments: { debitId: Id; context: MutationContext };
  retryWalletDebitReturn: Result<WalletDebit>;
  getOperationArguments: { operationId: Id };
  getOperationReturn: Result<Operation>;
}
