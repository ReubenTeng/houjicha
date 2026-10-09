import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const address = probe.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
const client = new Client({ name: 'houjicha-catalog-check', version: '1' });
const root = fileURLToPath(new URL('../', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath,
  args: ['--env-file-if-exists=.env', '--import', 'tsx', 'src/mcp/stdio-main.ts'], cwd: root,
  env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined)), MCP_READ_ONLY: 'true', REAP_CHECKOUT_ENABLED: 'false', SANDBOX_SIMULATE_CHECKOUT: 'false', PORT: String(port), PUBLIC_BASE_URL: `http://127.0.0.1:${port}` }, stderr: 'pipe' });
// Keep the protocol check separate from an already running page server.
transport.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert(listed.tools.some(tool => tool.name === 'group_buy'));
  const result = await client.callTool({ name: 'group_buy', arguments: { action: 'search_catalog', query: process.argv.slice(2).join(' ') || 'coffee' } });
  const body = result.structuredContent as { ok: boolean; mode: string; simulated: boolean; status: string; data: { result: { items: unknown[] }; capabilities: { payments: boolean; consent: boolean } } };
  assert(body.ok, `MCP catalogue failed: ${body.status}`);
  assert.equal(body.mode, 'sandbox'); assert.equal(body.simulated, false);
  assert(body.data.result.items.length > 0, 'No catalogue items returned');
  assert.equal(body.data.capabilities.payments, false); assert.equal(body.data.capabilities.consent, false);
  const updates = await client.callTool({ name: 'group_buy', arguments: { action: 'get_my_updates' } });
  assert.equal(updates.isError, false, 'Supabase group persistence is unavailable');
  console.log(JSON.stringify({ path: 'MCP → Orchestration → Reap wrapper → Reap sandbox', ...body }, null, 2));
} finally { await client.close(); }
