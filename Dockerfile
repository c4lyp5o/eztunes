# ez standard Dockerfile: a build stage for the frontend bundle, then an Alpine
# runtime that runs as the unprivileged `bun` user (uid 1000) with a wget
# healthcheck. Keep the Bun version in step with `bun-version` in .github/workflows.

# ---- build: frontend bundle ----
FROM oven/bun:1.4.5-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/bun.lock ./frontend/
RUN cd frontend && bun install --frozen-lockfile
COPY frontend ./frontend
RUN cd frontend && bun run build

# ---- runtime ----
FROM oven/bun:1.4.5-alpine
ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="eztunes" \
	org.opencontainers.image.source="https://github.com/c4lyp5o/eztunes" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.version="$APP_VERSION"
RUN apk add --no-cache tzdata ffmpeg
ENV TZ=Asia/Kuala_Lumpur \
	NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=5000 \
	DATA_DIR=/data \
	OUTPUT_DIR=/data/blackhole \
	FRONTEND_DIR=/app/frontend/dist \
	FFMPEG_PATH=/usr/bin/ffmpeg \
	BROADCAST_URL=http://127.0.0.1:5000/api/internal/broadcast \
	YOUTUBE_DL_DIR=/opt/yt-dlp \
	YOUTUBE_DL_FILENAME=yt-dlp \
	YOUTUBE_DL_SKIP_DOWNLOAD=1 \
	YOUTUBE_DL_SKIP_PYTHON_CHECK=1
WORKDIR /app
# yt-dlp is a single static binary; pin a release with --build-arg YTDLP_URL=… .
ARG YTDLP_URL=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_musllinux
RUN mkdir -p /opt/yt-dlp \
	&& wget -qO /opt/yt-dlp/yt-dlp "$YTDLP_URL" \
	&& chmod 0755 /opt/yt-dlp/yt-dlp \
	&& /opt/yt-dlp/yt-dlp --version
# pm2-runtime supervises the processes; installed as root into /opt/bun, run as bun.
ENV BUN_INSTALL=/opt/bun PATH="/opt/bun/bin:${PATH}"
RUN bun add -g pm2
COPY backend/package.json backend/bun.lock ./backend/
RUN cd backend && bun install --production --frozen-lockfile --ignore-scripts
COPY backend/*.js ./backend/
COPY package.json ecosystem.config.js ./
COPY --from=build /app/frontend/dist ./frontend/dist
RUN mkdir -p /data /data/blackhole /app/logs && chown -R bun:bun /data /data/blackhole /app/logs
USER bun
VOLUME ["/data"]
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
	CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["bun", "start"]
