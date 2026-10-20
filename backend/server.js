import db from "./db.js";
import logger from "./logger.js";

const PORT = process.env.PORT || 5000;

const connectedClients = new Map();

Bun.serve({
	port: PORT,
	async fetch(req, server) {
		const url = new URL(req.url);

		if (url.pathname === "/api/ws") {
			// WS /ws
			const clientId = url.searchParams.get("clientId");
			if (!clientId) return new Response("Missing clientId", { status: 400 });

			if (server.upgrade(req, { data: { clientId } })) return;
			return new Response("Upgrade failed", { status: 500 });
		}
		// POST /api/internal/broadcast
		if (req.method === "POST" && url.pathname === "/api/internal/broadcast") {
			try {
				const { clientId, payload } = await req.json();

				// If the user is online, push the update to their browser!
				const ws = connectedClients.get(clientId);
				if (ws && ws.readyState === 1) {
					ws.send(JSON.stringify(payload));
				}
				return new Response("Broadcasted");
			} catch (e) {
				return new Response("Broadcast failed", { status: 500 });
			}
		}

		// POST /api/process
		if (req.method === "POST" && url.pathname === "/api/process") {
			try {
				const body = await req.json();
				if (!body.videoUrl || !body.clientId) {
					return new Response(
						JSON.stringify({ error: "Missing videoUrl or clientId" }),
						{ status: 400 },
					);
				}

				// Parse expectedTracks if the user provided it
				const expectedTracks = body.expectedTracks
					? parseInt(body.expectedTracks, 10)
					: null;

				const insertJob = db.query(
					`INSERT INTO jobs (client_id, video_url, expected_tracks) VALUES (?, ?, ?) RETURNING id`,
				);
				const result = insertJob.get(
					body.clientId,
					body.videoUrl,
					expectedTracks,
				);

				logger.info(
					`📝 Added new job #${result.id} (Expected Tracks: ${expectedTracks || "Auto"})`,
				);
				return new Response(
					JSON.stringify({ success: true, jobId: result.id }),
					{ status: 200 },
				);
			} catch (error) {
				logger.error(`Server error: ${error.message}`);
				return new Response(
					JSON.stringify({ error: "Internal Server Error" }),
					{ status: 500 },
				);
			}
		}

		// GET /api/history
		if (req.method === "GET" && url.pathname === "/api/history") {
			const clientId = req.headers.get("x-client-id");
			if (!clientId)
				return new Response("Missing x-client-id header", { status: 400 });

			const history = db
				.query(
					`SELECT id, video_url, status, error_msg, created_at FROM jobs WHERE client_id = ? ORDER BY created_at DESC`,
				)
				.all(clientId);

			const formatted = history.map((job) => ({
				...job,
				download_url:
					job.status === "completed"
						? `http://localhost:${PORT}/api/download/${job.id}`
						: null,
			}));
			return new Response(JSON.stringify(formatted), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// GET /api/download
		if (req.method === "GET" && url.pathname.startsWith("/api/download")) {
			const id = url.pathname.split("/").pop();
			const clientId = req.headers.get("x-client-id");

			if (!id || !clientId) return new Response("Not found", { status: 404 });

			const job = db
				.query(`SELECT client_id, result_file FROM jobs WHERE id = ?`)
				.get(id);

			if (!job) return new Response("Not found", { status: 404 });

			if (clientId !== job.client_id)
				return new Response("Forbidden", { status: 403 });

			return new Response(Bun.file(job.result_file), {
				headers: {
					"Content-Type": "application/zip",
					"Content-Disposition": `attachment; filename="eztunes_playlist_${id}.zip"`,
				},
			});
		}

		return new Response("Not Found", { status: 404 });
	},

	websocket: {
		open(ws) {
			connectedClients.set(ws.data.clientId, ws);
			logger.info(`🔗 Client connected: ${ws.data.clientId}`);
		},
		message(ws, message) {},
		close(ws) {
			connectedClients.delete(ws.data.clientId);
			logger.info(`🔌 Client disconnected: ${ws.data.clientId}`);
		},
	},
});

logger.info(`🚀 Eztunes Server running on http://localhost:${PORT}`);
