import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { CatalogPort, Money, Variant } from "../orchestration/contract.js";
import type { Config } from "../reap/config.js";
import type { Database } from "../reap/db.js";
import type { Provider, Details } from "../reap/domain.js";
import { AppError, contract } from "../reap/errors.js";
import { currencyDigits, money, type Money as ReapMoney } from "../reap/money.js";
import { canonical, hash } from "../reap/security.js";

export function minorMoney(value: ReapMoney): Money {
  const normalized = money(value.amount, value.currency);
  const minor = new Decimal(normalized.amount).times(new Decimal(10).pow(currencyDigits(value.currency)));
  contract(minor.isInteger() && !minor.isNegative() && minor.lt("1e18"), "The group price is outside the supported minor-unit range.");
  return { currency: value.currency, minor: minor.toFixed(0) };
}

interface Mapping { id: string; product_id: string; merchant_key: string; provider_product_id: string; provider_variant_id: string }
export class ReapCatalog implements CatalogPort {
  constructor(private readonly db: Pick<Database, "query" | "box">, private readonly provider: Pick<Provider, "search" | "details">,
    private readonly config: Pick<Config, "namespace" | "merchants">, private readonly country: string, private readonly currency: string) {}

  private merchant(name: string): string {
    const matches = Object.entries(this.config.merchants).filter(([, value]) => value.toLowerCase() === name.toLowerCase());
    if (matches.length !== 1) throw new AppError("UNSUPPORTED_REGION_OR_MERCHANT", "Group catalog merchant identity is unavailable or ambiguous.");
    return matches[0]![0];
  }

  private normalized(details: Details, row: Pick<Mapping, "id" | "product_id" | "merchant_key" | "provider_variant_id">): Variant {
    const variant = details.default_variant;
    contract(this.merchant(details.merchant) === row.merchant_key && variant.id === row.provider_variant_id, "The group product or default variant changed. Search again; no substitution was selected.");
    contract(variant.price.currency === this.currency);
    return { merchantId: row.merchant_key, productId: row.product_id, variantId: row.id, title: `${details.name} — ${variant.name}`,
      attributes: Object.fromEntries(variant.options.map(option => [option.name, option.value])), indicativePrice: minorMoney(variant.price), available: variant.available === true };
  }

  async search(query: string, merchantId?: string, cursor?: string): Promise<{ items: Variant[]; nextCursor: string | null }> {
    if (merchantId && !this.config.merchants[merchantId]) throw new AppError("UNSUPPORTED_REGION_OR_MERCHANT", "Choose a configured group merchant.");
    const contextHash = hash(canonical({ query, merchantId, country: this.country, currency: this.currency }));
    let providerCursor: string | undefined;
    if (cursor) {
      if (!/^[0-9a-f-]{36}$/i.test(cursor)) throw new AppError("INVALID_CURSOR", "Start a new group catalog search.");
      const [record] = await this.db.query<{ context_hash: string; cursor_ciphertext: string; expires_at: Date }>("SELECT context_hash,cursor_ciphertext,expires_at FROM group_catalog_cursors WHERE id=$1 AND namespace=$2", [cursor, this.config.namespace]);
      if (!record || record.context_hash !== contextHash || record.expires_at.getTime() <= Date.now()) throw new AppError("INVALID_CURSOR", "The group catalog cursor expired or belongs to different search criteria.");
      providerCursor = this.db.box.open<string>(record.cursor_ciphertext, `group-cursor:${cursor}`);
    }
    const response = await this.provider.search({ query, country: this.country, currency: this.currency, limit: 10,
      ...(merchantId ? { merchant: this.config.merchants[merchantId]! } : {}), ...(providerCursor ? { cursor: providerCursor } : {}) });
    const items: Variant[] = [];
    for (const product of response.products.slice(0, 10)) {
      let key: string;
      try { key = this.merchant(product.merchant); } catch (error) { if (error instanceof AppError) continue; throw error; }
      if (merchantId && key !== merchantId) continue;
      const details = await this.provider.details(product.id);
      contract(details.id === product.id && this.merchant(details.merchant) === key);
      const mapping = { id: randomUUID(), product_id: hash(canonical([this.config.namespace, this.country, this.currency, key, product.id])), merchant_key: key, provider_variant_id: details.default_variant.id };
      const value = this.normalized(details, mapping);
      const [saved] = await this.db.query<Mapping>("INSERT INTO group_catalog_variants (id,product_id,namespace,country,currency,merchant_key,provider_product_id,provider_variant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (namespace,country,currency,merchant_key,provider_product_id,provider_variant_id) DO UPDATE SET last_seen_at=now() RETURNING *", [mapping.id, mapping.product_id, this.config.namespace, this.country, this.currency, key, product.id, details.default_variant.id]);
      contract(saved);
      items.push({ ...value, variantId: saved.id, productId: saved.product_id });
    }
    let nextCursor: string | null = null;
    if (response.next_cursor) {
      contract(response.next_cursor.length <= 8192);
      nextCursor = randomUUID();
      await this.db.query("DELETE FROM group_catalog_cursors WHERE namespace=$1 AND expires_at<=now()", [this.config.namespace]);
      await this.db.query("INSERT INTO group_catalog_cursors VALUES ($1,$2,$3,$4,now()+interval '30 minutes')", [nextCursor, this.config.namespace, contextHash, this.db.box.seal(response.next_cursor, `group-cursor:${nextCursor}`)]);
    }
    return { items, nextCursor };
  }

  async get(id: string): Promise<Variant | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await this.db.query<Mapping>("SELECT * FROM group_catalog_variants WHERE id=$1 AND namespace=$2 AND country=$3 AND currency=$4", [id, this.config.namespace, this.country, this.currency]);
    if (!row) return null;
    const details = await this.provider.details(row.provider_product_id);
    contract(details.id === row.provider_product_id);
    return this.normalized(details, row);
  }
}
