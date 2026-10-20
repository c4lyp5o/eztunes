import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../db.js";
import { sweepJobs } from "../sweep.js";

/**
 * The sweeper used to delete every row whose status was not "completed",
 * which meant it could delete a job the worker was actively processing, or a
 * job that was simply queued. These tests pin the corrected behaviour.
 */

let dir;
let outDir;
let db;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "ezt-sweep-"));
	outDir = path.join(dir, "blackhole");
	rmSync(outDir, { force: true });
	writeFileSync(`${outDir}.tmp`, "");
	// create the dir via mkdir through the db helper's parent creation
	require("node:fs").mkdirSync(outDir, { recursive: true });
	db = openDatabase(":memory:");
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;

function insert(status, extra = {}) {
	const created = extra.createdAt ?? new Date().toISOString();
	const updated = extra.updatedAt ?? created;
	db.query(
		`INSERT INTO jobs (client_id, video_url, status, result_file, created_at, updated_at)
     VALUES ('c', 'https://youtu.be/x', ?, ?, ?, ?)`,
	).run(status, extra.resultFile ?? null, created, updated);
}

async function run(overrides = {}) {
	return sweepJobs(db, {
		outputDir: outDir,
		stuckJobMs: 6 * HOUR,
		retentionMs: 7 * 24 * HOUR,
		...overrides,
	});
}

describe("sweepJobs", () => {
	test("a PENDING job is never swept", async () => {
		insert("pending");
		const result = await run();
		expect(result.deadRemoved).toBe(0);
		expect(db.query(`SELECT count(*) c FROM jobs`).get().c).toBe(1);
	});

	test("a job the worker is ACTIVELY processing is not swept", async () => {
		// updated_at is now, so the worker is plainly still on it.
		insert("processing", { updatedAt: new Date().toISOString() });
		const result = await run();
		expect(result.deadRemoved).toBe(0);
		expect(db.query(`SELECT count(*) c FROM jobs`).get().c).toBe(1);
	});

	test("a STALE processing job is swept - the worker died on it", async () => {
		insert("processing", {
			updatedAt: new Date(Date.now() - 10 * HOUR).toISOString(),
		});
		const result = await run();
		expect(result.deadRemoved).toBe(1);
		expect(db.query(`SELECT count(*) c FROM jobs`).get().c).toBe(0);
	});

	test("a FAILED job is swept", async () => {
		insert("failed");
		const result = await run();
		expect(result.deadRemoved).toBe(1);
		expect(db.query(`SELECT count(*) c FROM jobs`).get().c).toBe(0);
	});

	test("a COMPLETED job inside the retention window survives", async () => {
		insert("completed", { createdAt: new Date(Date.now() - HOUR).toISOString() });
		const result = await run();
		expect(result.expiredRemoved).toBe(0);
		expect(db.query(`SELECT count(*) c FROM jobs`).get().c).toBe(1);
	});

	test("a COMPLETED job past the retention window is pruned", async () => {
		insert("completed", {
			createdAt: new Date(Date.now() - 10 * 24 * HOUR).toISOString(),
		});
		const result = await run();
		expect(result.expiredRemoved).toBe(1);
		expect(db.query(`SELECT count(*) c FROM jobs`).get().c).toBe(0);
	});

	test("the retention sweep runs even when there are NO dead jobs", async () => {
		// This is the regression: the old code returned early when nothing
		// was stuck, so expired results were never reclaimed.
		insert("completed", {
			createdAt: new Date(Date.now() - 30 * 24 * HOUR).toISOString(),
		});
		const result = await run();
		expect(result.deadRemoved).toBe(0);
		expect(result.expiredRemoved).toBe(1);
		expect(db.query(`SELECT count(*) c FROM jobs`).get().c).toBe(0);
	});

	test("the result file of a pruned job is deleted from disk", async () => {
		const zip = path.join(outDir, "job_1_playlist.zip");
		writeFileSync(zip, "zip");
		insert("completed", {
			createdAt: new Date(Date.now() - 30 * 24 * HOUR).toISOString(),
			resultFile: "job_1_playlist.zip",
		});
		await run();
		expect(existsSync(zip)).toBe(false);
	});

	test("a result_file pointing outside the output dir cannot delete it", async () => {
		// A tampered row must not be able to remove an arbitrary file.
		const victim = path.join(dir, "important.txt");
		writeFileSync(victim, "do not delete me");

		insert("completed", {
			createdAt: new Date(Date.now() - 30 * 24 * HOUR).toISOString(),
			resultFile: "../important.txt",
		});
		await run();

		expect(existsSync(victim)).toBe(true);
	});

	test("timestamps in EITHER format are compared correctly", async () => {
		// The schema DEFAULT writes "YYYY-MM-DD HH:MM:SS" while a JavaScript
		// ISO string is "YYYY-MM-DDTHH:MM:SS.sssZ". A plain string comparison
		// between the two silently matched the wrong rows, so the sweep never
		// fired for ISO-written rows. julianday() parses both.
		const isoStale = new Date(Date.now() - 10 * HOUR).toISOString();
		const sqliteStale = new Date(Date.now() - 10 * HOUR)
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "");

		insert("processing", { updatedAt: isoStale });
		insert("processing", { updatedAt: sqliteStale });

		const result = await run();
		expect(result.deadRemoved).toBe(2);
		expect(db.query(`SELECT count(*) c FROM jobs`).get().c).toBe(0);
	});

	test("a FRESH processing job with an ISO timestamp is NOT swept", async () => {
		insert("processing", { updatedAt: new Date().toISOString() });
		const result = await run();
		expect(result.deadRemoved).toBe(0);
		expect(db.query(`SELECT count(*) c FROM jobs`).get().c).toBe(1);
	});
});
