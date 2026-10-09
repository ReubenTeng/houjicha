import { listDemoAccounts } from "../demo-accounts.js";
import type { WalletDebitInput } from "./contract.js";
import { REAP_VERSION, type ManagedReapWrapper } from "./config.js";
import { MemoryJournalStore } from "./journal.js";
import { integerToDecimal } from "./money.js";
import { createReapWrapperInternal } from "./wrapper.js";

const DEMO_STORE_ID = "mock_store_demo";
const DEMO_MERCHANT_NAME = "GroupCart Demo Merchant";
const DEMO_ASSET_ID = "mock_asset_usd";
const DEMO_CURRENCY = "USD";
const DEMO_EVIDENCE_REF = "fixture:groupcart-demo-v1";
export const DEMO_RETURN_URL = "https://groupcart.example/return";

const DEMO_PRODUCTS = [
  {
    productId: "mock_product_coffee",
    variantId: "mock_variant_coffee",
    optionId: "mock_option_coffee",
    name: "Demo coffee",
    priceMinor: 900n,
  },
  {
    productId: "mock_product_milk",
    variantId: "mock_variant_milk",
    optionId: "mock_option_milk",
    name: "Demo milk",
    priceMinor: 600n,
  },
] as const;

const DEMO_SHIPPING = [
  { id: "mock_shipping_standard", name: "Standard shipping", priceMinor: 600n },
  { id: "mock_shipping_express", name: "Express shipping", priceMinor: 900n },
] as const;

interface DemoEnrollment {
  enrollmentId: string;
  ownerId: string;
  email: string;
  status: "ACTIVE" | "REVOKED";
}

interface DemoQuote {
  quoteId: string;
  email: string;
  shippingAddress: unknown;
  items: { variantId: string; quantity: number }[];
  selectedShippingId: string;
  expiresAt: string;
}

interface DemoCheckout {
  checkoutId: string;
  quoteId: string;
  enrollmentId: string;
  orderId: string;
  finalMinor: bigint;
}

interface DemoPosting {
  postingId: string;
  accountId: string;
  entries: { virtualAssetId: string; amount: string }[];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(status, { error: { code, message: "demo provider error" } });
}

function decimalFromMinor(minor: bigint): string {
  return integerToDecimal(minor, 2);
}

function moneyAmount(minor: bigint): { amount: number; currency: string } {
  return { amount: Number(decimalFromMinor(minor)), currency: DEMO_CURRENCY };
}

function minorFromUnits(units: string | number): bigint {
  const text = String(units);
  const match = /^-?(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) {
    throw new Error("invalid units");
  }
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return BigInt(`${match[1]}${fraction.slice(0, 2)}`) * (text.startsWith("-") ? -1n : 1n);
}

export class DemoProvider {
  private readonly now: () => Date;
  private readonly balances = new Map<string, bigint>();
  private readonly withdrawable = new Map<string, bigint>();
  private readonly enrollments = new Map<string, DemoEnrollment>();
  private readonly quotes = new Map<string, DemoQuote>();
  private readonly checkouts = new Map<string, DemoCheckout>();
  private readonly postings = new Map<string, DemoPosting>();
  private readonly idempotent = new Map<string, Response>();
  private counters = { enrollment: 0, quote: 0, checkout: 0, posting: 0 };

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
    for (const account of listDemoAccounts()) {
      const minor = BigInt(account.wallet.availableBalance.minor);
      this.balances.set(account.wallet.accountId, minor);
      this.withdrawable.set(account.wallet.accountId, minor);
    }
  }

  readonly fetch: typeof globalThis.fetch = async (input, init): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const idemKey = typeof init?.headers === "object" && init.headers !== null
      ? (init.headers as Record<string, string>)["Idempotency-Key"]
      : undefined;
    if (method === "POST" && idemKey !== undefined) {
      const cached = this.idempotent.get(`${method} ${url.pathname} ${idemKey}`);
      if (cached !== undefined) {
        return cached.clone();
      }
    }
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string" && init.body !== "") {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    const response = this.route(method, url, body);
    if (method === "POST" && idemKey !== undefined && response.status >= 200 && response.status < 300) {
      this.idempotent.set(`${method} ${url.pathname} ${idemKey}`, response.clone());
    }
    return response;
  };

  private route(method: string, url: URL, body: Record<string, unknown>): Response {
    const path = url.pathname;
    const segments = path.split("/").filter((segment) => segment !== "");
    try {
      if (method === "GET" && segments[0] === "accounts" && segments.length === 2) {
        return this.getAccount(segments[1]!);
      }
      if (method === "GET" && segments[0] === "accounts" && segments[2] === "balance") {
        return this.getBalance(segments[1]!);
      }
      if (method === "GET" && segments[0] === "accounts" && segments[2] === "assets") {
        return this.getAssets(segments[1]!);
      }
      if (method === "GET" && segments[0] === "virtual-assets" && segments.length === 2) {
        return this.getVirtualAsset(segments[1]!);
      }
      if (method === "GET" && segments[0] === "cards") {
        return jsonResponse(200, { items: [], nextCursor: null });
      }
      if (segments[0] === "agentic" && segments[1] === "enrollments") {
        return this.routeEnrollments(method, segments, url, body);
      }
      if (segments[0] === "agentic" && segments[1] === "products") {
        return this.routeProducts(method, segments, body);
      }
      if (segments[0] === "agentic" && segments[1] === "quotes") {
        return this.routeQuotes(method, segments, body);
      }
      if (segments[0] === "agentic" && segments[1] === "checkouts") {
        return this.routeCheckouts(method, segments, body);
      }
      if (segments[0] === "postings") {
        return this.routePostings(method, segments, body);
      }
      return errorResponse(404, "NOT_FOUND");
    } catch {
      return errorResponse(500, "INTERNAL");
    }
  }

  private accountFor(accountId: string): boolean {
    return this.balances.has(accountId);
  }

  private ownerForAccount(accountId: string): string | null {
    const account = listDemoAccounts().find((candidate) => candidate.wallet.accountId === accountId);
    return account === undefined ? null : account.userId;
  }

  private getAccount(accountId: string): Response {
    if (!this.accountFor(accountId)) {
      return errorResponse(404, "ACCOUNT_NOT_FOUND");
    }
    return jsonResponse(200, {
      id: accountId,
      ownerType: "USER",
      ownerId: this.ownerForAccount(accountId),
      status: "ACTIVE",
      createdAt: this.now().toISOString(),
    });
  }

  private getBalance(accountId: string): Response {
    const balance = this.balances.get(accountId);
    if (balance === undefined) {
      return errorResponse(404, "ACCOUNT_NOT_FOUND");
    }
    return jsonResponse(200, {
      currency: DEMO_CURRENCY,
      totalAssetValue: Number(decimalFromMinor(balance)),
      totalLiabilities: 0,
      availableBalance: Number(decimalFromMinor(balance)),
    });
  }

  private getAssets(accountId: string): Response {
    const balance = this.balances.get(accountId);
    const withdrawable = this.withdrawable.get(accountId);
    if (balance === undefined || withdrawable === undefined) {
      return errorResponse(404, "ACCOUNT_NOT_FOUND");
    }
    return jsonResponse(200, {
      items: [
        {
          type: "VIRTUAL",
          virtualAssetId: DEMO_ASSET_ID,
          amount: decimalFromMinor(balance),
          withdrawable: decimalFromMinor(withdrawable),
          decimals: 2,
          rate: 1,
        },
      ],
    });
  }

  private getVirtualAsset(assetId: string): Response {
    if (assetId !== DEMO_ASSET_ID) {
      return errorResponse(404, "ASSET_NOT_FOUND");
    }
    return jsonResponse(200, {
      id: DEMO_ASSET_ID,
      status: "ACTIVE",
      rateSource: "FIXED",
      currentRate: 1,
    });
  }

  private routeEnrollments(method: string, segments: string[], url: URL, body: Record<string, unknown>): Response {
    if (method === "POST" && segments.length === 2) {
      const owner = body.owner as Record<string, unknown> | undefined;
      const ownerId = typeof owner?.id === "string" ? owner.id : null;
      const ownerType = typeof owner?.type === "string" ? owner.type : null;
      const email = typeof owner?.email === "string" ? owner.email : null;
      if (ownerType !== "CLIENT_REFERENCE" || ownerId === null || email === null) {
        return errorResponse(422, "INVALID_REQUEST");
      }
      if (!listDemoAccounts().some((account) => account.userId === ownerId)) {
        return errorResponse(404, "OWNER_NOT_FOUND");
      }
      this.counters.enrollment += 1;
      const enrollment: DemoEnrollment = {
        enrollmentId: `mock_enrollment_${this.counters.enrollment}`,
        ownerId,
        email,
        status: "ACTIVE",
      };
      this.enrollments.set(enrollment.enrollmentId, enrollment);
      return jsonResponse(201, this.enrollmentResponse(enrollment));
    }
    if (method === "GET" && segments.length === 2) {
      const ownerId = url.searchParams.get("ownerId");
      const items = [...this.enrollments.values()].filter(
        (enrollment) => enrollment.ownerId === ownerId,
      );
      return jsonResponse(200, { items: items.map((enrollment) => this.enrollmentResponse(enrollment)), nextCursor: null });
    }
    if (segments.length === 3 && method === "GET") {
      const enrollment = this.enrollments.get(segments[2]!);
      if (enrollment === undefined) {
        return errorResponse(404, "ENROLLMENT_NOT_FOUND");
      }
      return jsonResponse(200, this.enrollmentResponse(enrollment));
    }
    if (segments.length === 4 && segments[3] === "revoke" && method === "POST") {
      const enrollment = this.enrollments.get(segments[2]!);
      if (enrollment === undefined) {
        return errorResponse(404, "ENROLLMENT_NOT_FOUND");
      }
      enrollment.status = "REVOKED";
      return jsonResponse(200, this.enrollmentResponse(enrollment));
    }
    return errorResponse(404, "NOT_FOUND");
  }

  private enrollmentResponse(enrollment: DemoEnrollment): Record<string, unknown> {
    return {
      id: enrollment.enrollmentId,
      owner: { type: "CLIENT_REFERENCE", id: enrollment.ownerId, email: enrollment.email },
      status: enrollment.status,
      paymentMethod: { network: "MOCK", last4: "0000", expiryMonth: 1, expiryYear: 2030 },
      nextAction: null,
      createdAt: this.now().toISOString(),
    };
  }

  private productSearchItem(product: (typeof DEMO_PRODUCTS)[number]): Record<string, unknown> {
    const price = moneyAmount(product.priceMinor);
    return {
      id: product.productId,
      name: product.name,
      merchant: { name: DEMO_MERCHANT_NAME },
      imageUrl: null,
      available: true,
      priceRange: { min: price, max: price },
      previewVariant: { id: product.variantId, name: "Standard", price, available: true },
    };
  }

  private routeProducts(method: string, segments: string[], body: Record<string, unknown>): Response {
    if (method !== "POST" || segments.length !== 3) {
      return errorResponse(404, "NOT_FOUND");
    }
    if (segments[2] === "search") {
      const query = typeof body.query === "string" ? body.query.toLowerCase() : "";
      const preference = body.merchantPreference as Record<string, unknown> | undefined;
      const filters = body.filters as Record<string, unknown> | undefined;
      const pagination = body.pagination as Record<string, unknown> | undefined;
      const limit = typeof pagination?.limit === "number" ? pagination.limit : 20;
      const cursor = typeof pagination?.cursor === "string" ? pagination.cursor : null;
      let products = DEMO_PRODUCTS.filter((product) => product.name.toLowerCase().includes(query) || query === "");
      if (preference?.mode === "ONLY" && preference.merchantName !== DEMO_MERCHANT_NAME) {
        products = [];
      }
      const priceFilter = filters?.price as Record<string, unknown> | undefined;
      if (priceFilter !== undefined) {
        const min = typeof priceFilter.min === "string" ? minorFromUnits(priceFilter.min) : null;
        const max = typeof priceFilter.max === "string" ? minorFromUnits(priceFilter.max) : null;
        products = products.filter(
          (product) => (min === null || product.priceMinor >= min) && (max === null || product.priceMinor <= max),
        );
      }
      if (filters?.availability === "AVAILABLE_ONLY") {
        products = products.filter(() => true);
      }
      const offset = cursor === null ? 0 : Number.parseInt(cursor.replace("mock_cursor_", ""), 10);
      const page = products.slice(offset, offset + limit);
      const hasMore = offset + limit < products.length;
      return jsonResponse(200, {
        products: page.map((product) => this.productSearchItem(product)),
        pagination: { nextCursor: hasMore ? `mock_cursor_${offset + limit}` : null },
        warnings: [],
      });
    }
    if (segments[2] === "details") {
      const ids = Array.isArray(body.productIds) ? (body.productIds as unknown[]).map(String) : [];
      const products: Record<string, unknown>[] = [];
      const errors: Record<string, unknown>[] = [];
      for (const id of ids) {
        const product = DEMO_PRODUCTS.find((candidate) => candidate.productId === id);
        if (product === undefined) {
          errors.push({ productId: id, code: "PRODUCT_NOT_FOUND" });
          continue;
        }
        const price = moneyAmount(product.priceMinor);
        products.push({
          id: product.productId,
          name: product.name,
          description: `${product.name} (demo fixture)`,
          merchant: { name: DEMO_MERCHANT_NAME },
          options: [
            { name: "Variant", values: [{ optionId: product.optionId, label: "Standard", available: true }] },
          ],
          media: [],
          defaultVariant: {
            id: product.variantId,
            name: "Standard",
            price,
            options: [{ name: "Variant", value: "Standard" }],
            available: true,
            requiresShipping: true,
          },
        });
      }
      return jsonResponse(200, { products, errors });
    }
    if (segments[2] === "variant") {
      const productId = typeof body.productId === "string" ? body.productId : null;
      const optionIds = Array.isArray(body.optionIds) ? (body.optionIds as unknown[]).map(String) : [];
      const product = DEMO_PRODUCTS.find((candidate) => candidate.productId === productId);
      if (product === undefined || optionIds.length !== 1 || optionIds[0] !== product.optionId) {
        return errorResponse(422, "INVALID_VARIANT_OPTIONS");
      }
      return jsonResponse(200, {
        id: product.variantId,
        name: "Standard",
        price: moneyAmount(product.priceMinor),
        options: [{ name: "Variant", value: "Standard" }],
        available: true,
        requiresShipping: true,
      });
    }
    return errorResponse(404, "NOT_FOUND");
  }

  private quoteResponse(quote: DemoQuote): Record<string, unknown> {
    let subtotal = 0n;
    for (const item of quote.items) {
      const product = DEMO_PRODUCTS.find((candidate) => candidate.variantId === item.variantId);
      if (product === undefined) {
        throw new Error("unknown variant");
      }
      subtotal += product.priceMinor * BigInt(item.quantity);
    }
    const selected = DEMO_SHIPPING.find((option) => option.id === quote.selectedShippingId) ?? DEMO_SHIPPING[0];
    const shippingOptions = DEMO_SHIPPING.map((option) => ({
      id: option.id,
      name: option.name,
      selected: option.id === selected.id,
      price: moneyAmount(option.priceMinor),
      details: [],
    }));
    return {
      id: quote.quoteId,
      expiresAt: quote.expiresAt,
      shippingOptions,
      amountBreakdown: {
        itemsSubtotal: moneyAmount(subtotal),
        shipping: moneyAmount(selected.priceMinor),
        discounts: [],
        additionalCharges: [],
        finalAmount: moneyAmount(subtotal + selected.priceMinor),
      },
    };
  }

  private routeQuotes(method: string, segments: string[], body: Record<string, unknown>): Response {
    if (method === "POST" && segments.length === 2) {
      const items = body.items;
      if (typeof body.email !== "string" || !Array.isArray(items) || items.length === 0) {
        return errorResponse(422, "INVALID_REQUEST");
      }
      for (const item of items as Record<string, unknown>[]) {
        const product = DEMO_PRODUCTS.find((candidate) => candidate.variantId === item.variantId);
        if (product === undefined || typeof item.quantity !== "number" || !Number.isInteger(item.quantity) || item.quantity < 1) {
          return errorResponse(422, "INVALID_ITEM");
        }
      }
      this.counters.quote += 1;
      const quote: DemoQuote = {
        quoteId: `mock_quote_${this.counters.quote}`,
        email: body.email,
        shippingAddress: body.shippingAddress,
        items: (items as Record<string, unknown>[]).map((item) => ({
          variantId: String(item.variantId),
          quantity: item.quantity as number,
        })),
        selectedShippingId: "mock_shipping_standard",
        expiresAt: new Date(this.now().getTime() + 15 * 60 * 1000).toISOString(),
      };
      this.quotes.set(quote.quoteId, quote);
      return jsonResponse(201, this.quoteResponse(quote));
    }
    if (method === "GET" && segments.length === 3) {
      const quote = this.quotes.get(segments[2]!);
      if (quote === undefined) {
        return errorResponse(404, "QUOTE_NOT_FOUND");
      }
      return jsonResponse(200, this.quoteResponse(quote));
    }
    if (method === "POST" && segments.length === 4 && segments[3] === "shipping-option") {
      const quote = this.quotes.get(segments[2]!);
      if (quote === undefined) {
        return errorResponse(404, "QUOTE_NOT_FOUND");
      }
      const optionId = typeof body.shippingOptionId === "string" ? body.shippingOptionId : null;
      if (!DEMO_SHIPPING.some((option) => option.id === optionId)) {
        return errorResponse(422, "INVALID_SHIPPING_OPTION");
      }
      quote.selectedShippingId = optionId!;
      return jsonResponse(200, this.quoteResponse(quote));
    }
    return errorResponse(404, "NOT_FOUND");
  }

  private routeCheckouts(method: string, segments: string[], _body: Record<string, unknown>): Response {
    if (method === "POST" && segments.length === 2) {
      const quoteId = typeof _body.quoteId === "string" ? _body.quoteId : null;
      const enrollmentId = typeof _body.enrollmentId === "string" ? _body.enrollmentId : null;
      const quote = quoteId === null ? undefined : this.quotes.get(quoteId);
      const enrollment = enrollmentId === null ? undefined : this.enrollments.get(enrollmentId);
      if (quote === undefined || enrollment === undefined) {
        return errorResponse(422, "INVALID_REQUEST");
      }
      if (enrollment.status !== "ACTIVE") {
        return errorResponse(422, "ENROLLMENT_NOT_ACTIVE");
      }
      this.counters.checkout += 1;
      const response = this.quoteResponse(quote);
      const breakdown = response.amountBreakdown as Record<string, { amount: number; currency: string }>;
      const checkout: DemoCheckout = {
        checkoutId: `mock_checkout_${this.counters.checkout}`,
        quoteId: quote.quoteId,
        enrollmentId: enrollment.enrollmentId,
        orderId: `mock_order_${this.counters.checkout}`,
        finalMinor: minorFromUnits(breakdown.finalAmount!.amount),
      };
      this.checkouts.set(checkout.checkoutId, checkout);
      return jsonResponse(201, {
        id: checkout.checkoutId,
        quoteId: checkout.quoteId,
        enrollmentId: checkout.enrollmentId,
        status: "COMPLETED",
        amount: breakdown.finalAmount,
        nextAction: null,
      });
    }
    if (method === "GET" && segments.length === 3) {
      const checkout = this.checkouts.get(segments[2]!);
      if (checkout === undefined) {
        return errorResponse(404, "CHECKOUT_NOT_FOUND");
      }
      return jsonResponse(200, {
        id: checkout.checkoutId,
        quoteId: checkout.quoteId,
        enrollmentId: checkout.enrollmentId,
        status: "COMPLETED",
        orderId: checkout.orderId,
        finalAmount: moneyAmount(checkout.finalMinor),
        nextAction: null,
      });
    }
    return errorResponse(404, "NOT_FOUND");
  }

  private routePostings(method: string, segments: string[], body: Record<string, unknown>): Response {
    if (method === "POST" && segments.length === 1) {
      const accountId = typeof body.accountId === "string" ? body.accountId : null;
      const entries = body.entries;
      if (accountId === null || body.type !== "WITHDRAWAL" || !Array.isArray(entries) || entries.length !== 1) {
        return errorResponse(422, "INVALID_REQUEST");
      }
      const entry = entries[0] as Record<string, unknown>;
      if (entry.virtualAssetId !== DEMO_ASSET_ID || typeof entry.amount !== "string") {
        return errorResponse(422, "INVALID_ENTRY");
      }
      const minor = minorFromUnits(entry.amount);
      const balance = this.balances.get(accountId);
      const withdrawable = this.withdrawable.get(accountId);
      if (balance === undefined || withdrawable === undefined) {
        return errorResponse(404, "ACCOUNT_NOT_FOUND");
      }
      if (minor < 0n || minor > balance || minor > withdrawable) {
        return errorResponse(422, "INSUFFICIENT_BALANCE");
      }
      this.balances.set(accountId, balance - minor);
      this.withdrawable.set(accountId, withdrawable - minor);
      this.counters.posting += 1;
      const posting: DemoPosting = {
        postingId: `mock_posting_${this.counters.posting}`,
        accountId,
        entries: [{ virtualAssetId: DEMO_ASSET_ID, amount: entry.amount }],
      };
      this.postings.set(posting.postingId, posting);
      return jsonResponse(201, {
        id: posting.postingId,
        accountId: posting.accountId,
        type: "WITHDRAWAL",
        entries: posting.entries,
        rate: 1,
        currency: DEMO_CURRENCY,
        createdAt: this.now().toISOString(),
      });
    }
    if (method === "GET" && segments.length === 2) {
      const posting = this.postings.get(segments[1]!);
      if (posting === undefined) {
        return errorResponse(404, "POSTING_NOT_FOUND");
      }
      return jsonResponse(200, {
        id: posting.postingId,
        accountId: posting.accountId,
        type: "WITHDRAWAL",
        entries: posting.entries,
        rate: 1,
        currency: DEMO_CURRENCY,
        createdAt: this.now().toISOString(),
      });
    }
    return errorResponse(404, "NOT_FOUND");
  }
}

export function getDemoUnitPrices(): Record<string, { currency: string; minor: string }> {
  return Object.fromEntries(
    DEMO_PRODUCTS.map((product) => [
      product.variantId,
      { currency: DEMO_CURRENCY, minor: product.priceMinor.toString() },
    ]),
  );
}

const DEMO_FEATURE_REASON = "LOCAL_MOCK fixture supports this operation; no Reap provider verification implied.";

function demoFeature(now: string) {
  return {
    state: "VERIFIED" as const,
    reason: DEMO_FEATURE_REASON,
    checkedAt: now,
    evidenceRef: DEMO_EVIDENCE_REF,
  };
}

function disabledFeature(reason: string) {
  return { state: "DISABLED" as const, reason, checkedAt: null, evidenceRef: null };
}

export function createDemoReapWrapper(options?: { now?: () => Date; intercept?: (provider: typeof globalThis.fetch) => typeof globalThis.fetch }): ManagedReapWrapper {
  const now = options?.now ?? (() => new Date());
  const provider = new DemoProvider(now);
  const checkedAt = now().toISOString();
  const verified = demoFeature(checkedAt);
  return createReapWrapperInternal(
    {
      mode: "LOCAL_MOCK",
      journalPath: "demo-in-memory",
      config: {
        apiKey: "mock_demo_key",
        projectRef: "groupcart-demo",
        environment: "SANDBOX",
        baseUrl: "https://sg.sandbox.api.reap.global",
        reapVersion: REAP_VERSION,
        fundingModel: "PROGRAM_FUNDED",
        authorizationMode: "MANAGED",
        billingCurrency: DEMO_CURRENCY,
        walletAssetId: DEMO_ASSET_ID,
        simulateCheckout: false,
        stores: [
          {
            storeId: DEMO_STORE_ID,
            providerMerchantName: DEMO_MERCHANT_NAME,
            country: "SG",
            currencies: [DEMO_CURRENCY],
            eligibility: {
              state: "VERIFIED",
              reason: "LOCAL_MOCK fixture store mapping; no Reap provider verification implied.",
              checkedAt,
              evidenceRef: DEMO_EVIDENCE_REF,
            },
          },
        ],
        features: {
          agenticCheckout: { ...verified },
          externalEnrollment: { ...verified },
          productSearch: { ...verified },
          virtualAssetDebit: { ...verified },
          externalCheckoutUrl: disabledFeature("Not implemented in the demo provider."),
          merchantOrderTracking: disabledFeature("Not implemented in the demo provider."),
          merchantOrderCancellation: disabledFeature("Not implemented in the demo provider."),
          merchantRefunds: disabledFeature("Not implemented in the demo provider."),
        },
      },
      users: listDemoAccounts().map((account) => ({
        userId: account.userId,
        reapUserId: account.userId,
        accountId: account.wallet.accountId,
        enrollmentOwnerId: account.userId,
      })),
      validateReturnUrl: (url, binding) => {
        if (!url.startsWith(`${DEMO_RETURN_URL}?`)) {
          return false;
        }
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return false;
        }
        if (parsed.origin !== "https://groupcart.example" || parsed.pathname !== "/return") {
          return false;
        }
        if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
          return false;
        }
        const state = parsed.searchParams.get("state");
        return state === `${binding.operationId}:${binding.userId}`;
      },
      validateConsent: (input: WalletDebitInput) =>
        input.consentRef === `mock-consent:${input.allocationId}:${input.userId}`,
      fetch: options?.intercept?.(provider.fetch) ?? provider.fetch,
      now,
    },
    { journal: new MemoryJournalStore(), minIntervalMs: 0 },
  );
}
