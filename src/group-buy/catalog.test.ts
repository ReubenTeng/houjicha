import { randomBytes } from "node:crypto";
import { expect, test, vi } from "vitest";
import type { Database } from "../mcp/db.js";
import type { Details, Provider } from "../mcp/domain.js";
import { CryptoBox } from "../mcp/security.js";
import { minorMoney, ReapCatalog } from "./catalog.js";

const details: Details = { id: "provider-product", name: "Tea", merchant: "Merchant", options: [], default_variant: { id: "provider-variant", name: "Small", options: [{ name: "Size", value: "Small" }], price: { amount: "1.23", currency: "USD" }, available: true, requires_shipping: true } };
const variantId = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const query = vi.fn(async () => [{ id: variantId, product_id: "stable-product", merchant_key: "merchant", provider_product_id: details.id, provider_variant_id: details.default_variant.id }]);
  const db = { query, box: new CryptoBox(randomBytes(32)) } as unknown as Pick<Database, "query" | "box">;
  const provider = { details: vi.fn(async () => structuredClone(details)), search: vi.fn(async () => ({ products: [{ id: details.id, merchant: details.merchant }], warnings: [], next_cursor: null })) };
  const catalog = new ReapCatalog(db, provider as unknown as Provider, { namespace: "sandbox:one", merchants: { merchant: "Merchant" } }, "US", "USD");
  return { catalog, provider, query };
}

test.each([["1.23", "USD", "123"], ["12", "JPY", "12"], ["1.234", "KWD", "1234"], ["90071992547409.93", "USD", "9007199254740993"]])("converts %s %s without floating-point loss", (amount, currency, minor) => {
  expect(minorMoney({ amount: amount!, currency: currency! })).toEqual({ currency, minor });
});
test.each(["1.001", "-1", "NaN", "10000000000000000"])("rejects unrepresentable group money %s", amount => {
  expect(() => minorMoney({ amount, currency: "USD" })).toThrow();
});
test("catalog uses stable shared IDs, concrete options, and namespace isolation", async () => {
  const { catalog, query } = fixture();
  const response = await catalog.search("Tea", "merchant");
  expect(response.items[0]).toMatchObject({ variantId, productId: "stable-product", indicativePrice: { currency: "USD", minor: "123" }, attributes: { Size: "Small" } });
  expect(query.mock.calls[0]).toEqual([expect.stringContaining("ON CONFLICT"), expect.arrayContaining(["sandbox:one", "US", "USD"])]);
});
test("get always refreshes provider availability and never treats unknown as available", async () => {
  const { catalog, provider, query } = fixture();
  provider.details.mockResolvedValueOnce({ ...details, default_variant: { ...details.default_variant, available: null } });
  expect((await catalog.get(variantId))?.available).toBe(false);
  expect(provider.details).toHaveBeenCalledWith(details.id);
  expect(query.mock.calls[0]).toEqual([expect.stringContaining("namespace=$2"), [variantId, "sandbox:one", "US", "USD"]]);
});
test("merchant or default variant changes are not silently substituted", async () => {
  const { catalog, provider } = fixture();
  provider.details.mockResolvedValueOnce({ ...details, merchant: "Other" });
  await expect(catalog.get(variantId)).rejects.toThrow();
  provider.details.mockResolvedValueOnce({ ...details, default_variant: { ...details.default_variant, id: "other" } });
  await expect(catalog.get(variantId)).rejects.toThrow(/changed/);
});
test("unknown IDs and malformed cursors are rejected without querying the provider", async () => {
  const { catalog, provider } = fixture();
  expect(await catalog.get("commerce-product-id")).toBeNull();
  await expect(catalog.search("Tea", undefined, "unsafe-provider-cursor")).rejects.toThrow(/search/);
  expect(provider.search).not.toHaveBeenCalled();
  expect(provider.details).not.toHaveBeenCalled();
});
