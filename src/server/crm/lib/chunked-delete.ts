/** Rows deleted per statement by the clean-ups (docs/agent/database.md: big deletes in bounded batches). */
const PRUNE_CHUNK = 5000;

/**
 * Deletes in chunks of `size` (one statement each, e.g. `DELETE … WHERE id IN (SELECT id … LIMIT n)`)
 * until a chunk comes back short or `until` (ms since 1970) has passed; the next run takes the rest.
 */
export async function deleteInChunks(until: number, chunk: (size: number) => Promise<number>, size = PRUNE_CHUNK) {
  let total = 0;
  for (;;) {
    const n = await chunk(size);
    total += n;
    if (n < size || Date.now() >= until) return total;
  }
}
