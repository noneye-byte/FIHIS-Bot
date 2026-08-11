import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

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
    ]
  },
  filters: {
    retweets: true,
    replies: false,
    quotes: true
  },
  linkStyle: 'fxtwitter',
  messageTemplate: '{pings} New post from **@{handle}**\n{link}',
  // web setup wizard
  guildId: null,
  setupCompleted: false,
  webPassword: null,
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

export async function load() {
  if (cache) return cache;
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    cache = merge(DEFAULTS, JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[store] ${CONFIG_PATH} is unreadable, starting from defaults:`, err.message);
    }
    cache = structuredClone(DEFAULTS);
  }

  // Env vars win on first boot so a fresh container can be fully configured
  // from the Unraid template without touching Discord.
  if (!cache.channelId && process.env.DISCORD_CHANNEL_ID) {
    cache.channelId = process.env.DISCORD_CHANNEL_ID;
  }
  if (process.env.X_HANDLE) {
    cache.handle = process.env.X_HANDLE.replace(/^@/, '');
  }
  if (!cache.pings.length && process.env.PING_ROLE_ID) {
    cache.pings = process.env.PING_ROLE_ID.split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ type: 'role', id }));
  }
  if (process.env.POLL_INTERVAL_SECONDS) {
    const parsed = Number.parseInt(process.env.POLL_INTERVAL_SECONDS, 10);
    if (Number.isFinite(parsed) && parsed >= 30) cache.intervalSeconds = parsed;
  }
  if (process.env.RSS_URLS) {
    cache.source.rssUrls = process.env.RSS_URLS.split(',').map((u) => u.trim()).filter(Boolean);
  }

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

  await save();
  return cache;
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
  }).catch((err) => {
    console.error('[store] failed to persist config:', err.message);
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
