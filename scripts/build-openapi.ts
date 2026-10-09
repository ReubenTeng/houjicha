import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

const root = fileURLToPath(new URL('../', import.meta.url));
// JSON Schema is recursive and intentionally heterogeneous.
type Schema = Record<string, any>;
const generated = createGenerator({
  path: `${root}docs/reap-wrapper-http.ts`, tsconfig: `${root}tsconfig.docs.json`,
  type: 'HttpSchemas', expose: 'export', jsDoc: 'extended', additionalProperties: false,
}).createSchema('HttpSchemas') as Schema;
const definitions = generated.definitions as Record<string, Schema>;
const names = Object.fromEntries(Object.keys(definitions).map(name => [name, name.replace(/[^a-zA-Z0-9._-]/g, '_')]));
if (new Set(Object.values(names)).size !== Object.keys(names).length) throw new Error('Schema name collision');
function rewrite(value: any): any {
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === '$ref') {
      const name = decodeURIComponent(String(item).replace('#/definitions/', ''));
      if (!names[name]) throw new Error(`Unknown definition ${name}`);
      return [key, `#/components/schemas/${names[name]}`];
    }
    return [key, rewrite(item)];
  }));
  return value;
}
const schemas: Record<string, Schema> = Object.fromEntries(Object.entries(definitions).map(([name, schema]) => [names[name]!, rewrite(schema)]));
const http = schemas.HttpSchemas!;
const schemaFor = (name: string): Schema => {
  const schema = http.properties[name];
  if (!schema) throw new Error(`No HTTP schema ${name}`);
  return schema;
};
const props = (name: string): Schema => schemas[names[name] ?? name]!.properties;
Object.assign(props('Money').currency, { pattern: '^[A-Z]{3}$', examples: ['SGD'] });
Object.assign(props('Money').minor, { pattern: '^-?(0|[1-9][0-9]*)$', examples: ['625'], description: 'Integer minor units as a string, not a float. Negative values are permitted for balances; purchase/debit requests must be nonnegative.' });
for (const name of ['QuoteInput', 'Quote']) Object.assign(props(name).basketRevision, { type: 'integer', minimum: 0 });
Object.assign(props('BasketLine').quantity, { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
Object.assign(props('QuoteInput').lines, { minItems: 1, maxItems: 20, description: 'Consolidated distinct variants from exactly one verified store. No automatic order splitting.' });
Object.assign(props('ProductDetailsInput').productIds, { minItems: 1, maxItems: 10 });
Object.assign(props('VariantInput').optionIds, { minItems: 1 });
Object.assign(props('PageInput').limit, { type: 'integer', minimum: 1, maximum: 50, description: 'Search-page size. GET card/enrollment lists use separate query parameters.' });
for (const name of ['EnrollmentInput', 'CheckoutInput']) Object.assign(props(name).returnUrl, { format: 'uri', pattern: '^https://' });
for (const name of ['EnrollmentInput', 'QuoteInput']) Object.assign(props(name).email, { format: 'email' });
Object.assign(props('ShippingAddress').phone, { pattern: '^\\+[1-9][0-9]{6,14}$' });
Object.assign(props('ShippingAddress').country, { pattern: '^[A-Z]{2}$' });
for (const name of ['QuoteInput', 'SearchContext', 'ProductSearchInput']) {
  if (props(name)?.currency) Object.assign(props(name).currency, { pattern: '^[A-Z]{3}$' });
  if (props(name)?.country) Object.assign(props(name).country, { pattern: '^[A-Z]{2}$' });
}
// These restrictions are specific to commands, not signed financial snapshots.
const nonnegative = { allOf: [{ $ref: '#/components/schemas/Money' }, { type: 'object', properties: { minor: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' } } }] };
props('CheckoutInput').approvedTotal = nonnegative;
props('WalletDebitInput').amount = nonnegative;
props('WalletDebitInput').approvedAmount = nonnegative;

type Operation = { id: string; method: 'get' | 'post'; path: string; tag: string; summary: string; response: string; body?: string; mutation?: boolean; page?: boolean; description: string };
const operations: Operation[] = [
  { id: 'getCapabilities', method: 'get', path: '/capabilities', tag: 'Setup', summary: 'Read verified integration capabilities', response: 'CapabilitiesResponse', description: 'Wrapper configuration registry, not a Reap endpoint. Untested capabilities remain UNVERIFIED. Merchant/currency availability requires project-specific evidence.' },
  { id: 'getWallet', method: 'get', path: '/users/{userId}/wallet', tag: 'Wallets', summary: 'Read account value and debit eligibility', response: 'WalletResponse', description: 'Read mapped account, balance and eligible virtual-asset headroom. Does not reserve money or include orchestration holds. External-card available credit is not exposed.' },
  { id: 'listCards', method: 'get', path: '/users/{userId}/cards', tag: 'Setup', summary: 'List masked Reap-issued cards', response: 'CardsResponse', page: true, description: 'Diagnostics for issued cards. Participants paying virtual credits do not need issued cards. Never return PAN/CVV.' },
  { id: 'listEnrollments', method: 'get', path: '/users/{userId}/enrollments', tag: 'Enrollments', summary: 'List a purchaser’s stored enrollments', response: 'EnrollmentsResponse', page: true, description: 'Scope provider lookup to the verified owner mapping; an active enrollment does not guarantee sufficient card funds.' },
  { id: 'getEnrollment', method: 'get', path: '/users/{userId}/enrollments/{enrollmentId}', tag: 'Enrollments', summary: 'Refresh enrollment readiness', response: 'EnrollmentResponse', description: 'Check owner and provider status after the hosted step. A return redirect is not proof of activation.' },
  { id: 'createEnrollment', method: 'post', path: '/enrollments', tag: 'Enrollments', summary: 'Start external-card enrollment', response: 'EnrollmentResponse', body: 'EnrollmentInput', mutation: true, description: 'Uses EXTERNAL enrollment with a CLIENT_REFERENCE owner. Send hosted action only to the designated purchaser. REAP_CARD/BIN_SPONSOR are gated pending verification.' },
  { id: 'revokeEnrollment', method: 'post', path: '/users/{userId}/enrollments/{enrollmentId}/revoke', tag: 'Enrollments', summary: 'Revoke a stored enrollment', response: 'EnrollmentResponse', mutation: true, description: 'Explicit card removal. This is not merchant order cancellation, refund, or timeout recovery. No request body.' },
  { id: 'discoverMerchants', method: 'post', path: '/merchants/search', tag: 'Discovery', summary: 'Discover merchant candidates from product search', response: 'MerchantDiscoveryResponse', body: 'SearchContext', description: 'Derived, partial discovery; not a complete or geospatial merchant directory. An unmapped merchant cannot open a group. Read-only POST; no mutation headers.' },
  { id: 'searchProducts', method: 'post', path: '/products/search', tag: 'Discovery', summary: 'Search a store’s products', response: 'ProductsResponse', body: 'ProductSearchInput', description: 'storeId maps to merchantPreference.mode ONLY. Country, currency and merchant must be supported. Prices are catalog estimates; no stock reservation. Search pages allow 1–50 results.' },
  { id: 'getProductDetails', method: 'post', path: '/products/details', tag: 'Discovery', summary: 'Get details and options for up to ten products', response: 'ProductDetailsResponse', body: 'ProductDetailsInput', description: 'Preserve per-product errors alongside successful products. Do not hide partial failures.' },
  { id: 'resolveVariant', method: 'post', path: '/products/variant', tag: 'Discovery', summary: 'Resolve selected product options', response: 'VariantResponse', body: 'VariantInput', description: 'Quotes require a purchasable variant ID. Unknown availability is not in-stock. A valid default variant can avoid this call.' },
  { id: 'createQuote', method: 'post', path: '/quotes', tag: 'Quotes', summary: 'Quote the consolidated single-store basket', response: 'QuoteResponse', body: 'QuoteInput', mutation: true, description: 'Require 1–20 distinct consolidated variants and organiser address. Keep participant attribution in orchestration. Provider quote totals do not establish per-item checkout prices; default itemPricing is AGGREGATE_ONLY.' },
  { id: 'getQuote', method: 'get', path: '/quotes/{quoteId}', tag: 'Quotes', summary: 'Refresh a quote and its fingerprint', response: 'QuoteResponse', description: 'Preserve current expiry. Changed terms produce a new local revision/fingerprint and invalidate stale approvals. A read does not extend the quote lifetime.' },
  { id: 'selectShippingOption', method: 'post', path: '/quotes/{quoteId}/shipping-option', tag: 'Quotes', summary: 'Reprice using a selected delivery option', response: 'QuoteResponse', body: 'ShippingSelectionInput', mutation: true, description: 'quoteId is in the HTTP path only. Validate expected fingerprint and serialize against checkout. Reapprove changed allocations. QUOTE_REPLACEMENT_REQUIRED requires a new quote.' },
  { id: 'createCheckout', method: 'post', path: '/checkouts', tag: 'Checkout', summary: 'Submit one merchant checkout', response: 'CheckoutResponse', body: 'CheckoutInput', mutation: true, description: 'Require final participant approvals/holds in orchestration. Refresh enrollment and quote; exact total, currency and fingerprint must match. Deduplicate purchaseAttemptId durably. One purchaser card funds the merchant order. A hosted action or absent action is not proof of success.' },
  { id: 'getCheckout', method: 'get', path: '/checkouts/{checkoutId}', tag: 'Checkout', summary: 'Poll merchant purchase outcome', response: 'CheckoutResponse', description: 'Only provider COMPLETED establishes order placement. Keep reservations on uncertainty. Require orderId and finalAmount before reconciliation. This endpoint does not report parcel delivery.' },
  { id: 'debitWallet', method: 'post', path: '/wallet-debits', tag: 'Wallets', summary: 'Debit one participant’s approved share', response: 'WalletDebitResponse', body: 'WalletDebitInput', mutation: true, description: 'Require completed checkout, eligible fixed-rate virtual asset and exact approved amount/currency. Map to WITHDRAWAL, not SETTLEMENT. Unique groupOrderId+participantId prevents repeat capture. Zero share is NOOP. Separate postings are not atomic across participants and do not reimburse the external purchaser.' },
  { id: 'getWalletDebit', method: 'get', path: '/wallet-debits/{debitId}', tag: 'Wallets', summary: 'Recover a participant debit', response: 'WalletDebitResponse', description: 'Read wrapper journal and provider posting when known. A failed balance refresh must not repeat a successful debit. States here are wrapper states, not a Reap posting-status enum.' },
  { id: 'retryWalletDebit', method: 'post', path: '/wallet-debits/{debitId}/retry', tag: 'Wallets', summary: 'Retry a definitively rejected debit', response: 'WalletDebitResponse', mutation: true, description: 'New operation headers, no body; original amount/account/consent identity stays fixed. APPLIED/NOOP returns the existing result. UNKNOWN blocks a new provider attempt until reconciled.' },
  { id: 'getOperation', method: 'get', path: '/operations/{operationId}', tag: 'Recovery', summary: 'Read a durable operation record', response: 'OperationResponse', description: 'Recover after connection loss or process restart. Provider idempotency expires after 24 hours; wrapper records must outlive it. Never treat unknown outcome as permission for a fresh purchase.' },
];
const sampleMoney = { currency: 'SGD', minor: '2400' };
const examples: Record<string, any> = {
  EnrollmentInput: { userId: 'user_demo', email: 'buyer@example.com', returnUrl: 'https://app.example.com/enrollment/return' },
  SearchContext: { query: 'bread', country: 'SG', currency: 'SGD', page: { limit: 20 } },
  ProductSearchInput: { query: 'bread', country: 'SG', currency: 'SGD', storeId: 'store_demo', availableOnly: true, page: { limit: 20 } },
  ProductDetailsInput: { productIds: ['product_demo'] },
  VariantInput: { productId: 'product_demo', optionIds: ['option_demo'] },
  QuoteInput: { groupOrderId: 'group_demo', basketRevision: 1, storeId: 'store_demo', currency: 'SGD', email: 'buyer@example.com', shippingAddress: { firstName: 'Demo', lastName: 'Buyer', phone: '+6560000000', addressLine1: '1 Example Street', city: 'Singapore', postalCode: '000000', country: 'SG' }, lines: [{ variantId: 'variant_demo', quantity: 2 }] },
  ShippingSelectionInput: { expectedFingerprint: 'fingerprint_demo', shippingOptionId: 'shipping_demo' },
  CheckoutInput: { groupOrderId: 'group_demo', purchaseAttemptId: 'attempt_demo', quoteId: 'quote_demo', expectedFingerprint: 'fingerprint_demo', purchaserUserId: 'user_demo', enrollmentId: 'enrollment_demo', approvedTotal: sampleMoney, returnUrl: 'https://app.example.com/checkout/return' },
  WalletDebitInput: { groupOrderId: 'group_demo', checkoutId: 'checkout_demo', participantId: 'participant_demo', userId: 'user_demo', allocationId: 'allocation_demo', consentRef: 'consent_demo', approvedAmount: { currency: 'SGD', minor: '600' }, amount: { currency: 'SGD', minor: '600' } },
};
const paths: Record<string, any> = {};
for (const op of operations) {
  const parameters: any[] = [...op.path.matchAll(/\{(\w+)\}/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: { type: 'string', minLength: 1 } }));
  if (op.mutation) parameters.push(...['OperationId', 'IdempotencyKey'].map(name => ({ $ref: `#/components/parameters/${name}` })));
  if (op.page) parameters.push({ name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } });
  const responses: Schema = { '200': { description: 'Current resource or completed command. Inspect resource state; HTTP 200 alone is not payment success.', content: { 'application/json': { schema: schemaFor(op.response) } } } };
  for (const [status, description] of Object.entries({ '401': 'Missing/invalid internal service credentials', '403': 'Ownership or access denied', '404': 'Resource or mapping not found', '409': 'Stale quote, operation conflict or unmet precondition', '422': 'Invalid input', '429': 'Rate limited', '502': 'Invalid upstream response', '503': 'Provider unavailable or capability unverified' })) {
    responses[status] = { description, content: { 'application/json': { schema: schemaFor('Failure') } } };
  }
  responses['429'].headers = { 'Retry-After': { description: 'Seconds to wait before retrying', schema: { type: 'integer', minimum: 0 } } };
  if (op.mutation) responses['202'] = {
    description: 'Journaled but unresolved upstream outcome. Use error.operationId to recover; do not create a replacement command.',
    content: { 'application/json': { schema: schemaFor('Failure'), example: { ok: false, error: { code: 'OPERATION_OUTCOME_UNKNOWN', message: 'Recover the existing operation before retrying.', providerCode: null, operationId: 'operation_demo', outcome: 'UNKNOWN', recovery: 'POLL_RESOURCE', retryAfterSeconds: 5 }, requestId: 'request_demo', mode: 'LOCAL_MOCK' } } },
  };
  const operation: Schema = { operationId: op.id, tags: [op.tag], summary: op.summary, description: op.description, parameters, responses };
  if (op.body) operation.requestBody = { required: true, content: { 'application/json': { schema: schemaFor(op.body), example: examples[op.body] } } };
  paths[op.path] = { ...paths[op.path], [op.method]: operation };
}
delete schemas.HttpSchemas;
const spec = {
  openapi: '3.1.0',
  info: { title: 'GroupCart — Reap Wrapper', version: '0.1.0', description: 'PROPOSED INTERNAL CONTRACT — not the Reap provider API. TypeScript is the source of payload schemas. This docs server does not implement payment routes. All examples are fictional; SG/SGD and merchants require verification. Orchestration owns group matching, baskets, approvals and allocation; the wrapper owns provider calls and durable operation recovery. See reap-wrapper-api.md for money-model limits and unresolved provider questions.' },
  servers: [{ url: '/internal/reap/v1', description: 'Future internal wrapper base path (not implemented by the docs server)' }],
  security: [{ ServiceBearer: [] }],
  tags: [...new Set(operations.map(op => op.tag))].map(name => ({ name })), paths,
  components: { schemas, securitySchemes: { ServiceBearer: { type: 'http', scheme: 'bearer', description: 'Internal service credential; never enter the Reap API key here.' } }, parameters: {
    OperationId: { name: 'X-Operation-Id', in: 'header', required: true, schema: { type: 'string', minLength: 1 }, description: 'Persist before dispatch. Reuse for recovery of the same command.' },
    IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 255 }, description: 'Stable for retries of the identical command. Provider caching does not replace durable wrapper uniqueness.' },
  } },
};
const output = `${JSON.stringify(spec, null, 2)}\n`;
const target = `${root}docs/reap-wrapper.openapi.json`;
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('OpenAPI is stale; run npm run docs:generate');
  console.log(`OpenAPI is current: ${operations.length} operations.`);
} else {
  writeFileSync(target, output);
  console.log(`Wrote ${target}: ${operations.length} operations.`);
}
