/**
 * The design preview harness.
 *
 * This page renders the REAL app against a stubbed server, so the design
 * can be inspected with real-looking data: a job part-way through its
 * split, the map filling in, the tracks naming themselves.
 *
 * It is a development tool. It is not part of the production build (Vite
 * only builds index.html) and it never ships in the image.
 *
 * The stubs are honest: they answer the same shapes the real server
 * answers, and the app is not modified in any way to accommodate them.
 */

import { createRoot } from "react-dom/client";
import App from "./App.jsx";

/* ------------------------------------------------------------------ */
/* the fixture                                                        */
/* ------------------------------------------------------------------ */

/** Real song titles, standing in for what AudD recognises. */
const BOUNDARIES = [
	{ index: 1, start: 0, end: 214.4, title: null },
	{ index: 2, start: 216.8, end: 401.2, title: null },
	{ index: 3, start: 404.6, end: 612.9, title: null },
	{ index: 4, start: 615.1, end: 838.3, title: null },
];

const NAMED = [
	{
		index: 1,
		title: "Midnight City",
		artist: "M83",
		album: "Hurry Up, We're Dreaming",
		start: 0,
		end: 214.4,
		length: 214.4,
	},
	{
		index: 2,
		title: "Instant Crush",
		artist: "The xx",
		album: "Coexist",
		start: 216.8,
		end: 401.2,
		length: 184.4,
	},
	{
		index: 3,
		title: "Little Dark Age",
		artist: "MGMT",
		album: "Little Dark Age",
		start: 404.6,
		end: 612.9,
		length: 208.3,
	},
	{
		index: 4,
		title: "Tongue Tied",
		artist: "Grouplove",
		album: "Never Trust a Happy Song",
		start: 615.1,
		end: 838.3,
		length: 223.2,
	},
];

const HISTORY = [
	{
		id: 7,
		video_url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
		title: "Night Drive Mix, Chapter Two",
		status: "completed",
		track_count: 12,
		duration_secs: 2841,
		created_at: "2026-10-20 21:04:11",
		download_url: "/api/download/7",
	},
	{
		id: 6,
		video_url: "https://www.youtube.com/watch?v=3JZ_D3ELwOQ",
		title: "Warehouse Sessions, November",
		status: "completed",
		track_count: 9,
		duration_secs: 1977,
		created_at: "2026-10-19 22:41:58",
		download_url: "/api/download/6",
	},
	{
		id: 5,
		video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		title: "Full Set, Side B",
		status: "failed",
		error_msg: "Could not detect any silences at any volume level.",
		created_at: "2026-10-18 19:22:03",
		download_url: null,
	},
];

/* ------------------------------------------------------------------ */
/* the stubbed server                                                 */
/* ------------------------------------------------------------------ */

function jsonResponse(payload, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

const realFetch = window.fetch.bind(window);

/*
 * The preview can be forced into either mood with ?theme=light or
 * ?theme=dark, so both can be inspected without clicking the switch.
 */
const forcedTheme = new URLSearchParams(window.location.search).get("theme");
if (forcedTheme === "light" || forcedTheme === "dark") {
	document.documentElement.dataset.theme = forcedTheme;
	try {
		window.localStorage.setItem("eztunes-theme", forcedTheme);
	} catch {
		// Preview only. Storage being unavailable is not a problem here.
	}
}

window.fetch = async (input, init) => {
	const url = typeof input === "string" ? input : input.url;
	const path = url.replace(/^https?:\/\/[^/]+/, "");

	if (path === "/api/history") {
		return jsonResponse(HISTORY);
	}
	if (path === "/api/session") {
		return jsonResponse({ success: true, clientId: "preview0session" });
	}
	if (path === "/api/process") {
		return jsonResponse({ success: true, jobId: 7 });
	}
	if (path.startsWith("/api/jobs/")) {
		return jsonResponse({ id: 7, tracks: NAMED });
	}
	if (path.startsWith("/api/download/")) {
		return new Response(new Blob(["preview"]), {
			headers: { "Content-Type": "application/zip" },
		});
	}
	return realFetch(input, init);
};

/**
 * The live socket.
 *
 * It plays back a real sequence: the boundaries arrive first, then the
 * names, a beat apart, exactly as the worker reports them.
 */
class PreviewSocket {
	constructor() {
		this.readyState = 1;
		this.onmessage = null;
		this.onclose = null;

		setTimeout(() => {
			this.emit({
				jobId: 7,
				status: "processing",
				progressMsg: "Found 4 track boundaries",
				detail: {
					phase: "identifying",
					total: 4,
					tracks: BOUNDARIES,
				},
			});
		}, 900);

		setTimeout(() => {
			this.emit({
				jobId: 7,
				status: "processing",
				progressMsg: "Match found",
				detail: { phase: "cutting", total: 4, tracks: NAMED },
			});
		}, 1700);
	}

	emit(payload) {
		if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
	}

	close() {
		this.readyState = 3;
	}
}

window.WebSocket = PreviewSocket;

/* ------------------------------------------------------------------ */
/* drive the app                                                     */
/* ------------------------------------------------------------------ */

/**
 * Fill the URL field and submit the form, so the preview shows the app in
 * its working state rather than its empty one.
 *
 * The native setter is used because React tracks the previous value on the
 * element and would ignore a plain assignment.
 */
function startAJob() {
	const input = document.getElementById("youtube-url");
	if (!input) return;

	const setter = Object.getOwnPropertyDescriptor(
		window.HTMLInputElement.prototype,
		"value",
	).set;
	setter.call(input, "https://www.youtube.com/watch?v=aqz-KE-bpKQ");
	input.dispatchEvent(new Event("input", { bubbles: true }));

	setTimeout(() => {
		const form = input.closest("form");
		if (form) form.requestSubmit();
	}, 250);
}

createRoot(document.getElementById("root")).render(<App />);

if (document.readyState === "complete") {
	setTimeout(startAJob, 600);
} else {
	window.addEventListener("load", () => setTimeout(startAJob, 600));
}
