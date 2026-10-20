import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import logger from "./logger.js";
import {
	authenticate,
	authenticateInternal,
	buildClearCookie,
	buildSessionCookie,
	createSession,
	deriveClientId,
	safeEqual,
} from "./auth.js";
import { safeJoin } from "./paths.js";
import { sanitizeProgress } from "./progress.js";

/**
 * The eztunes HTTP server.
 *
 * Serves three things:
 *   - the built single-page app (so one process is the whole product)
 *   - the authenticated job API
 *   - the internal broadcast endpoint the worker pushes progress to
 *
 * Security model, in one paragraph: every /api route except the session
 * exchange and the health probe requires a valid signed session cookie. The
 * client identity is derived from the API token by the server, never chosen by
 * the browser. File downloads resolve a stored NAME against the output root
 * and refuse to escape it.
 */

const config = loadConfig();
const db = openDatabase(config.dbPath);

const connectedClients = new Map();

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".map": "application/json; charset=utf-8",
};

function json(payload, status = 200, headers = {}) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
	});
}

/** Read a JSON body with a size cap, so a huge POST cannot exhaust memory. */
async function readJsonBody(req) {
	const declared = Number(req.headers.get("content-length") || "0");
	if (declared > config.maxBodyBytes) {
		throw new Error("Payload too large");
	}
	const text = await req.text();
	if (text.length > config.maxBodyBytes) throw new Error("Payload too large");
	return text ? JSON.parse(text) : {};
}

/**
 * Serve a file from the built frontend, falling back to index.html so the
 * single-page app owns its own routing.
 */
async function serveStatic(pathname) {
	const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const resolved = safeJoin(config.frontendDir, relative);

	// A miss (or a traversal attempt) falls through to the SPA shell.
	const target =
		resolved && (await Bun.file(resolved).exists())
			? resolved
			: safeJoin(config.frontendDir, "index.html");

	if (!target) return new Response("Not Found", { status: 404 });

	const file = Bun.file(target);
	if (!(await file.exists())) {
		return new Response(
			"Frontend bundle not found. Run `bun run build:client` before starting the server.",
			{ status: 503 },
		);
	}

	const ext = target.slice(target.lastIndexOf("."));
	return new Response(file, {
		headers: {
			"Content-Type": MIME[ext] || "application/octet-stream",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

const server = Bun.serve({
	port: config.port,
	hostname: config.host,
	// A hard ceiling on request body size at the transport layer too.
	maxRequestBodySize: config.maxBodyBytes,

	async fetch(req, srv) {
		const url = new URL(req.url);
		const { pathname } = url;

		// ---------------------------------------------------------------
		// Unauthenticated endpoints
		// ---------------------------------------------------------------

		// Health probe. Says nothing about job data.
		if (pathname === "/api/health") {
			return json({ status: "ok" });
		}

		// Session exchange. The browser posts the operator's API token once
		// and receives an HttpOnly signed cookie.
		if (req.method === "POST" && pathname === "/api/session") {
			try {
				const body = await readJsonBody(req);
				const presented = body?.token;

				if (!presented || !safeEqual(presented, config.apiToken)) {
					// Do not reveal which part was wrong.
					return json({ error: "Invalid credentials" }, 401);
				}

				const clientId = deriveClientId(config.apiToken, config.sessionSecret);
				const session = createSession(
					clientId,
					config.sessionSecret,
					config.sessionTtlMs,
				);
				return json(
					{ success: true, clientId },
					200,
					{
						"Set-Cookie": buildSessionCookie(session, {
							secure: config.cookieSecure,
							maxAgeMs: config.sessionTtlMs,
						}),
					},
				);
			} catch {
				return json({ error: "Invalid request" }, 400);
			}
		}

		// Log out: clear the cookie.
		if (req.method === "POST" && pathname === "/api/logout") {
			return json({ success: true }, 200, { "Set-Cookie": buildClearCookie() });
		}

		// ---------------------------------------------------------------
		// Internal worker -> server hop
		// ---------------------------------------------------------------
		if (req.method === "POST" && pathname === "/api/internal/broadcast") {
			if (!authenticateInternal(req, { internalToken: config.internalToken })) {
				return json({ error: "Forbidden" }, 403);
			}
			try {
				const body = await readJsonBody(req);
				const { clientId, payload } = body;

				if (typeof clientId !== "string" || !clientId || !payload) {
					return json({ error: "Missing clientId or payload" }, 400);
				}

				// Only forward to a client that is actually connected, and
				// only if the payload is the shape we expect. A forged
				// broadcast must not be able to inject arbitrary fields.
				const ws = connectedClients.get(clientId);
				if (ws && ws.readyState === 1) {
					ws.send(
						JSON.stringify({
							jobId: payload.jobId ?? null,
							status: payload.status ?? null,
							progressMsg:
								typeof payload.progressMsg === "string"
									? payload.progressMsg.slice(0, 500)
									: null,
							downloadUrl:
								typeof payload.downloadUrl === "string"
									? payload.downloadUrl.slice(0, 200)
									: null,
							// The structured detail is whitelisted on the
							// way out, so the browser can trust its shape.
							detail: sanitizeProgress(payload.detail),
						}),
					);
				}
				return json({ success: true });
			} catch {
				return json({ error: "Broadcast failed" }, 500);
			}
		}

		// ---------------------------------------------------------------
		// WebSocket upgrade
		// ---------------------------------------------------------------
		if (pathname === "/api/ws") {
			const clientId = authenticate(req, { sessionSecret: config.sessionSecret });
			if (!clientId) {
				return new Response("Unauthorized", { status: 401 });
			}
			if (srv.upgrade(req, { data: { clientId } })) return undefined;
			return new Response("Upgrade failed", { status: 500 });
		}

		// ---------------------------------------------------------------
		// Everything else under /api needs a session
		// ---------------------------------------------------------------
		if (pathname.startsWith("/api/")) {
			const clientId = authenticate(req, { sessionSecret: config.sessionSecret });
			if (!clientId) {
				return json({ error: "Unauthorized" }, 401);
			}

			// --- POST /api/process ---
			if (req.method === "POST" && pathname === "/api/process") {
				try {
					const body = await readJsonBody(req);
					const { videoUrl, expectedTracks } = body;

					if (typeof videoUrl !== "string" || !videoUrl.trim()) {
						return json({ error: "Missing videoUrl" }, 400);
					}

					// Only http(s). A "url" of file:// or a raw path must not
					// reach the downloader.
					let parsed;
					try {
						parsed = new URL(videoUrl.trim());
					} catch {
						return json({ error: "videoUrl must be a valid URL" }, 400);
					}
					if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
						return json({ error: "videoUrl must be http or https" }, 400);
					}

					const expected =
						expectedTracks === undefined ||
						expectedTracks === null ||
						expectedTracks === ""
							? null
							: Number.parseInt(String(expectedTracks), 10);
					if (expected !== null && (!Number.isFinite(expected) || expected < 1)) {
						return json({ error: "expectedTracks must be a positive integer" }, 400);
					}

					// client_id comes from the session, never from the body.
					const result = db
						.query(
							`INSERT INTO jobs (client_id, video_url, expected_tracks) VALUES (?, ?, ?) RETURNING id`,
						)
						.get(clientId, parsed.toString(), expected);

					logger.info(
						`📝 Added job #${result.id} (expected tracks: ${expected ?? "auto"})`,
					);
					return json({ success: true, jobId: result.id });
				} catch (error) {
					logger.error(`Server error: ${error.message}`);
					return json({ error: "Internal Server Error" }, 500);
				}
			}

			// --- GET /api/history ---
			if (req.method === "GET" && pathname === "/api/history") {
				const history = db
					.query(
						`SELECT id, video_url, status, error_msg, created_at FROM jobs WHERE client_id = ? ORDER BY created_at DESC, id DESC`,
					)
					.all(clientId);

				return json(
					history.map((job) => ({
						...job,
						download_url:
							job.status === "completed" ? `/api/download/${job.id}` : null,
					})),
				);
			}

			// --- GET /api/download/:id ---
			if (req.method === "GET" && pathname.startsWith("/api/download/")) {
				const id = pathname.slice("/api/download/".length);
				if (!/^\d+$/.test(id)) {
					return json({ error: "Not found" }, 404);
				}

				const job = db
					.query(`SELECT client_id, result_file FROM jobs WHERE id = ?`)
					.get(Number(id));

				if (!job) return json({ error: "Not found" }, 404);
				// The session owns the job. A different client cannot fetch it.
				if (job.client_id !== clientId) {
					return json({ error: "Forbidden" }, 403);
				}
				if (!job.result_file) {
					return json({ error: "No result file" }, 404);
				}

				// Resolve the stored NAME against the output root. Anything
				// that escapes is refused rather than served.
				const resolved = safeJoin(config.outputDir, job.result_file);
				if (!resolved) {
					logger.error(`Refused unsafe result path for job ${id}`);
					return json({ error: "Not found" }, 404);
				}

				const file = Bun.file(resolved);
				if (!(await file.exists())) {
					// The row says completed but the artefact is gone (disk
					// cleaned, volume remounted). Say so rather than 500.
					return json({ error: "Result file no longer available" }, 410);
				}

				return new Response(file, {
					headers: {
						"Content-Type": "application/zip",
						"Content-Disposition": `attachment; filename="eztunes_playlist_${id}.zip"`,
						"X-Content-Type-Options": "nosniff",
					},
				});
			}

			return json({ error: "Not Found" }, 404);
		}

		// ---------------------------------------------------------------
		// The single-page app
		// ---------------------------------------------------------------
		if (req.method === "GET" || req.method === "HEAD") {
			return serveStatic(pathname);
		}

		return new Response("Not Found", { status: 404 });
	},

	websocket: {
		open(ws) {
			connectedClients.set(ws.data.clientId, ws);
			logger.info(`🔗 Client connected: ${ws.data.clientId.slice(0, 8)}…`);
		},
		message() {
			// The client never needs to talk to the server over the socket.
		},
		close(ws) {
			// Only drop the map entry if it is still THIS socket: a reconnect
			// must not be unregistered by the close of its predecessor.
			if (connectedClients.get(ws.data.clientId) === ws) {
				connectedClients.delete(ws.data.clientId);
			}
			logger.info(`🔌 Client disconnected: ${ws.data.clientId.slice(0, 8)}…`);
		},
	},
});

logger.info(
	`🚀 Eztunes server on http://${config.host}:${config.port} (data: ${config.dataDir})`,
);
