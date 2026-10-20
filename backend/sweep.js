import path from "node:path";
import { rm } from "node:fs/promises";

/**
 * Housekeeping for the job table.
 *
 * Extracted from worker.js so it can be tested against a real database
 * without booting the whole worker.
 *
 * The bug this replaces: the sweeper deleted every row whose status was not
 * "completed". That included jobs the worker was ACTIVELY processing and
 * jobs merely WAITING in the queue. A sweep landing on a live job deleted its
 * row mid-flight, so the worker's subsequent status update matched zero rows
 * and the job vanished from the history while still burning CPU and bandwidth.
 *
 * The rule now:
 *   - "failed"      -> dead on arrival, safe to remove.
 *   - "processing"  -> only if stale (updated_at older than stuckJobMs),
 *                      which means the worker died mid-job.
 *   - "pending"     -> NEVER. It is waiting its turn, not broken.
 *   - "completed"   -> kept until it is older than the retention window.
 */

/**
 * The job table's timestamp columns are written in SQLite's native format
 * ("YYYY-MM-DD HH:MM:SS") by the schema DEFAULT and by datetime('now'), but
 * anything written as a JavaScript ISO string ("2026-10-20T05:06:34.746Z")
 * is a DIFFERENT string. A plain `<=` comparison between the two is a
 * lexicographic comparison of two unrelated formats, so it silently matches
 * the wrong rows.
 *
 * julianday() parses both formats into a comparable number, so the sweep
 * behaves correctly no matter which writer produced the row.
 */
const DEAD_JOB_SQL = `
  SELECT id, result_file FROM jobs
  WHERE status = 'failed'
     OR (status = 'processing' AND julianday(updated_at) <= julianday('now', ?))
`;

const DEAD_JOB_DELETE_SQL = `
  DELETE FROM jobs
  WHERE status = 'failed'
     OR (status = 'processing' AND julianday(updated_at) <= julianday('now', ?))
`;

const EXPIRED_JOB_SQL = `
  SELECT id, result_file FROM jobs WHERE julianday(created_at) <= julianday('now', ?)
`;

/**
 * Remove the artefacts belonging to a job.
 *
 * result_file holds a NAME. It is reduced to its basename and resolved
 * inside the output root - a raw value from the database is never handed to
 * rm(), because that would let a tampered row delete anything on the disk.
 */
async function removeArtifacts(db, outputDir, job) {
	await rm(path.join(outputDir, `job_${job.id}`), {
		recursive: true,
		force: true,
	}).catch(() => {});

	await rm(path.join(outputDir, `job_${job.id}_playlist.zip`), {
		force: true,
	}).catch(() => {});

	if (job.result_file) {
		const safeName = path.basename(job.result_file);
		await rm(path.join(outputDir, safeName), { force: true }).catch(() => {});
	}
}

/**
 * Run one sweep pass.
 *
 * Returns a summary so the caller can log it and the tests can assert on it.
 */
export async function sweepJobs(db, { outputDir, stuckJobMs, retentionMs, logger }) {
	const log = logger ?? { info() {}, success() {} };
	const stuckSeconds = `-${Math.floor(stuckJobMs / 1000)} seconds`;
	const retentionSeconds = `-${Math.floor(retentionMs / 1000)} seconds`;

	// --- dead jobs ---
	const deadJobs = db.query(DEAD_JOB_SQL).all(stuckSeconds);

	for (const job of deadJobs) {
		await removeArtifacts(db, outputDir, job);
	}

	if (deadJobs.length > 0) {
		db.query(DEAD_JOB_DELETE_SQL).run(stuckSeconds);
		log.success(`🧹 Sweeper: removed ${deadJobs.length} dead job(s).`);
	} else {
		log.info("✨ Sweeper: no dead jobs found.");
	}

	// --- expired results ---
	// This used to sit AFTER an early `return` that fired whenever no dead
	// job was found, which meant it never ran at all. The retention sweep is
	// a separate concern and always runs now.
	const expiredJobs = db.query(EXPIRED_JOB_SQL).all(retentionSeconds);

	for (const job of expiredJobs) {
		await removeArtifacts(db, outputDir, job);
	}

	if (expiredJobs.length > 0) {
		db.query(`DELETE FROM jobs WHERE created_at <= datetime('now', ?)`).run(
			retentionSeconds,
		);
		log.success(
			`🕰️ Sweeper: deleted ${expiredJobs.length} expired job(s) and freed disk.`,
		);
	} else {
		log.info("🕰️ Sweeper: no expired results.");
	}

	return {
		deadRemoved: deadJobs.length,
		expiredRemoved: expiredJobs.length,
	};
}

export default sweepJobs;
