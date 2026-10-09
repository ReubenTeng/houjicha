export interface DemoAccount {
  userId: string;
  name: string;
  mode: "LOCAL_MOCK";
  wallet: {
    accountId: string;
    status: "ACTIVE";
    availableBalance: { currency: "USD"; minor: string };
  };
}

const accounts: DemoAccount[] = [
  {
    userId: "mock_user_justin_1",
    name: "Justin 1",
    mode: "LOCAL_MOCK",
    wallet: {
      accountId: "mock_wallet_justin_1",
      status: "ACTIVE",
      availableBalance: { currency: "USD", minor: "10000" },
    },
  },
  {
    userId: "mock_user_justin_2",
    name: "Justin 2",
    mode: "LOCAL_MOCK",
    wallet: {
      accountId: "mock_wallet_justin_2",
      status: "ACTIVE",
      availableBalance: { currency: "USD", minor: "10000" },
    },
  },
  {
    userId: "mock_user_reuben",
    name: "Reuben",
    mode: "LOCAL_MOCK",
    wallet: {
      accountId: "mock_wallet_reuben",
      status: "ACTIVE",
      availableBalance: { currency: "USD", minor: "10000" },
    },
  },
  {
    userId: "mock_user_andrew",
    name: "Andrew",
    mode: "LOCAL_MOCK",
    wallet: {
      accountId: "mock_wallet_andrew",
      status: "ACTIVE",
      availableBalance: { currency: "USD", minor: "10000" },
    },
  },
];

export function listDemoAccounts(): DemoAccount[] {
  return structuredClone(accounts);
}

export function getDemoAccount(userId: string): DemoAccount | undefined {
  const account = accounts.find((candidate) => candidate.userId === userId);
  return account === undefined ? undefined : structuredClone(account);
}
