FROM node:20-alpine

RUN apk add --no-cache tini wget

WORKDIR /app

# Copy manifests first so `npm ci` stays cached across source edits.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY FIHAS.jpg ./FIHAS.jpg

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    HEALTH_PORT=8080

VOLUME ["/config"]
EXPOSE 8080

# /healthz is deliberately unauthenticated so the check works without a password.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

# tini reaps zombies and forwards SIGTERM so the shutdown handler actually runs.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
