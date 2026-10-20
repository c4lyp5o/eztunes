import { describe, test, expect } from "bun:test";
import {
	PHASES,
	sanitizeProgress,
	tracksFromTimestamps,
} from "../progress.js";

describe("sanitizeProgress", () => {
	test("an empty object yields an empty object", () => {
		expect(sanitizeProgress({})).toEqual({});
		expect(sanitizeProgress(null)).toEqual({});
		expect(sanitizeProgress("nonsense")).toEqual({});
		expect(sanitizeProgress(undefined)).toEqual({});
	});

	test("a known phase survives, an unknown one is dropped", () => {
		expect(sanitizeProgress({ phase: PHASES.DETECTING }).phase).toBe("detecting");
		expect(sanitizeProgress({ phase: "rm -rf" }).phase).toBeUndefined();
		expect(sanitizeProgress({ phase: 42 }).phase).toBeUndefined();
	});

	test("a total is rounded and bounded", () => {
		expect(sanitizeProgress({ total: 12.6 }).total).toBe(13);
		expect(sanitizeProgress({ total: -5 }).total).toBe(0);
		expect(sanitizeProgress({ total: 10 ** 9 }).total).toBe(100000);
		expect(sanitizeProgress({ total: "many" }).total).toBeUndefined();
	});

	test("tracks are normalised, numbered from one and capped", () => {
		const result = sanitizeProgress({
			tracks: [
				{ start: 0, end: 120.456, title: "  First  " },
				{ start: 120.456, end: null },
			],
		});

		expect(result.tracks).toHaveLength(2);
		expect(result.tracks[0].index).toBe(1);
		expect(result.tracks[1].index).toBe(2);
		expect(result.tracks[0].start).toBe(0);
		expect(result.tracks[0].end).toBe(120.46);
		expect(result.tracks[0].title).toBe("First");
		expect(result.tracks[1].end).toBeNull();
		expect(result.tracks[1].title).toBeNull();
	});

	test("a track with a negative or non-numeric start is dropped", () => {
		const result = sanitizeProgress({
			tracks: [
				{ start: -1, end: 10 },
				{ start: "abc", end: 10 },
				{ start: 5, end: 10 },
			],
		});
		expect(result.tracks).toHaveLength(1);
		expect(result.tracks[0].start).toBe(5);
	});

	test("an unknown field cannot be smuggled through", () => {
		const result = sanitizeProgress({
			phase: PHASES.CUTTING,
			evil: "<script>alert(1)</script>",
			__proto__: { polluted: true },
		});
		expect(result.evil).toBeUndefined();
		expect(Object.keys(result)).toEqual(["phase"]);
	});

	test("a title is length-capped", () => {
		const long = "x".repeat(5000);
		const result = sanitizeProgress({ tracks: [{ start: 0, title: long }] });
		expect(result.tracks[0].title.length).toBe(200);
	});

	test("a runaway track list is capped", () => {
		const many = Array.from({ length: 5000 }, (_, i) => ({ start: i }));
		const result = sanitizeProgress({ tracks: many });
		expect(result.tracks).toHaveLength(500);
	});
});

describe("tracksFromTimestamps", () => {
	test("maps timestamps into track boundaries", () => {
		const tracks = tracksFromTimestamps([
			{ start: 0, end: 100 },
			{ start: 100, end: null },
		]);
		expect(tracks).toHaveLength(2);
		expect(tracks[0].start).toBe(0);
		expect(tracks[0].end).toBe(100);
		expect(tracks[1].end).toBeNull();
	});

	test("carries chapter titles through when they are given", () => {
		const tracks = tracksFromTimestamps(
			[{ start: 0, end: 10 }],
			["Opening"],
		);
		expect(tracks[0].title).toBe("Opening");
	});

	test("a missing title becomes null", () => {
		const tracks = tracksFromTimestamps([{ start: 0, end: 10 }]);
		expect(tracks[0].title).toBeNull();
	});
});
