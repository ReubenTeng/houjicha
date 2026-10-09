import { createHash } from 'node:crypto';
import { DomainError } from './contract.js';
import type { Charge, Collection, Constraints, Group, Line, Money, Point, Quote, Window } from './contract.js';
export function requireRule(condition: unknown, code: ConstructorParameters<typeof DomainError>[0] = 'VALIDATION_ERROR'): asserts condition {
  if (!condition) throw new DomainError(code);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function amount(money: Money, currency?: string): bigint {
  requireRule(money && /^[A-Z]{3}$/.test(money.currency) && typeof money.minor === 'string' && /^(0|[1-9][0-9]{0,17})$/.test(money.minor));
  requireRule(!currency || money.currency === currency);
  return BigInt(money.minor);
}
export function money(currency: string, minor: bigint): Money { const result = { currency, minor: minor.toString() }; amount(result); return result; }
export function instant(value: string): number {
  requireRule(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));
  return Date.parse(value);
}
export function windowValid(window: Window): void {
  requireRule(window && typeof window.timeZone==='string' && window.timeZone.length>0 && instant(window.startsAt) < instant(window.endsAt));
  try { new Intl.DateTimeFormat('en', { timeZone: window.timeZone }); } catch { throw new DomainError('VALIDATION_ERROR'); }
}
export function pointValid(point: Point): void {
  requireRule(point && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180);
}
export function linesValid(lines: Line[]): void {
  requireRule(Array.isArray(lines) && lines.length > 0 && lines.length <= 20);
  const ids = new Set<string>();
  for (const line of lines) {
    requireRule(typeof line.variantId === 'string' && line.variantId.length > 0 && Number.isSafeInteger(line.quantity) && line.quantity > 0 && line.quantity <= 1000000 && !ids.has(line.variantId));
    ids.add(line.variantId);
  }
}
export function constraintsValid(constraints: Constraints): void {
  requireRule(constraints);
  amount(constraints.maxTotal); pointValid(constraints.origin); windowValid(constraints.availabilityWindow);
  requireRule(Number.isFinite(constraints.maxDistanceMeters) && constraints.maxDistanceMeters >= 0);
}
export function distance(a: Point, b: Point): number {
  const r = Math.PI / 180;
  const h = Math.sin((b.latitude-a.latitude)*r/2)**2 + Math.cos(a.latitude*r)*Math.cos(b.latitude*r)*Math.sin((b.longitude-a.longitude)*r/2)**2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1,h)));
}
export function fits(collection: Collection, constraints: Constraints): boolean {
  return distance(collection.point, constraints.origin) <= constraints.maxDistanceMeters && instant(collection.window.startsAt) >= instant(constraints.availabilityWindow.startsAt) && instant(collection.window.endsAt) <= instant(constraints.availabilityWindow.endsAt);
}
export function allocate(group: Group, quote: Quote, now: string): Charge[] {
  requireRule(instant(quote.expiresAt) > instant(now), 'QUOTE_EXPIRED');
  const currency = group.participants[0]?.constraints.maxTotal.currency;
  requireRule(currency && quote.currency === currency);
  requireRule(quote.evidence === 'VERIFIED_LINES', 'PRICING_UNSUPPORTED');
  const expected = group.participants.flatMap(p => p.lines.map(l => ({ ...l, participantId: p.userId })));
  requireRule(quote.lines.length === expected.length);
  const costs = new Map<string, bigint>();
  for (const line of expected) {
    const matches = quote.lines.filter(l => l.participantId === line.participantId && l.variantId === line.variantId && l.quantity === line.quantity);
    requireRule(matches.length === 1);
    const priced = matches[0]!;
    requireRule(priced.available, 'ITEM_UNAVAILABLE');
    costs.set(line.participantId, (costs.get(line.participantId) ?? 0n) + amount(priced.amount, currency));
  }
  const delivery = amount(quote.sharedDelivery, currency);
  requireRule([...costs.values()].reduce((a,b) => a+b, delivery) === amount(quote.merchantTotal, currency));
  requireRule(quote.fundingFees.length === group.participants.length);
  const ids = group.participants.map(p => p.userId).sort();
  const count = BigInt(ids.length);
  return ids.map((id, index) => {
    const fees = quote.fundingFees.filter(f => f.participantId === id);
    requireRule(fees.length === 1);
    const fee = amount(fees[0]!.amount, currency);
    const share = costs.get(id)! + delivery / count + (BigInt(index) < delivery % count ? 1n : 0n);
    const participant = group.participants.find(p => p.userId === id)!;
    return { participantId: id, merchantShare: money(currency, share), fundingFee: money(currency,fee), totalDebit: money(currency,share+fee), authorizationId: participant.authorization.authorizationId };
  });
}
