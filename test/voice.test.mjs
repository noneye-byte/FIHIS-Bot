import { check, tmpConfigDir, finish } from './_harness.mjs';

process.env.CONFIG_DIR = tmpConfigDir();

const store = await import('../src/store.js');
const voice = await import('../src/voice.js');
const actions = await import('../src/actions.js');

await store.load();

/* --- 1. the clip ships with the bot ---------------------------------------- */
check('audio file is present', voice.audioAvailable(), voice.AUDIO_PATH);
check('clip name is reported for the UI', voice.clipName().endsWith('.mp3'), voice.clipName());

/* --- 2. volume clamping -----------------------------------------------------
   Gain is a 0-1 multiplier on PCM samples, and an out-of-range one either
   silences the clip or blows the mixer up, so nothing may reach it unclamped. */
const [MIN, MAX] = store.VOICE_LIMITS.volume;
check('default volume comes from the config',
  voice.gainFrom({ voice: { volume: 40 } }) === 0.4);
check('an override beats the saved default',
  voice.gainFrom({ voice: { volume: 40 } }, 90) === 0.9);
check('above the ceiling is clamped', voice.gainFrom({ voice: { volume: 9000 } }) === MAX / 100);
check('below the floor is clamped', voice.gainFrom({ voice: { volume: -50 } }) === MIN / 100);
check('a missing voice block falls back to full', voice.gainFrom({}) === 1);
check('garbage reads as silence, not NaN', voice.gainFrom({ voice: { volume: 'loud' } }) === 0);

/* --- 3. a fake guild with voice channels ------------------------------------ */
class Collection extends Map {
  filter(fn) {
    const out = new Collection();
    for (const [k, v] of this) if (fn(v)) out.set(k, v);
    return out;
  }
}
const human = (id) => ({ user: { bot: false }, id });
const bot = (id) => ({ user: { bot: true }, id });

function voiceChannel(id, name, members, type = 2) {
  return { id, name, type, members: new Collection(members.map((m) => [m.id, m])) };
}

// type 2 = GuildVoice, 13 = GuildStageVoice, 0 = text.
const quiet = voiceChannel('v1', 'Quiet', []);
const busy = voiceChannel('v2', 'Busy', [human('u1'), human('u2'), bot('b1')]);
const oneGuy = voiceChannel('v3', 'Corner', [human('u3')]);
const botsOnly = voiceChannel('v4', 'Bots', [bot('b2'), bot('b3')]);
const text = { id: 't1', name: 'general', type: 0, members: new Collection() };

const guild = {
  id: 'g1',
  channels: { cache: new Collection([quiet, busy, oneGuy, botsOnly, text].map((c) => [c.id, c])) }
};

check('bots do not count as an audience', voice.humanCount(botsOnly) === 0);
check('humans are counted, bots in the same channel are not', voice.humanCount(busy) === 2);

/* --- 4. picking a channel ---------------------------------------------------- */
check('busiest occupied channel wins by default',
  voice.pickChannel(guild, null)?.id === 'v2', voice.pickChannel(guild, null)?.name);
check('the caller\'s own channel beats a busier one',
  voice.pickChannel(guild, { voice: { channel: oneGuy } })?.id === 'v3');
// Someone sitting alone in an empty channel still counts as an audience — they
// asked for it.
check('an empty channel the caller is in is still chosen',
  voice.pickChannel(guild, { voice: { channel: quiet } })?.id === 'v1');
check('a stage channel is playable',
  voice.pickChannel({ id: 'g2', channels: { cache: new Collection([['s1',
    voiceChannel('s1', 'Stage', [human('u9')], 13)]]) } })?.id === 's1');
check('text channels are never picked',
  voice.pickChannel({ id: 'g3', channels: { cache: new Collection([['t1', text]]) } }) === null);

const emptyGuild = {
  id: 'g4',
  channels: { cache: new Collection([['v1', quiet], ['v4', botsOnly]].map(([k, v]) => [k, v])) }
};
check('nobody in voice means no channel', voice.pickChannel(emptyGuild, null) === null);

/* --- 5. what the command answers -------------------------------------------- */
let r = await actions.playAudio(emptyGuild, null, {});
check('an empty server is refused, not joined', r.content.includes('Nobody is in a voice channel'),
  r.content);
check('nothing was left playing', voice.status('g4').playing === false);

r = await actions.playAudio(guild, null, { volume: 500 });
check('an out-of-range volume is rejected before joining',
  r.content.includes(`between ${MIN} and ${MAX}`), r.content);

/* The bot has to be able to hear itself into the channel; without Connect and
   Speak it would join and play to nobody. */
const noPerms = {
  ...guild,
  members: { fetchMe: async () => ({}) },
  channels: guild.channels
};
noPerms.channels = { cache: new Collection([['v2', { ...busy, permissionsFor: () => ({ has: () => false }) }]]) };
r = await actions.playAudio(noPerms, null, {});
check('missing voice permissions are named, not swallowed',
  r.content.includes('Connect') && r.content.includes('Speak'), r.content);

r = actions.stopAudio(guild);
check('stopping when idle says so', r.content.includes('Nothing is playing'), r.content);

check('status reports an idle guild', voice.status('g1').playing === false);
voice.stopAll();

finish();
