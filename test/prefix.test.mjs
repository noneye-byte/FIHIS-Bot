import { check, tmpConfigDir, finish } from './_harness.mjs';

process.env.CONFIG_DIR = tmpConfigDir();

const store = await import('../src/store.js');
const prefix = await import('../src/prefix.js');
const rsshub = await import('../src/rsshub.js');

const config = await store.load();

/* --- 1. parsing ------------------------------------------------------------ */
check('matches the prefix', prefix.parse('!fihas status', '!fihas')?.args[0] === 'status');
check('bare prefix parses to no args', prefix.parse('!fihas', '!fihas')?.args.length === 0);
check('case insensitive', prefix.parse('!FIHAS Status', '!fihas')?.args[0] === 'Status');
check('leading whitespace tolerated', prefix.parse('   !fihas check', '!fihas')?.args[0] === 'check');
check('collapses repeated spaces',
  prefix.parse('!fihas   set    interval   90', '!fihas')?.args.join('|') === 'set|interval|90');
check('ignores unrelated messages', prefix.parse('hello world', '!fihas') === null);
check('ignores a mid-sentence prefix', prefix.parse('look at !fihas', '!fihas') === null);
// The word-boundary rule is what stops "!fihasburger" being read as a command.
check('word prefix needs a separator', prefix.parse('!fihasburger', '!fihas') === null);
check('punctuation prefix does not', prefix.parse('!status', '!')?.args[0] === 'status');
check('rest() keeps the raw remainder',
  prefix.parse('!fihas set template A  B {link}', '!fihas')?.rest(2) === 'A  B {link}');

/* --- 2. a fake guild ------------------------------------------------------- */
class Collection extends Map {
  find(fn) {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}
const guild = {
  id: 'g1',
  members: { fetchMe: async () => ({ permissions: { has: () => true } }) },
  channels: {
    cache: new Collection([
      ['100000000000000001', {
        id: '100000000000000001', name: 'general',
        isTextBased: () => true, permissionsFor: () => ({ has: () => true })
      }]
    ])
  },
  roles: { cache: new Collection([['r1', { id: 'r1', name: 'Fans' }]]) }
};

const run = (line) => prefix.dispatch(guild, prefix.parse(line, store.get().prefix));

/* --- 3. read-only commands ------------------------------------------------- */
let r = await run('!fihas help');
check('help lists commands', r.content.includes('!fihas status'));
r = await run('!fihas');
check('bare prefix shows help', r.content.includes('FIHAS Bot'));
r = await run('!fihas status');
check('status returns an embed', Array.isArray(r.embeds) && r.embeds.length === 1);
r = await run('!fihas nonsense');
check('unknown command is reported', r.content.includes('Unknown command'));
check('help no longer advertises the retired commands',
  !(await run('!fihas help')).content.includes('set interval'));

/* --- 4. server settings belong to the web UI -------------------------------
   Discord keeps the Discord-side settings and the run controls; everything the
   watcher itself runs on is edited in the web UI only. The retired commands
   have to say so rather than silently doing nothing or reporting nonsense. */
const before = {
  interval: store.get().intervalSeconds,
  retweets: store.get().filters.retweets,
  linkStyle: store.get().linkStyle,
  template: store.get().messageTemplate,
  handle: store.get().handle,
  mode: store.get().source.mode,
  urls: store.get().source.rssUrls.join('|')
};

for (const line of [
  '!fihas set interval 90',
  '!fihas set handle someone_else',
  '!fihas set filter retweets off',
  '!fihas set link vxtwitter',
  '!fihas set template Look: {link}',
  '!fihas source mode rss',
  '!fihas source add https://example.com/feed.rss',
  '!fihas source list',
  '!fihas settings',
  '!fihas config'
]) {
  r = await run(line);
  check(`"${line.slice(7)}" points at the web UI`, r.content.includes('web UI'), r.content.slice(0, 90));
}

check('interval unchanged from Discord', store.get().intervalSeconds === before.interval);
check('handle unchanged from Discord', store.get().handle === before.handle);
check('filters unchanged from Discord', store.get().filters.retweets === before.retweets);
check('link style unchanged from Discord', store.get().linkStyle === before.linkStyle);
check('template unchanged from Discord', store.get().messageTemplate === before.template);
check('source mode unchanged from Discord', store.get().source.mode === before.mode);
check('feed chain unchanged from Discord', store.get().source.rssUrls.join('|') === before.urls);
// The dump is gone, but the guarantee it used to carry must not come back by
// some other route: no reply may ever contain the web password.
check('nothing leaks the web password', !r.content.includes(config.webPassword), r.content.slice(0, 90));

/* --- 5. Discord-side settings still work ----------------------------------- */
r = await run('!fihas channel set <#100000000000000001>');
check('channel mention resolved', store.get().channelId === '100000000000000001', r.content);
r = await run('!fihas channel #general');
check('channel by name, without "set"', store.get().channelId === '100000000000000001', r.content);
r = await run('!fihas channel set #nope');
check('unknown channel reported', r.content.includes('could not find'), r.content);

await run('!fihas ping add <@&999888777>');
check('role mention added', store.get().pings.some((p) => p.type === 'role' && p.id === '999888777'));
await run('!fihas ping add <@111222333>');
check('user mention added', store.get().pings.some((p) => p.type === 'user' && p.id === '111222333'));
await run('!fihas ping remove <@&999888777>');
check('role removed', !store.get().pings.some((p) => p.id === '999888777'));
await run('!fihas ping clear');
check('ping list cleared', store.get().pings.length === 0);

await run('!fihas pause');
check('paused', store.get().paused === true);
await run('!fihas resume');
check('resumed', store.get().paused === false);

// Voice playback is a run control, so both command styles reach it. This guild
// has no voice channels, which is the "nobody to play to" path.
r = await run('!fihas play');
check('play is dispatched', r.content.includes('voice channel'), r.content);
r = await run('!fihas sound');
check('"sound" is an alias for play', r.content.includes('voice channel'), r.content);
r = await run('!fihas play 900');
check('a bad volume argument is caught', r.content.includes('between'), r.content);
r = await run('!fihas play loud');
// A non-numeric argument is not a volume, so it falls back to the saved default
// rather than refusing to play at all.
check('a non-numeric volume is ignored, not rejected', r.content.includes('voice channel'), r.content);
r = await run('!fihas stop');
check('stop is dispatched', r.content.includes('Nothing is playing'), r.content);

/* --- 6. the prefix can change itself, from either spelling ------------------- */
// A multi-word prefix must be refused outright, not truncated to "bad".
r = await run('!fihas set prefix bad prefix');
check('prefix with a space refused', store.get().prefix === '!fihas', store.get().prefix);
check('and says why', r.content.includes('no spaces'), r.content);
await run('!fihas set prefix !f');
check('prefix changed', store.get().prefix === '!f');
check('new prefix takes effect immediately',
  prefix.parse('!f status', store.get().prefix)?.args[0] === 'status');
check('old prefix stops matching', prefix.parse('!fihas status', store.get().prefix) === null);
await run('!f prefix off');
check('prefix commands can be turned off', store.get().prefixEnabled === false);
await run('!f prefix on');
check('and back on', store.get().prefixEnabled === true);
await store.update((c) => { c.prefix = '!fihas'; });

/* --- 7. permission gate ------------------------------------------------------ */
function fakeMessage(canManage) {
  const replies = [];
  return {
    replies,
    content: '!fihas status',
    author: { bot: false },
    inGuild: () => true,
    guild,
    member: { permissions: { has: () => canManage } },
    channel: { sendTyping: async () => {}, send: async (p) => replies.push(p) },
    reply: async (p) => replies.push(p)
  };
}

let msg = fakeMessage(false);
await prefix.handleMessage(msg);
check('non-admins are refused', msg.replies[0]?.content.includes('Manage Server'), JSON.stringify(msg.replies));

msg = fakeMessage(true);
await prefix.handleMessage(msg);
check('admins get an answer', Array.isArray(msg.replies[0]?.embeds));
check('replies never ping',
  msg.replies[0]?.allowedMentions?.parse.length === 0 &&
    msg.replies[0]?.allowedMentions?.repliedUser === false,
  JSON.stringify(msg.replies[0]?.allowedMentions));

const bot = fakeMessage(true);
bot.author.bot = true;
await prefix.handleMessage(bot);
check('bot messages ignored', bot.replies.length === 0);

await store.update((c) => { c.prefixEnabled = false; });
const off = fakeMessage(true);
await prefix.handleMessage(off);
check('disabled prefix ignores everything', off.replies.length === 0);
await store.update((c) => { c.prefixEnabled = true; });

/* --- 8. bundled RSSHub helpers ------------------------------------------------ */
check('feed url points at the local instance',
  rsshub.localFeedUrl('F_I_H_A_S') === `http://127.0.0.1:${rsshub.port()}/twitter/user/F_I_H_A_S`,
  rsshub.localFeedUrl('F_I_H_A_S'));
check('recognises its own urls', rsshub.isLocalUrl(rsshub.localFeedUrl('x')));
check('recognises localhost form', rsshub.isLocalUrl(`http://localhost:${rsshub.port()}/twitter/user/x`));
check('does not claim public mirrors', !rsshub.isLocalUrl('https://rsshub.app/twitter/user/x'));
check('not bundled outside the image', rsshub.isBundled() === false);
// start() must be a no-op rather than a crash when RSSHub is not present.
const state = rsshub.start();
check('start is safe without a bundled rsshub', state.running === false && state.bundled === false);
rsshub.stop();

finish();
