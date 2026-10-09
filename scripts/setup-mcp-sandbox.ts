import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadConfig, readEnvironment } from '../src/mcp/config.js';
import { Database } from '../src/mcp/db.js';
import { groupSettings } from '../src/group-buy/runtime.js';
import { supabaseConfig } from '../src/orchestration/supabase.js';

const directory = fileURLToPath(new URL('../.reap/', import.meta.url));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const profilePath = join(directory, 'mcp.env');
if (!existsSync(profilePath)) {
  const profile = {
    APP_MODE: 'sandbox', MCP_READ_ONLY: 'true', MCP_DATABASE_BACKEND: 'supabase', MCP_DATABASE_SCHEMA: 'houjicha_mcp',
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), PUBLIC_BASE_URL: 'http://127.0.0.1:3000', BIND_HOST: '127.0.0.1',
    REAP_PROJECT_REFERENCE: 'houjicha-catalog', REAP_MONEY_UNIT: 'major', REAP_CHECKOUT_ENABLED: 'false', SANDBOX_SIMULATE_CHECKOUT: 'false',
    ALLOWED_COUNTRIES: 'SG', ALLOWED_CURRENCIES: 'USD', ALLOWED_MERCHANTS: '{"death-wish-coffee":"Death Wish Coffee"}', PURCHASE_CAPS: '{"USD":"100.00"}',
    GROUP_BUY_ENABLED: 'true', GROUP_BUY_COUNTRY: 'SG', GROUP_BUY_CURRENCY: 'USD', LOCAL_DEMO_SUBJECT: 'mock_user_reuben',
  };
  writeFileSync(profilePath, Object.entries(profile).map(([key, value]) => `${key}='${value}'`).join('\n')+'\n', { mode: 0o600, flag: 'wx' });
}
readEnvironment();
let db: Database | undefined;
let groups: Pool | undefined;
try {
  const config = loadConfig();
  if (config.mode !== 'sandbox' || !config.readOnly || config.databaseSchema === 'public' || process.env.MCP_DATABASE_BACKEND !== 'supabase') throw new Error('Use the Supabase read-only sandbox profile.');
  const settings = groupSettings(config, process.env);
  if (!settings) throw new Error('Enable the sandbox group backend.');
  db = new Database(config);
  await db.migrate();
  groups = new Pool({ ...supabaseConfig(), connectionTimeoutMillis: 5000 });
  await groups.query(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8').replaceAll('orchestration', settings.schema));
  console.log('Supabase MCP sandbox ready. Real Reap catalogue; payment actions disabled. Run npm run dev:stdio.');
} catch (error) {
  // Connection errors may contain secrets; expose only a safe configuration message.
  console.error('Supabase MCP setup failed. Check SUPABASE_* fields, TLS CA, schema privileges and the sandbox profile.');
  process.exitCode = 1;
} finally { await db?.close(); await groups?.end(); }
