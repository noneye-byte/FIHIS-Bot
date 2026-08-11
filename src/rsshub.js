import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Supervises the RSSHub instance bundled into this image.
 *
 * Unraid runs one container per template, so a compose sidecar is not an option
 * there — the image is built on top of the official RSSHub image and this module
 * starts it as a child process. Everything here degrades to a no-op when RSSHub
 * is absent (running `npm start` from a checkout, or the tests), so the bot
 * never depends on it.
 */

const DIR = process.env.RSSHUB_DIR || '/app';
const PORT = Number.parseInt(process.env.RSSHUB_PORT || '1200', 10) || 1200;

// Where the RSSHub image keeps its compiled entrypoint. `dist/index.mjs` is
// what current images ship (its own start script runs `node dist/index.mjs`);
// the rest cover older layouts. RSSHUB_ENTRY overrides the search outright if a
// future image moves it again — the Dockerfile fails the build if none match.
const ENTRY_CANDIDATES = ['dist/index.mjs', 'lib/index.js', 'dist/index.js', 'index.js'];

const RESTART_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 2_000;
// Enough of the boot log to diagnose a failure, without echoing a line per
// request forever. RSSHUB_LOG=all disables the cap.
const QUIET_LOG_LINES = 40;

// The auth_token cookie RSSHub needs for X routes, when it comes from the
// config rather than the container. Kept here rather than read from store.js
// because store.js already imports this module.
let savedAuthToken = null;

let child = null;
let restarts = 0;
let restartTimer = null;
let readyTimer = null;
let stopping = false;
let stdoutLines = 0;

const state = {
  ready: false,
  lastError: null,
  startedAt: null,
  exitCode: null
};

function truthy(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

export function isEnabled() {
  return truthy(process.env.RSSHUB_ENABLED, true);
}

/** Resolves the RSSHub entrypoint, or null when this is not the bundled image. */
export function entrypoint() {
  if (process.env.RSSHUB_ENTRY) {
    return fs.existsSync(process.env.RSSHUB_ENTRY) ? process.env.RSSHUB_ENTRY : null;
  }
  for (const candidate of ENTRY_CANDIDATES) {
    const full = path.join(DIR, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

export function isBundled() {
  return entrypoint() !== null;
}

export function port() {
  return PORT;
}

export function baseUrl() {
  return `http://127.0.0.1:${PORT}`;
}

/** The feed URL to point the poller at for a given handle. */
export function localFeedUrl(handle) {
  return `${baseUrl()}/twitter/user/${encodeURIComponent(handle)}`;
}

/** True for any URL served by the bundled instance, whatever host form is used. */
export function isLocalUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname) &&
      parsed.port === String(PORT)
    );
  } catch {
    return false;
  }
}

/**
 * Supplies the X credential from the config. Takes effect on the next start or
 * restart, since RSSHub only reads its environment when it boots.
 */
export function configure({ authToken } = {}) {
  savedAuthToken = authToken?.trim() || null;
}

/**
 * The token RSSHub will actually be given. A token saved in the web UI wins
 * over the container's, because it is the one that can be replaced without
 * editing the container — which is the whole point of having it in the UI.
 */
export function effectiveAuthToken() {
  return savedAuthToken || process.env.TWITTER_AUTH_TOKEN?.trim() || '';
}

export function authTokenSource() {
  if (savedAuthToken) return 'config';
  if (process.env.TWITTER_AUTH_TOKEN?.trim()) return 'env';
  return null;
}

export function status() {
  const token = effectiveAuthToken();
  return {
    bundled: isBundled(),
    enabled: isEnabled(),
    // Never the value itself — just enough to confirm which token is loaded.
    authToken: {
      present: Boolean(token),
      source: authTokenSource(),
      // Both halves of a cookie pair look alike; the tail identifies it.
      preview: token ? `…${token.slice(-4)}` : null,
      envPresent: Boolean(process.env.TWITTER_AUTH_TOKEN?.trim())
    },
    running: Boolean(child),
    ready: state.ready,
    port: PORT,
    url: baseUrl(),
    restarts,
    lastError: state.lastError,
    startedAt: state.startedAt,
    exitCode: state.exitCode
  };
}

function logLine(stream, chunk) {
  for (const line of String(chunk).split('\n')) {
    const text = line.trimEnd();
    if (!text) continue;
    if (stream === 'stdout' && process.env.RSSHUB_LOG !== 'all') {
      // Keep the boot log, drop the per-request chatter that follows it.
      stdoutLines += 1;
      if (stdoutLines > QUIET_LOG_LINES && !/error|fatal|listening/i.test(text)) continue;
      if (stdoutLines === QUIET_LOG_LINES + 1) {
        console.log('[rsshub] (further output suppressed — set RSSHUB_LOG=all to see it)');
      }
    }
    console.log(`[rsshub] ${text}`);
  }
}

async function probeReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (child && !stopping && Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl(), { signal: AbortSignal.timeout(5_000) });
      // Any HTTP answer means the listener is up; RSSHub's index route may well
      // redirect or 404 depending on version.
      if (res.status) {
        state.ready = true;
        state.lastError = null;
        console.log(`[rsshub] ready on ${baseUrl()}`);
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => {
      readyTimer = setTimeout(resolve, READY_POLL_MS);
      readyTimer.unref?.();
    });
  }
  if (child && !stopping && !state.ready) {
    state.lastError = `RSSHub did not answer on ${baseUrl()} within ${READY_TIMEOUT_MS / 1000}s`;
    console.warn(`[rsshub] ${state.lastError}`);
  }
}

function scheduleRestart() {
  if (stopping) return;
  const delay = RESTART_DELAYS_MS[Math.min(restarts, RESTART_DELAYS_MS.length - 1)];
  restarts += 1;
  console.warn(`[rsshub] restarting in ${Math.round(delay / 1000)}s (attempt ${restarts})`);
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => spawnChild(), delay);
  restartTimer.unref?.();
}

function spawnChild() {
  const entry = entrypoint();
  if (!entry) return;

  stdoutLines = 0;
  state.ready = false;
  state.exitCode = null;
  state.startedAt = new Date().toISOString();

  // RSSHub reads its own configuration straight from the environment, so every
  // RSSHub variable set on the container is inherited as-is.
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'production',
    PORT: String(PORT),
    // X sends headers big enough to trip Node's default cap; RSSHub's own
    // start script raises it for exactly this reason.
    NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-http-header-size=32768'
  };
  const token = effectiveAuthToken();
  if (token) env.TWITTER_AUTH_TOKEN = token;
  else delete env.TWITTER_AUTH_TOKEN;

  child = spawn(process.execPath, [entry], {
    cwd: DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  console.log(`[rsshub] started (pid ${child.pid}) on port ${PORT}`);

  child.stdout.on('data', (chunk) => logLine('stdout', chunk));
  child.stderr.on('data', (chunk) => logLine('stderr', chunk));

  child.on('error', (err) => {
    state.lastError = err.message;
    console.error('[rsshub] failed to spawn:', err.message);
  });

  child.on('exit', (code, signal) => {
    state.ready = false;
    state.exitCode = code;
    child = null;
    if (stopping) return;
    state.lastError = `RSSHub exited (${signal ? `signal ${signal}` : `code ${code}`})`;
    console.error(`[rsshub] ${state.lastError}`);
    scheduleRestart();
  });

  probeReady();
}

/** Starts the bundled RSSHub. Safe to call when there isn't one. */
export function start() {
  if (child) return status();
  stopping = false;

  if (!isEnabled()) {
    console.log('[rsshub] disabled by RSSHUB_ENABLED — using the configured RSS URLs only');
    return status();
  }
  if (!isBundled()) {
    console.log(`[rsshub] not bundled in this image (looked in ${DIR}) — skipping`);
    return status();
  }

  spawnChild();
  return status();
}

export function stop() {
  stopping = true;
  clearTimeout(restartTimer);
  clearTimeout(readyTimer);
  state.ready = false;
  if (!child) return;
  const doomed = child;
  doomed.kill('SIGTERM');
  // RSSHub normally exits promptly; don't let a wedged one hold up shutdown.
  const hard = setTimeout(() => doomed.kill('SIGKILL'), 5_000);
  hard.unref?.();
}

/** Manual restart, used by the web UI when a start has failed. */
export function restart() {
  clearTimeout(restartTimer);
  restarts = 0;
  state.lastError = null;
  if (child) {
    // The exit handler reschedules for us.
    stopping = false;
    child.kill('SIGTERM');
    return status();
  }
  stopping = false;
  return start();
}
