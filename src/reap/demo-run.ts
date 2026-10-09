import { pathToFileURL } from "node:url";
import { listDemoAccounts } from "../demo-accounts.js";
import type { Result } from "./contract.js";
import { createDemoReapWrapper } from "./demo.js";

const DEMO_RETURN_BASE = "https://groupcart.example/return";

function unwrap<T>(result: Result<T>, step: string): T {
  if (!result.ok) {
    throw new Error(`${step} failed: ${result.error.code}`);
  }
  return result.data;
}

export async function runDemo(): Promise<void> {
  const wrapper = createDemoReapWrapper();
  try {
    const accounts = listDemoAccounts();
    const initialWallets: Record<string, unknown> = {};
    for (const account of accounts) {
      const wallet = unwrap(await wrapper.getWallet(account.userId), `getWallet ${account.userId}`);
      initialWallets[account.name] = {
        userId: account.userId,
        accountId: wallet.accountId,
        availableBalance: wallet.availableBalance,
      };
    }
    const search = unwrap(
      await wrapper.searchProducts({ query: "demo", country: "SG", currency: "USD", storeId: "mock_store_demo" }),
      "searchProducts",
    );
    if (search.items.length < 2) {
      throw new Error("searchProducts returned fewer than two products");
    }
    const productIds = search.items.map((item) => item.productId);
    const details = unwrap(await wrapper.getProductDetails(productIds), "getProductDetails");
    if (details.errors.length > 0) {
      throw new Error("getProductDetails reported errors");
    }
    const coffee = details.products.find((product) => product.productId === "mock_product_coffee");
    const milk = details.products.find((product) => product.productId === "mock_product_milk");
    if (coffee?.defaultVariant == null || milk?.defaultVariant == null) {
      throw new Error("Expected demo products with default variants");
    }
    const quote = unwrap(
      await wrapper.createQuote(
        {
          groupOrderId: "group-order-demo-1",
          basketRevision: 1,
          storeId: "mock_store_demo",
          currency: "USD",
          email: "demo-organizer@example.com",
          shippingAddress: {
            firstName: "Demo",
            lastName: "Organizer",
            phone: "+12025550100",
            addressLine1: "1 Demo Street",
            city: "Singapore",
            postalCode: "000001",
            country: "SG",
          },
          lines: [
            { variantId: coffee.defaultVariant.variantId, quantity: 1 },
            { variantId: milk.defaultVariant.variantId, quantity: 1 },
          ],
        },
        { operationId: "op-quote-1", idempotencyKey: "idem-quote-1" },
      ),
      "createQuote",
    );
    if (quote.amountBreakdown.finalAmount.minor !== "2100") {
      throw new Error(`Unexpected quote total ${quote.amountBreakdown.finalAmount.minor}`);
    }
    const enrollment = unwrap(
      await wrapper.createEnrollment(
        {
          userId: "mock_user_justin_1",
          email: "justin1@example.com",
          returnUrl: `${DEMO_RETURN_BASE}?state=${encodeURIComponent("op-enroll-1:mock_user_justin_1")}`,
        },
        { operationId: "op-enroll-1", idempotencyKey: "idem-enroll-1" },
      ),
      "createEnrollment",
    );
    const checkout = unwrap(
      await wrapper.createCheckout(
        {
          groupOrderId: "group-order-demo-1",
          purchaseAttemptId: "attempt-demo-1",
          quoteId: quote.quoteId,
          expectedFingerprint: quote.fingerprint,
          purchaserUserId: "mock_user_justin_1",
          enrollmentId: enrollment.enrollmentId,
          approvedTotal: { currency: "USD", minor: "2100" },
          returnUrl: `${DEMO_RETURN_BASE}?state=${encodeURIComponent("op-checkout-1:mock_user_justin_1")}`,
        },
        { operationId: "op-checkout-1", idempotencyKey: "idem-checkout-1" },
      ),
      "createCheckout",
    );
    const completed = unwrap(await wrapper.getCheckout(checkout.checkoutId), "getCheckout");
    if (completed.status !== "COMPLETED" || !completed.reconciliationReady || completed.finalAmount?.minor !== "2100") {
      throw new Error("Checkout did not reach a reconciliation-ready completed state");
    }
    const debitJustin = unwrap(
      await wrapper.debitWallet(
        {
          groupOrderId: "group-order-demo-1",
          checkoutId: checkout.checkoutId,
          participantId: "mock_user_justin_1",
          userId: "mock_user_justin_1",
          allocationId: "alloc-justin-1",
          consentRef: "mock-consent:alloc-justin-1:mock_user_justin_1",
          approvedAmount: { currency: "USD", minor: "1200" },
          amount: { currency: "USD", minor: "1200" },
        },
        { operationId: "op-debit-justin-1", idempotencyKey: "idem-debit-justin-1" },
      ),
      "debitWallet justin_1",
    );
    const debitReuben = unwrap(
      await wrapper.debitWallet(
        {
          groupOrderId: "group-order-demo-1",
          checkoutId: checkout.checkoutId,
          participantId: "mock_user_reuben",
          userId: "mock_user_reuben",
          allocationId: "alloc-reuben",
          consentRef: "mock-consent:alloc-reuben:mock_user_reuben",
          approvedAmount: { currency: "USD", minor: "900" },
          amount: { currency: "USD", minor: "900" },
        },
        { operationId: "op-debit-reuben", idempotencyKey: "idem-debit-reuben" },
      ),
      "debitWallet reuben",
    );
    const finalWallets: Record<string, unknown> = {};
    const expected: Record<string, string> = {
      "Justin 1": "8800",
      "Justin 2": "10000",
      Reuben: "9100",
      Andrew: "10000",
    };
    for (const account of accounts) {
      const wallet = unwrap(await wrapper.getWallet(account.userId), `final getWallet ${account.userId}`);
      finalWallets[account.name] = {
        userId: account.userId,
        availableBalance: wallet.availableBalance,
      };
      if (wallet.availableBalance?.minor !== expected[account.name]) {
        throw new Error(
          `Final balance for ${account.name} is ${wallet.availableBalance?.minor ?? "null"}, expected ${expected[account.name]}`,
        );
      }
    }
    const output = {
      mode: "LOCAL_MOCK",
      scenario: "legacy checkout then virtual-credit debit; not participant-funded group payment",
      initialWallets,
      quote: {
        quoteId: quote.quoteId,
        fingerprint: quote.fingerprint,
        finalAmount: quote.amountBreakdown.finalAmount,
        itemPricing: quote.itemPricing,
      },
      checkout: {
        checkoutId: completed.checkoutId,
        status: completed.status,
        orderId: completed.orderId,
        finalAmount: completed.finalAmount,
        reconciliationReady: completed.reconciliationReady,
      },
      debits: [
        {
          debitId: debitJustin.debitId,
          participantId: debitJustin.participantId,
          amount: debitJustin.amount,
          state: debitJustin.state,
          postingId: debitJustin.postingId,
        },
        {
          debitId: debitReuben.debitId,
          participantId: debitReuben.participantId,
          amount: debitReuben.amount,
          state: debitReuben.state,
          postingId: debitReuben.postingId,
        },
      ],
      finalWallets,
    };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await wrapper.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runDemo().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "demo failed";
    console.error(`reap demo failed: ${message}`);
    process.exit(1);
  });
}
