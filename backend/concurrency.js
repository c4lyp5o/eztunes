/**
 * A bounded-concurrency map.
 *
 * `Promise.all(items.map(fn))` starts everything at once, which is wrong for
 * two different reasons depending on what `fn` does:
 *
 *  - For CPU-bound work (ffmpeg decoding) it oversubscribes the box and
 *    makes every job slower, not faster.
 *  - For network-bound work (an API round trip) it hammers the service and
 *    invites rate limiting.
 *
 * This runs at most `limit` of them at a time, preserves the order of the
 * results, and never rejects: a failing item yields `null` and the rest
 * carry on. A single bad track must not lose the other eleven.
 */

/**
 * @param {Array} items       the things to process
 * @param {number} limit       how many may be in flight at once
 * @param {(item: any, index: number) => Promise<any>} fn
 * @returns {Promise<Array>}  the results, in the order of `items`
 */
export async function mapWithConcurrency(items, limit, fn) {
	const results = new Array(items.length);
	if (items.length === 0) return results;

	const width = Math.max(1, Math.min(limit, items.length));
	let next = 0;

	async function worker() {
		for (;;) {
			// Claim the next index. Because JS is single-threaded, the
			// read-then-increment here is atomic with respect to other
			// workers - no two workers can claim the same index.
			const index = next++;
			if (index >= items.length) return;

			try {
				results[index] = await fn(items[index], index);
			} catch (err) {
				// One failure must not abandon the rest of the batch.
				results[index] = null;
			}
		}
	}

	await Promise.all(Array.from({ length: width }, () => worker()));
	return results;
}
