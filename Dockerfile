# syntax=docker/dockerfile:1

# Pin this to a digest or a release tag if you would rather not track RSSHub's
# latest. It must stay an image that publishes both amd64 and arm64.
ARG RSSHUB_IMAGE=diygod/rsshub:latest

# ---------------------------------------------------------------- bot deps ---
# Dependencies are installed here and copied wholesale into the RSSHub base
# below, so this stage MUST use the same libc as that base — glibc, i.e. a
# -slim/Debian image and never Alpine. npm picks native builds by platform at
# install time: @discordjs/voice pulls in @snazzah/davey (Discord's DAVE voice
# encryption), which is a compiled addon, and on Alpine npm resolves its musl
# variant. Copied onto glibc that binary does not exist under the name the
# loader wants and the bot dies on import, before it can even log why.
# The addons are all N-API, so the Node version here need not match the base.
# `npm ci` (not install) so CI builds match the committed lockfile exactly.
FROM node:22-bookworm-slim AS botdeps
WORKDIR /bot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# ffmpeg-static fetches its binary in a postinstall hook. If that is ever
# skipped or blocked the bot still starts and only voice playback fails at the
# moment someone asks for it, which is a terrible place to find out.
RUN node -e "const p=require('ffmpeg-static'); \
  if(!p||!require('fs').existsSync(p)){console.error('ffmpeg-static did not fetch a binary — voice playback would fail at runtime');process.exit(1);} \
  console.log('bundled ffmpeg:', p);"

# ----------------------------------------------------------------- runtime ---
# Built on the official RSSHub image so a self-hosted feed bridge ships inside
# the container. Unraid runs one container per template, so a compose sidecar
# is not an option there — this is what makes "just works" possible on Unraid.
# The bot supervises RSSHub as a child process (src/rsshub.js) and keeps running
# without it, so RSSHUB_ENABLED=false leaves a perfectly working bot.
FROM ${RSSHUB_IMAGE}

WORKDIR /bot
COPY --from=botdeps /bot/node_modules ./node_modules
COPY package.json ./package.json
COPY src ./src
COPY FIHAS.jpg ./FIHAS.jpg
COPY F_I_H_A_S_audio.mp3 ./F_I_H_A_S_audio.mp3

# Fail the build, not the deployment, if a future RSSHub image moves its
# entrypoint out from under src/rsshub.js.
RUN node -e "const {isBundled,entrypoint}=await import('/bot/src/rsshub.js'); \
  if(!isBundled()){console.error('RSSHub entrypoint not found under /app — update ENTRY_CANDIDATES in src/rsshub.js');process.exit(1);} \
  console.log('bundled RSSHub entrypoint:', entrypoint());" --input-type=module

# Voice is the part that breaks silently when the build platform and this base
# disagree: davey is a compiled addon picked by libc at install time, opusscript
# is only loaded when someone actually plays something, and ffmpeg is a
# downloaded binary that has to match this architecture. Exercising all three
# here turns a crash loop at startup into a failed build.
RUN node -e "await import('/bot/src/voice.js'); \
  const {createRequire}=await import('node:module'); \
  const req=createRequire('/bot/package.json'); \
  req('opusscript'); \
  const ffmpeg=req('ffmpeg-static'); \
  const {execFileSync}=await import('node:child_process'); \
  execFileSync(ffmpeg,['-version'],{stdio:'ignore'}); \
  console.log('voice stack loads, ffmpeg at', ffmpeg);" --input-type=module

# TZ is set because the RSSHub base image defaults it to Asia/Shanghai.
ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    HEALTH_PORT=8080 \
    RSSHUB_ENABLED=true \
    RSSHUB_PORT=1200 \
    RSSHUB_DIR=/app \
    TZ=Etc/UTC

VOLUME ["/config"]
# 8080 setup UI + /healthz, 1200 the bundled RSSHub (only needs publishing if
# you want to reach it from outside the container).
EXPOSE 8080 1200

# /healthz is deliberately unauthenticated so the check works without a password.
HEALTHCHECK --interval=60s --timeout=10s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dumb-init (already in the base) reaps zombies and forwards SIGTERM, so both
# the shutdown handler and the RSSHub child process exit cleanly.
ENTRYPOINT ["dumb-init", "--", "node"]
CMD ["/bot/src/index.js"]
