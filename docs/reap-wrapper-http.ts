/** Concrete HTTP bodies and responses used to generate Swagger from our TS contract. */
import type {
  Capabilities, CardSummary, Checkout, CheckoutInput, Enrollment, Failure,
  MerchantDiscovery, Operation, Page, ProductDetailsResult, ProductSearchInput,
  ProductSummary, Quote, QuoteInput, SearchContext, Success, Variant,
  WalletDebit, WalletDebitInput, WalletSnapshot,
} from './reap-wrapper-contract.js';

export interface EnrollmentInput { userId: string; email: string; returnUrl: string }
export interface ProductDetailsInput { productIds: string[] }
export interface VariantInput { productId: string; optionIds: string[] }
/** quoteId is carried only in the HTTP path. */
export interface ShippingSelectionInput { expectedFingerprint: string; shippingOptionId: string }

/** This concrete root makes generics available to the schema generator. */
export interface HttpSchemas {
  EnrollmentInput: EnrollmentInput;
  SearchContext: SearchContext;
  ProductSearchInput: ProductSearchInput;
  ProductDetailsInput: ProductDetailsInput;
  VariantInput: VariantInput;
  QuoteInput: QuoteInput;
  ShippingSelectionInput: ShippingSelectionInput;
  CheckoutInput: CheckoutInput;
  WalletDebitInput: WalletDebitInput;
  CapabilitiesResponse: Success<Capabilities>;
  WalletResponse: Success<WalletSnapshot>;
  CardsResponse: Success<Page<CardSummary>>;
  EnrollmentsResponse: Success<Page<Enrollment>>;
  EnrollmentResponse: Success<Enrollment>;
  MerchantDiscoveryResponse: Success<MerchantDiscovery>;
  ProductsResponse: Success<Page<ProductSummary>>;
  ProductDetailsResponse: Success<ProductDetailsResult>;
  VariantResponse: Success<Variant>;
  QuoteResponse: Success<Quote>;
  CheckoutResponse: Success<Checkout>;
  WalletDebitResponse: Success<WalletDebit>;
  OperationResponse: Success<Operation>;
  Failure: Failure;
}
