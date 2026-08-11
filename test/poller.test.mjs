import http from 'node:http';
import { check, tmpConfigDir, finish } from './_harness.mjs';

process.env.CONFIG_DIR = tmpConfigDir();

const store = await import('../src/store.js');
const poller = await import('../src/poller.js');
const rss = await import('../src/sources/rss.js');

/* --- a fake feed we can mutate between polls ------------------------------ */
let items = [
  { id: '1900000000000000002', title: 'second post', link: 'http://x.com/F_I_H_A_S/status/1900000000000000002' },
  { id: '1900000000000000001', title: 'first post', link: 'http://x.com/F_I_H_A_S/status/1900000000000000001' }
];
const server = http.createServer((req, res) => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link><description>${i.title}</description></item>`)
    .join('')}</channel></rss>`;
  res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
  res.end(xml);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/rss`;

/* --- a fake Discord client that records what would be sent ---------------- */
const sent = [];
poller.attach({
  channels: {
    fetch: async () => ({
      type: 0,
      isTextBased: () => true,
      send: async (payload) => {
        sent.push(payload);
        return { crosspost: async () => {} };
      }
    })
  }
});

const config = await store.load();
await store.update((c) => {
  c.channelId = '12345';
  c.source.mode = 'rss';
  c.source.rssUrls = [url];
  c.pings = [{ type: 'role', id: '777' }];
  c.paused = false;
});

/* --- 1. first poll must bootstrap silently -------------------------------- */
let r = await poller.checkNow({ force: true });
check('first poll bootstraps', r.bootstrap === true);
check('first poll posts nothing', sent.length === 0, `sent ${sent.length}`);
check('bootstrap recorded both ids', r.skipped === 2);

/* --- 2. no change -> quiet ------------------------------------------------ */
r = await poller.checkNow({ force: true });
check('no-change poll is quiet', sent.length === 0 && r.posted.length === 0);

/* --- 3. two new tweets, oldest first -------------------------------------- */
items = [
  { id: '1900000000000000004', title: 'fourth post', link: 'http://x.com/F_I_H_A_S/status/1900000000000000004' },
  { id: '1900000000000000003', title: 'third post', link: 'http://x.com/F_I_H_A_S/status/1900000000000000003' },
  ...items
];
r = await poller.checkNow({ force: true });
check('posted both new tweets', sent.length === 2, `sent ${sent.length}`);
check('chronological order (oldest first)',
  sent[0].content.includes('1900000000000000003') && sent[1].content.includes('1900000000000000004'),
  sent.map((s) => s.content.match(/status\/(\d+)/)[1]).join(' then '));
check('uses fxtwitter link', sent[0].content.includes('fxtwitter.com/F_I_H_A_S/status/'));
check('includes the role ping', sent[0].content.includes('<@&777>'));
check('allowedMentions scoped to that role only',
  sent[0].allowedMentions.roles.length === 1 &&
    sent[0].allowedMentions.roles[0] === '777' &&
    sent[0].allowedMentions.parse.length === 0,
  JSON.stringify(sent[0].allowedMentions));

/* --- 4. re-poll must not repost -------------------------------------------- */
sent.length = 0;
await poller.checkNow({ force: true });
check('no duplicate reposts', sent.length === 0, `sent ${sent.length}`);

/* --- 5. retweet filter ------------------------------------------------------ */
await store.update((c) => { c.filters.retweets = false; });
items = [
  { id: '1900000000000000005', title: 'RT by @F_I_H_A_S: not mine', link: 'http://x.com/other/status/1900000000000000005' },
  ...items
];
r = await poller.checkNow({ force: true });
check('retweet filtered out', sent.length === 0 && r.skipped === 1, `sent ${sent.length}, skipped ${r.skipped}`);

/* --- 6. filtered tweet is marked seen, not retried ------------------------- */
r = await poller.checkNow({ force: true });
check('filtered tweet not re-evaluated', r.skipped === 0 && sent.length === 0);

/* --- 7. paused stops posting ----------------------------------------------- */
await store.update((c) => { c.paused = true; });
items = [
  { id: '1900000000000000006', title: 'while paused', link: 'http://x.com/F_I_H_A_S/status/1900000000000000006' },
  ...items
];
r = await poller.checkNow();
check('paused poll does nothing', sent.length === 0 && r.posted.length === 0);

/* --- 8. resuming delivers what was missed ---------------------------------- */
await store.update((c) => { c.paused = false; });
r = await poller.checkNow({ force: true });
check('missed tweet delivered after resume',
  sent.length === 1 && sent[0].content.includes('1900000000000000006'), `sent ${sent.length}`);

/* --- 8b. a disabled feed is skipped entirely --------------------------------- */
await store.update((c) => { c.source.disabledUrls = [url]; });
let disabledError = null;
try {
  await poller.checkNow({ force: true });
} catch (err) {
  disabledError = err.message;
}
check('disabled feed leaves nothing to try', /disabled/i.test(disabledError ?? ''), String(disabledError));
check('enabledRssUrls hides the disabled feed', store.enabledRssUrls(store.get()).length === 0);
await store.update((c) => { c.source.disabledUrls = []; });

/* --- 8c. maxItems caps what a feed can return --------------------------------- */
await store.update((c) => { c.source.rss.maxItems = 1; });
const capped = await rss.fetchTweets('F_I_H_A_S', {
  url,
  ...rss.optionsFrom(store.get())
});
check('maxItems caps the fetch', capped.length === 1, `${capped.length} item(s)`);
check('the cap keeps the newest item', capped[0].id === '1900000000000000006', capped[0].id);
await store.update((c) => { c.source.rss.maxItems = 20; });

/* --- 9. state survives a restart -------------------------------------------- */
await store.save();
const store2 = await import(`../src/store.js?reload=${Date.now()}`);
const reloaded = await store2.load();
check('bootstrapped flag persisted', reloaded.bootstrapped === true);
check('seen ids persisted', reloaded.seen.includes('1900000000000000006'), `${reloaded.seen.length} ids`);
check('high-water mark persisted', reloaded.highWaterMark === '1900000000000000006', reloaded.highWaterMark);
check('post-restart dedupe holds', store2.hasSeen(reloaded, '1900000000000000004'));

server.close();
finish();
