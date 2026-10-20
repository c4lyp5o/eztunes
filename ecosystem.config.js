/**
 * Process supervisor for eztunes.
 *
 * The server and the worker are separate processes that share one SQLite
 * file: the server owns the HTTP and WebSocket surface, the worker owns the
 * job queue. pm2 keeps both alive and restarts them if they crash.
 *
 * This file was MISSING from the repo - the root package.json referenced it
 * in the start/stop/restart/logs scripts, so `bun run start` died with
 * "ENOENT: no such file or directory, open 'ecosystem.config.js'".
 *
 * The broadcast URL is not hard-coded here: the worker reads it from the
 * environment, and compose.yml sets BROADCAST_URL to the server's address
 * inside the container network.
 */
module.exports = {
	apps: [
		{
			name: "eztunes-server",
			script: "./backend/server.js",
			interpreter: "bun",
			instances: 1,
			exec_mode: "fork",
			autorestart: true,
			watch: false,
			// The server and the worker both open the same SQLite file. WAL
			// mode plus a busy timeout makes concurrent access safe, but
			// keeping them in one process group and letting pm2 restart them
			// independently is still the right shape.
			max_memory_restart: "512M",
			env: {
				NODE_ENV: "development",
			},
		},
		{
			name: "eztunes-worker",
			script: "./backend/worker.js",
			interpreter: "bun",
			instances: 1,
			exec_mode: "fork",
			autorestart: true,
			watch: false,
			// The worker is the memory-hungry one: ffmpeg and yt-dlp are
			// children of this process, so the cap has to leave room for
			// them.
			max_memory_restart: "2G",
			env: {
				NODE_ENV: "development",
			},
		},
	],
};
