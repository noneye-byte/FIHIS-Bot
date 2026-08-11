import Parser from 'rss-parser';

const parser = new Parser({
  timeout: 20_000,
  headers: { 'User-Agent': 'FIHAS-Bot/1.0 (+https://github.com/)' }
});

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
export async function fetchTweets(handle, { url } = {}) {
  if (!url) throw new Error('No RSS URL configured');
  const feed = await parser.parseURL(url);

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
  return items.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
}

export const name = 'rss';
