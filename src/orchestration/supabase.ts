import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';
import { PostgresStore } from './postgres-store.js';

export function supabaseConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const required = (key: string): string => {
    const value = env[key];
    if (!value?.trim()) throw new Error(`Missing ${key}`);
    return value;
  };
  // Keep the connection field names already used by this repository.
  const host = required('SUPABASE_URL').trim();
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('SUPABASE_URL must be the PostgreSQL host, not an HTTP URL or connection string');
  const portText = required('SUPABASE_PORT').trim();
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SUPABASE_PORT');
  const user = required('SUPABASE_USER');
  const password = required('SUPABASE_PASSWORD');
  const database = env.SUPABASE_DATABASE?.trim() || 'postgres';
  const ca = env.SUPABASE_SSL_CA_FILE ? readFileSync(env.SUPABASE_SSL_CA_FILE, 'utf8') : undefined;
  return { host, port, user, password, database, ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) } };
}

// Inject the returned store into Orchestration alongside authenticated consent and payment ports.
export function createSupabaseStore(env: NodeJS.ProcessEnv = process.env): PostgresStore {
  return new PostgresStore(supabaseConfig(env));
}
