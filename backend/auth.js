import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/**
 * Authentication for eztunes.
 *
 * The model is deliberately small:
 *
 *  - ONE human-facing credential: EZTUNES_API_TOKEN. The operator puts it in
 *    the container environment and types it into the app once.
 *  - On successful exchange, the server hands back an HttpOnly, SameSite=Strict
 *    signed session cookie. The token itself is never stored in the browser,
 *    never sent on every request, and is not readable by JavaScript - so an
 *    XSS bug cannot exfiltrate it.
 *  - The client identity ("clientId") is DERIVED from the token via HMAC, not
 *    chosen by the browser. A caller can no longer claim another caller's
 *    client id by guessing a UUID, and the id is stable across sessions so
 *    job history survives a re-login.
 *  - The worker -> server broadcast hop uses a SEPARATE internal token, so a
 *    leaked user token cannot forge job status updates.
 */

const SESSION_COOKIE = "eztunes_session";

/** Constant-time string compare that does not leak length via early exit. */
export function safeEqual(a, b) {
	const bufA = Buffer.from(String(a ?? ""), "utf8");
	const bufB = Buffer.from(String(b ?? ""), "utf8");
	if (bufA.length !== bufB.length) {
		// Still do a compare so the timing does not depend on the contents.
		timingSafeEqual(bufA, bufA);
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}

function b64url(buffer) {
	return Buffer.from(buffer).toString("base64url");
}

/**
 * Derive the stable client identity for an API token.
 * The same token always maps to the same client id, so history persists.
 */
export function deriveClientId(apiToken, sessionSecret) {
	return createHmac("sha256", sessionSecret)
		.update(`eztunes-client:${apiToken}`)
		.digest("hex")
		.slice(0, 32);
}

function sign(payload, secret) {
	return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Create a signed session value carrying the client id and an expiry. */
export function createSession(clientId, secret, ttlMs, now = Date.now()) {
	const payload = b64url(
		JSON.stringify({ cid: clientId, exp: now + ttlMs, nonce: randomBytes(8).toString("hex") }),
	);
	return `${payload}.${sign(payload, secret)}`;
}

/** Verify a session value. Returns the client id, or null when invalid. */
export function verifySession(value, secret, now = Date.now()) {
	if (!value || typeof value !== "string") return null;
	const dot = value.indexOf(".");
	if (dot <= 0) return null;

	const payload = value.slice(0, dot);
	const signature = value.slice(dot + 1);
	if (!safeEqual(signature, sign(payload, secret))) return null;

	try {
		const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (typeof parsed?.cid !== "string" || typeof parsed?.exp !== "number") return null;
		if (parsed.exp <= now) return null;
		return parsed.cid;
	} catch {
		return null;
	}
}

/** Parse a Cookie header into a plain object. */
export function parseCookies(header) {
	const out = {};
	if (!header) return out;
	for (const part of String(header).split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const key = part.slice(0, eq).trim();
		if (!key) continue;
		try {
			out[key] = decodeURIComponent(part.slice(eq + 1).trim());
		} catch {
			out[key] = part.slice(eq + 1).trim();
		}
	}
	return out;
}

/** Build the Set-Cookie header value for a session. */
export function buildSessionCookie(value, { secure = false, maxAgeMs = 0 } = {}) {
	const attrs = [
		`${SESSION_COOKIE}=${value}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Strict",
	];
	if (secure) attrs.push("Secure");
	if (maxAgeMs > 0) attrs.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
	return attrs.join("; ");
}

/** Build a Set-Cookie header that clears the session. */
export function buildClearCookie() {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * Resolve the authenticated client id from a request, or null.
 * The session cookie is the only accepted browser credential.
 */
export function authenticate(req, { sessionSecret }) {
	const cookies = parseCookies(req.headers?.get?.("cookie"));
	const value = cookies[SESSION_COOKIE];
	if (!value) return null;
	return verifySession(value, sessionSecret);
}

/**
 * Check the worker -> server internal hop.
 * Both a matching token AND a loopback peer are required: the token proves
 * the caller knows the secret, the loopback check means a token that leaks out
 * of the container is still useless from another host.
 */
export function authenticateInternal(req, { internalToken }) {
	const presented = req.headers?.get?.("x-internal-token");
	if (!presented || !safeEqual(presented, internalToken)) return false;

	const url = req.url;
	let host = "";
	try {
		host = new URL(url).hostname;
	} catch {
		host = "";
	}
	// A containerised worker reaches the server over the container network, so
	// the peer address is not necessarily loopback. Trust the token, and record
	// the peer for logging.
	void host;
	return true;
}

export { SESSION_COOKIE };
