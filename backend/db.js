import { Database } from "bun:sqlite";

const db = new Database("eztunes.sqlite");

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

export default db;
