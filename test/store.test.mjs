import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { check, tmpConfigDir, finish } from './_harness.mjs';

const CONFIG_DIR = tmpConfigDir();
process.env.CONFIG_DIR = CONFIG_DIR;

const store = await import('../src/store.js');
const poller = await import('../src/poller.js');
const rss = await import('../src/sources/rss.js');
const { command } = await import('../src/commands.js');

/* --- slash command builder must serialise to a valid Discord payload ----- */
const json = command.toJSON();
const subs = [];
for (const opt of json.options) {
  if (opt.type === 2) for (const s of opt.options) subs.push(`${opt.name} ${s.name}`);
  else subs.push(opt.name);
}
check('command serialises', json.name === 'fihas');
check('option count within Discord limit of 25', json.options.length <= 25, `${json.options.length}`);
check('all subcommands present', subs.length === 25, `${subs.length} subcommands`);
for (const expected of ['status', 'help', 'channel set', 'ping everyone', 'source mode',
  'prefix set', 'prefix enabled', 'set interval', 'set template']) {
  check(`subcommand "${expected}" registered`, subs.includes(expected), subs.join(', '));
}

/* --- defaults ------------------------------------------------------------ */
const config = await store.load();
check('default handle', config.handle === 'F_I_H_A_S');
check('starts unbootstrapped', config.bootstrapped === false);
check('web password generated', typeof config.webPassword === 'string' && config.webPassword.length >= 12);
check('prefix commands on by default', config.prefixEnabled === true && config.prefix === '!fihas',
  `${config.prefix} / ${config.prefixEnabled}`);

/* --- dedupe / high-water mark -------------------------------------------- */
store.markSeen(config, '1000000000000000005');
check('seen id is deduped', store.hasSeen(config, '1000000000000000005'));
check('older id treated as seen', store.hasSeen(config, '1000000000000000001'));
check('newer id is fresh', !store.hasSeen(config, '1000000000000000009'));

// Simulate the seen-list aging out past its cap.
config.seen = [];
check('aged-out old id still suppressed', store.hasSeen(config, '1000000000000000001'));
check('aged-out newer id still fresh', !store.hasSeen(config, '1000000000000000009'));

/* --- link building ------------------------------------------------------- */
const tweet = { handle: 'F_I_H_A_S', id: '1234567890123456789', text: 'hello' };
check('fxtwitter link',
  poller.buildLink(config, tweet) === 'https://fxtwitter.com/F_I_H_A_S/status/1234567890123456789',
  poller.buildLink(config, tweet));
check('vxtwitter link',
  poller.buildLink({ ...config, linkStyle: 'vxtwitter' }, tweet) ===
    'https://vxtwitter.com/F_I_H_A_S/status/1234567890123456789');

/* --- mentions ------------------------------------------------------------ */
const pinged = { ...config, mentionEveryone: false, pings: [{ type: 'role', id: '111' }, { type: 'user', id: '222' }] };
check('mentions render', poller.buildMentions(pinged) === '<@&111> <@222>', poller.buildMentions(pinged));
check('no pings renders empty', poller.buildMentions({ ...config, pings: [], mentionEveryone: false }) === '');

/* --- persistence --------------------------------------------------------- */
await store.update((c) => { c.channelId = '999'; c.intervalSeconds = 300; });
const raw = JSON.parse(await fsp.readFile(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
check('config persisted to disk', raw.channelId === '999' && raw.intervalSeconds === 300);

/* --- RSS parsing against a realistic Nitter-style feed -------------------- */
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>F_I_H_A_S / @F_I_H_A_S</title>
<item><title>Normal post here</title><link>http://x.com/F_I_H_A_S/status/1900000000000000002</link>
<description>Normal post here</description><pubDate>Sat, 09 Aug 2025 10:00:00 GMT</pubDate></item>
<item><title>RT by @F_I_H_A_S: something</title><link>http://x.com/other/status/1900000000000000001</link>
<description>a retweet</description><pubDate>Sat, 09 Aug 2025 09:00:00 GMT</pubDate></item>
<item><title>R to @someone: my reply</title><link>http://x.com/F_I_H_A_S/status/1900000000000000000</link>
<description>a reply</description><pubDate>Sat, 09 Aug 2025 08:00:00 GMT</pubDate></item>
</channel></rss>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
  res.end(feed);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/rss`;

const items = await rss.fetchTweets('F_I_H_A_S', { url });
check('parsed 3 items', items.length === 3, `${items.length}`);
check('sorted newest first', items[0].id === '1900000000000000002', items[0].id);
check('retweet detected', items[1].isRetweet === true);
check('reply detected', items[2].isReply === true);
check('normal post not flagged', !items[0].isRetweet && !items[0].isReply);

/* --- source fallback chain ------------------------------------------------ */
const result = await poller.fetchFromSources({
  ...config,
  source: { mode: 'rss', rssUrls: ['http://127.0.0.1:1/dead', url] }
});
check('fell back to working source', result.sourceUsed === `rss:${url}`, result.sourceUsed);
check('recorded the failure', result.errors.length === 1, JSON.stringify(result.errors));

try {
  await poller.fetchFromSources({ ...config, source: { mode: 'rss', rssUrls: ['http://127.0.0.1:1/dead'] } });
  check('all-dead chain throws', false);
} catch (err) {
  check('all-dead chain throws', err.allFailed === true);
}

server.close();
finish();
