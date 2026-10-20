import { describe, test, expect } from "bun:test";
import { mapWithConcurrency } from "../concurrency.js";

describe("mapWithConcurrency", () => {
	test("returns the results in the order of the input", async () => {
		const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
			// Reverse the natural completion order to prove the results are
			// re-ordered back to match the input, not the completion order.
			await new Promise((r) => setTimeout(r, (6 - n) * 10));
			return n * 10;
		});
		expect(results).toEqual([10, 20, 30, 40, 50]);
	});

	test("never runs more than the limit at once", async () => {
		let inFlight = 0;
		let peak = 0;

		await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
		});

		expect(peak).toBeLessThanOrEqual(3);
		expect(peak).toBeGreaterThan(1);
	});

	test("a failing item does not abandon the rest of the batch", async () => {
		const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
			if (n === 2) throw new Error("boom");
			return n;
		});
		expect(results[0]).toBe(1);
		expect(results[1]).toBeNull();
		expect(results[2]).toBe(3);
		expect(results[3]).toBe(4);
	});

	test("an empty input resolves to an empty array", async () => {
		expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
	});

	test("a limit of zero still processes everything, one at a time", async () => {
		let inFlight = 0;
		let peak = 0;
		const results = await mapWithConcurrency([1, 2, 3], 0, async (n) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 1));
			inFlight--;
			return n;
		});
		expect(results).toEqual([1, 2, 3]);
		expect(peak).toBe(1);
	});

	test("a limit larger than the input is clamped to the input size", async () => {
		let inFlight = 0;
		let peak = 0;
		await mapWithConcurrency([1, 2], 50, async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
		});
		expect(peak).toBe(2);
	});
});
