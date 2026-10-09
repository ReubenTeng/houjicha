import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDemoAccounts } from '../demo-accounts.js';
import { Orchestration } from '../orchestration/application.js';
import { SqliteStore } from '../orchestration/sqlite-fixture-store.js';
import { createReapWithMockUsers, createReapOrchestrationPorts, loadReapConfig } from './index.js';
const directory = mkdtempSync(join(tmpdir(), 'reap-orchestration-'));
const wrapper = createReapWithMockUsers({ config: loadReapConfig({ ...process.env, REAP_PROJECT_REF: process.env.REAP_PROJECT_REF || 'houjicha-catalog', REAP_ENVIRONMENT: 'SANDBOX', REAP_SIMULATE_CHECKOUT: 'false' }), journalPath: join(directory, 'journal.json'), validateConsent: () => false, validateReturnUrl: () => false });
const store = new SqliteStore(join(directory, 'core.sqlite'));
const ports = createReapOrchestrationPorts({ wrapper, mappingPath: join(directory, 'variants.sqlite'), country: 'SG', currency: 'USD', fulfillment: () => { throw new Error('Read-only demo does not quote orders'); } });
try {
  const app = new Orchestration(store, ports.catalog, ports.payments, { resolve: async () => null }, { now: () => new Date().toISOString() });
  const catalog = await app.searchCatalog({ userId: 'mock_user_reuben' }, process.argv.slice(2).join(' ') || 'coffee');
  const wallets = [];
  for (const account of listDemoAccounts()) {
    const wallet = await wrapper.getWallet(account.userId);
    if (!wallet.ok) throw new Error(wallet.error.code);
    wallets.push(wallet);
  }
  console.log(JSON.stringify({ catalogMode: 'SANDBOX', usersMode: 'LOCAL_MOCK', catalog, wallets }, null, 2));
} finally {
  ports.close(); store.close(); await wrapper.close(); rmSync(directory, { recursive: true, force: true });
}
