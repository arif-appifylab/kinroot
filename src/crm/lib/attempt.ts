import {attemptKey, forgetAttempt} from '../../lib/idempotency';

/**
 * One attempt of a public write a visitor may send twice (a booking, a support request, a form
 * response, a chat's first message): the same `idempotency-key` on every retry of it, so the
 * server makes the thing once and answers a retry with the first answer
 * (docs/agent/orders-and-stock.md).
 *
 *   const r = await sendAttempt(['booking', linkId, start, duration], (headers) => api.post(path, body, headers));
 *
 * (`attemptKey` / `forgetAttempt` of src/lib/idempotency.ts underneath.)
 *
 * `what` says what is being sent: something else is another attempt with its own key. The key is
 * kept when no answer came (a lost connection), on a 5xx and on 429 ("wait a moment", then the
 * same attempt again), and forgotten after any final answer: done, or refused (4xx).
 */
export async function sendAttempt<T>(what: unknown[], send: (headers: {'idempotency-key': string}) => Promise<T>): Promise<T> {
  // Kept by a short digest: what was typed (a message, a form's answers) never sits in storage.
  const parts = ['attempt', digest(JSON.stringify(what))];
  const key = attemptKey(parts);
  try {
    const result = await send({'idempotency-key': key});
    forgetAttempt(parts);
    return result;
  } catch (error) {
    const status = (error as {status?: unknown} | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) forgetAttempt(parts);
    throw error;
  }
}

/** A 53-bit hash (cyrb53) as text: tells attempts apart, nothing more. */
function digest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
