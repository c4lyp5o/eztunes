# ===========================
# Stage 1: frontend builder
# ===========================
FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app

# Dependencies first: this layer is cached until package.json changes.
COPY frontend/package.json frontend/bun.lock ./frontend/
RUN cd frontend && bun install --frozen-lockfile

COPY frontend ./frontend
RUN cd frontend && bun run build


# ===========================
# Stage 2: backend deps
# ===========================
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app

COPY backend/package.json backend/bun.lock ./backend/
RUN cd backend && bun install --frozen-lockfile --production


# ===========================
# Stage 3: runtime
# ===========================
FROM oven/bun:1.3.14-alpine
WORKDIR /app

ENV TZ=Asia/Kuala_Lumpur

# ffmpeg does the silence detection and the track slicing. The Windows tree
# shipped a bundled ffmpeg.exe (202MB of Windows binaries) which is useless
# here, so the container uses the Alpine build instead.
#
# yt-dlp: the youtube-dl-exec package normally downloads the binary in a
# postinstall script, but Bun BLOCKS postinstall scripts by default and
# alpine has no python3 for the preinstall check. The binary is therefore
# fetched here, at build time, explicitly. The musllinux build is required:
# the default yt-dlp_linux is a glibc binary and will not run on Alpine's
# musl libc ("not found" despite being present and executable).
ARG YTDLP_URL=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_musllinux

RUN apk add --no-cache ffmpeg curl \
 && mkdir -p /opt/yt-dlp \
 && curl -fsSL "$YTDLP_URL" -o /opt/yt-dlp/yt-dlp \
 && chmod 0755 /opt/yt-dlp/yt-dlp \
 && /opt/yt-dlp/yt-dlp --version \
 && rm -rf /var/cache/apk/*

# Point youtube-dl-exec at the binary we just placed, and stop it trying to
# fetch its own (its postinstall does not run, and it would fetch the glibc
# build anyway).
ENV YOUTUBE_DL_DIR=/opt/yt-dlp \
    YOUTUBE_DL_FILENAME=yt-dlp \
    YOUTUBE_DL_SKIP_DOWNLOAD=1 \
    YOUTUBE_DL_SKIP_PYTHON_CHECK=1

# Unprivileged user. The app downloads untrusted media and runs ffmpeg
# against it, so it must not run as root.
RUN addgroup -S eztunes && adduser -S eztunes -G eztunes -h /home/eztunes \
 && mkdir -p /data/blackhole /app/logs \
 && chown -R eztunes:eztunes /data /app

# Backend
COPY --from=deps --chown=eztunes:eztunes /app/backend/node_modules ./backend/node_modules
COPY --chown=eztunes:eztunes backend/package.json backend/bun.lock ./backend/
COPY --chown=eztunes:eztunes backend/*.js ./backend/
COPY --chown=eztunes:eztunes backend/tests ./backend/tests
COPY --chown=eztunes:eztunes backend/.env.example ./backend/

# Frontend bundle - the server serves it directly, so one process is the
# whole product.
COPY --from=builder --chown=eztunes:eztunes /app/frontend/dist ./frontend/dist

# Process supervisor. The server and the worker are separate processes
# sharing one SQLite file; pm2 keeps both alive and restarts them on crash.
COPY --chown=eztunes:eztunes package.json ./
COPY --chown=eztunes:eztunes ecosystem.config.js ./

# pm2 as the app user. The oven/bun image pins BUN_INSTALL_BIN to a
# root-owned directory, so redirect the global bin dir to a user-writable
# one that is already on PATH.
USER eztunes
ENV PATH="/home/eztunes/.bun/bin:${PATH}"
RUN BUN_INSTALL_BIN=/home/eztunes/.bun/bin bun add -g pm2

ENV PORT=5000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    OUTPUT_DIR=/data/blackhole \
    DB_PATH=/data/eztunes.sqlite \
    FRONTEND_DIR=/app/frontend/dist \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    BROADCAST_URL=http://127.0.0.1:5000/api/internal/broadcast

VOLUME ["/data"]
EXPOSE 5000

# The health endpoint is unauthenticated on purpose and reveals nothing but
# liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:5000/api/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "start"]
