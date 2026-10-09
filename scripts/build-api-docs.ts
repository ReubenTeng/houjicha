import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { createGenerator } from 'ts-json-schema-generator';
import { renderApiDocs } from './render-api-docs.js';

const root = fileURLToPath(new URL('../', import.meta.url));
type Schema = Record<string, any>;
const contract = readFileSync(`${root}docs/reap-wrapper-contract.ts`, 'utf8');
const source = ts.createSourceFile('contract.ts', contract, ts.ScriptTarget.Latest, true);
const service = source.statements.find(s => ts.isInterfaceDeclaration(s) && s.name.text === 'ReapWrapper') as ts.InterfaceDeclaration;
const methods = service.members.filter(ts.isMethodSignature);
const exports = source.statements.filter(s => ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)).map(s => s.name.text);
const bindings = `/** Generated from ReapWrapper function signatures. Do not edit. */\nimport type { ${exports.join(', ')} } from './reap-wrapper-contract.js';\nexport interface ServiceSchemas {\n${methods.map(m => {
  const name = m.name.getText(source);
  const args = m.parameters.map(p => `${p.name.getText(source)}${p.questionToken ? '?' : ''}: ${p.type!.getText(source)}`).join('; ');
  const result = (m.type as ts.TypeReferenceNode).typeArguments![0]!.getText(source);
  return `  ${name}Arguments: { ${args} };\n  ${name}Return: ${result};`;
}).join('\n')}\n}\n`;
const bindingPath = `${root}docs/reap-wrapper-schema.ts`;
if (process.argv.includes('--check')) assert.equal(readFileSync(bindingPath, 'utf8'), bindings, 'Function schema bindings are stale');
else writeFileSync(bindingPath, bindings);
const generated = createGenerator({path: bindingPath, tsconfig: `${root}tsconfig.docs.json`, type: 'ServiceSchemas', expose: 'export', jsDoc: 'extended', additionalProperties: false}).createSchema('ServiceSchemas') as Schema;
const definitions = generated.definitions as Record<string, Schema>;
const schemas = Object.fromEntries(Object.entries(definitions).map(([name, value]) => [encodeURIComponent(name), value]));
delete schemas.Id?.description;
const serviceSchemas = definitions.ServiceSchemas!.properties;
const money = definitions.Money!;
Object.assign(money.properties.minor, {pattern: '^-?(0|[1-9][0-9]*)$', description: 'Exact integer minor units. Commands require nonnegative amounts.'});
Object.assign(money.properties.currency, {pattern: '^[A-Z]{3}$'});
Object.assign(definitions.QuoteInput!.properties.lines, {minItems: 1, maxItems: 20});
Object.assign(definitions.BasketLine!.properties.quantity, {type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER});
type Operation = { id: string; tag: string; summary: string; mutation?: boolean; description: string };
const operations: Operation[] = [
  { id: 'getCapabilities', tag: 'Setup', summary: 'Read verified integration capabilities', description: 'Wrapper configuration registry, not a provider operation. Untested capabilities remain UNVERIFIED. Merchant/currency availability requires project-specific evidence.' },
  { id: 'getWallet', tag: 'Wallets', summary: 'Read account value and debit eligibility', description: 'Read mapped account, balance and eligible virtual-asset headroom. Does not reserve money or include orchestration holds. External-card available credit is not exposed.' },
  { id: 'listCards', tag: 'Setup', summary: 'List masked Reap-issued cards', description: 'Diagnostics for issued cards. Participants paying virtual credits do not need issued cards. Never return PAN/CVV.' },
  { id: 'listEnrollments', tag: 'Enrollments', summary: 'List a purchaser’s stored enrollments', description: 'Scope provider lookup to the verified owner mapping; an active enrollment does not guarantee sufficient card funds.' },
  { id: 'getEnrollment', tag: 'Enrollments', summary: 'Refresh enrollment readiness', description: 'Check owner and provider status after the hosted step. A return redirect is not proof of activation.' },
  { id: 'createEnrollment', tag: 'Enrollments', summary: 'Start external-card enrollment', mutation: true, description: 'Uses EXTERNAL enrollment with a CLIENT_REFERENCE owner. Send hosted action only to the designated purchaser. REAP_CARD/BIN_SPONSOR are gated pending verification.' },
  { id: 'revokeEnrollment', tag: 'Enrollments', summary: 'Revoke a stored enrollment', mutation: true, description: 'Explicit card removal. This is not merchant order cancellation, refund, or timeout recovery. Pass the identifiers and mutation context.' },
  { id: 'discoverMerchants', tag: 'Discovery', summary: 'Discover merchant candidates from product search', description: 'Derived, partial discovery; not a complete or geospatial merchant directory. An unmapped merchant cannot open a group. Read-only function; no mutation context.' },
  { id: 'searchProducts', tag: 'Discovery', summary: 'Search a store’s products', description: 'storeId maps to merchantPreference.mode ONLY. Country, currency and merchant must be supported. Prices are catalog estimates; no stock reservation. Search pages allow 1–50 results.' },
  { id: 'getProductDetails', tag: 'Discovery', summary: 'Get details and options for up to ten products', description: 'Preserve per-product errors alongside successful products. Do not hide partial failures.' },
  { id: 'resolveVariant', tag: 'Discovery', summary: 'Resolve selected product options', description: 'Quotes require a purchasable variant ID. Unknown availability is not in-stock. A valid default variant can avoid this call.' },
  { id: 'createQuote', tag: 'Quotes', summary: 'Quote the consolidated single-store basket', mutation: true, description: 'Require 1–20 distinct consolidated variants and organiser address. Keep participant attribution in orchestration. Provider quote totals do not establish per-item checkout prices; default itemPricing is AGGREGATE_ONLY.' },
  { id: 'getQuote', tag: 'Quotes', summary: 'Refresh a quote and its fingerprint', description: 'Preserve current expiry. Changed terms produce a new local revision/fingerprint and invalidate stale approvals. A read does not extend the quote lifetime.' },
  { id: 'selectShippingOption', tag: 'Quotes', summary: 'Reprice using a selected delivery option', mutation: true, description: 'Validate expected fingerprint and serialize against checkout. Reapprove changed allocations. QUOTE_REPLACEMENT_REQUIRED requires a new quote.' },
  { id: 'createCheckout', tag: 'Checkout', summary: 'Submit one merchant checkout', mutation: true, description: 'Require final participant approvals/holds in orchestration. Refresh enrollment and quote; exact total, currency and fingerprint must match. Deduplicate purchaseAttemptId durably. One purchaser card funds the merchant order. A hosted action or absent action is not proof of success.' },
  { id: 'getCheckout', tag: 'Checkout', summary: 'Poll merchant purchase outcome', description: 'Only provider COMPLETED establishes order placement. Keep reservations on uncertainty. Require orderId and finalAmount before reconciliation. This function does not report parcel delivery.' },
  { id: 'debitWallet', tag: 'Wallets', summary: 'Debit one participant’s approved share', mutation: true, description: 'Require completed checkout, eligible fixed-rate virtual asset and exact approved amount/currency. Map to WITHDRAWAL, not SETTLEMENT. Unique groupOrderId+participantId prevents repeat capture. Zero share is NOOP. Separate postings are not atomic across participants and do not reimburse the external purchaser.' },
  { id: 'getWalletDebit', tag: 'Wallets', summary: 'Recover a participant debit', description: 'Read wrapper journal and provider posting when known. A failed balance refresh must not repeat a successful debit. States here are wrapper states, not a Reap posting-status enum.' },
  { id: 'retryWalletDebit', tag: 'Wallets', summary: 'Retry a definitively rejected debit', mutation: true, description: 'New mutation context; original amount/account/consent identity stays fixed. APPLIED/NOOP returns the existing result. UNKNOWN blocks a new provider attempt until reconciled.' },
  { id: 'getOperation', tag: 'Recovery', summary: 'Read a durable operation record', description: 'Recover after connection loss or process restart. Provider idempotency expires after 24 hours; wrapper records must outlive it. Never treat unknown outcome as permission for a fresh purchase.' },
];
assert.deepEqual(operations.map(op => op.id).sort(), methods.map(m => m.name.getText(source)).sort(), 'Every function must be documented exactly once');
const functions = operations.map(op => {
  const method = methods.find(m => m.name.getText(source) === op.id)!;
  return {...op, signature: method.getText(source), arguments: serviceSchemas[`${op.id}Arguments`], returns: serviceSchemas[`${op.id}Return`]};
});
const output = renderApiDocs({functions, schemas});
const target = `${root}docs/reap-wrapper-reference.html`;
if (process.argv.includes('--check')) {
  assert.equal(readFileSync(target, 'utf8'), output, 'Reference is stale; run npm run docs:generate');
  console.log(`Internal interface reference is current: ${functions.length} functions, all signatures covered.`);
} else {
  writeFileSync(target, output);
  console.log(`Wrote ${target}: ${functions.length} functions.`);
}
