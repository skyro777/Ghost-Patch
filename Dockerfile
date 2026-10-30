# syntax=docker/dockerfile:1

# ── build stage ─────────────────────────────────────────────────────────────
# node runs the toolchain; bun is installed only to honour bun.lock exactly.
FROM node:20-bookworm-slim AS build
WORKDIR /app

RUN npm install -g bun@1 --silent

# Dependencies first so this layer caches independently of source edits.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Application source (see .dockerignore — no .git, node_modules, db, logs).
COPY . .

# Prisma client + a freshly-migrated empty SQLite db. The db file gets baked
# into the image and seeds the named volume on first boot.
ENV DATABASE_URL=file:/app/db/custom.db \
    NEXT_TELEMETRY_DISABLED=1
RUN bunx prisma generate \
 && bunx prisma db push --skip-generate \
 && bun run build

# ── runtime stage ───────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner

# ffmpeg is the patch engine; ca-certificates for any outbound https.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -r app && useradd -r -g app -d /app app

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL=file:/app/db/custom.db

# Standalone Next server (package.json's build script already copies
# .next/static and public/ into the standalone folder).
COPY --from=build --chown=app:app /app/.next/standalone ./

# Belt & braces: Prisma's query engine binaries — Next's file tracing
# occasionally misses the native .so files.
COPY --from=build --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=app:app /app/node_modules/@prisma ./node_modules/@prisma

# Empty, migrated SQLite db — docker seeds the named volume from this on
# first start; afterwards the volume's copy wins (stats survive redeploys).
COPY --from=build --chown=app:app /app/db ./db

USER app
VOLUME /app/db
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
