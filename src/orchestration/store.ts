import { DatabaseSync } from 'node:sqlite';
import type { CommandResult, Event, Group } from './contract.js';
import { DomainError } from './contract.js';

export interface Store {
  read(id: string): Group | null;
  groups(): Group[];
  command(key: string, fingerprint: string): CommandResult | null;
  commit(group: Group, previousVersion: number, events: Event[], command?: { key: string; fingerprint: string; result: CommandResult }): CommandResult | null;
  updates(userId: string, cursor: number, limit: number): { items: Event[]; nextCursor: number };
  close(): void;
}
// Each aggregate contains its durable deadline, approvals and pending payment intent.
// Workers use versioned writes and payment-service deduplication, not in-memory locks.
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO migrations VALUES(1);
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, version INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS authorization_bindings(authorization_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, user_id TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(2);
      CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
    `);
  }
  read(id: string): Group | null {
    const row = this.db.prepare('SELECT body FROM groups WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) as Group : null;
  }
  groups(): Group[] { return this.db.prepare('SELECT body FROM groups ORDER BY id').all().map(r => JSON.parse(String(r.body)) as Group); }
  command(key: string, fingerprint: string): CommandResult | null {
    const row = this.db.prepare('SELECT fingerprint,result FROM commands WHERE key=?').get(key);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new DomainError('IDEMPOTENCY_CONFLICT');
    return JSON.parse(String(row.result)) as CommandResult;
  }
  commit(group: Group, previousVersion: number, events: Event[], command?: { key: string; fingerprint: string; result: CommandResult }): CommandResult | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (command) {
        const prior = this.command(command.key, command.fingerprint);
        if (prior) { this.db.exec('COMMIT'); return prior; }
      }
      const current = this.read(group.id);
      if ((current?.version ?? 0) !== previousVersion) throw new DomainError('VERSION_CONFLICT', true, current?.version ?? 0);
      for (const participant of group.participants) {
        const id=participant.authorization.authorizationId;
        const binding=this.db.prepare('SELECT group_id,user_id FROM authorization_bindings WHERE authorization_id=?').get(id);
        if(binding && (binding.group_id!==group.id || binding.user_id!==participant.userId))throw new DomainError('FORBIDDEN');
        this.db.prepare('INSERT OR IGNORE INTO authorization_bindings VALUES(?,?,?)').run(id,group.id,participant.userId);
      }
      this.db.prepare('INSERT INTO groups VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,body=excluded.body').run(group.id, group.version, JSON.stringify(group));
      for (const event of events) this.db.prepare('INSERT INTO events(event_id,body) VALUES(?,?)').run(event.eventId, JSON.stringify(event));
      if (command) this.db.prepare('INSERT INTO commands VALUES(?,?,?)').run(command.key, command.fingerprint, JSON.stringify(command.result));
      this.db.exec('COMMIT');
      return command?.result ?? null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  updates(userId: string, cursor: number, limit: number): { items: Event[]; nextCursor: number } {
    const items: Event[] = [];
    let nextCursor = cursor;
    for (const row of this.db.prepare('SELECT cursor,body FROM events WHERE cursor>? ORDER BY cursor').all(cursor)) {
      const event = JSON.parse(String(row.body)) as Event;
      nextCursor = Number(row.cursor);
      if (event.recipients.includes(userId)) items.push(event);
      if (items.length === limit) break;
    }
    return { items, nextCursor };
  }
  close(): void { this.db.close(); }
}
