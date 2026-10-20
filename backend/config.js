import path from "node:path";

/**
 * Central configuration for eztunes.
 *
 * Every secret, path and bind address is resolved HERE, once, at boot. Nothing
 * else in the codebase reads process.env directly. Two reasons:
 *
 *  1. A missing secret is a BOOT failure with a named cause, not a runtime
 *     surprise three hours into a job.
 *  2. The container gets one obvious place to look for what it needs.
 *
 * loadConfig() throws instead of exiting so the test suite can exercise the
 * validation rules without killing the runner.
 */

const APP_DIR = import.meta.dir;
const REPO_DIR = path.join(APP_DIR, "..");

export class ConfigError extends Error {
	constructor(missing) {
		super(
			`Missing required environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
		);
		this.name = "ConfigError";
		this.missing = missing;
	}
}

function required(name, env) {
	const value = env[name];
	if (value === undefined || value === null || String(value).trim() === "") {
		return null;
	}
	return String(value).trim();
}

function bool(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function int(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = Number.parseInt(String(value), 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolve ffmpeg to an ABSOLUTE path.
 *
 * The Windows tree shipped a bundled ffmpeg.exe, which is useless inside a
 * Linux container. Order of preference: an explicit FFMPEG_PATH, then the
 * bundled Windows build if this process is actually on Windows, then
 * whatever is on PATH.
 *
 * The result is absolute because yt-dlp's `ffmpegLocation` option wants the
 * DIRECTORY holding ffmpeg, and path.dirname("ffmpeg") is "." - which
 * would point yt-dlp at the wrong place entirely.
 */
function resolveFfmpeg(env) {
	const explicit = required("FFMPEG_PATH", env);
	if (explicit) return path.resolve(explicit);

	if (process.platform === "win32") {
		const bundled = path.join(APP_DIR, "bin", "ffmpeg.exe");
		if (Bun.file(bundled).size > 0) return bundled;
	}

	// Look for ffmpeg on PATH.
	const pathEnv = env.PATH || env.Path || "";
	for (const dir of pathEnv.split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "ffmpeg");
		try {
			if (Bun.file(candidate).size > 0) return candidate;
		} catch {
			/* not a regular file, keep looking */
		}
	}

	// Fall back to the bare name; spawn() will resolve it via PATH.
	return "ffmpeg";
}

export function loadConfig(env = process.env) {
	const missing = [];

	const apiToken = required("EZTUNES_API_TOKEN", env);
	if (!apiToken) missing.push("EZTUNES_API_TOKEN");

	const sessionSecret = required("EZTUNES_SESSION_SECRET", env);
	if (!sessionSecret) missing.push("EZTUNES_SESSION_SECRET");

	const internalToken = required("EZTUNES_INTERNAL_TOKEN", env);
	if (!internalToken) missing.push("EZTUNES_INTERNAL_TOKEN");

	const auddToken = required("AUDD_API_TOKEN", env);
	if (!auddToken) missing.push("AUDD_API_TOKEN");

	if (missing.length > 0) throw new ConfigError(missing);

	const dataDir = path.resolve(required("DATA_DIR", env) || path.join(APP_DIR, "data"));
	const outputDir = path.resolve(
		required("OUTPUT_DIR", env) || path.join(dataDir, "blackhole"),
	);
	const frontendDir = path.resolve(
		required("FRONTEND_DIR", env) || path.join(REPO_DIR, "frontend", "dist"),
	);

	return {
		// --- network ---
		port: int(env.PORT, 5000),
		// Loopback by default. A container or a reverse proxy must opt in
		// explicitly with HOST=0.0.0.0; the service is never world-reachable
		// by accident.
		host: required("HOST", env) || "127.0.0.1",

		// --- secrets ---
		apiToken,
		sessionSecret,
		internalToken,
		auddToken,

		// --- storage ---
		dataDir,
		outputDir,
		dbPath: path.resolve(
			required("DB_PATH", env) || path.join(dataDir, "eztunes.sqlite"),
		),
		frontendDir,

		// --- behaviour ---
		pollIntervalMs: int(env.POLL_INTERVAL_MS, 3000),
		sweepIntervalMs: int(env.SWEEP_INTERVAL_MS, 12 * 60 * 60 * 1000),
		// A job stuck in "processing" for this long is presumed dead and may
		// be swept. A job that is merely "pending" is never swept - it is
		// waiting its turn, not broken.
		stuckJobMs: int(env.STUCK_JOB_MS, 6 * 60 * 60 * 1000),
		// Completed jobs older than this are pruned along with their zip.
		retentionMs: int(env.RETENTION_MS, 7 * 24 * 60 * 60 * 1000),
		cookieSecure: bool(env.COOKIE_SECURE, false),
		sessionTtlMs: int(env.SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000),
		maxBodyBytes: int(env.MAX_BODY_BYTES, 64 * 1024),

		// --- externals ---
		ffmpegPath: resolveFfmpeg(env),
		broadcastUrl:
			required("BROADCAST_URL", env) || "http://127.0.0.1:5000/api/internal/broadcast",
	};
}

export default loadConfig;
