import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  get,
  update,
  hasSeen,
  isFeedEnabled,
  pruneDisabledUrls,
  rewriteFeedHandle,
  DEFAULTS,
  HANDLE_RE,
  PREFIX_RE,
  RSS_LIMITS
} from '../store.js';
import * as poller from '../poller.js';
import * as rsshub from '../rsshub.js';
import * as xapi from '../sources/xapi.js';
import * as rss from '../sources/rss.js';
import { runtime } from '../runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
export const LOGO_PATH = path.join(ROOT, 'FIHAS.jpg');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

const sessions = new Map(); // token -> expiry
const loginAttempts = new Map(); // ip -> { count, until }

let client = null;
let uiHtml = null;
let logoBytes = null;

export function attach(discordClient) {
  client = discordClient;
}

/* -------------------------------------------------------------- utilities */

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        chunks.length = 0;
        const err = new Error('Request body too large');
        err.statusCode = 413;
        // Drain rather than destroy: killing the socket here means the client
        // sees ECONNRESET instead of our 413.
        req.resume();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Body was not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function clientIp(req) {
  return req.socket.remoteAddress ?? 'unknown';
}

function isAuthed(req) {
  const token = parseCookies(req).fihas_session;
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------ state */

function collectGuilds() {
  if (!client?.isReady()) return [];
  return [...client.guilds.cache.values()].map((guild) => {
    const me = guild.members.me;
    return {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL({ size: 64 }),
      channels: [...guild.channels.cache.values()]
        .filter((ch) => ch.type === 0 || ch.type === 5)
        .map((ch) => ({
          id: ch.id,
          name: ch.name,
          announcement: ch.type === 5,
          // Surfacing this in the picker beats letting someone select a channel
          // the bot silently cannot post in.
          canPost: Boolean(me && ch.permissionsFor(me)?.has(['ViewChannel', 'SendMessages']))
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      roles: [...guild.roles.cache.values()]
        .filter((role) => role.id !== guild.id && !role.managed)
        .map((role) => ({ id: role.id, name: role.name, color: role.hexColor }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      canMentionEveryone: Boolean(me?.permissions.has('MentionEveryone'))
    };
  });
}

/**
 * Ready-made feed URLs for the account being watched, so adding a mirror is a
 * click instead of remembering someone's URL scheme.
 */
function feedPresets(handle) {
  const encoded = encodeURIComponent(handle);
  const presets = [];
  if (rsshub.isBundled()) {
    presets.push({ label: 'Built-in RSSHub', url: rsshub.localFeedUrl(handle), local: true });
  }
  presets.push(
    { label: 'RSSHub (public instance)', url: `https://rsshub.app/twitter/user/${encoded}` },
    { label: 'Nitter — privacydev', url: `https://nitter.privacydev.net/${encoded}/rss` },
    { label: 'Nitter — poast', url: `https://nitter.poast.org/${encoded}/rss` },
    { label: 'Nitter — 1d4', url: `https://nitter.1d4.us/${encoded}/rss` }
  );
  return presets;
}

function publicState() {
  const config = get();
  return {
    connected: Boolean(client?.isReady()),
    botTag: client?.user?.tag ?? null,
    botAvatar: client?.user?.displayAvatarURL({ size: 128 }) ?? null,
    clientId: process.env.DISCORD_CLIENT_ID ?? null,
    hasXToken: Boolean(process.env.X_BEARER_TOKEN),
    guilds: collectGuilds(),
    poller: poller.status(),
    rsshub: { ...rsshub.status(), feedUrl: rsshub.localFeedUrl(config.handle) },
    // Everything the feed manager needs to build and validate rows itself.
    feedPresets: feedPresets(config.handle),
    rssLimits: RSS_LIMITS,
    rssDefaultUserAgent: rss.DEFAULT_USER_AGENT,
    // 'active' | 'denied' | 'off' — whether prefix commands can read message text.
    messageIntent: runtime.messageIntent,
    // Why Discord is unreachable, when it is. The UI surfaces this because the
    // alternative is an admin staring at "Not connected" with no reason given.
    fault: runtime.fault,
    configReadOnly: runtime.configReadOnly,
    config: {
      handle: config.handle,
      guildId: config.guildId,
      channelId: config.channelId,
      pings: config.pings,
      mentionEveryone: config.mentionEveryone,
      intervalSeconds: config.intervalSeconds,
      paused: config.paused,
      source: config.source,
      filters: config.filters,
      linkStyle: config.linkStyle,
      messageTemplate: config.messageTemplate,
      prefix: config.prefix,
      prefixEnabled: config.prefixEnabled,
      setupCompleted: config.setupCompleted,
      bootstrapped: config.bootstrapped,
      lastCheckAt: config.lastCheckAt,
      lastPostAt: config.lastPostAt,
      lastError: config.lastError,
      lastSourceUsed: config.lastSourceUsed,
      seenCount: config.seen.length
    }
  };
}

/* ----------------------------------------------------------- config patch */

async function applyPatch(patch) {
  const errors = [];
  const config = get();
  let restartPoller = false;

  await update((c) => {
    if (patch.handle !== undefined) {
      const handle = String(patch.handle).replace(/^@/, '').trim();
      if (!HANDLE_RE.test(handle)) {
        errors.push('Handle must be 1-15 letters, numbers or underscores.');
      } else if (handle.toLowerCase() !== config.handle.toLowerCase()) {
        const previous = c.handle;
        c.handle = handle;
        // A different account makes the seen-list meaningless; re-bootstrap so
        // we do not dump their backlog into the channel.
        c.seen = [];
        c.highWaterMark = null;
        c.bootstrapped = false;
        rewriteFeedHandle(c, previous, handle);
        restartPoller = true;
      }
    }

    if (patch.guildId !== undefined) c.guildId = patch.guildId || null;

    if (patch.channelId !== undefined) c.channelId = patch.channelId || null;

    if (patch.pings !== undefined) {
      if (!Array.isArray(patch.pings)) {
        errors.push('Pings must be a list.');
      } else {
        c.pings = patch.pings
          .filter((p) => p && (p.type === 'role' || p.type === 'user') && /^\d{5,25}$/.test(p.id))
          .map((p) => ({ type: p.type, id: String(p.id) }));
      }
    }

    if (patch.mentionEveryone !== undefined) c.mentionEveryone = Boolean(patch.mentionEveryone);

    if (patch.intervalSeconds !== undefined) {
      const seconds = Number.parseInt(patch.intervalSeconds, 10);
      if (!Number.isFinite(seconds) || seconds < 30 || seconds > 86400) {
        errors.push('Interval must be between 30 and 86400 seconds.');
      } else {
        c.intervalSeconds = seconds;
        restartPoller = true;
      }
    }

    if (patch.paused !== undefined) {
      c.paused = Boolean(patch.paused);
      restartPoller = true;
    }

    if (patch.sourceMode !== undefined) {
      if (!['auto', 'xapi', 'rss'].includes(patch.sourceMode)) {
        errors.push('Unknown source mode.');
      } else {
        c.source.mode = patch.sourceMode;
        restartPoller = true;
      }
    }

    if (patch.rssUrls !== undefined) {
      if (!Array.isArray(patch.rssUrls)) {
        errors.push('RSS URLs must be a list.');
      } else {
        const cleaned = patch.rssUrls.map((u) => String(u).trim()).filter(Boolean);
        const bad = cleaned.filter((u) => !/^https?:\/\//i.test(u));
        if (bad.length) errors.push(`Not valid http(s) URLs: ${bad.join(', ')}`);
        // A duplicate feed is only ever a slower poll — the second copy is tried
        // with the same result as the first.
        c.source.rssUrls = [...new Set(cleaned.filter((u) => /^https?:\/\//i.test(u)))];
        pruneDisabledUrls(c);
        restartPoller = true;
      }
    }

    if (patch.rssDisabled !== undefined) {
      if (!Array.isArray(patch.rssDisabled)) {
        errors.push('Disabled feeds must be a list.');
      } else {
        c.source.disabledUrls = [...new Set(patch.rssDisabled.map((u) => String(u).trim()))];
        pruneDisabledUrls(c);
        restartPoller = true;
      }
    }

    if (patch.rssSettings !== undefined) {
      const s = patch.rssSettings ?? {};
      if (s.timeoutSeconds !== undefined) {
        const [min, max] = RSS_LIMITS.timeoutSeconds;
        const seconds = Number.parseInt(s.timeoutSeconds, 10);
        if (!Number.isFinite(seconds) || seconds < min || seconds > max) {
          errors.push(`Feed timeout must be between ${min} and ${max} seconds.`);
        } else {
          c.source.rss.timeoutSeconds = seconds;
        }
      }
      if (s.maxItems !== undefined) {
        const [min, max] = RSS_LIMITS.maxItems;
        const items = Number.parseInt(s.maxItems, 10);
        if (!Number.isFinite(items) || items < min || items > max) {
          errors.push(`Items per fetch must be between ${min} and ${max}.`);
        } else {
          c.source.rss.maxItems = items;
        }
      }
      if (s.userAgent !== undefined) {
        const agent = String(s.userAgent).trim();
        if (agent.length > RSS_LIMITS.userAgentMaxLength) {
          errors.push(`User agent must be ${RSS_LIMITS.userAgentMaxLength} characters or fewer.`);
        } else if (/[\r\n]/.test(agent)) {
          // It goes straight into a request header.
          errors.push('User agent cannot contain line breaks.');
        } else {
          c.source.rss.userAgent = agent;
        }
      }
      restartPoller = true;
    }

    if (patch.filters !== undefined) {
      for (const key of ['retweets', 'replies', 'quotes']) {
        if (patch.filters[key] !== undefined) c.filters[key] = Boolean(patch.filters[key]);
      }
    }

    if (patch.linkStyle !== undefined) {
      if (!['fxtwitter', 'vxtwitter'].includes(patch.linkStyle)) errors.push('Unknown link style.');
      else c.linkStyle = patch.linkStyle;
    }

    if (patch.messageTemplate !== undefined) {
      const template = String(patch.messageTemplate).trim();
      if (!template) c.messageTemplate = DEFAULTS.messageTemplate;
      else if (template.length > 1500) errors.push('Template is too long.');
      else if (!template.includes('{link}')) errors.push('Template must include {link}.');
      else c.messageTemplate = template;
    }

    if (patch.prefix !== undefined) {
      const prefix = String(patch.prefix).trim();
      if (!PREFIX_RE.test(prefix)) {
        errors.push('Prefix must be 1-16 characters with no spaces, @, # or backticks.');
      } else {
        c.prefix = prefix;
      }
    }

    if (patch.prefixEnabled !== undefined) c.prefixEnabled = Boolean(patch.prefixEnabled);

    if (patch.setupCompleted !== undefined) c.setupCompleted = Boolean(patch.setupCompleted);
  });

  if (restartPoller) poller.restart();
  return errors;
}

/* --------------------------------------------------------------- handlers */

/**
 * Why the built-in RSSHub is failing. It answers 503 for every route error, so
 * the status alone says nothing; in practice it is almost always its X
 * credentials, whether missing, expired or refused.
 */
function rsshubTokenHint() {
  return {
    source: 'Hint',
    skipped: true,
    detail: process.env.TWITTER_AUTH_TOKEN
      ? 'The built-in RSSHub answers 503 whenever a route fails, and its X route fails when the auth_token cookie is expired or rejected — X invalidates them often. Log in to X again, copy a fresh auth_token cookie into TWITTER_AUTH_TOKEN, restart the container, then use Restart RSSHub. The container log under [rsshub] carries the underlying error. See https://docs.rsshub.app/deploy/config#x-twitter'
      : 'The built-in RSSHub needs TWITTER_AUTH_TOKEN — the auth_token cookie from a logged-in X session — before its X routes return anything, and answers 503 until it has one. See https://docs.rsshub.app/deploy/config#x-twitter'
  };
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const record = loginAttempts.get(ip);
  if (record?.until && record.until > Date.now()) {
    const mins = Math.ceil((record.until - Date.now()) / 60000);
    return json(res, 429, { error: `Too many failed attempts. Try again in ${mins} minute(s).` });
  }

  const body = await readBody(req);
  const config = get();

  if (!timingSafeEqual(body.password ?? '', config.webPassword)) {
    const next = { count: (record?.count ?? 0) + 1, until: null };
    if (next.count >= LOGIN_MAX_ATTEMPTS) {
      next.until = Date.now() + LOGIN_LOCKOUT_MS;
      next.count = 0;
    }
    loginAttempts.set(ip, next);
    return json(res, 401, { error: 'Wrong password.' });
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': `fihas_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  });
  res.end(JSON.stringify({ ok: true }));
}

async function handleAction(req, res) {
  const body = await readBody(req);
  const config = get();

  switch (body.action) {
    case 'test': {
      const results = [];
      if (xapi.isConfigured()) {
        try {
          const tweets = await xapi.fetchTweets(config.handle, {});
          results.push({ source: 'X API', ok: true, detail: `${tweets.length} post(s) returned` });
        } catch (err) {
          results.push({ source: 'X API', ok: false, detail: err.message });
        }
      } else {
        results.push({ source: 'X API', skipped: true, detail: 'No X_BEARER_TOKEN set' });
      }
      let localFailed = false;
      const options = rss.optionsFrom(config);
      for (const url of config.source.rssUrls) {
        const local = rsshub.isLocalUrl(url);
        const source = local ? `${url} (built-in RSSHub)` : url;
        if (!isFeedEnabled(config, url)) {
          results.push({ source, skipped: true, detail: 'Disabled — the poller skips this feed' });
          continue;
        }
        try {
          const tweets = await rss.fetchTweets(config.handle, { url, ...options });
          results.push({ source, ok: true, detail: `${tweets.length} post(s), newest ${tweets[0].id}` });
        } catch (err) {
          results.push({ source, ok: false, detail: err.message });
          localFailed ||= local;
        }
      }
      if (localFailed) results.push(rsshubTokenHint());
      return json(res, 200, { results });
    }

    // One feed, tested on its own and with a sample of what it would post.
    // Testing the whole chain to find out which mirror is broken is tedious
    // once there are more than two of them.
    case 'feed-test': {
      const url = String(body.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        return json(res, 400, { error: 'That is not a valid http(s) URL.' });
      }
      const local = rsshub.isLocalUrl(url);
      const startedAt = Date.now();
      try {
        const tweets = await rss.fetchTweets(config.handle, { url, ...rss.optionsFrom(config) });
        return json(res, 200, {
          ok: true,
          url,
          local,
          ms: Date.now() - startedAt,
          count: tweets.length,
          // A preview of the newest few, flagged the way the poller would treat
          // them, so "works but posts nothing" is diagnosable from the UI.
          items: tweets.slice(0, 5).map((tweet) => ({
            id: tweet.id,
            text: (tweet.text ?? '').slice(0, 200),
            createdAt: tweet.createdAt ? new Date(tweet.createdAt).toISOString() : null,
            isRetweet: tweet.isRetweet,
            isReply: tweet.isReply,
            isQuote: tweet.isQuote,
            filtered: !poller.passesFilters(config, tweet),
            seen: hasSeen(config, tweet.id)
          }))
        });
      } catch (err) {
        return json(res, 200, {
          ok: false,
          url,
          local,
          ms: Date.now() - startedAt,
          error: err.message,
          hint: local ? rsshubTokenHint().detail : null
        });
      }
    }

    case 'rsshub-restart': {
      const state = rsshub.restart();
      return json(res, 200, {
        ok: state.bundled && state.enabled,
        rsshub: state,
        error: !state.bundled
          ? 'No RSSHub is bundled in this image.'
          : !state.enabled
            ? 'RSSHub is disabled by RSSHUB_ENABLED.'
            : null
      });
    }

    case 'check': {
      try {
        const result = await poller.checkNow({ force: true });
        return json(res, 200, {
          ok: true,
          bootstrap: result.bootstrap,
          posted: result.posted.length,
          skipped: result.skipped,
          sourceUsed: result.sourceUsed
        });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    }

    case 'latest': {
      try {
        const { tweets, sourceUsed } = await poller.fetchFromSources(config);
        if (!tweets.length) return json(res, 200, { ok: false, error: 'Source returned no posts.' });
        const withPing = Boolean(body.ping);
        await poller.postTweet(
          withPing ? config : { ...config, pings: [], mentionEveryone: false },
          tweets[0]
        );
        return json(res, 200, { ok: true, id: tweets[0].id, sourceUsed, pinged: withPing });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    }

    case 'preview': {
      // Renders the template without touching Discord, for the live preview.
      const tweet = { handle: config.handle, id: '1234567890123456789', text: 'Example post text' };
      const link = poller.buildLink(config, tweet);
      const mentions = poller.buildMentions(config) || '';
      const rendered = (body.template || config.messageTemplate)
        .replaceAll('{pings}', mentions)
        .replaceAll('{handle}', config.handle)
        .replaceAll('{link}', link)
        .replaceAll('{text}', tweet.text)
        .trim();
      return json(res, 200, { rendered });
    }

    default:
      return json(res, 400, { error: `Unknown action: ${body.action}` });
  }
}

/* ----------------------------------------------------------------- server */

async function loadAssets() {
  if (!uiHtml) uiHtml = await fs.readFile(path.join(HERE, 'ui.html'), 'utf8');
  if (!logoBytes) {
    logoBytes = await fs.readFile(LOGO_PATH).catch(() => null);
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  // Unauthenticated: the container health check must not need a password.
  if (pathname === '/healthz' || pathname === '/health') {
    const config = get();
    const healthy = Boolean(client?.isReady());
    return json(res, healthy ? 200 : 503, {
      status: healthy ? 'ok' : 'disconnected',
      fault: runtime.fault,
      configReadOnly: runtime.configReadOnly,
      handle: config.handle,
      paused: config.paused,
      channelConfigured: Boolean(config.channelId),
      setupCompleted: config.setupCompleted,
      lastCheckAt: config.lastCheckAt,
      lastPostAt: config.lastPostAt,
      lastError: config.lastError,
      lastSourceUsed: config.lastSourceUsed
    });
  }

  if (pathname === '/logo.jpg' || pathname === '/favicon.ico') {
    if (!logoBytes) {
      res.writeHead(404).end('Logo not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
    return res.end(logoBytes);
  }

  if (pathname === '/' ) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(uiHtml);
  }

  if (pathname === '/api/session') {
    return json(res, 200, { authed: isAuthed(req) });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    return handleLogin(req, res);
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req).fihas_session;
    if (token) sessions.delete(token);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'fihas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Everything past here needs a session.
  if (!isAuthed(req)) return json(res, 401, { error: 'Not authenticated' });

  if (pathname === '/api/state') return json(res, 200, publicState());

  if (pathname === '/api/config' && req.method === 'POST') {
    const patch = await readBody(req);
    const errors = await applyPatch(patch);
    return json(res, errors.length ? 400 : 200, { errors, state: publicState() });
  }

  if (pathname === '/api/action' && req.method === 'POST') return handleAction(req, res);

  return json(res, 404, { error: 'Not found' });
}

export async function createServer() {
  await loadAssets();
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error('[web] request failed:', err.message);
      if (!res.headersSent) json(res, err.statusCode ?? 500, { error: err.message });
      else res.end();
    });
  });
  return server;
}

export function sessionCount() {
  return sessions.size;
}
