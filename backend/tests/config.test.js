import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ConfigError, loadConfig } from "../config.js";

const COMPLETE = {
	EZTUNES_API_TOKEN: "api-token",
	EZTUNES_SESSION_SECRET: "session-secret",
	EZTUNES_INTERNAL_TOKEN: "internal-token",
	AUDD_API_TOKEN: "audd-token",
};

describe("loadConfig", () => {
	test("throws and names every missing variable", () => {
		expect(() => loadConfig({})).toThrow(ConfigError);
		try {
			loadConfig({});
		} catch (err) {
			expect(err.missing).toEqual([
				"EZTUNES_API_TOKEN",
				"EZTUNES_SESSION_SECRET",
				"EZTUNES_INTERNAL_TOKEN",
				"AUDD_API_TOKEN",
			]);
			expect(err.message).toContain("EZTUNES_API_TOKEN");
		}
	});

	test("treats a whitespace-only value as missing", () => {
		expect(() => loadConfig({ ...COMPLETE, EZTUNES_API_TOKEN: "   " })).toThrow(
			ConfigError,
		);
	});

	test("binds to loopback by default - never 0.0.0.0 by accident", () => {
		const config = loadConfig({ ...COMPLETE });
		expect(config.host).toBe("127.0.0.1");
	});

	test("allows an explicit 0.0.0.0 for containers", () => {
		const config = loadConfig({ ...COMPLETE, HOST: "0.0.0.0" });
		expect(config.host).toBe("0.0.0.0");
	});

	test("derives every path from DATA_DIR", () => {
		const config = loadConfig({ ...COMPLETE, DATA_DIR: "/data" });
		expect(config.dataDir).toBe(path.resolve("/data"));
		expect(config.outputDir).toBe(path.resolve("/data/blackhole"));
		expect(config.dbPath).toBe(path.resolve("/data/eztunes.sqlite"));
	});

	test("resolves the output dir to an absolute path", () => {
		const config = loadConfig({ ...COMPLETE, OUTPUT_DIR: "relative/out" });
		expect(path.isAbsolute(config.outputDir)).toBe(true);
	});

	test("honours an explicit DB_PATH", () => {
		const config = loadConfig({ ...COMPLETE, DB_PATH: "/var/lib/ez/jobs.sqlite" });
		expect(config.dbPath).toBe(path.resolve("/var/lib/ez/jobs.sqlite"));
	});

	test("uses an explicit FFMPEG_PATH when given", () => {
		const config = loadConfig({ ...COMPLETE, FFMPEG_PATH: "/usr/bin/ffmpeg" });
		expect(config.ffmpegPath).toBe("/usr/bin/ffmpeg");
	});

	test("falls back to ffmpeg on PATH", () => {
		const config = loadConfig({ ...COMPLETE });
		expect(["ffmpeg", "ffmpeg.exe"]).toContain(
			path.basename(config.ffmpegPath),
		);
	});

	test("defaults the broadcast URL to loopback", () => {
		const config = loadConfig({ ...COMPLETE });
		expect(config.broadcastUrl).toContain("127.0.0.1");
	});

	test("cookie Secure is off unless asked for", () => {
		expect(loadConfig({ ...COMPLETE }).cookieSecure).toBe(false);
		expect(loadConfig({ ...COMPLETE, COOKIE_SECURE: "true" }).cookieSecure).toBe(true);
	});
});
