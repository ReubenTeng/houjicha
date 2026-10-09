import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoReapWrapper, DemoProvider } from './demo.js';
import { createReapWrapperInternal } from './wrapper.js';
import { loadReapConfig } from './config.js';
import type { ManagedReapWrapper } from './config.js';
import type { Result, QuoteInput, WalletDebitInput } from './contract.js';
import { createReapWithMockUsers } from './mock-users.js';
import { createReapOrchestrationPorts } from './orchestration.js';
import { FileJournalStore, sha256Hex, canonicalJson } from './journal.js';
import { minorToUnits, providerAmountToMinor } from './money.js';

const dirs: string[] = []; const wrappers: ManagedReapWrapper[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'reap-test-')); dirs.push(path); return path; };
const unwrap = <T>(r: Result<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.data; };
const context = (id: string) => ({ operationId: id, idempotencyKey: id });
const user = 'mock_user_reuben';
const config = () => loadReapConfig({ REAP_API_KEY: 'test', REAP_PROJECT_REF: 'test', REAP_ENVIRONMENT: 'SANDBOX' });
const quoteInput: QuoteInput = { groupOrderId: 'group', basketRevision: 1, storeId: 'mock_store_demo', currency: 'USD', email: 'test@example.com', shippingAddress: { firstName: 'Test', lastName: 'User', phone: '+12025550100', addressLine1: '1 Street', city: 'Singapore', country: 'SG' }, lines: [{ variantId: 'mock_variant_coffee', quantity: 1 }] };
afterEach(async () => { for (const w of wrappers.splice(0)) await w.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const fixture = () => { const w = createDemoReapWrapper(); wrappers.push(w); return w; };
async function catalog(w: ManagedReapWrapper) { unwrap(await w.searchProducts({ query: 'coffee', country: 'SG', currency: 'USD' })); unwrap(await w.getProductDetails(['mock_product_coffee'])); }

describe('wrapper contract with injected provider only', () => {
  it('covers all twenty methods including purchase, debit, replay and revocation', async () => {
    const w = fixture();
    expect(unwrap(await w.getCapabilities()).maxQuoteLines).toBe(20);
    expect(unwrap(await w.getWallet(user)).availableBalance?.minor).toBe('10000');
    unwrap(await w.listCards(user)); unwrap(await w.listEnrollments(user));
    expect(unwrap(await w.discoverMerchants({ query: 'coffee', country: 'SG', currency: 'USD' })).coverage).toBe('PARTIAL');
    await catalog(w);
    expect(unwrap(await w.resolveVariant('mock_product_coffee', ['mock_option_coffee'])).variantId).toBe('mock_variant_coffee');
    const initial = unwrap(await w.createQuote(quoteInput, context('quote')));
    const quote = unwrap(await w.selectShippingOption({ quoteId: initial.quoteId, expectedFingerprint: initial.fingerprint, shippingOptionId: 'mock_shipping_express' }, context('shipping')));
    expect(unwrap(await w.getQuote(quote.quoteId)).itemPricing).toBe('AGGREGATE_ONLY');
    const enrollment = unwrap(await w.createEnrollment({ userId: user, email: 'test@example.com', returnUrl: `https://groupcart.example/return?state=enroll:${user}` }, context('enroll')));
    expect(unwrap(await w.getEnrollment(user, enrollment.enrollmentId)).status).toBe('ACTIVE');
    const checkout = unwrap(await w.createCheckout({ groupOrderId: 'group', purchaseAttemptId: 'purchase', quoteId: quote.quoteId, expectedFingerprint: quote.fingerprint, purchaserUserId: user, enrollmentId: enrollment.enrollmentId, approvedTotal: quote.amountBreakdown.finalAmount, returnUrl: `https://groupcart.example/return?state=checkout:${user}` }, context('checkout')));
    expect(unwrap(await w.getCheckout(checkout.checkoutId)).status).toBe('COMPLETED');
    const input: WalletDebitInput = { groupOrderId: 'group', checkoutId: checkout.checkoutId, participantId: user, userId: user, allocationId: 'alloc', consentRef: `mock-consent:alloc:${user}`, approvedAmount: quote.amountBreakdown.finalAmount, amount: quote.amountBreakdown.finalAmount };
    const debit = unwrap(await w.debitWallet(input, context('debit')));
    expect(debit.state).toBe('APPLIED');
    expect(unwrap(await w.getWalletDebit(debit.debitId)).postingId).toBe(debit.postingId);
    expect(unwrap(await w.retryWalletDebit(debit.debitId, context('retry'))).postingId).toBe(debit.postingId);
    expect(unwrap(await w.getOperation('debit')).state).toBe('SUCCEEDED');
    expect(unwrap(await w.revokeEnrollment(user, enrollment.enrollmentId, context('revoke'))).status).toBe('REVOKED');
  });
  it('separates mock users from sandbox catalogue, persists deterministic merchants and rejects old journals', async () => {
    const path = join(directory(), 'journal.json'); const provider = new DemoProvider(); const fetch = vi.fn(provider.fetch);
    const opts = { config: config(), journalPath: path, fetch, validateConsent: () => false, validateReturnUrl: () => false };
    const w = createReapWithMockUsers(opts); wrappers.push(w);
    expect((await w.getWallet(user)).mode).toBe('LOCAL_MOCK');
    expect(unwrap(await w.listCards(user)).items).toEqual([]); expect(unwrap(await w.listEnrollments(user)).items).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    const result = await w.searchProducts({ query: 'coffee', country: 'SG', currency: 'USD' });
    expect(result.mode).toBe('SANDBOX');
    const id = `reap_merchant_${sha256Hex(canonicalJson(['GroupCart Demo Merchant', 'SG', 'USD'])).slice(0,24)}`;
    expect(unwrap(result).items[0]?.storeId).toBe(id);
    expect((await w.getWallet('real-user')).ok).toBe(false);
    await w.close(); const reopened = createReapWithMockUsers(opts); wrappers.push(reopened);
    expect(unwrap(await reopened.getCapabilities()).stores[0]?.eligibility.state).toBe('UNVERIFIED');
    await reopened.close(); const state = JSON.parse(readFileSync(path,'utf8')); state.version = 1; writeFileSync(path, JSON.stringify(state));
    expect(() => createReapWithMockUsers(opts)).toThrow();
    state.version = 2; writeFileSync(path, JSON.stringify(state));
    const again = createReapWithMockUsers(opts); wrappers.push(again);
  });
  it('rejects malformed caller values and work after close begins', async () => {
    const w = fixture();
    expect(await w.createQuote(null as unknown as QuoteInput, context('bad'))).toMatchObject({ok:false,error:{code:'VALIDATION_ERROR'}});
    expect(await w.searchProducts({query:'coffee',country:'SG',currency:'USD',minPrice:{currency:'NOPE',minor:'1'}})).toMatchObject({ok:false,error:{code:'VALIDATION_ERROR'}});
    const closing = w.close(); expect(await w.getCapabilities()).toMatchObject({ok:false,error:{code:'WRAPPER_CLOSED'}}); await closing;
  });
  it('preserves a replacement journal lock', () => {
    const path = join(directory(), 'journal.json'); const journal = new FileJournalStore(path); journal.acquire(); writeFileSync(`${path}.lock`,'other-owner'); journal.release(); expect(readFileSync(`${path}.lock`,'utf8')).toBe('other-owner');
  });
  it('maps variants durably without searching titles and blocks absent payment execution', async () => {
    const w = fixture(); const path = join(directory(), 'variants.sqlite');
    const options = { wrapper:w, mappingPath:path, country:'SG', currency:'USD', fulfillment: () => ({email:quoteInput.email,shippingAddress:quoteInput.shippingAddress}) };
    let ports = createReapOrchestrationPorts(options);
    const found = await ports.catalog.search('coffee'); const id = found.items[0]!.variantId; ports.close();
    ports = createReapOrchestrationPorts(options);
    try {
      expect((await ports.catalog.get(id))?.variantId).toBe(id); expect(await ports.catalog.get('absent')).toBeNull();
      const quote = await ports.payments.quoteGroupOrder({groupBuyId:'group',orderRevision:1,merchantId:'mock_store_demo',currency:'USD',lines:[{variantId:id,quantity:1,participantId:user}],collection:{point:{latitude:1,longitude:1,label:'Test',address:'Test'},window:{startsAt:'2030-01-01T00:00:00Z',endsAt:'2030-01-01T01:00:00Z',timeZone:'UTC'}}});
      expect(quote.evidence).toBe('AGGREGATE_ONLY'); expect(quote.lines).toEqual([]);
      expect(await ports.payments.getGroupPayment('missing')).toBeNull();
      await expect(ports.payments.requestRecovery('missing','test')).rejects.toMatchObject({code:'PROVIDER_UNAVAILABLE'});
      await expect(ports.payments.startGroupPayment({} as never,'missing')).rejects.toMatchObject({code:'PROVIDER_UNAVAILABLE'});
    } finally { ports.close(); }
  });
  it('marks interrupted operations unknown on reopening and rejects corrupt maps', async () => {
    const path = join(directory(), 'journal.json');
    const opts = { config: config(), journalPath: path, users: [], validateConsent: () => false, validateReturnUrl: () => false };
    let w = createReapWrapperInternal(opts); await w.close();
    const state = JSON.parse(readFileSync(path, 'utf8'));
    state.operations.pending = { operationId: 'pending', method: 'createQuote', requestHash: 'hash', idempotencyKey: 'key', resourceType: 'QUOTE', resourceId: null, state: 'PENDING', error: null, requestBody: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.idempotencyKeys.key = { operationId: 'pending', method: 'createQuote' };
    writeFileSync(path, JSON.stringify(state));
    w = createReapWrapperInternal(opts); wrappers.push(w);
    expect(unwrap(await w.getOperation('pending')).state).toBe('UNKNOWN'); await w.close();
    for (const name of ['operations', 'idempotencyKeys', 'enrollments', 'quotes', 'products', 'variants', 'cursors', 'checkouts', 'debits', 'participants', 'discoveredStores']) {
      writeFileSync(path, JSON.stringify({ ...state, [name]: [] }));
      expect(() => createReapWrapperInternal(opts)).toThrow();
    }
  });
  it('keeps exact monetary precision', () => {
    expect(providerAmountToMinor('90071992547409.93','USD')).toBe('9007199254740993');
    expect(minorToUnits('1999','USD')).toBe('19.99');
    expect(() => providerAmountToMinor('1.001','USD')).toThrow();
  });
});
