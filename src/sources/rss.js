import Parser from 'rss-parser';

export const DEFAULT_USER_AGENT = 'FIHAS-Bot/1.0 (+https://github.com/)';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_ITEMS = 20;

// A parser holds nothing but its options, but building one per request would
// still be wasteful when every poll uses the same settings.
const parsers = new Map();

function parserFor(timeoutMs, userAgent) {
  const key = `${timeoutMs}\n${userAgent}`;
  let parser = parsers.get(key);
  if (!parser) {
    parser = new Parser({ timeout: timeoutMs, headers: { 'User-Agent': userAgent } });
    parsers.set(key, parser);
  }
  return parser;
}

/** Turns the stored `source.rss` block into fetchTweets options. */
export function optionsFrom(config) {
  const settings = config?.source?.rss ?? {};
  return {
    timeoutMs: (settings.timeoutSeconds || DEFAULT_TIMEOUT_MS / 1000) * 1000,
    maxItems: settings.maxItems || DEFAULT_MAX_ITEMS,
    userAgent: settings.userAgent?.trim() || DEFAULT_USER_AGENT
  };
}

const STATUS_ID = /(?:status|statuses)\/(\d+)/;

function extractId(item) {
  for (const candidate of [item.link, item.guid, item.id]) {
    const match = typeof candidate === 'string' ? candidate.match(STATUS_ID) : null;
    if (match) return match[1];
  }
  return null;
}

function classify(item) {
  const title = (item.title ?? '').trim();
  const content = (item.contentSnippet ?? item.content ?? '').trim();
  return {
    // Nitter prefixes retweets with "RT by @user:"; RSSHub and most mirrors
    // keep Twitter's own "RT @user:" prefix on the body.
    isRetweet: /^RT by @/i.test(title) || /^RT @/i.test(title) || /^RT @/i.test(content),
    // Nitter marks replies as "R to @user:".
    isReply: /^R to @/i.test(title) || /^@\w+/.test(title),
    isQuote: false
  };
}

/**
 * @returns {Promise<Array<{id, handle, text, createdAt, isRetweet, isReply, isQuote}>>}
 *          newest first
 */
export async function fetchTweets(handle, {
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxItems = DEFAULT_MAX_ITEMS,
  userAgent = DEFAULT_USER_AGENT
} = {}) {
  if (!url) throw new Error('No RSS URL configured');
  const feed = await parserFor(timeoutMs, userAgent).parseURL(url);

  const items = (feed.items ?? [])
    .map((item) => {
      const id = extractId(item);
      if (!id) return null;
      const flags = classify(item);
      return {
        id,
        handle,
        text: (item.contentSnippet ?? item.title ?? '').trim(),
        createdAt: item.isoDate ? new Date(item.isoDate) : null,
        ...flags
      };
    })
    .filter(Boolean);

  if (!items.length) {
    throw new Error(`Feed parsed but contained no tweet links: ${url}`);
  }

  // Feeds are usually newest-first already, but mirrors disagree often enough
  // that sorting by snowflake is worth the few microseconds.
  items.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  return maxItems > 0 ? items.slice(0, maxItems) : items;
}

export const name = 'rss';
