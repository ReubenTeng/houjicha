import type { CommandResult, Event, Group } from './contract.js';

type Result<T> = T | Promise<T>;

export interface Store {
  read(id: string): Result<Group | null>;
  groups(): Result<Group[]>;
  command(key: string, fingerprint: string): Result<CommandResult | null>;
  commit(group: Group, previousVersion: number, events: Event[], command?: { key: string; fingerprint: string; result: CommandResult }): Result<CommandResult | null>;
  updates(userId: string, cursor: number, limit: number): Result<{ items: Event[]; nextCursor: number }>;
  close(): Result<void>;
}
