import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { supabaseConfig } from './supabase.js';

// Connection fields come from .env.example. Verified TLS is the backend connection contract.
const env = { SUPABASE_URL: 'db.example.supabase.co', SUPABASE_PORT: '5432', SUPABASE_USER: 'postgres', SUPABASE_PASSWORD: 'synthetic-password' };
describe('Supabase PostgreSQL configuration', () => {
  it('maps the existing connection fields and requires verified TLS', () => {
    expect(supabaseConfig(env)).toEqual({ host: 'db.example.supabase.co', port: 5432, user: 'postgres', password: 'synthetic-password', database: 'postgres', ssl: { rejectUnauthorized: true } });
    expect(supabaseConfig({ ...env, SUPABASE_PORT: '6543', SUPABASE_USER: 'postgres.project', SUPABASE_DATABASE: 'custom' })).toMatchObject({ port: 6543, user: 'postgres.project', database: 'custom' });
  });
  it.each(['SUPABASE_URL', 'SUPABASE_PORT', 'SUPABASE_USER', 'SUPABASE_PASSWORD'])('rejects missing %s without disclosing credentials', key => {
    expect(() => supabaseConfig({ ...env, [key]: '' })).toThrow(`Missing ${key}`);
  });
  it('rejects API URLs and invalid database ports', () => {
    expect(() => supabaseConfig({ ...env, SUPABASE_URL: 'https://example.supabase.co' })).toThrow('PostgreSQL host');
    for (const port of ['0', '65536', 'abc', '54.32']) expect(() => supabaseConfig({ ...env, SUPABASE_PORT: port })).toThrow('Invalid SUPABASE_PORT');
  });
  it('loads an explicitly supplied CA without disabling certificate verification', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supabase-config-'));
    try {
      const path = join(dir, 'ca.pem'); writeFileSync(path, 'synthetic-ca');
      expect(supabaseConfig({ ...env, SUPABASE_SSL_CA_FILE: path }).ssl).toEqual({ rejectUnauthorized: true, ca: 'synthetic-ca' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
