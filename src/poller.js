import { get, save, markSeen, hasSeen } from './store.js';
import * as xapi from './sources/xapi.js';
import * as rss from './sources/rss.js';

const MIN_INTERVAL = 30;
const MAX_BACKOFF_MS = 15 * 60_000;

let timer = null;
let running = false;
let client = null;
let consecutiveFailures = 0;
let backoffUntil = 0;

export function attach(discordClient) {
  client = discordClient;
}

export function buildLink(config, tweet) {
  const host = config.linkStyle === 'vxtwitter' ? 'vxtwitter.com' : 'fxtwitter.com';
  return `https://${host}/${tweet.handle}/status/${tweet.id}`;
}

export function buildMentions(config) {
  const parts = [];
  if (config.mentionEveryone) parts.push('@everyone');
  for (const ping of config.pings) {
    parts.push(ping.type === 'user' ? `<@${ping.id}>` : `<@&${ping.id}>`);
  }
  return parts.join(' ');
}

function renderMessage(config, tweet) {
  const mentions = buildMentions(config);
  const link = buildLink(config, tweet);
  return (config.messageTemplate || '{pings} New post from **@{handle}**\n{link}')
    .replaceAll('{pings}', mentions)
    .replaceAll('{handle}', tweet.handle)
    .replaceAll('{link}', link)
    .replaceAll('{text}', tweet.text ?? '')
    .trim();
}

function passesFilters(config, tweet) {
  if (tweet.isRetweet && !config.filters.retweets) return false;
  if (tweet.isReply && !config.filters.replies) return false;
  if (tweet.isQuote && !config.filters.quotes) return false;
  return true;
}

/**
 * Runs the configured source chain until one succeeds.
 * @returns {Promise<{tweets: Array, sourceUsed: string, errors: string[]}>}
 */
export async function fetchFromSources(config) {
  const errors = [];
  const attempts = [];

  const mode = config.source.mode;
  if ((mode === 'auto' || mode === 'xapi') && xapi.isConfigured()) {
    attempts.push({
      label: 'xapi',
      run: () => xapi.fetchTweets(config.handle, { sinceId: config.highWaterMark })
    });
  }
  if (mode === 'auto' || mode === 'rss') {
    for (const url of config.source.rssUrls) {
      attempts.push({ label: `rss:${url}`, run: () => rss.fetchTweets(config.handle, { url }) });
    }
  }

  if (!attempts.length) {
    throw new Error(
      mode === 'xapi'
        ? 'Source mode is "xapi" but X_BEARER_TOKEN is not set.'
        : 'No sources configured. Add an RSS URL with /fihas source add.'
    );
  }

  for (const attempt of attempts) {
    try {
      const tweets = await attempt.run();
      return { tweets, sourceUsed: attempt.label, errors };
    } catch (err) {
      errors.push(`${attempt.label}: ${err.message}`);
    }
  }

  const err = new Error(`All sources failed.\n${errors.join('\n')}`);
  err.allFailed = true;
  throw err;
}

/**
 * @param {{force?: boolean}} opts force ignores the paused flag and backoff.
 * @returns {Promise<{posted: Array, skipped: number, sourceUsed: string|null, bootstrap: boolean}>}
 */
export async function checkNow({ force = false } = {}) {
  const config = get();

  if (config.paused && !force) return { posted: [], skipped: 0, sourceUsed: null, bootstrap: false };
  if (!force && Date.now() < backoffUntil) {
    return { posted: [], skipped: 0, sourceUsed: null, bootstrap: false };
  }

  const { tweets, sourceUsed } = await fetchFromSources(config);
  config.lastCheckAt = new Date().toISOString();
  config.lastSourceUsed = sourceUsed;
  config.lastError = null;
  consecutiveFailures = 0;
  backoffUntil = 0;

  // First successful poll only records history. Without this the bot would
  // dump the entire feed into the channel the moment it starts.
  if (!config.bootstrapped) {
    for (const tweet of tweets) markSeen(config, tweet.id);
    config.bootstrapped = true;
    await save();
    return { posted: [], skipped: tweets.length, sourceUsed, bootstrap: true };
  }

  const fresh = tweets.filter((t) => !hasSeen(config, t.id));
  const posted = [];
  let skipped = 0;

  // Oldest first, so a burst of tweets lands in chronological order.
  for (const tweet of fresh.slice().reverse()) {
    if (!passesFilters(config, tweet)) {
      markSeen(config, tweet.id);
      skipped += 1;
      continue;
    }
    try {
      await postTweet(config, tweet);
      markSeen(config, tweet.id);
      posted.push(tweet);
      config.lastPostAt = new Date().toISOString();
    } catch (err) {
      // Leave it unseen so the next cycle retries it.
      console.error(`[poller] failed to post ${tweet.id}:`, err.message);
      config.lastError = `post failed: ${err.message}`;
      break;
    }
  }

  await save();
  return { posted, skipped, sourceUsed, bootstrap: false };
}

async function postTweet(config, tweet) {
  if (!config.channelId) throw new Error('No channel configured (/fihas channel set)');
  if (!client) throw new Error('Discord client not attached');

  const channel = await client.channels.fetch(config.channelId);
  if (!channel?.isTextBased()) {
    throw new Error(`Channel ${config.channelId} is not a text channel`);
  }

  const message = await channel.send({
    content: renderMessage(config, tweet),
    allowedMentions: {
      parse: config.mentionEveryone ? ['everyone'] : [],
      roles: config.pings.filter((p) => p.type === 'role').map((p) => p.id),
      users: config.pings.filter((p) => p.type === 'user').map((p) => p.id)
    }
  });

  // Announcement channels are worth crossposting from; failure is not fatal.
  if (channel.type === 5) {
    await message.crosspost().catch(() => {});
  }
  return message;
}

export { postTweet };

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await checkNow();
    if (result.bootstrap) {
      console.log(`[poller] bootstrapped with ${result.skipped} existing tweets via ${result.sourceUsed}`);
    } else if (result.posted.length) {
      console.log(`[poller] posted ${result.posted.length} tweet(s) via ${result.sourceUsed}`);
    }
  } catch (err) {
    consecutiveFailures += 1;
    const config = get();
    config.lastError = err.message;
    config.lastCheckAt = new Date().toISOString();
    await save();

    const backoff = Math.min(
      MAX_BACKOFF_MS,
      config.intervalSeconds * 1000 * 2 ** Math.min(consecutiveFailures, 6)
    );
    backoffUntil = Date.now() + backoff;
    console.error(
      `[poller] check failed (${consecutiveFailures}x), backing off ${Math.round(backoff / 1000)}s:`,
      err.message
    );
  } finally {
    running = false;
    schedule();
  }
}

function schedule() {
  clearTimeout(timer);
  const config = get();
  const base = Math.max(MIN_INTERVAL, config.intervalSeconds) * 1000;
  // A little jitter keeps us from hammering shared RSS mirrors on the tick.
  const delay = Math.max(base, backoffUntil - Date.now()) + Math.random() * 5_000;
  timer = setTimeout(tick, delay);
  timer.unref?.();
}

export function start() {
  clearTimeout(timer);
  timer = setTimeout(tick, 5_000);
  timer.unref?.();
  console.log(`[poller] started, interval ${get().intervalSeconds}s`);
}

export function stop() {
  clearTimeout(timer);
  timer = null;
}

export function restart() {
  stop();
  backoffUntil = 0;
  consecutiveFailures = 0;
  schedule();
}

export function status() {
  return {
    running,
    nextCheckInMs: timer ? Math.max(0, backoffUntil - Date.now()) || null : null,
    consecutiveFailures,
    backoffUntil
  };
}
