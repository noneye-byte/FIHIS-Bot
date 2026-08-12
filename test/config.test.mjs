import { check, tmpConfigDir, finish, note } from './_harness.mjs';

/**
 * Container variables must seed the config, not overwrite it on every boot.
 *
 * On Unraid, opening a container and pressing Apply recreates it from the
 * template — so anything re-applied at startup silently undid whatever you had
 * changed in the web UI. Each reload below is a container restart.
 */

const CONFIG_DIR = tmpConfigDir();
process.env.CONFIG_DIR = CONFIG_DIR;

let generation = 0;
async function boot() {
  // A fresh module instance re-reads config.json exactly like a restart does.
  const store = await import(`../src/store.js?boot=${generation++}`);
  return { store, config: await store.load() };
}

/* --- 1. first boot seeds from the template --------------------------------- */
process.env.X_HANDLE = 'F_I_H_A_S';
process.env.POLL_INTERVAL_SECONDS = '120';
process.env.COMMAND_PREFIX = '!fihas';
process.env.PREFIX_ENABLED = 'true';

let { store, config } = await boot();
check('env seeds the interval on a fresh config', config.intervalSeconds === 120, `${config.intervalSeconds}`);
check('env seeds the handle', config.handle === 'F_I_H_A_S', config.handle);
check('what was applied is recorded', config.envApplied.POLL_INTERVAL_SECONDS === '120',
  JSON.stringify(config.envApplied));

/* --- 2. edits made in the web UI ------------------------------------------- */
await store.update((c) => {
  c.intervalSeconds = 600;
  c.prefix = '!f';
  c.prefixEnabled = false;
  c.setupCompleted = true;
});

/* --- 3. restarting with the same template must not undo them ---------------- */
({ store, config } = await boot());
check('interval set in the UI survives a restart', config.intervalSeconds === 600, `${config.intervalSeconds}`);
check('prefix set in the UI survives a restart', config.prefix === '!f', config.prefix);
check('prefix toggle set in the UI survives a restart', config.prefixEnabled === false);
check('setup stays completed', config.setupCompleted === true);
note('this is the regression: these used to revert to the template on every boot');

/* --- 4. changing the template still wins ------------------------------------ */
process.env.POLL_INTERVAL_SECONDS = '300';
process.env.PREFIX_ENABLED = 'false';
({ store, config } = await boot());
check('a changed template value is applied', config.intervalSeconds === 300, `${config.intervalSeconds}`);
check('an unchanged template value is still ignored', config.prefix === '!f', config.prefix);
check('re-applying records the new value', config.envApplied.POLL_INTERVAL_SECONDS === '300');

/* --- 5. and only once ------------------------------------------------------- */
await store.update((c) => { c.intervalSeconds = 900; });
({ store, config } = await boot());
check('the same changed value is not re-applied on the next boot',
  config.intervalSeconds === 900, `${config.intervalSeconds}`);

/* --- 6. a blank variable is "not set", never "clear it" --------------------- */
process.env.COMMAND_PREFIX = '';
process.env.RSS_USER_AGENT = '';
({ store, config } = await boot());
check('a blank variable leaves the saved value alone', config.prefix === '!f', config.prefix);
check('a blank user agent leaves the saved value alone', config.source.rss.userAgent === '');

/* --- 7. changing the watched account re-bootstraps -------------------------- */
await store.update((c) => {
  c.bootstrapped = true;
  c.seen = ['1900000000000000001'];
  c.source.rssUrls = ['https://mirror.example/F_I_H_A_S/rss'];
});
process.env.X_HANDLE = 'someone_else';
({ store, config } = await boot());
check('a new handle from the template is applied', config.handle === 'someone_else', config.handle);
check('a new handle rewrites the feed URLs',
  config.source.rssUrls[0] === 'https://mirror.example/someone_else/rss', config.source.rssUrls[0]);
check('a new handle clears the seen list rather than dumping a backlog',
  config.bootstrapped === false && config.seen.length === 0,
  `${config.bootstrapped} / ${config.seen.length}`);

/* --- 8. credentials outlive a container that forgets them --------------------
   The Discord token lives only in the container template, and re-applying a
   template resets every field to its default. That used to mean a blank token
   and a bot that could not log in until it was typed in by hand. */
const { runtime } = await import('../src/runtime.js');

process.env.DISCORD_TOKEN = 'tok-original';
process.env.DISCORD_CLIENT_ID = '123456789012345678';
process.env.DISCORD_GUILD_ID = '987654321098765432';
({ store, config } = await boot());
check('credentials from the container are mirrored into the config',
  config.discordToken === 'tok-original' && config.discordClientId === '123456789012345678',
  `${config.discordToken} / ${config.discordClientId}`);
check('nothing is reported as restored while the variables are set',
  runtime.credentialsRestored.length === 0, JSON.stringify(runtime.credentialsRestored));

// The template gets re-applied and hands back a container with empty fields.
process.env.DISCORD_TOKEN = '';
process.env.DISCORD_CLIENT_ID = '';
process.env.DISCORD_GUILD_ID = '';
({ store, config } = await boot());
check('a wiped token falls back to the saved copy',
  store.credentials().token === 'tok-original', String(store.credentials().token));
check('so does the client id', store.credentials().clientId === '123456789012345678');
check('so does the guild id', store.credentials().guildId === '987654321098765432');
check('and the reason is recorded for the log and the UI',
  runtime.credentialsRestored.join() === 'DISCORD_TOKEN,DISCORD_CLIENT_ID,DISCORD_GUILD_ID',
  JSON.stringify(runtime.credentialsRestored));
note('this is the regression: a re-applied Unraid template used to blank the token');

// Rotating the token still has to work — a variable with a value always wins.
process.env.DISCORD_TOKEN = 'tok-rotated';
({ store, config } = await boot());
check('a new token in the container replaces the saved one',
  store.credentials().token === 'tok-rotated', String(store.credentials().token));
check('the replacement is persisted for the next boot', config.discordToken === 'tok-rotated');
check('only the still-blank variables count as restored',
  runtime.credentialsRestored.join() === 'DISCORD_CLIENT_ID,DISCORD_GUILD_ID',
  JSON.stringify(runtime.credentialsRestored));

// A genuinely first-ever boot with nothing set must not claim it restored
// anything — that message would send someone hunting a problem they don't have.
delete process.env.DISCORD_TOKEN;
delete process.env.DISCORD_CLIENT_ID;
delete process.env.DISCORD_GUILD_ID;
process.env.CONFIG_DIR = tmpConfigDir();
({ store, config } = await boot());
check('a first boot with no credentials anywhere reports none restored',
  runtime.credentialsRestored.length === 0, JSON.stringify(runtime.credentialsRestored));
check('and hands back nulls rather than empty strings',
  store.credentials().token === null && store.credentials().clientId === null);

finish();
