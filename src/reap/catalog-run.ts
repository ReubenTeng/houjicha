import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDemoAccounts } from "../demo-accounts.js";
import { createReapWrapper, loadReapConfig } from "./index.js";

const config = loadReapConfig({
  ...process.env,
  REAP_PROJECT_REF: process.env.REAP_PROJECT_REF || "houjicha-catalog",
  REAP_ENVIRONMENT: "SANDBOX",
  REAP_SIMULATE_CHECKOUT: "false",
});
const directory = await mkdtemp(join(tmpdir(), "houjicha-reap-catalog-"));
try {
  const wrapper = createReapWrapper({
    config,
    journalPath: join(directory, "journal.json"),
    users: [],
    validateReturnUrl: () => false,
    validateConsent: () => false,
  });
  try {
    const context = {
      query: process.argv.slice(2).join(" ") || "coffee",
      country: process.env.REAP_CATALOG_COUNTRY || "SG",
      currency: process.env.REAP_CATALOG_CURRENCY || "USD",
      page: { limit: 5 },
    };
    const products = await wrapper.searchProducts(context);
    if (!products.ok) throw new Error(`Reap catalog: ${products.error.code}`);
    const first = products.data.items[0];
    const details = first ? await wrapper.getProductDetails([first.productId]) : null;
    if (details && (!details.ok || details.data.errors.length)) throw new Error('Reap details failed');
    const merchants = [...new Set(products.data.items.map((item) => item.providerMerchantName))];
    console.log(JSON.stringify({
      catalogMode: products.mode,
      catalogSource: "Reap sandbox API",
      usersMode: "LOCAL_MOCK",
      users: listDemoAccounts(),
      context,
      merchants,
      merchantCoverage: "PARTIAL_PRODUCT_SEARCH",
      products: products.data.items,
      details: details?.ok ? details.data : null,
      warnings: products.warnings,
    }, null, 2));
  } finally {
    await wrapper.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
