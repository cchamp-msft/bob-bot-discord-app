import { AsyncLocalStorage } from 'async_hooks';
import * as crypto from 'crypto';

/**
 * Per-queue-item thread context backed by AsyncLocalStorage.
 *
 * Each request-queue execution wraps its executor in a context that
 * carries a 4-character hex thread ID.  Any code running inside that
 * executor (including nested awaits) can call `getThreadId()` to
 * retrieve the ID — no explicit parameter passing required.
 */
const threadStorage = new AsyncLocalStorage<string>();

/**
 * Generate a 4-character lowercase hex thread ID.
 * Collision probability is acceptable (1 in 65 536 per concurrent pair).
 */
export function generateThreadId(): string {
  return crypto.randomBytes(2).toString('hex');
}

/**
 * Run `fn` inside a thread-context scope.
 * All synchronous and asynchronous work spawned from `fn` will
 * see `threadId` via `getThreadId()`.
 */
export function runWithThreadId<T>(threadId: string, fn: () => T): T {
  return threadStorage.run(threadId, fn);
}

/**
 * Retrieve the current thread ID, or `undefined` when called
 * outside a `runWithThreadId` scope.
 */
export function getThreadId(): string | undefined {
  return threadStorage.getStore();
}
