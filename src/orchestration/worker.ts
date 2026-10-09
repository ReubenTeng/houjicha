import { setTimeout } from 'node:timers/promises';
import type { Orchestration } from './application.js';
// Host this loop in the backend process independently of client connections.
// Restarting needs only the same Store and payment port, not a session registry.
export async function runWorker(app: Orchestration, options: { signal: AbortSignal; intervalMs?: number; onError: (error: unknown) => void }): Promise<void> {
  const intervalMs=options.intervalMs ?? 1000;
  if(!Number.isSafeInteger(intervalMs) || intervalMs<=0)throw new RangeError('intervalMs must be a positive integer');
  while(!options.signal.aborted) {
    try { await app.tick(); } catch(error) {options.onError(error);}
    try { await setTimeout(intervalMs,undefined,{signal:options.signal}); } catch(error) {if(!options.signal.aborted)throw error;}
  }
}
