import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { supabaseConfig } from '../src/orchestration/supabase.js';

let pool: Pool | undefined;
try {
  pool = new Pool(supabaseConfig());
  await pool.query(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  console.log('Supabase orchestration schema ready. No existing data was migrated.');
} catch (error) {
  // Do not log driver errors or connection configuration containing credentials.
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  console.error(`Supabase setup failed${/^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ''}. Check the PostgreSQL host, credentials, TLS CA and schema privileges.`);
  process.exitCode = 1;
} finally { await pool?.end(); }
