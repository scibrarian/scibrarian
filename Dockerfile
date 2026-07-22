# syntax=docker/dockerfile:1

# Pinned to the repo's Node major (see .nvmrc / engines >=22.13). node:sqlite is
# built into this runtime and works without a flag on 22 LTS, so no native build
# tools are needed. Bump the patch periodically — a stale pin accumulates CVEs.

# ---- Stage 1: build the React client ----
FROM node:22.23.1-trixie-slim AS builder
WORKDIR /app

# Install the full workspace so the client build has its toolchain (tsc, vite).
# Copying only the manifests first keeps this layer cached across source edits.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci

# Build the client -> client/dist (the server serves these files in production).
COPY . .
RUN npm run build -w client

# ---- Stage 2: runtime ----
FROM node:22.23.1-trixie-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only. The server runs TypeScript directly via tsx
# (a devDependency), so install that globally rather than shipping the whole
# dev toolchain.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci --omit=dev \
    && npm install -g tsx@4 \
    && npm cache clean --force

# Server source (executed untranspiled) and the client bundle from the builder.
COPY server/ server/
COPY --from=builder /app/client/dist client/dist

# Config baked for the container:
#  - HOST=0.0.0.0 so the published port reaches the process (this makes
#    ADMIN_TOKEN mandatory — the server enforces it at startup).
#  - DB + PDF blobs live under /data, a volume, so they survive `docker rm`.
ENV HOST=0.0.0.0 \
    PORT=3001 \
    DB_PATH=/data/app.db \
    BLOBS_DIR=/data/blobs

# Run unprivileged; the built-in `node` user owns the data dir it writes to.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3001

# GET /api/auth needs no token and returns 200 once the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/auth').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["tsx", "server/src/index.ts"]
