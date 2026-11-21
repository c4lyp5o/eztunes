# Developing eztunes

Bun backend with a worker process, React + Vite frontend; ffmpeg for audio.

## Commands

Run from the repo root with [Bun](https://bun.sh).

| Task | Command |
| --- | --- |
| Install every package | `bun run install` |
| Run the dev servers | `bun run dev` |
| Run the test suite | `bun run test` |
| Lint with Biome | `bun run lint` |
| Apply Biome's safe fixes | `bun run lint:fix` |
| Build the frontend | `bun run build:client` |
| Start in production (PM2 where configured) | `bun run start` |

## Tests

`bun run test` runs the backend suite (needs `ffmpeg` on `PATH` for `silence.test.js`).

## Linting

[Biome](https://biomejs.dev) 2.6.8 is the only linter. It is pinned at the repo root, so run it from there: `bun run lint` checks, `bun run lint:fix` applies safe fixes. Configuration is `biome.json`; the formatter is off in the root config, so untouched files are never reformatted. CI runs the same command.

## Branches and releases

There are two long-lived branches:

| Branch | Role |
| --- | --- |
| `development` | Integration branch. Branch from it (`feat/…`, `fix/…`, `chore/…`) and open every PR against it. |
| `master` | Released code. Only `development` is merged into it, by PR. |

No other long-lived branches (`main`, `dev`, `staging`, …) are kept; delete feature branches once merged.

To release: bump the version in `package.json`, `backend/package.json` and `frontend/package.json`, move the `[Unreleased]` notes in `CHANGELOG.md` under `## [x.y.z] - YYYY-MM-DD`, then merge `development` into `master`. Every push to `master` (or a `v*` tag) runs `docker-publish.yml`, which runs the test workflow first and then pushes the GHCR image.

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`fix(scope): …`) with a body that explains why. Add a `CHANGELOG.md` line under `[Unreleased]` for anything a user would notice. Every behaviour change needs a test; a bug fix needs one that fails without the fix.

## Docker

The image is built from `Dockerfile` on `oven/bun:1.4.5-alpine`. Keep the Bun version there and `bun-version` in `.github/workflows/` in step, and smoke-test a locally built image (`docker build -t eztunes .`) after changing either.

## Backend layout

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

## Frontend

React 19 + Vite, Tailwind v4 and the shared ez kit (`src/ez/`), Motion for transitions and a three.js backdrop. Dark is the default theme; the choice is stored under `ez.theme`.

`preview.html` renders every screen state with fake data, without a backend: open `http://localhost:3000/preview.html` while `bun dev` runs.

The footer shows `version` from `frontend/package.json`, injected at build time as `__APP_VERSION__` (see `vite.config.js`).
