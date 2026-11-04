/**
 * Waiting on background work in tests by TIME, not by a count of short tries: jobs run in-process,
 * but some finish after the answer, and on a busy machine "40 tries × 50 ms" (2 s) is not enough.
 * Polls `read` until `done(value)` or `timeoutMs` (default 10 s) passes, then returns the last value
 * (the caller's `expect` says what was wrong).
 */
export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, {timeoutMs = 10_000, intervalMs = 50} = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() >= deadline) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** `eventually` for anything with a `status`: until it is one of `statuses`. */
export function settle<T extends {status: string}>(read: () => Promise<T>, statuses: string[], opts?: {timeoutMs?: number}): Promise<T> {
  return eventually(read, (v) => statuses.includes(v.status), opts);
}
