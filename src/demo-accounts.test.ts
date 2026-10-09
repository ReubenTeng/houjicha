import { describe, expect, test } from "vitest";
import { getDemoAccount, listDemoAccounts } from "./demo-accounts.js";

describe("hardcoded demo accounts", () => {
  test("provides the four requested names with stable unique IDs", () => {
    const accounts = listDemoAccounts();
    expect(accounts.map(({ name, userId, wallet }) => [name, userId, wallet.accountId])).toEqual([
      ["Justin 1", "mock_user_justin_1", "mock_wallet_justin_1"],
      ["Justin 2", "mock_user_justin_2", "mock_wallet_justin_2"],
      ["Reuben", "mock_user_reuben", "mock_wallet_reuben"],
      ["Andrew", "mock_user_andrew", "mock_wallet_andrew"],
    ]);
    expect(new Set(accounts.map(({ userId }) => userId)).size).toBe(4);
    expect(new Set(accounts.map(({ wallet }) => wallet.accountId)).size).toBe(4);
  });

  test("labels every account as local mock with USD 100 in integer-string minor units", () => {
    for (const account of listDemoAccounts()) {
      expect(account.mode).toBe("LOCAL_MOCK");
      expect(account.wallet.status).toBe("ACTIVE");
      expect(account.wallet.availableBalance).toEqual({ currency: "USD", minor: "10000" });
      expect(Object.keys(account).sort()).toEqual(["mode", "name", "userId", "wallet"]);
    }
  });

  test("looks up by explicit ID without interpreting names as identity", () => {
    expect(getDemoAccount("mock_user_reuben")?.name).toBe("Reuben");
    expect(getDemoAccount("Reuben")).toBeUndefined();
    expect(getDemoAccount("missing")).toBeUndefined();
  });

  test("list callers cannot mutate the seeds or other callers' balances", () => {
    const account = listDemoAccounts()[0]!;
    account.name = "Changed";
    account.wallet.availableBalance.minor = "0";
    const fresh = listDemoAccounts()[0]!;
    expect(fresh.name).toBe("Justin 1");
    expect(fresh.wallet.availableBalance.minor).toBe("10000");
    expect(getDemoAccount(account.userId)?.wallet.availableBalance.minor).toBe("10000");
  });

  test("lookup callers receive independent copies", () => {
    const first = getDemoAccount("mock_user_andrew")!;
    first.wallet.availableBalance.minor = "1";
    expect(getDemoAccount("mock_user_andrew")?.wallet.availableBalance.minor).toBe("10000");
  });
});
