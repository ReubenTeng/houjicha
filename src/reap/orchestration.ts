import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../orchestration/contract.js';
import type { CatalogPort, GroupPaymentPort, Quote, QuoteOrder, Variant } from '../orchestration/contract.js';
import type { Quote as ReapQuote, QuoteInput, ReapWrapper, Result } from './contract.js';
import { canonicalJson, sha256Hex } from './journal.js';

export interface ReapOrchestrationOptions {
  wrapper: ReapWrapper;
  mappingPath: string;
  country: string;
  currency: string;
  fulfillment: (order: QuoteOrder) => Pick<QuoteInput, 'email' | 'shippingAddress'> | Promise<Pick<QuoteInput, 'email' | 'shippingAddress'>>;
  lineEvidence?: (order: QuoteOrder, quote: ReapQuote) => Promise<Pick<Quote, 'lines' | 'sharedDelivery' | 'fundingFees'> | null>;
  paymentExecutor?: Omit<GroupPaymentPort, 'quoteGroupOrder'>;
}
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new DomainError(result.error.code === 'VALIDATION_ERROR' ? 'VALIDATION_ERROR' : 'PROVIDER_UNAVAILABLE');
  return result.data;
}
export function createReapOrchestrationPorts(options: ReapOrchestrationOptions): { catalog: CatalogPort; payments: GroupPaymentPort; close(): void } {
  const db = new DatabaseSync(options.mappingPath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reap_variants (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  const save = (variant: Variant) => db.prepare('INSERT INTO reap_variants VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(variant.variantId, JSON.stringify(variant));
  const catalog: CatalogPort = {
    async search(query, merchantId, cursor) {
      const page = unwrap(await options.wrapper.searchProducts({ query, country: options.country, currency: options.currency, ...(merchantId ? { storeId: merchantId } : {}), page: { limit: 10, ...(cursor ? { cursor } : {}) } }));
      const items: Variant[] = [];
      if (page.items.length) {
        const details = unwrap(await options.wrapper.getProductDetails(page.items.map(p => p.productId)));
        if (details.errors.length) throw new DomainError('PROVIDER_UNAVAILABLE');
        for (const product of details.products) {
          const source = page.items.find(p => p.productId === product.productId);
          const variant = product.defaultVariant;
          if (!source?.storeId || !variant) continue;
          const mapped: Variant = { merchantId: source.storeId, productId: product.productId, variantId: variant.variantId, title: product.name, attributes: Object.fromEntries(variant.options.map(o => [o.name, o.value])), indicativePrice: variant.catalogPrice, available: variant.available === true };
          save(mapped); items.push(mapped);
        }
      }
      return { items, nextCursor: page.nextCursor };
    },
    async get(variantId) {
      const row = db.prepare('SELECT body FROM reap_variants WHERE id=?').get(variantId);
      if (!row) return null;
      const saved = JSON.parse(String(row.body)) as Variant;
      const details = unwrap(await options.wrapper.getProductDetails([saved.productId]));
      const current = details.products.find(p => p.productId === saved.productId)?.defaultVariant;
      if (!current || current.variantId !== variantId) return null;
      const variant = { ...saved, indicativePrice: current.catalogPrice, available: current.available === true };
      save(variant); return variant;
    },
  };
  const unavailable = async (): Promise<never> => { throw new DomainError('PROVIDER_UNAVAILABLE'); };
  const payments: GroupPaymentPort = {
    async quoteGroupOrder(order) {
      const fulfillment = await options.fulfillment(order);
      const input: QuoteInput = { groupOrderId: order.groupBuyId, basketRevision: order.orderRevision, storeId: order.merchantId, currency: order.currency, ...fulfillment, lines: order.lines.map(({ variantId, quantity }) => ({ variantId, quantity })) };
      const key = `quote_${sha256Hex(canonicalJson(input))}`;
      const quote = unwrap(await options.wrapper.createQuote(input, { operationId: key, idempotencyKey: key }));
      const evidence = await options.lineEvidence?.(order, quote);
      return { quoteId: quote.quoteId, expiresAt: quote.expiresAt, currency: order.currency, merchantTotal: quote.amountBreakdown.finalAmount, evidence: evidence ? 'VERIFIED_LINES' : 'AGGREGATE_ONLY', lines: evidence?.lines ?? [], sharedDelivery: evidence?.sharedDelivery ?? quote.amountBreakdown.shipping ?? { currency: order.currency, minor: '0' }, fundingFees: evidence?.fundingFees ?? [] };
    },
    startGroupPayment: options.paymentExecutor?.startGroupPayment.bind(options.paymentExecutor) ?? unavailable,
    getGroupPayment: options.paymentExecutor?.getGroupPayment.bind(options.paymentExecutor) ?? (async () => null),
    requestRecovery: options.paymentExecutor?.requestRecovery.bind(options.paymentExecutor) ?? unavailable,
  };
  return { catalog, payments, close: () => db.close() };
}
