/**
 * concurrency.mjs — bounded-parallelism helpers shared by pull and push.
 *
 * Every script here is dominated by round-trip latency rather than by any
 * work it does locally: a Skilljar GET costs ~380ms, so a sync that issues
 * them one at a time spends essentially all of its wall clock waiting. The
 * obvious fix — fire them all at once — trips Skilljar's rate limit, which
 * the client then has to back off from, and a throttled burst is slower than
 * a steady stream. So requests go out in parallel, but bounded.
 */

/**
 * Like `items.map(fn)` awaited with `Promise.all`, but with at most `limit`
 * calls to `fn` in flight at once. Results keep input order regardless of
 * completion order.
 *
 * Rejections propagate, as they would from `Promise.all`: these callers write
 * to disk or to a live LMS from the results, so a partial set is not a usable
 * outcome and must not be mistaken for a complete one.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
