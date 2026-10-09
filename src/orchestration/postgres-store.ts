import { Pool } from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import { DomainError } from './contract.js';
import type { CommandResult, Event, Group } from './contract.js';
import type { Store } from './store.js';

// Backend-only PostgreSQL access. The schema is not exposed through Supabase's Data API.
export class PostgresStore implements Store {
  private readonly pool: Pool;
  private readonly tables: string;
  constructor(config: PoolConfig, private readonly schema = 'orchestration') {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema');
    this.tables = `"${schema}"`;
    this.pool = new Pool({ max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 15000, ...config });
    // Idle connection errors must not become uncaught EventEmitter errors.
    this.pool.on('error', () => {});
  }
  async read(id: string): Promise<Group | null> {
    const result = await this.pool.query<{ body: Group }>(`SELECT body FROM ${this.tables}.groups WHERE id=$1`, [id]);
    return result.rows[0]?.body ?? null;
  }
  async groups(): Promise<Group[]> {
    const result = await this.pool.query<{ body: Group }>(`SELECT body FROM ${this.tables}.groups ORDER BY id`);
    return result.rows.map(row => row.body);
  }
  private async recorded(client: Pool | PoolClient, key: string, fingerprint: string): Promise<CommandResult | null> {
    const result = await client.query<{ fingerprint: string; result: CommandResult }>(`SELECT fingerprint,result FROM ${this.tables}.commands WHERE key=$1`, [key]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new DomainError('IDEMPOTENCY_CONFLICT');
    return row.result;
  }
  command(key: string, fingerprint: string): Promise<CommandResult | null> {
    return this.recorded(this.pool, key, fingerprint);
  }
  async commit(group: Group, previousVersion: number, events: Event[], command?: { key: string; fingerprint: string; result: CommandResult }): Promise<CommandResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize short commits across backend instances. Sequence allocation alone is not
      // commit ordered: a cursor must never skip an earlier event still in another transaction.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 913837)', [this.schema]);
      if (command) {
        const prior = await this.recorded(client, command.key, command.fingerprint);
        if (prior) { await client.query('COMMIT'); return prior; }
      }
      const current = await client.query<{ version: number }>(`SELECT version FROM ${this.tables}.groups WHERE id=$1`, [group.id]);
      const version = current.rows[0]?.version ?? 0;
      if (version !== previousVersion) throw new DomainError('VERSION_CONFLICT', true, version);
      for (const participant of group.participants) {
        const id = participant.authorization.authorizationId;
        const existing = await client.query<{ group_id: string; user_id: string }>(`SELECT group_id,user_id FROM ${this.tables}.authorization_bindings WHERE authorization_id=$1`, [id]);
        const binding = existing.rows[0];
        if (binding && (binding.group_id !== group.id || binding.user_id !== participant.userId)) throw new DomainError('FORBIDDEN');
        await client.query(`INSERT INTO ${this.tables}.authorization_bindings VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [id, group.id, participant.userId]);
      }
      await client.query(`INSERT INTO ${this.tables}.groups VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET version=excluded.version,body=excluded.body`, [group.id, group.version, JSON.stringify(group)]);
      for (const event of events) await client.query(`INSERT INTO ${this.tables}.events(event_id,body) VALUES($1,$2)`, [event.eventId, JSON.stringify(event)]);
      if (command) await client.query(`INSERT INTO ${this.tables}.commands VALUES($1,$2,$3)`, [command.key, command.fingerprint, JSON.stringify(command.result)]);
      await client.query('COMMIT');
      return command?.result ?? null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  async updates(userId: string, cursor: number, limit: number): Promise<{ items: Event[]; nextCursor: number }> {
    const result = await this.pool.query<{ cursor: string; body: Event }>(`SELECT cursor,body FROM ${this.tables}.events WHERE cursor>$1 AND body->'recipients' ? $2 ORDER BY cursor LIMIT $3`, [cursor, userId, limit]);
    const last = result.rows.at(-1);
    const nextCursor = last ? Number(last.cursor) : cursor;
    if (!Number.isSafeInteger(nextCursor)) throw new Error('Event cursor exceeds the application contract');
    return { items: result.rows.map(row => row.body), nextCursor };
  }
  close(): Promise<void> { return this.pool.end(); }
}
