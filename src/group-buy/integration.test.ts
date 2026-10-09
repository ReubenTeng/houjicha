import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { expect, test, vi } from 'vitest';
import { loadConfig, scopes } from '../mcp/config.js';
import { buildMcpServer } from '../mcp/mcp.js';
import type { Commerce } from '../mcp/commerce.js';
import type { Database } from '../mcp/db.js';
import { SqliteStore } from '../orchestration/sqlite-fixture-store.js';
import { DemoProvider } from '../reap/demo.js';
import { createGroupRuntime } from './runtime.js';

const config = loadConfig({ APP_MODE: 'sandbox', MCP_READ_ONLY: 'true', REAP_API_KEY: 'test', REAP_PROJECT_REFERENCE: 'test',
  DATABASE_URL: 'postgresql://test@127.0.0.1/test', DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ALLOWED_COUNTRIES: 'SG', ALLOWED_CURRENCIES: 'USD', ALLOWED_MERCHANTS: '{"unused":"Unused merchant"}', PURCHASE_CAPS: '{"USD":"100"}' });
const identity = { issuer: 'test', subject: 'mock_user_reuben', scopes: [...scopes], email: null, emailVerified: false };

test('MCP group catalogue traverses real orchestration and wrapper, never the commerce provider', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-wrapper-'));
  const provider = new DemoProvider();
  let fail = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => fail ? Response.json({}, { status: 500 }) : provider.fetch(url, init));
  const db = { actor: vi.fn(async () => ({ ...identity, id: 'local-user', ownerReference: 'local-owner' })), rateLimit: vi.fn(async () => {}), audit: vi.fn(async () => {}) } as unknown as Database;
  const commerce = { config, db, call: vi.fn(), provider: { search: vi.fn(() => { throw new Error('Wrong provider path'); }) } } as unknown as Commerce;
  const env = { GROUP_BUY_ENABLED: 'true', GROUP_BUY_COUNTRY: 'SG', GROUP_BUY_CURRENCY: 'USD', GROUP_BUY_REAP_DATA_DIR: directory };
  const runtime = await createGroupRuntime(commerce, env, { store: new SqliteStore(':memory:'), fetch });
  const server = buildMcpServer(commerce, identity, runtime.tool);
  const client = new Client({ name: 'test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    const result = await client.callTool({ name: 'group_buy', arguments: { action: 'search_catalog', query: 'coffee' } });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ mode: 'sandbox', simulated: false, data: { capabilities: { catalog: true, payments: false, consent: false }, result: { items: [expect.objectContaining({ merchantId: expect.stringMatching(/^reap_merchant_/), indicativePrice: {currency:'USD',minor:'900'} })] } } });
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/agentic/products/search', '/agentic/products/details']);
    expect(commerce.provider.search).not.toHaveBeenCalled(); expect(commerce.call).not.toHaveBeenCalled();
    const blocked = await client.callTool({ name: 'group_buy', arguments: { action: 'close_group_buy', groupBuyId: 'test', metadata: {commandId:'close',expectedVersion:1} } });
    expect(blocked.structuredContent).toMatchObject({ status: 'READ_ONLY_MODE' });
    fail = true;
    expect((await client.callTool({ name: 'group_buy', arguments: { action: 'search_catalog', query: 'coffee' } })).structuredContent).toMatchObject({ ok: false, status: 'PROVIDER_UNAVAILABLE' });
  } finally { await client.close(); await server.close(); await runtime.close(); }
  // Reopening proves shutdown released the wrapper journal lock and SQLite DB.
  const reopened = await createGroupRuntime(commerce, env, { store: new SqliteStore(':memory:'), fetch });
  await reopened.close(); rmSync(directory, {recursive:true,force:true});
});

