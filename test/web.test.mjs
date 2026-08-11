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
