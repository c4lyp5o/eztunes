# eztunes

[![Test](https://github.com/c4lyp5o/eztunes/actions/workflows/test.yml/badge.svg)](https://github.com/c4lyp5o/eztunes/actions/workflows/test.yml)
[![Build & Push Docker Image](https://github.com/c4lyp5o/eztunes/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/c4lyp5o/eztunes/actions/workflows/docker-publish.yml)

Split a YouTube upload into individual tagged MP3 tracks, and download them
as a ZIP.

Version **1.0.0**. The running version is shown in the app's footer.

**How it works:** a worker downloads the audio with yt-dlp, finds the gaps
between tracks with ffmpeg's `silencedetect`, cuts the audio at those
boundaries, fingerprints each track with AudD.io to recover its title and
artist, writes the ID3 tags, and zips the result. The browser sees the
progress live over a WebSocket.

---

## Quick start (Docker)

```bash
git clone git@github.com:c4lyp5o/eztunes.git && cd eztunes
cp backend/.env.example .env   # fill in the four secrets - see below
docker compose up -d --build
```

The app is on `http://localhost:5000`. Open it, paste your
`EZTUNES_API_TOKEN` into the sign-in screen, and you are in. **Sign out**
in the top bar clears the session cookie.

### Using the published image

Every push to `master` (and every `v*` tag) is tested and then published
to GHCR, so you can skip the local build:

```bash
docker pull ghcr.io/c4lyp5o/eztunes:latest    # or a pinned tag, e.g. :v1.0.0
docker compose up -d                           # compose.yml already names this image
```

The image is `linux/amd64` only, and public: no `docker login` needed.

### The four required secrets

The container refuses to start without these. There are no defaults,
because a guessable credential is worse than a refusal to boot.

| Variable | What it is | How to make one |
|---|---|---|
| `EZTUNES_API_TOKEN` | The credential you type into the unlock screen | `openssl rand -base64 32` |
| `EZTUNES_SESSION_SECRET` | Signs the session cookie | `openssl rand -base64 32` |
| `EZTUNES_INTERNAL_TOKEN` | Authenticates the worker's progress broadcasts | `openssl rand -base64 32` |
| `AUDD_API_TOKEN` | Song recognition. Free tier at [dashboard.audd.io](https://dashboard.audd.io) | their dashboard |

**`AUDD_API_TOKEN` is the one that matters most.** Without a working token
the splitting still works, but every track comes out named
`Unknown Track NN` - the product becomes a renaming service.

---

## Running without Docker

You need **Bun**, **ffmpeg** and **ffprobe** on your PATH, plus a
`yt-dlp` binary.

```bash
bun install                       # installs backend and frontend
cd frontend && bun run build      # the server serves the built bundle

export EZTUNES_API_TOKEN=$(openssl rand -base64 32)
export EZTUNES_SESSION_SECRET=$(openssl rand -base64 32)
export EZTUNES_INTERNAL_TOKEN=$(openssl rand -base64 32)
export AUDD_API_TOKEN=your-token-here

bun run start                     # pm2 runs the server and the worker
```

For development with hot reload, run the three processes separately:

```bash
bun run dev                       # backend, worker and vite, concurrently
```

The Vite dev server runs on `:3000` and proxies `/api` to the backend on
`:5000`.

---

## How it is put together

```
backend/
  config.js    every secret, path and bind address, resolved once at boot
  auth.js      session signing, cookie handling, the internal token
  paths.js     path containment and filename sanitisation
  db.js        the jobs table (SQLite via bun:sqlite)
  server.js    HTTP + WebSocket + serves the built frontend
  worker.js    claims jobs, splits audio, tags tracks, zips
  sweep.js     housekeeping for dead and expired jobs
  tests/       111 tests across 8 files
frontend/
  src/App.jsx           the splitter screen: form, progress, history
  src/components/       SignIn, PhaseReadout, SplitMap, TrackList
  src/ez/               the shared ez design kit (shell, motion, 3D backdrop)
  preview.html          a design harness that renders every state with fake data
.github/workflows/
  test.yml              tests, build, lint, secret scan, image build
  docker-publish.yml    runs test.yml, then pushes the image to GHCR
```

The server and the worker are **separate processes** sharing one SQLite
file. The server owns the HTTP surface; the worker owns the queue. WAL mode
plus a busy timeout makes the concurrent access safe. `pm2` keeps both
alive - `ecosystem.config.js` is what `bun run start` uses.

### The security model

- **One credential, then a cookie.** You enter `EZTUNES_API_TOKEN` once.
  The server exchanges it for an HttpOnly, `SameSite=Strict` signed cookie.
  The token is never stored in the browser and is not readable by
  JavaScript, so an XSS bug has nothing to exfiltrate.
- **The client identity is derived, not chosen.** It is an HMAC of your
  token, so the browser cannot claim another caller's identity - and your
  job history survives a re-login.
- **The worker's broadcast hop uses a separate token**, so a leaked user
  token cannot forge job status updates.
- **Downloads cannot escape.** The job row stores a file *name*. The
  server resolves it inside the output directory and refuses anything that
  does not fit.
- **ffmpeg is spawned with an argv array**, never a shell string, so no
  title or artist metadata can be read as a command.
- **Binds to loopback by default.** `HOST=0.0.0.0` has to be said out
  loud.

---

## Configuration

Every setting is an environment variable. `backend/.env.example` documents
the full set; the ones you are most likely to touch:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `5000` | |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` in a container |
| `DATA_DIR` | `/data` | The database and the produced zips live here |
| `RETENTION_MS` | 7 days | Completed jobs are pruned after this |
| `STUCK_JOB_MS` | 6 hours | A job stuck this long is presumed dead |
| `COOKIE_SECURE` | `false` | Set `true` behind an HTTPS proxy |

---

## Tests

```bash
cd backend && bun test        # 111 tests; silence.test.js needs ffmpeg on PATH
cd frontend && bun run lint
```

The suite covers the security properties directly: unauthenticated access
is refused, forged cookies are rejected, the old `x-client-id` header no
longer authenticates anything, path traversal cannot escape the output
directory, the sweeper does not delete a job that is still running, and
timestamps are compared correctly regardless of the format they were
written in.

### Continuous integration

`test.yml` runs on every push to `master`, on pull requests, and on
demand. It installs ffmpeg, runs the backend suite, builds and lints the
frontend, scans the tree for credential-shaped literals, and builds the
Docker image. `docker-publish.yml` calls it as a gate and only pushes to
`ghcr.io/c4lyp5o/eztunes` when it passes. Images are tagged `latest` plus
the output of `git describe` (the tag name on a release, the short SHA
otherwise).

---

## Releasing

1. Bump `version` in `package.json`, `frontend/package.json` and
   `backend/package.json` (the footer reads `frontend/package.json`).
2. Commit, then tag: `git tag v1.2.3 && git push origin master v1.2.3`.
3. The tag build publishes `ghcr.io/c4lyp5o/eztunes:v1.2.3`.

---

## Licence

Private. All rights reserved.
