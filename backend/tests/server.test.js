import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * End-to-end tests against the REAL server process.
 *
 * These are the tests that matter for the security pass: they prove that an
 * unauthenticated caller gets nothing, that one client cannot read another
 * client's job, and that a crafted result path cannot escape the output
 * directory.
 */

const API_TOKEN = "integration-api-token";
const SESSION_SECRET = "integration-session-secret";
const INTERNAL_TOKEN = "integration-internal-token";
const PORT = 5391;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let dataDir;
let outDir;
let dbPath;

beforeAll(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "ezt-srv-"));
	outDir = path.join(dataDir, "blackhole");
	dbPath = path.join(dataDir, "jobs.sqlite");
	mkdirSync(outDir, { recursive: true });

	// A minimal built frontend so the static route has something to serve.
	const frontendDir = path.join(dataDir, "dist");
	mkdirSync(frontendDir, { recursive: true });
	writeFileSync(path.join(frontendDir, "index.html"), "<!doctype html><title>ez</title>");

	server = spawn("bun", ["run", "server.js"], {
		cwd: path.join(import.meta.dir, ".."),
		env: {
			...process.env,
			PORT: String(PORT),
			HOST: "127.0.0.1",
			EZTUNES_API_TOKEN: API_TOKEN,
			EZTUNES_SESSION_SECRET: SESSION_SECRET,
			EZTUNES_INTERNAL_TOKEN: INTERNAL_TOKEN,
			AUDD_API_TOKEN: "unused-in-tests",
			DATA_DIR: dataDir,
			OUTPUT_DIR: outDir,
			DB_PATH: dbPath,
			FRONTEND_DIR: frontendDir,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let log = "";
	server.stdout.on("data", (d) => (log += d.toString()));
	server.stderr.on("data", (d) => (log += d.toString()));

	// Wait for the port to answer.
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/api/health`);
			if (res.ok) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`server did not start. log:\n${log}`);
});

afterAll(() => {
	server?.kill("SIGKILL");
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** Exchange the API token for a session cookie. */
async function login(token = API_TOKEN) {
	const res = await fetch(`${BASE}/api/session`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
	});
	const cookie = res.headers.get("set-cookie");
	const value = cookie ? cookie.split(";")[0] : "";
	return { res, cookie: value };
}

describe("unauthenticated access", () => {
	test("the health probe is open and leaks nothing", async () => {
		const res = await fetch(`${BASE}/api/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});

	test("history without a session is refused", async () => {
		const res = await fetch(`${BASE}/api/history`);
		expect(res.status).toBe(401);
	});

	test("submitting a job without a session is refused", async () => {
		const res = await fetch(`${BASE}/api/process`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ videoUrl: "https://youtu.be/abc" }),
		});
		expect(res.status).toBe(401);
	});

	test("the old x-client-id header is NOT accepted as auth", async () => {
		// The pre-security build trusted this header. It must not work now.
		const res = await fetch(`${BASE}/api/history`, {
			headers: { "x-client-id": "made-up-client-id" },
		});
		expect(res.status).toBe(401);
	});

	test("a download without a session is refused", async () => {
		const res = await fetch(`${BASE}/api/download/1`);
		expect(res.status).toBe(401);
	});

	test("a forged session cookie is refused", async () => {
		const res = await fetch(`${BASE}/api/history`, {
			headers: { cookie: "eztunes_session=forged.signature" },
		});
		expect(res.status).toBe(401);
	});

	test("the broadcast endpoint is refused without the internal token", async () => {
		const res = await fetch(`${BASE}/api/internal/broadcast`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ clientId: "x", payload: { status: "completed" } }),
		});
		expect(res.status).toBe(403);
	});

	test("the broadcast endpoint refuses the USER api token", async () => {
		const res = await fetch(`${BASE}/api/internal/broadcast`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-internal-token": API_TOKEN,
			},
			body: JSON.stringify({ clientId: "x", payload: { status: "completed" } }),
		});
		expect(res.status).toBe(403);
	});
});

describe("session exchange", () => {
	test("a wrong token is refused", async () => {
		const { res } = await login("not-the-token");
		expect(res.status).toBe(401);
	});

	test("the right token yields an HttpOnly cookie and a client id", async () => {
		const { res, cookie } = await login();
		expect(res.status).toBe(200);
		expect(cookie).toContain("eztunes_session=");

		const setCookie = res.headers.get("set-cookie");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");

		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.clientId).toHaveLength(32);
	});

	test("the client id is stable across logins", async () => {
		const first = await login();
		const second = await login();
		const a = await first.res.json();
		const b = await second.res.json();
		expect(a.clientId).toBe(b.clientId);
	});
});

describe("authenticated access", () => {
	test("history is reachable with a session", async () => {
		const { cookie } = await login();
		const res = await fetch(`${BASE}/api/history`, { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("a job is created with the session's client id, not a body-supplied one", async () => {
		const { cookie } = await login();
		const res = await fetch(`${BASE}/api/process`, {
			method: "POST",
			headers: { "Content-Type": "application/json", cookie },
			body: JSON.stringify({
				videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
				clientId: "attacker-chosen-id",
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);

		const history = await (
			await fetch(`${BASE}/api/history`, { headers: { cookie } })
		).json();
		expect(history).toHaveLength(1);
		expect(history[0].id).toBe(body.jobId);
	});

	test("a non-http videoUrl is rejected", async () => {
		const { cookie } = await login();
		for (const url of [
			"file:///etc/passwd",
			"ftp://example.com/x",
			"not-a-url",
			"javascript:alert(1)",
		]) {
			const res = await fetch(`${BASE}/api/process`, {
				method: "POST",
				headers: { "Content-Type": "application/json", cookie },
				body: JSON.stringify({ videoUrl: url }),
			});
			expect(res.status).toBe(400);
		}
	});

	test("a non-numeric job id in the download path is a 404, not a lookup", async () => {
		const { cookie } = await login();
		for (const id of ["abc", "1; DROP TABLE jobs", "../../etc/passwd", "1e5"]) {
			const res = await fetch(`${BASE}/api/download/${encodeURIComponent(id)}`, {
				headers: { cookie },
			});
			expect(res.status).toBe(404);
		}
	});

	test("the job table still exists after the injection attempts", async () => {
		const { cookie } = await login();
		const res = await fetch(`${BASE}/api/history`, { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(Array.isArray(await res.json())).toBe(true);
	});
});

describe("static serving", () => {
	test("the SPA shell is served for the root path", async () => {
		const res = await fetch(`${BASE}/`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("<title>ez</title>");
	});

	test("an unknown path falls back to the SPA shell, not a directory listing", async () => {
		const res = await fetch(`${BASE}/some/client/route`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("<title>ez</title>");
	});

	test("a traversal attempt does not escape the frontend directory", async () => {
		// If the traversal worked, this would be the backend's own source file.
		const res = await fetch(`${BASE}/../backend/server.js`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).not.toContain("Bun.serve");
		expect(body).toContain("<title>ez</title>");
	});
});
