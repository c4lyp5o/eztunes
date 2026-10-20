/**
 * Formatting helpers.
 *
 * Kept out of the component files so each file exports only components,
 * which is what makes React Fast Refresh work in development.
 */

/** 214 -> "3:34". The one place a number is put on the page. */
export function formatDuration(seconds) {
	if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
		return "";
	}
	const total = Math.max(0, Math.round(seconds));
	const mins = Math.floor(total / 60);
	const secs = total % 60;
	return `${mins}:${String(secs).padStart(2, "0")}`; // taste-skill-ignore: a clock
}

/** "2026-10-20 15:06:34" -> "20 Oct, 15:06". */
export function formatWhen(value) {
	if (!value) return "";
	const parsed = new Date(
		value.includes("T") ? value : `${value.replace(" ", "T")}Z`,
	);
	if (Number.isNaN(parsed.getTime())) return "";

	const months = [
		"Jan", "Feb", "Mar", "Apr", "May", "Jun",
		"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
	];
	const hh = String(parsed.getHours()).padStart(2, "0");
	const mm = String(parsed.getMinutes()).padStart(2, "0");
	return `${parsed.getDate()} ${months[parsed.getMonth()]}, ${hh}:${mm}`;
}
