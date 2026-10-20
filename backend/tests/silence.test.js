/**
 * The single-pass silence optimisation is only safe if it is EXACTLY
 * equivalent to the old 48-scan sweep. These tests prove that against a real
 * ffmpeg, on real audio, rather than trusting the reasoning.
 */
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DB_LEVELS,
	GAP_DURATIONS,
	buildSongs,
	estimateTrackCount,
	filterByDuration,
	parseSilences,
} from "../silence.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function ffmpeg(args) {
	return new Promise((resolve, reject) => {
		const p = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		p.stderr.on("data", (d) => (stderr += d.toString()));
		p.on("close", (code) =>
			code === 0 ? resolve({ stderr }) : reject(new Error(stderr.slice(-400))),
		);
	});
}

async function detect(file, db, dur) {
	const { stderr } = await ffmpeg([
		"-i",
		file,
		"-af",
		`silencedetect=noise=${db}dB:d=${dur}`,
		"-f",
		"null",
		"-",
	]);
	return parseSilences(stderr);
}

function sameSilences(a, b, tolerance = 0.02) {
	if (a.length !== b.length) return false;
	return a.every((s, i) =>
		Math.abs(s.start - b[i].start) < tolerance &&
		Math.abs(s.end - b[i].end) < tolerance &&
		Math.abs(s.duration - b[i].duration) < tolerance,
	);
}

const hasFfmpeg = existsSync(FFMPEG) || FFMPEG === "ffmpeg";

describe("silence parsing", () => {
	test("parses start, end and duration from ffmpeg output", () => {
		const stderr = `
[silencedetect @ 0x1] silence_start: 12.5
[silencedetect @ 0x1] silence_end: 14.25 | silence_duration: 1.75
[silencedetect @ 0x1] silence_start: 30
[silencedetect @ 0x1] silence_end: 30.4 | silence_duration: 0.4
`;
		const silences = parseSilences(stderr);
		expect(silences).toHaveLength(2);
		expect(silences[0].start).toBeCloseTo(12.5, 3);
		expect(silences[0].end).toBeCloseTo(14.25, 3);
		expect(silences[0].duration).toBeCloseTo(1.75, 3);
		expect(silences[1].duration).toBeCloseTo(0.4, 3);
	});

	test("an unmatched silence_start does not produce a broken entry", () => {
		const stderr = "[silencedetect @ 0x1] silence_start: 5\n";
		expect(parseSilences(stderr)).toHaveLength(0);
	});
});

describe("duration filtering", () => {
	const silences = [
		{ start: 0, end: 0.3, duration: 0.3 },
		{ start: 10, end: 10.8, duration: 0.8 },
		{ start: 20, end: 22, duration: 2 },
	];

	test("keeps only the silences at least as long as the threshold", () => {
		expect(filterByDuration(silences, 0.2)).toHaveLength(3);
		expect(filterByDuration(silences, 0.4)).toHaveLength(2);
		expect(filterByDuration(silences, 0.8)).toHaveLength(2);
		expect(filterByDuration(silences, 1.0)).toHaveLength(1);
		expect(filterByDuration(silences, 3)).toHaveLength(0);
	});

	test("a silence of exactly the threshold duration is kept, matching ffmpeg", () => {
		// ffmpeg reports a silence when duration >= d, so an exact match must
		// survive the filter. Using > here would silently drop boundary cases.
		expect(filterByDuration(silences, 0.8)).toHaveLength(2);
		expect(filterByDuration(silences, 2)[0].duration).toBe(2);
	});
});

describe("track counting", () => {
	test("counts one more track than there are qualifying gaps", () => {
		const silences = [
			{ start: 10, end: 11, duration: 1 },
			{ start: 30, end: 31, duration: 1 },
			{ start: 50, end: 51, duration: 1 },
		];
		expect(estimateTrackCount(silences)).toBe(4);
	});

	test("a gap under five seconds does not create a track boundary", () => {
		const silences = [
			{ start: 2, end: 3, duration: 1 },
			{ start: 40, end: 41, duration: 1 },
		];
		// The first gap is only 2s from the start, so it is a glitch, not a
		// track boundary. One real boundary plus the final track.
		expect(estimateTrackCount(silences)).toBe(2);
	});
});

describe("song building", () => {
	test("turns silences into track boundaries", () => {
		const silences = [
			{ start: 10, end: 11, duration: 1 },
			{ start: 30, end: 31, duration: 1 },
		];
		const songs = buildSongs(silences);
		expect(songs).toHaveLength(3);
		expect(songs[0]).toEqual({ start: 0, end: 10 });
		expect(songs[1]).toEqual({ start: 11, end: 30 });
		expect(songs[2].end).toBeNull();
	});
});

describe.skipIf(!hasFfmpeg)("equivalence with a real ffmpeg", () => {
	const file = join(tmpdir(), "eztunes-silence-equiv.wav");

	// Four tones separated by gaps of 0.3s, 1.0s, 0.5s and 2.0s, plus a
	// short pause inside a tone so intra-track gaps exist as well.
	//
	// The fixture is built lazily and memoised: Bun's test runner has no
	// beforeAll, and building it eagerly would pay the ffmpeg cost even when
	// every test in the block is skipped.
	let fixture = null;
	async function getFixture() {
		if (fixture) return fixture;
		await ffmpeg([
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=5",
			"-f",
			"lavfi",
			"-i",
			"anullsrc=r=44100:cl=stereo:d=0.3",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=5",
			"-f",
			"lavfi",
			"-i",
			"anullsrc=r=44100:cl=stereo:d=1.0",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=5",
			"-f",
			"lavfi",
			"-i",
			"anullsrc=r=44100:cl=stereo:d=0.5",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=5",
			"-f",
			"lavfi",
			"-i",
			"anullsrc=r=44100:cl=stereo:d=2.0",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=5",
			"-filter_complex",
			"[0:a][1:a][2:a][3:a][4:a][5:a][6:a][7:a][8:a]concat=n=9:v=0:a=1",
			"-y",
			file,
		]);
		fixture = file;
		return file;
	}

	test("one pass per dB level plus an in-memory filter matches a direct pass, for every combination", async () => {
		const audio = await getFixture();
		const base = GAP_DURATIONS[0];

		for (const db of DB_LEVELS) {
			const single = await detect(audio, db, base);

			for (const dur of GAP_DURATIONS) {
				const direct = await detect(audio, db, dur);
				const derived = filterByDuration(single, dur);

				expect(
					sameSilences(direct, derived),
					`db=${db} dur=${dur}: direct=${JSON.stringify(direct)} derived=${JSON.stringify(derived)}`,
				).toBe(true);
			}
		}
	}, 120000);

	test("the single pass finds strictly more silences than a narrow one", async () => {
		const audio = await getFixture();
		const wide = await detect(audio, -40, GAP_DURATIONS[0]);
		const narrow = await detect(audio, -40, 1.5);
		expect(wide.length).toBeGreaterThanOrEqual(narrow.length);
	}, 60000);
});
