import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * The job table.
 *
 * Two changes from the original:
 *
 *  - The database file lives at an explicit path (a mounted volume in a
 *    container) instead of "eztunes.sqlite" relative to the process CWD.
 *  - result_file stores a FILE NAME, never a path. The server resolves the
 *    name against the output root and refuses anything that escapes it. The
 *    old code stored an absolute path, which broke as soon as the repo moved
 *    and let a tampered row point the download endpoint anywhere on disk.
 */

export function openDatabase(dbPath) {
	if (dbPath !== ":memory:") {
		// Bun creates the file on first write, but the parent directory has to
		// exist first.
		mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
	}

	const db = new Database(dbPath, { create: true });

	// WAL lets the server (readers) and the worker (writer) share one file
	// without blocking each other. busy_timeout stops the loser from failing
	// immediately.
	if (dbPath !== ":memory:") db.run("PRAGMA journal_mode = WAL;");
	db.run("PRAGMA busy_timeout = 5000;");
	db.run("PRAGMA foreign_keys = ON;");

	db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      video_url TEXT NOT NULL,
      expected_tracks INTEGER,
      status TEXT DEFAULT 'pending',
      error_msg TEXT,
      result_file TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

	// The columns that carry the RESULT of a job.
	//
	// The original table held only the URL and the status, so the history
	// list could show a bare youtube link and nothing else - no title, no
	// track count, no duration. The page had nothing real to show.
	//
	// title          the video's own title, from yt-dlp
	// track_count    how many tracks the split produced
	// duration_secs  the length of the source recording
	// tracks_json    the named tracks, as a JSON array
	addColumnIfMissing(db, "title", "TEXT");
	addColumnIfMissing(db, "track_count", "INTEGER");
	addColumnIfMissing(db, "duration_secs", "INTEGER");
	addColumnIfMissing(db, "tracks_json", "TEXT");

	// The sweeper scans by status; without this it is a full table scan on
	// every pass.
	db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);`);
	db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);`);
	db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id);`);

	return db;
}

/**
 * Add a column to an existing table if it is not already there.
 *
 * SQLite's ALTER TABLE has no IF NOT EXISTS, so the table is inspected
 * first. This is what lets an old database file keep working after an
 * upgrade instead of failing every query against a missing column.
 */
function addColumnIfMissing(db, name, type) {
	const columns = db.query(`PRAGMA table_info(jobs)`).all();
	if (columns.some((c) => c.name === name)) return false;
	db.run(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
	return true;
}

export default openDatabase;
