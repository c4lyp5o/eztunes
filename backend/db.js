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

	// The sweeper scans by status; without this it is a full table scan on
	// every pass.
	db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);`);
	db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);`);
	db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id);`);

	return db;
}

export default openDatabase;
