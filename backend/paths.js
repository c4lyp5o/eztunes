import path from "node:path";

/**
 * Path safety helpers.
 *
 * The job table stores the name of a produced file, never a path. Everything
 * that touches the filesystem resolves a name against a known root and
 * verifies the result is still inside that root. This is the one rule that
 * stops a crafted job id or a tampered DB row from turning the download
 * endpoint into an arbitrary file read.
 */

/**
 * Resolve `name` inside `root` and refuse anything that escapes.
 * Returns null when the name is unsafe.
 */
export function safeJoin(root, name) {
	if (typeof name !== "string" || name.length === 0) return null;
	if (name.includes("\0")) return null;

	// A stored result is a BARE file name. If it contains a separator it is
	// either a traversal attempt or a bug, and in both cases it is refused
	// rather than silently rewritten - silently stripping the directory part
	// would map "..%2F..%2Fetc%2Fpasswd" onto a real file called "passwd",
	// which is safe but confusing and hides the attempt.
	//
	// Both separators are rejected EXPLICITLY rather than via path.basename(),
	// because basename() is platform-dependent: on Linux "a\\b" is a single
	// file name, not a path. The server runs on Linux in the container and on
	// Windows in dev, so the check must not change meaning between them.
	if (name !== path.basename(name)) return null;
	if (name.includes("/") || name.includes("\\")) return null;

	const resolvedRoot = path.resolve(root);
	const candidate = path.resolve(resolvedRoot, name);

	// Belt and braces: check the containment explicitly so a future change to
	// the resolution order cannot silently reopen the hole.
	const rel = path.relative(resolvedRoot, candidate);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;

	return candidate;
}

/**
 * A file name safe to write into a directory: no separators, no drive
 * letters, no control characters, and not a dotfile.
 */
export function isSafeFileName(name) {
	if (typeof name !== "string") return false;
	if (name.length === 0 || name.length > 255) return false;
	if (name === "." || name === "..") return false;
	if (name.includes("/") || name.includes("\\")) return false;
	if (name.includes("\0")) return false;
	if (path.basename(name) !== name) return false;
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x1f\x7f]/.test(name)) return false;
	return true;
}

/**
 * Turn arbitrary text (a song title from a metadata API, a YouTube video
 * title) into a filename that is safe on Windows, macOS and Linux.
 *
 * Windows forbids:  < > : " / \ | ? *  and trailing dots or spaces.
 * We replace rather than strip so the name stays readable.
 */
export function sanitizeFileName(input, fallback = "track") {
	const cleaned = String(input ?? "")
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x1f\x7f]/g, "")
		.replace(/[/\\?%*:|"<>]/g, "-")
		// Shell metacharacters that a title has no business containing. The
		// worker passes this name to ffmpeg as an ARGV ELEMENT (no shell), so
		// these are harmless in practice - but stripping them means the name
		// stays safe even if some future code does quote it into a command.
		// Parentheses and brackets are kept: they are common in real song
		// titles ("Song (Remastered)") and are not shell metacharacters.
		.replace(/[$`;&|!]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		// Windows drops trailing dots and spaces; do it ourselves so the name
		// we record is the name we actually get.
		.replace(/[. ]+$/g, "")
		.slice(0, 180);

	if (!cleaned) return fallback;
	return cleaned;
}

/**
 * Strip characters that would be dangerous if a value is ever placed inside a
 * shell command. Used for metadata that lands in a command string.
 *
 * This is defence in depth, NOT the primary defence: the worker no longer
 * builds shell command strings for metadata at all. It is kept because
 * "sanitise before you shell out" and "never shell out" are both cheap.
 */
export function sanitizeForShell(value) {
	return String(value ?? "")
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x1f\x7f]/g, "")
		.replace(/["`$;&|<>^!(){}[\]*?~#]/g, "")
		.trim()
		.slice(0, 200);
}
