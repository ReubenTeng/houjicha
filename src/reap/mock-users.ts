import { randomUUID } from 'node:crypto';
import { getDemoAccount } from '../demo-accounts.js';
import type { ManagedReapWrapper, ReapWrapperOptions } from './config.js';
import type { Success, WalletSnapshot } from './contract.js';
import { createReapWrapperInternal } from './wrapper.js';

export function createReapWithMockUsers(options: Omit<ReapWrapperOptions, 'users' | 'mode'>): ManagedReapWrapper {
  const real = createReapWrapperInternal({ ...options, users: [] });
  const success = <T>(data: T): Success<T> => ({ ok: true, data, mode: 'LOCAL_MOCK', requestId: `req_${randomUUID()}`, warnings: ['LOCAL_MOCK_USERS_ONLY'] });
  return new Proxy(real, {
    get(target, property) {
      if (property === 'getWallet') return async (userId: string) => {
        const user = getDemoAccount(userId);
        if (!user) return target.getWallet(userId);
        return success<WalletSnapshot>({ userId, accountId: user.wallet.accountId, accountStatus: 'ACTIVE', providerAccountStatus: 'LOCAL_MOCK', fundingModel: 'UNKNOWN', authorizationMode: 'UNKNOWN', availableBalance: user.wallet.availableBalance, totalAssetValue: user.wallet.availableBalance, totalLiabilities: { currency: 'USD', minor: '0' }, eligibleAsset: null, debitEligibility: { state: 'DISABLED', reason: 'Local mock wallet cannot be debited.', checkedAt: null, evidenceRef: null }, observedAt: (options.now?.() ?? new Date()).toISOString() });
      };
      if (property === 'listCards' || property === 'listEnrollments') return async (userId: string, page?: { cursor?: string; limit?: number }) => getDemoAccount(userId) ? success({ items: [], nextCursor: null }) : target[property](userId, page);
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
