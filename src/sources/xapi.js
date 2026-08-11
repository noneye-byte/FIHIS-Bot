const API = 'https://api.x.com/2';

// Looking a user id up costs a request, and the id never changes, so cache it
// for the life of the process.
const userIdCache = new Map();

function authHeaders() {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error('X_BEARER_TOKEN is not set');
  return { Authorization: `Bearer ${token}`, 'User-Agent': 'FIHAS-Bot/1.0' };
}

async function call(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 429) {
    const reset = res.headers.get('x-rate-limit-reset');
    const waitFor = reset ? Math.max(0, Number(reset) * 1000 - Date.now()) : null;
    const err = new Error(
      `X API rate limited${waitFor ? `, resets in ${Math.ceil(waitFor / 1000)}s` : ''}`
    );
    err.retryAfterMs = waitFor;
    err.rateLimited = true;
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `X API rejected the token (HTTP ${res.status}). Reading a user timeline needs a Basic tier plan or higher.`
    );
  }
  if (!res.ok) {
    throw new Error(`X API returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

async function resolveUserId(handle) {
  const key = handle.toLowerCase();
  if (userIdCache.has(key)) return userIdCache.get(key);
  const body = await call(`${API}/users/by/username/${encodeURIComponent(handle)}`);
  if (!body?.data?.id) throw new Error(`X API could not resolve @${handle}`);
  userIdCache.set(key, body.data.id);
  return body.data.id;
}

/**
 * @returns {Promise<Array<{id, handle, text, createdAt, isRetweet, isReply, isQuote}>>}
 *          newest first
 */
export async function fetchTweets(handle, { sinceId } = {}) {
  const userId = await resolveUserId(handle);
  const params = new URLSearchParams({
    max_results: '10',
    'tweet.fields': 'created_at,referenced_tweets,in_reply_to_user_id'
  });
  // since_id keeps the response small once we are caught up, but the API
  // rejects it alongside an empty timeline on the very first call.
  if (sinceId) params.set('since_id', sinceId);

  const body = await call(`${API}/users/${userId}/tweets?${params}`);
  const tweets = body?.data ?? [];

  return tweets.map((t) => {
    const refs = t.referenced_tweets ?? [];
    return {
      id: t.id,
      handle,
      text: t.text ?? '',
      createdAt: t.created_at ? new Date(t.created_at) : null,
      isRetweet: refs.some((r) => r.type === 'retweeted'),
      isReply: refs.some((r) => r.type === 'replied_to') || Boolean(t.in_reply_to_user_id),
      isQuote: refs.some((r) => r.type === 'quoted')
    };
  });
}

export function isConfigured() {
  return Boolean(process.env.X_BEARER_TOKEN);
}

export const name = 'xapi';
