# eztunes backend

Bun server and worker. See the [top-level README](../README.md) for setup,
configuration and the security model.

```bash
bun install
cp .env.example .env          # fill in the four required secrets
bun --watch server.js         # HTTP + WebSocket on :5000
bun --watch worker.js         # job queue: download, split, tag, zip
bun test                      # 111 tests; needs ffmpeg on PATH
```

| File | Role |
|---|---|
| `config.js` | Every secret, path and bind address, resolved once at boot |
| `auth.js` | Session signing, cookies, the internal broadcast token |
| `paths.js` | Path containment and filename sanitising |
| `db.js` | The jobs table (SQLite via `bun:sqlite`, WAL mode) |
| `server.js` | HTTP API, WebSocket progress, serves `frontend/dist` |
| `worker.js` | Claims queued jobs and runs the pipeline |
| `silence.js` | ffmpeg `silencedetect` parsing and cut-point selection |
| `progress.js` | The progress message shape shared by worker and server |
| `concurrency.js` | Bounded parallelism for the per-track steps |
| `sweep.js` | Removes dead, stuck and expired jobs |
| `logger.js` | The shared `deadslog` logger |
