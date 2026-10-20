import { describe, expect, test } from "bun:test";
import {
	authenticate,
	authenticateInternal,
	buildClearCookie,
	buildSessionCookie,
	createSession,
	deriveClientId,
	parseCookies,
	safeEqual,
	verifySession,
} from "../auth.js";

const SECRET = "test-session-secret-please-change-me";
const API_TOKEN = "test-api-token";
const INTERNAL = "test-internal-token";

describe("safeEqual", () => {
	test("matches identical strings", () => {
		expect(safeEqual("abc", "abc")).toBe(true);
	});

	test("rejects different strings of equal length", () => {
		expect(safeEqual("abc", "abd")).toBe(false);
	});

	test("rejects different lengths without throwing", () => {
		expect(safeEqual("abc", "abcdef")).toBe(false);
		expect(safeEqual("", "a")).toBe(false);
		expect(safeEqual(undefined, null)).toBe(true); // both become ""
	});
});

describe("deriveClientId", () => {
	test("is deterministic for the same token and secret", () => {
		const a = deriveClientId(API_TOKEN, SECRET);
		const b = deriveClientId(API_TOKEN, SECRET);
		expect(a).toBe(b);
		expect(a.length).toBe(32);
	});

	test("differs for a different token", () => {
		expect(deriveClientId(API_TOKEN, SECRET)).not.toBe(
			deriveClientId("other-token", SECRET),
		);
	});

	test("differs for a different secret", () => {
		expect(deriveClientId(API_TOKEN, SECRET)).not.toBe(
			deriveClientId(API_TOKEN, "other-secret"),
		);
	});
});

describe("session signing", () => {
	test("round-trips the client id", () => {
		const cid = deriveClientId(API_TOKEN, SECRET);
		const session = createSession(cid, SECRET, 60_000);
		expect(verifySession(session, SECRET)).toBe(cid);
	});

	test("rejects a tampered payload", () => {
		const cid = deriveClientId(API_TOKEN, SECRET);
		const session = createSession(cid, SECRET, 60_000);
		const [payload, signature] = session.split(".");
		const forged = Buffer.from(
			JSON.stringify({ cid: "someone-else", exp: Date.now() + 60_000 }),
		).toString("base64url");
		expect(verifySession(`${forged}.${signature}`, SECRET)).toBeNull();
		expect(verifySession(`${payload}.${signature}`, SECRET)).toBe(cid);
	});

	test("rejects a session signed with a different secret", () => {
		const cid = deriveClientId(API_TOKEN, SECRET);
		const session = createSession(cid, SECRET, 60_000);
		expect(verifySession(session, "wrong-secret")).toBeNull();
	});

	test("rejects an expired session", () => {
		const cid = deriveClientId(API_TOKEN, SECRET);
		const past = Date.now() - 1000;
		const session = createSession(cid, SECRET, 1, past);
		expect(verifySession(session, SECRET)).toBeNull();
	});

	test("rejects garbage input without throwing", () => {
		expect(verifySession("", SECRET)).toBeNull();
		expect(verifySession("no-dot", SECRET)).toBeNull();
		expect(verifySession(".sig", SECRET)).toBeNull();
		expect(verifySession(undefined, SECRET)).toBeNull();
		expect(verifySession("a.b.c", SECRET)).toBeNull();
	});
});

describe("cookie handling", () => {
	test("parses a cookie header", () => {
		const cookies = parseCookies("a=1; b=two; c=three");
		expect(cookies).toEqual({ a: "1", b: "two", c: "three" });
	});

	test("decodes percent-encoded values", () => {
		expect(parseCookies("x=a%20b").x).toBe("a b");
	});

	test("tolerates an empty or absent header", () => {
		expect(parseCookies("")).toEqual({});
		expect(parseCookies(undefined)).toEqual({});
	});

	test("the session cookie is HttpOnly and SameSite=Strict", () => {
		const header = buildSessionCookie("value", { maxAgeMs: 60_000 });
		expect(header).toContain("HttpOnly");
		expect(header).toContain("SameSite=Strict");
		expect(header).toContain("Path=/");
		expect(header).toContain("Max-Age=60");
	});

	test("Secure is opt-in", () => {
		expect(buildSessionCookie("v", { secure: true })).toContain("Secure");
		expect(buildSessionCookie("v", { secure: false })).not.toContain("Secure");
	});

	test("the clear cookie expires the session", () => {
		expect(buildClearCookie()).toContain("Max-Age=0");
	});
});

describe("authenticate", () => {
	const cid = deriveClientId(API_TOKEN, SECRET);

	function requestWithCookie(value) {
		return new Request("http://localhost/api/history", {
			headers: { cookie: `eztunes_session=${value}` },
		});
	}

	test("returns the client id for a valid session", () => {
		const session = createSession(cid, SECRET, 60_000);
		expect(authenticate(requestWithCookie(session), { sessionSecret: SECRET })).toBe(
			cid,
		);
	});

	test("returns null when there is no cookie", () => {
		const req = new Request("http://localhost/api/history");
		expect(authenticate(req, { sessionSecret: SECRET })).toBeNull();
	});

	test("returns null for a forged cookie", () => {
		const req = requestWithCookie("forged.value");
		expect(authenticate(req, { sessionSecret: SECRET })).toBeNull();
	});
});

describe("authenticateInternal", () => {
	function requestWithToken(token) {
		return new Request("http://localhost/api/internal/broadcast", {
			headers: token ? { "x-internal-token": token } : {},
		});
	}

	test("accepts the correct internal token", () => {
		expect(
			authenticateInternal(requestWithToken(INTERNAL), { internalToken: INTERNAL }),
		).toBe(true);
	});

	test("rejects a missing token", () => {
		expect(
			authenticateInternal(requestWithToken(null), { internalToken: INTERNAL }),
		).toBe(false);
	});

	test("rejects the user API token - the two credentials are separate", () => {
		expect(
			authenticateInternal(requestWithToken(API_TOKEN), { internalToken: INTERNAL }),
		).toBe(false);
	});

	test("rejects a wrong internal token", () => {
		expect(
			authenticateInternal(requestWithToken("nope"), { internalToken: INTERNAL }),
		).toBe(false);
	});
});
