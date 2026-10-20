/**
 * The progress protocol.
 *
 * The worker and the server agree on the shape of a progress message here,
 * so the browser can render what is actually happening rather than a line of
 * prose. Before this, the only thing the UI could show was a status string,
 * so the "live" part of the app was a spinner and a sentence.
 *
 * The vocabulary is small and fixed. The server forwards only these fields,
 * so a broadcast can never inject arbitrary data into the page.
 */

/** The phases a job moves through, in order. */
export const PHASES = {
	QUEUED: "queued",
	DOWNLOADING: "downloading",
	DETECTING: "detecting",
	IDENTIFYING: "identifying",
	CUTTING: "cutting",
	ZIPPING: "zipping",
	DONE: "done",
	FAILED: "failed",
};

/** Every phase the server will forward. Anything else is dropped. */
const ALLOWED_PHASES = new Set(Object.values(PHASES));

/**
 * The maximum number of tracks a single message may carry.
 *
 * A pathological input could produce thousands of silences, and every one
 * of them would be serialised to every connected browser. A mix with a
 * thousand tracks is not a mix.
 */
const MAX_TRACKS = 500;

/** The maximum length of a track title. */
const MAX_TITLE_LENGTH = 200;

/**
 * Normalise a track boundary.
 *
 * Times are seconds from the start of the source, and are rounded to
 * hundredths because that is all ffmpeg's silencedetect reports to.
 */
function sanitizeTrack(track, index) {
	const start = Number(track?.start);
	const end = track?.end === null || track?.end === undefined ? null : Number(track.end);

	if (!Number.isFinite(start) || start < 0) return null;

	const title =
		typeof track?.title === "string" && track.title.trim()
			? track.title.trim().slice(0, MAX_TITLE_LENGTH)
			: null;

	return {
		index: index + 1,
		start: Math.round(start * 100) / 100,
		end: end === null ? null : Math.round(end * 100) / 100,
		title,
	};
}

/**
 * Build the safe progress payload the server forwards to browsers.
 *
 * Everything is whitelisted and length-capped here, on the server, so the
 * browser can trust the shape of what it receives. `detail` comes from the
 * worker over the internal channel, which is already authenticated, but it
 * is still treated as untrusted input: a bug in the worker must not be able
 * to inject a field the page will act on.
 */
export function sanitizeProgress(detail) {
	if (!detail || typeof detail !== "object") return {};

	const out = {};

	if (typeof detail.phase === "string" && ALLOWED_PHASES.has(detail.phase)) {
		out.phase = detail.phase;
	}

	if (Number.isFinite(detail.total)) {
		out.total = Math.max(0, Math.min(100000, Math.round(detail.total)));
	}

	if (Array.isArray(detail.tracks)) {
		const tracks = [];
		for (let i = 0; i < Math.min(detail.tracks.length, MAX_TRACKS); i++) {
			const track = sanitizeTrack(detail.tracks[i], i);
			if (track) tracks.push(track);
		}
		out.tracks = tracks;
	}

	return out;
}

/**
 * Turn a list of track boundaries into the payload's track array.
 *
 * The final track has no end - it runs to the end of the source - which is
 * why `end` can be null.
 */
export function tracksFromTimestamps(timestamps, titles = []) {
	return timestamps.map((t, i) => ({
		start: t.start,
		end: t.end ?? null,
		title: titles[i] ?? null,
	}));
}

export default sanitizeProgress;
