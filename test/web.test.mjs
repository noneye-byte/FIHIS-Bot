import http from 'node:http';
import { check, tmpConfigDir, finish } from './_harness.mjs';

process.env.CONFIG_DIR = tmpConfigDir();
process.env.DISCORD_CLIENT_ID = '123456789012345678';

const store = await import('../src/store.js');
const web = await import('../src/web/server.js');

const config = await store.load();
const PASSWORD = config.webPassword;
check('password generated on first boot', typeof PASSWORD === 'string' && PASSWORD.length >= 12, `len ${PASSWORD?.length}`);
check('generated flag set', config.webPasswordGenerated === true);

/* --- fake Discord client with one guild, channels and roles --------------- */
const perms = (allowed) => ({ has: () => allowed });
const guild = {
  id: 'g1', name: 'Test Server', iconURL: () => null,
  members: { me: { permissions: perms(true) } },
  channels: { cache: new Map([
    ['c1', { id: 'c1', name: 'general', type: 0, permissionsFor: () => perms(true) }],
    ['c2', { id: 'c2', name: 'locked', type: 0, permissionsFor: () => perms(false) }],
    ['c3', { id: 'c3', name: 'news', type: 5, permissionsFor: () => perms(true) }],
    ['c4', { id: 'c4', name: 'Voice', type: 2, permissionsFor: () => perms(true) }]
  ]) },
  roles: { cache: new Map([
    ['g1', { id: 'g1', name: '@everyone', managed: false, hexColor: '#000000' }],
    ['r1', { id: 'r1', name: 'Fans', managed: false, hexColor: '#ff8c00' }],
    ['r2', { id: 'r2', name: 'BotRole', managed: true, hexColor: '#000000' }]
  ]) }
};
web.attach({
  isReady: () => true,
  user: { tag: 'FIHAS#0001', displayAvatarURL: () => 'http://avatar' },
  guilds: { cache: new Map([['g1', guild]]) }
});

const server = await web.createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

let cookie = '';
async function req(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

/* --- 1. health is unauthenticated ------------------------------------------ */
let r = await req('/healthz', { auth: false });
check('healthz open without auth', r.status === 200 && r.json.status === 'ok');

/* --- 2. protected endpoints reject anonymous -------------------------------- */
r = await req('/api/state', { auth: false });
check('state requires auth', r.status === 401, `got ${r.status}`);
r = await req('/api/config', { method: 'POST', body: { intervalSeconds: 60 }, auth: false });
check('config write requires auth', r.status === 401, `got ${r.status}`);

/* --- 3. UI + assets serve ---------------------------------------------------- */
r = await req('/', { auth: false });
check('UI html serves', r.status === 200 && r.text.includes('FIHAS Bot'));
check('UI references logo', r.text.includes('/logo.jpg'));
r = await req('/logo.jpg', { auth: false });
check('logo serves as jpeg', r.status === 200 && r.headers.get('content-type') === 'image/jpeg');

/* --- 4. wrong password rejected ---------------------------------------------- */
r = await req('/api/login', { method: 'POST', body: { password: 'wrong' } });
check('wrong password rejected', r.status === 401);
check('no session cookie issued on failure', !cookie.includes('fihas_session'), cookie);

/* --- 5. correct password logs in ---------------------------------------------- */
r = await req('/api/login', { method: 'POST', body: { password: PASSWORD } });
check('correct password accepted', r.status === 200 && r.json.ok === true);
check('session cookie issued', cookie.startsWith('fihas_session='));
const setCookieHeader = r.headers.get('set-cookie');
check('cookie is HttpOnly + SameSite=Strict',
  /HttpOnly/i.test(setCookieHeader) && /SameSite=Strict/i.test(setCookieHeader), setCookieHeader);

/* --- 6. state exposes guild data, filtered correctly --------------------------- */
r = await req('/api/state');
check('state authorised', r.status === 200);
const g = r.json.guilds[0];
check('one guild returned', r.json.guilds.length === 1 && g.name === 'Test Server');
check('voice channel excluded', !g.channels.some((c) => c.name === 'Voice'), g.channels.map((c) => c.name).join(','));
check('announcement channel included', g.channels.some((c) => c.announcement));
check('unpostable channel flagged', g.channels.find((c) => c.name === 'locked').canPost === false);
check('@everyone role excluded', !g.roles.some((x) => x.id === 'g1'));
check('managed role excluded', !g.roles.some((x) => x.id === 'r2'));
check('normal role present', g.roles.some((x) => x.id === 'r1'));
check('password never exposed in state', !JSON.stringify(r.json).includes(PASSWORD));
check('state carries the prefix settings',
  r.json.config.prefix === '!fihas' && r.json.config.prefixEnabled === true);
check('state reports the message intent', typeof r.json.messageIntent === 'string', r.json.messageIntent);
check('state reports the bundled rsshub', r.json.rsshub.bundled === false
  && r.json.rsshub.feedUrl.includes('/twitter/user/'), JSON.stringify(r.json.rsshub));

/* --- 6b. quick-edit patches the dashboard sends ------------------------------- */
r = await req('/api/config', { method: 'POST', body: { prefix: '!f', prefixEnabled: false } });
check('prefix settings editable', r.status === 200
  && r.json.state.config.prefix === '!f' && r.json.state.config.prefixEnabled === false);
await req('/api/config', { method: 'POST', body: { prefix: '!fihas', prefixEnabled: true } });

/* --- 7. valid config patch ------------------------------------------------------ */
r = await req('/api/config', { method: 'POST', body: {
  guildId: 'g1', channelId: 'c1', pings: [{ type: 'role', id: '4444444444' }],
  intervalSeconds: 300, linkStyle: 'vxtwitter', filters: { retweets: false }
}});
check('valid patch accepted', r.status === 200 && r.json.errors.length === 0, JSON.stringify(r.json.errors));
check('patch applied to state', r.json.state.config.intervalSeconds === 300
  && r.json.state.config.linkStyle === 'vxtwitter'
  && r.json.state.config.filters.retweets === false);

/* --- 8. validation rejects bad input ---------------------------------------------- */
r = await req('/api/config', { method: 'POST', body: { intervalSeconds: 5 } });
check('sub-30s interval rejected', r.status === 400 && r.json.errors.length === 1, JSON.stringify(r.json.errors));
r = await req('/api/config', { method: 'POST', body: { handle: 'bad handle!' } });
check('invalid handle rejected', r.status === 400);
r = await req('/api/config', { method: 'POST', body: { linkStyle: 'evil.com' } });
check('unknown link style rejected', r.status === 400);
r = await req('/api/config', { method: 'POST', body: { rssUrls: ['javascript:alert(1)'] } });
check('non-http URL rejected', r.status === 400);
r = await req('/api/config', { method: 'POST', body: { messageTemplate: 'no placeholder' } });
check('template without {link} rejected', r.status === 400);
r = await req('/api/config', { method: 'POST', body: { pings: [{ type: 'role', id: 'not-an-id' }] } });
check('malformed ping id dropped', r.status === 200 && r.json.state.config.pings.length === 0);
r = await req('/api/config', { method: 'POST', body: { sourceMode: 'nonsense' } });
check('unknown source mode rejected', r.status === 400);
r = await req('/api/config', { method: 'POST', body: { prefix: 'has spaces' } });
check('prefix with a space rejected', r.status === 400);
r = await req('/api/config', { method: 'POST', body: { prefix: '@fihas' } });
check('prefix that looks like a mention rejected', r.status === 400);

/* --- 9. rejected patches leave state intact ----------------------------------------- */
r = await req('/api/state');
check('rejected patch did not corrupt interval', r.json.config.intervalSeconds === 300,
  String(r.json.config.intervalSeconds));

/* --- 10. template preview ------------------------------------------------------------ */
await req('/api/config', { method: 'POST', body: { pings: [{ type: 'role', id: '777777777777777777' }] } });
r = await req('/api/action', { method: 'POST', body: { action: 'preview', template: '{pings} yo {handle} {link}' } });
check('preview renders placeholders',
  r.json.rendered.includes('<@&777777777777777777>') && r.json.rendered.includes('vxtwitter.com/F_I_H_A_S/status/'),
  r.json.rendered);

/* --- 11. handle change re-bootstraps --------------------------------------------------- */
await req('/api/config', { method: 'POST', body: { setupCompleted: true } });
store.get().bootstrapped = true;
store.get().seen = ['1', '2'];
r = await req('/api/config', { method: 'POST', body: { handle: 'someone_else' } });
check('handle change resets bootstrap', r.json.state.config.bootstrapped === false);
check('handle change clears seen ids', r.json.state.config.seenCount === 0);

/* --- 11b. RSS feed management ------------------------------------------------------------
   The feed manager sends the whole chain plus the disabled subset, so ordering,
   de-duplication and the enabled/disabled split all have to survive a round trip. */
const FEED_A = 'http://127.0.0.1:9/a.rss';
const FEED_B = 'http://127.0.0.1:9/b.rss';
r = await req('/api/config', { method: 'POST', body: {
  rssUrls: [FEED_A, FEED_B, FEED_A], rssDisabled: [FEED_B]
}});
check('duplicate feeds collapsed', r.json.state.config.source.rssUrls.length === 2,
  JSON.stringify(r.json.state.config.source.rssUrls));
check('feed order preserved', r.json.state.config.source.rssUrls[0] === FEED_A);
check('feed can be disabled without removing it',
  r.json.state.config.source.disabledUrls.join() === FEED_B,
  JSON.stringify(r.json.state.config.source.disabledUrls));

r = await req('/api/config', { method: 'POST', body: { rssUrls: [FEED_A] } });
check('dropping a feed drops its disabled entry',
  r.json.state.config.source.disabledUrls.length === 0,
  JSON.stringify(r.json.state.config.source.disabledUrls));

r = await req('/api/config', { method: 'POST', body: { rssDisabled: ['http://not-in-the-list/'] } });
check('disabling an unknown feed is a no-op',
  r.json.state.config.source.disabledUrls.length === 0);

r = await req('/api/config', { method: 'POST', body: {
  rssSettings: { timeoutSeconds: 45, maxItems: 5, userAgent: 'Custom/1.0' }
}});
check('rss fetch settings saved', r.status === 200
  && r.json.state.config.source.rss.timeoutSeconds === 45
  && r.json.state.config.source.rss.maxItems === 5
  && r.json.state.config.source.rss.userAgent === 'Custom/1.0',
  JSON.stringify(r.json.state.config.source.rss));

r = await req('/api/config', { method: 'POST', body: { rssSettings: { timeoutSeconds: 1 } } });
check('too-short timeout rejected', r.status === 400, `got ${r.status}`);
r = await req('/api/config', { method: 'POST', body: { rssSettings: { maxItems: 0 } } });
check('zero items per fetch rejected', r.status === 400, `got ${r.status}`);
r = await req('/api/config', { method: 'POST', body: { rssSettings: { userAgent: 'bad\r\nX-Evil: 1' } } });
check('header injection in the user agent rejected', r.status === 400, `got ${r.status}`);
r = await req('/api/state');
check('rejected rss settings left the saved ones alone',
  r.json.config.source.rss.timeoutSeconds === 45 && r.json.config.source.rss.userAgent === 'Custom/1.0');
check('state carries feed presets for the watched handle',
  Array.isArray(r.json.feedPresets) && r.json.feedPresets.every((p) => p.url.includes(r.json.config.handle)),
  JSON.stringify(r.json.feedPresets?.slice(0, 1)));
check('state carries the rss limits', Array.isArray(r.json.rssLimits?.timeoutSeconds));
check('state carries the default user agent the UI shows as a placeholder',
  typeof r.json.rssDefaultUserAgent === 'string' && r.json.rssDefaultUserAgent.length > 0,
  r.json.rssDefaultUserAgent);
check('state carries the disabled feed list', Array.isArray(r.json.config.source.disabledUrls));

/* --- 11c. single-feed test ----------------------------------------------------------------- */
const feedItems = [
  { id: '1900000000000000009', title: 'newest post' },
  { id: '1900000000000000008', title: 'RT @someone: not mine' }
];
const feedServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
  res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${feedItems
    .map((i) => `<item><title>${i.title}</title><link>http://x.com/h/status/${i.id}</link>` +
      `<description>${i.title}</description></item>`).join('')}</channel></rss>`);
});
await new Promise((res) => feedServer.listen(0, '127.0.0.1', res));
const feedUrl = `http://127.0.0.1:${feedServer.address().port}/rss`;

await req('/api/config', { method: 'POST', body: { filters: { retweets: false } } });
r = await req('/api/action', { method: 'POST', body: { action: 'feed-test', url: feedUrl } });
check('single feed test succeeds', r.json.ok === true && r.json.count === 2, JSON.stringify(r.json));
check('feed test previews the newest items first',
  r.json.items[0].id === '1900000000000000009', JSON.stringify(r.json.items?.[0]));
check('feed test flags what the filters would drop',
  r.json.items[1].isRetweet === true && r.json.items[1].filtered === true,
  JSON.stringify(r.json.items?.[1]));

r = await req('/api/action', { method: 'POST', body: { action: 'feed-test', url: 'javascript:alert(1)' } });
check('feed test refuses a non-http URL', r.status === 400, `got ${r.status}`);
r = await req('/api/action', { method: 'POST', body: { action: 'feed-test', url: 'http://127.0.0.1:9/nope' } });
check('unreachable feed reports the error rather than throwing',
  r.status === 200 && r.json.ok === false && typeof r.json.error === 'string', JSON.stringify(r.json));

/* A disabled feed still appears in the chain test, marked as skipped. */
await req('/api/config', { method: 'POST', body: {
  sourceMode: 'rss', rssUrls: [feedUrl], rssDisabled: [feedUrl]
}});
r = await req('/api/action', { method: 'POST', body: { action: 'test' } });
check('disabled feed is reported as skipped, not fetched',
  r.json.results.some((x) => x.source.includes(feedUrl) && x.skipped === true),
  JSON.stringify(r.json.results));
feedServer.close();

/* --- 12. unknown action + route -------------------------------------------------------- */
r = await req('/api/action', { method: 'POST', body: { action: 'drop-tables' } });
check('unknown action rejected', r.status === 400);
r = await req('/api/nope');
check('unknown route 404s', r.status === 404);

/* --- 13. oversized body answers 413 rather than killing the socket ---------------------- */
r = await req('/api/config', { method: 'POST', body: { messageTemplate: 'x'.repeat(200000) } });
check('oversized body rejected with 413', r.status === 413, `status ${r.status}`);

/* --- 14. logout invalidates the session -------------------------------------------------- */
await req('/api/logout', { method: 'POST', body: {} });
r = await req('/api/state');
check('session invalid after logout', r.status === 401, `got ${r.status}`);

server.close();
finish();
