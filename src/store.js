import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as rsshub from './rsshub.js';
import { setConfigReadOnly, setConfigFresh } from './runtime.js';

const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// Tweet IDs are snowflakes, so "newest" is just the numerically largest one we
// have ever seen. We keep a bounded list of recent IDs too, because a deleted
// or backfilled item can otherwise resurface and get posted twice.
const SEEN_LIMIT = 500;

export const DEFAULTS = {
  handle: 'F_I_H_A_S',
  channelId: null,
  // [{ type: 'role' | 'user', id: '...' }]
  pings: [],
  mentionEveryone: false,
  intervalSeconds: 120,
  paused: false,
  source: {
    // 'auto' tries xapi (if a token exists) then falls back through rssUrls.
    mode: 'auto',
    rssUrls: [
      'https://rsshub.app/twitter/user/F_I_H_A_S',
      'https://nitter.privacydev.net/F_I_H_A_S/rss'
    ],
    // Feeds kept in the list but skipped. Parking a flaky mirror this way beats
    // deleting it and having to remember the URL when it recovers.
    disabledUrls: [],
    // How the feeds are fetched. Mirrors differ wildly in how slow they are and
    // how much they dislike a default user agent, so these are worth exposing.
    rss: {
      timeoutSeconds: 20,
      // Only the newest few items ever matter; a mirror that returns 200 is
      // otherwise 200 items to parse and diff on every poll.
      maxItems: 20,
      // Blank means the built-in one.
      userAgent: ''
    }
  },
  filters: {
    retweets: true,
    replies: false,
    quotes: true
  },
  linkStyle: 'fxtwitter',
  messageTemplate: '{pings} New post from **@{handle}**\n{link}',
  // Text commands, for servers where slash commands never show up.
  prefix: '!fihas',
  prefixEnabled: true,
  // web setup wizard
  guildId: null,
  setupCompleted: false,
  webPassword: null,
  // The auth_token cookie the bundled RSSHub needs for X routes. Settable from
  // the web UI so a token that expires does not mean editing the container.
  // Never leaves this file: the API reports only whether one is present.
  twitterAuthToken: '',
  // The env values that have already been applied, so a variable seeds the
  // config once instead of overwriting your edits on every container restart.
  // See applyEnv() for why that distinction matters on Unraid.
  envApplied: {},
  // sha256 of the avatar we last uploaded, so we only call setAvatar on change
  avatarHash: null,
  // runtime state
  seen: [],
  highWaterMark: null,
  bootstrapped: false,
  lastCheckAt: null,
  lastPostAt: null,
  lastError: null,
  lastSourceUsed: null
};

// Shared by every writer of the config — the web API, slash commands and prefix
// commands must agree on what is valid.
export const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
export const PREFIX_RE = /^[^\s@#`]{1,16}$/;
// X's auth_token cookie is hex today, but it has changed shape before and the
// bot only ever passes it through, so this stays deliberately permissive.
export const AUTH_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{8,300}$/;
export const RSS_LIMITS = {
  timeoutSeconds: [5, 120],
  maxItems: [1, 100],
  userAgentMaxLength: 200
};

function inRange(value, [min, max]) {
  return Number.isFinite(value) && value >= min && value <= max;
}

let cache = null;
let writeQueue = Promise.resolve();

function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = merge(base[key] ?? {}, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Applies a container variable to the config **once**, and again only when its
 * value in the template actually changes.
 *
 * Re-applying on every boot is what made settings look like they reset
 * themselves: on Unraid, opening a container and pressing Apply recreates it
 * with the template's values, so an interval or handle changed in the web UI
 * was overwritten by the old template value seconds later. Remembering what was
 * last applied keeps both halves working — the template still wins when *it*
 * changes, and edits made in the UI survive a container edit.
 *
 * @returns {string|null} the previous config value, when something was applied
 */
function seedFromEnv(config, name, apply) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return false;
  if (config.envApplied[name] === raw) return false;
  apply(raw.trim());
  config.envApplied[name] = raw;
  return true;
}

function applyEnv(config, fresh) {
  seedFromEnv(config, 'DISCORD_CHANNEL_ID', (v) => {
    config.channelId = v;
  });

  seedFromEnv(config, 'X_HANDLE', (v) => {
    const handle = v.replace(/^@/, '');
    const previous = config.handle;
    if (handle.toLowerCase() === previous.toLowerCase()) {
      config.handle = handle;
      return;
    }
    config.handle = handle;
    rewriteFeedHandle(config, previous, handle);
    if (!fresh) {
      // Watching someone else makes the history meaningless. Re-bootstrap so the
      // new account's backlog is recorded instead of announced.
      config.seen = [];
      config.highWaterMark = null;
      config.bootstrapped = false;
    }
  });

  seedFromEnv(config, 'PING_ROLE_ID', (v) => {
    config.pings = v
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ type: 'role', id }));
  });

  seedFromEnv(config, 'POLL_INTERVAL_SECONDS', (v) => {
    const parsed = Number.parseInt(v, 10);
    if (Number.isFinite(parsed) && parsed >= 30) config.intervalSeconds = parsed;
  });

  const seededUrls = seedFromEnv(config, 'RSS_URLS', (v) => {
    config.source.rssUrls = v.split(',').map((u) => u.trim()).filter(Boolean);
  });
  if (!seededUrls && fresh && rsshub.isBundled() && rsshub.isEnabled()) {
    // The RSSHub bundled into this image only serves us, so it is the most
    // reliable source available. Public mirrors stay behind it as a fallback.
    config.source.rssUrls.unshift(rsshub.localFeedUrl(config.handle));
  }

  seedFromEnv(config, 'RSS_TIMEOUT_SECONDS', (v) => {
    const parsed = Number.parseInt(v, 10);
    if (inRange(parsed, RSS_LIMITS.timeoutSeconds)) config.source.rss.timeoutSeconds = parsed;
  });
  seedFromEnv(config, 'RSS_MAX_ITEMS', (v) => {
    const parsed = Number.parseInt(v, 10);
    if (inRange(parsed, RSS_LIMITS.maxItems)) config.source.rss.maxItems = parsed;
  });
  seedFromEnv(config, 'RSS_USER_AGENT', (v) => {
    config.source.rss.userAgent = v.slice(0, RSS_LIMITS.userAgentMaxLength);
  });

  seedFromEnv(config, 'COMMAND_PREFIX', (v) => {
    config.prefix = v;
  });
  seedFromEnv(config, 'PREFIX_ENABLED', (v) => {
    config.prefixEnabled = !/^(0|false|no|off)$/i.test(v);
  });
}

export async function load() {
  if (cache) return cache;
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  let fresh = false;
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    cache = merge(DEFAULTS, JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[store] ${CONFIG_PATH} is unreadable, starting from defaults:`, err.message);
    }
    cache = structuredClone(DEFAULTS);
    fresh = true;
  }
  // Whether this boot started from an empty /config. Expected on a first run,
  // and the single best clue when settings keep vanishing: it means the path
  // mapped to /config is not the one the previous container wrote to.
  setConfigFresh(fresh);
  if (fresh) {
    console.log(
      `[store] no existing config at ${CONFIG_PATH} — starting from defaults.\n` +
        '  Expected on a first run. If you see this after every container edit, the host\n' +
        '  path mapped to /config is not persistent and every setting will be lost again.'
    );
  }

  applyEnv(cache, fresh);

  // The setup UI is reachable on the LAN, so it always needs a password. If the
  // admin did not pick one we generate it and print it to the container log,
  // which is where an Unraid user will look.
  if (!cache.webPassword) {
    cache.webPassword = process.env.WEB_PASSWORD || crypto.randomBytes(9).toString('base64url');
    cache.webPasswordGenerated = !process.env.WEB_PASSWORD;
  } else if (process.env.WEB_PASSWORD && process.env.WEB_PASSWORD !== cache.webPassword) {
    // Env always wins, so a locked-out admin can reset it from the template.
    cache.webPassword = process.env.WEB_PASSWORD;
    cache.webPasswordGenerated = false;
  }

  // A URL that is no longer in the chain cannot be "disabled" — env overrides
  // and hand-edited config files both get here.
  pruneDisabledUrls(cache);

  await save();
  return cache;
}

/** Drops disabled entries whose feed is gone, so the two lists cannot drift. */
export function pruneDisabledUrls(config) {
  config.source.disabledUrls = (config.source.disabledUrls ?? []).filter((u) =>
    config.source.rssUrls.includes(u)
  );
  return config.source.disabledUrls;
}

/** The feeds the poller is actually allowed to try, in order. */
export function enabledRssUrls(config) {
  const disabled = new Set(config.source.disabledUrls ?? []);
  return config.source.rssUrls.filter((url) => !disabled.has(url));
}

/**
 * Points every feed URL at a new handle after the watched account changes.
 * The disabled list holds URLs verbatim, so it has to be rewritten in step or
 * a parked feed silently comes back to life.
 */
export function rewriteFeedHandle(config, previous, next) {
  const swap = (url) => url.replace(new RegExp(previous, 'gi'), next);
  config.source.rssUrls = config.source.rssUrls.map(swap);
  config.source.disabledUrls = (config.source.disabledUrls ?? []).map(swap);
  pruneDisabledUrls(config);
}

export function isFeedEnabled(config, url) {
  return !(config.source.disabledUrls ?? []).includes(url);
}

export function get() {
  if (!cache) throw new Error('store.load() must be awaited before store.get()');
  return cache;
}

export async function update(mutator) {
  const config = get();
  await mutator(config);
  await save();
  return config;
}

export async function save() {
  const snapshot = JSON.stringify(cache, null, 2);
  // Serialise writes; two commands landing in the same tick would otherwise
  // interleave rename() calls on the same temp file.
  writeQueue = writeQueue.then(async () => {
    const tmp = `${CONFIG_PATH}.tmp`;
    await fs.writeFile(tmp, snapshot, 'utf8');
    await fs.rename(tmp, CONFIG_PATH);
    setConfigReadOnly(false);
  }).catch((err) => {
    // Swallowing this used to make an unwritable /config look like the settings
    // "reset themselves" on every restart: the UI reported success, the values
    // lived in memory until the container was recreated, and then they were gone.
    // Flag it so the UI can say so out loud.
    setConfigReadOnly(true);
    console.error(
      `[store] failed to persist config to ${CONFIG_PATH}: ${err.message}\n` +
        '  Settings will be lost when this container restarts. Check that the host\n' +
        '  path mapped to /config exists and is writable by the container.'
    );
  });
  return writeQueue;
}

export function markSeen(config, id) {
  if (!config.seen.includes(id)) {
    config.seen.push(id);
    if (config.seen.length > SEEN_LIMIT) {
      config.seen.splice(0, config.seen.length - SEEN_LIMIT);
    }
  }
  if (isNewerThanHighWater(config, id)) {
    config.highWaterMark = id;
  }
}

export function hasSeen(config, id) {
  if (config.seen.includes(id)) return true;
  // Anything at or below the high-water mark predates us, even if it aged out
  // of the seen list.
  return config.highWaterMark != null && !isNewerThanHighWater(config, id);
}

function isNewerThanHighWater(config, id) {
  if (config.highWaterMark == null) return true;
  try {
    return BigInt(id) > BigInt(config.highWaterMark);
  } catch {
    return id !== config.highWaterMark;
  }
}

export { CONFIG_PATH, CONFIG_DIR };
