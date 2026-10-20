import { describe, expect, test } from "bun:test";
import path from "node:path";
import { isSafeFileName, safeJoin, sanitizeFileName } from "../paths.js";

const ROOT = "/data/blackhole";

describe("safeJoin", () => {
	test("resolves a plain name inside the root", () => {
		expect(safeJoin(ROOT, "job_1_playlist.zip")).toBe(
			path.join(ROOT, "job_1_playlist.zip"),
		);
	});

	test("refuses a parent-directory escape", () => {
		expect(safeJoin(ROOT, "../../etc/passwd")).toBeNull();
		expect(safeJoin(ROOT, "../../../etc/shadow")).toBeNull();
	});

	test("refuses an absolute path", () => {
		expect(safeJoin(ROOT, "/etc/passwd")).toBeNull();
	});

	test("refuses a Windows-style absolute path", () => {
		expect(safeJoin(ROOT, "C:\\Windows\\System32\\config\\SAM")).toBeNull();
	});

	test("refuses a null byte", () => {
		expect(safeJoin(ROOT, "job\u0000.zip")).toBeNull();
	});

	test("refuses an empty or non-string name", () => {
		expect(safeJoin(ROOT, "")).toBeNull();
		expect(safeJoin(ROOT, null)).toBeNull();
		expect(safeJoin(ROOT, undefined)).toBeNull();
		expect(safeJoin(ROOT, 42)).toBeNull();
	});

	test("strips nested directories rather than following them", () => {
		// A name with a separator is REFUSED, not silently rewritten.
		// Rewriting it would map "../../etc/passwd" onto a real file called
		// "passwd" - safe, but it hides the attempt.
		expect(safeJoin(ROOT, "../../../etc/passwd")).toBeNull();
		expect(safeJoin(ROOT, "sub/dir/file.zip")).toBeNull();
		expect(safeJoin(ROOT, "sub\\file.zip")).toBeNull();
	});

	test("a name that is only dots is refused", () => {
		expect(safeJoin(ROOT, "..")).toBeNull();
	});
});

describe("isSafeFileName", () => {
	test("accepts an ordinary name", () => {
		expect(isSafeFileName("01 - Watashi no Uso.mp3")).toBe(true);
	});

	test("rejects separators", () => {
		expect(isSafeFileName("a/b.mp3")).toBe(false);
		expect(isSafeFileName("a\\b.mp3")).toBe(false);
	});

	test("rejects dotfiles and dot-dot", () => {
		expect(isSafeFileName(".")).toBe(false);
		expect(isSafeFileName("..")).toBe(false);
	});

	test("rejects control characters and null bytes", () => {
		expect(isSafeFileName("a\u0000b")).toBe(false);
		expect(isSafeFileName("a\nb")).toBe(false);
	});

	test("rejects an over-long name", () => {
		expect(isSafeFileName("x".repeat(256))).toBe(false);
	});
});

describe("sanitizeFileName", () => {
	test("keeps a normal title intact", () => {
		expect(sanitizeFileName("Hikaru Nara")).toBe("Hikaru Nara");
	});

	test("replaces characters Windows forbids", () => {
		const out = sanitizeFileName('AC/DC: Back? <in> "Black" | Thunder');
		expect(out).not.toContain("/");
		expect(out).not.toContain(":");
		expect(out).not.toContain("?");
		expect(out).not.toContain("<");
		expect(out).not.toContain(">");
		expect(out).not.toContain('"');
		expect(out).not.toContain("|");
	});

	test("removes trailing dots and spaces, which Windows drops silently", () => {
		expect(sanitizeFileName("Song Name...")).toBe("Song Name");
		expect(sanitizeFileName("Song Name   ")).toBe("Song Name");
	});

	test("strips control characters", () => {
		expect(sanitizeFileName("Bad\u0000Name\u001f")).toBe("BadName");
	});

	test("falls back when the input is empty", () => {
		expect(sanitizeFileName("", "Unknown Track 01")).toBe("Unknown Track 01");
		expect(sanitizeFileName("...", "fallback")).toBe("fallback");
	});

	test("caps the length", () => {
		expect(sanitizeFileName("x".repeat(500)).length).toBeLessThanOrEqual(180);
	});

	test("a shell payload stays a harmless filename", () => {
		const out = sanitizeFileName("$(rm -rf /) `id` ;whoami");
		expect(out).not.toContain("$(");
		expect(out).not.toContain("`");
	});
});
