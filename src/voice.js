import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType
} from '@discordjs/voice';
import { get, VOICE_LIMITS } from './store.js';

/**
 * Plays the shipped clip into a voice channel.
 *
 * The pipeline is mp3 -> ffmpeg -> PCM -> volume -> opus, which is why the
 * volume knob exists at all: Discord takes opus, and gain can only be applied
 * while the audio is still PCM. ffmpeg comes from the `ffmpeg-static` package
 * (prism-media finds it on its own) and the encoder is `opusscript`. Both are
 * deliberately non-native — deps are installed on Alpine and copied into the
 * Debian-based RSSHub image, so a compiled addon would not load there.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const AUDIO_PATH = path.join(ROOT, 'F_I_H_A_S_audio.mp3');

// A clip that never reaches Idle — a wedged ffmpeg, a half-open connection —
// would otherwise leave the bot sitting in the channel indefinitely.
const MAX_PLAY_MS = 15 * 60 * 1000;
const READY_TIMEOUT_MS = 20_000;

/** guildId -> { connection, player, channelId, startedAt, timer } */
const sessions = new Map();

export function audioAvailable() {
  return fs.existsSync(AUDIO_PATH);
}

export function clipName() {
  return path.basename(AUDIO_PATH);
}

/** The saved default, clamped, as the 0–1 gain the mixer wants. */
export function gainFrom(config = get(), override = null) {
  const [min, max] = VOICE_LIMITS.volume;
  const raw = override ?? config.voice?.volume ?? 100;
  return Math.min(max, Math.max(min, Number(raw) || 0)) / 100;
}

function isVoiceChannel(channel) {
  return (
    channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice
  );
}

/** People, not bots — the bot's own presence must never count as an audience. */
export function humanCount(channel) {
  return channel.members.filter((m) => !m.user?.bot).size;
}

/**
 * Where to play: the caller's own channel if they are in one, otherwise the
 * busiest occupied channel in the guild. Null means nobody is in voice, which
 * is the case where playing would be shouting into an empty room.
 */
export function pickChannel(guild, member = null) {
  const own = member?.voice?.channel;
  if (isVoiceChannel(own)) return own;

  let best = null;
  let bestCount = 0;
  for (const channel of guild.channels.cache.values()) {
    if (!isVoiceChannel(channel)) continue;
    const count = humanCount(channel);
    if (count > bestCount) {
      best = channel;
      bestCount = count;
    }
  }
  return best;
}

function missingPermissions(channel, me) {
  const perms = channel.permissionsFor(me);
  return [
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.Connect, 'Connect'],
    [PermissionFlagsBits.Speak, 'Speak']
  ]
    .filter(([flag]) => !perms?.has(flag))
    .map(([, name]) => name);
}

export function status(guildId) {
  const session = sessions.get(guildId);
  return {
    available: audioAvailable(),
    playing: Boolean(session),
    channelId: session?.channelId ?? null,
    startedAt: session?.startedAt ?? null
  };
}

/**
 * Tears a session down whatever killed it, and never throws doing so.
 *
 * `only` pins the teardown to one specific session. Handlers on a dead
 * connection can fire seconds late — the disconnect race waits 5s to see if it
 * is a channel move — and by then the guild may already be playing a *new*
 * clip. Without this check that stale handler would stop the wrong one.
 */
function end(guildId, only = null) {
  const session = sessions.get(guildId);
  if (!session || (only && session !== only)) return false;
  sessions.delete(guildId);
  clearTimeout(session.timer);
  try {
    session.player.stop(true);
  } catch {
    /* already dead */
  }
  try {
    session.connection.destroy();
  } catch {
    /* already destroyed */
  }
  return true;
}

export function stop(guildId) {
  return end(guildId);
}

export function stopAll() {
  for (const guildId of [...sessions.keys()]) end(guildId);
}

/**
 * Joins and starts the clip. Resolves as soon as audio is flowing rather than
 * when it finishes — the clip outlives any interaction Discord will wait for,
 * so the rest plays out in the background and the bot leaves on its own.
 *
 * @returns {Promise<{ok: boolean, reason?: string, channel?: object, missing?: string[]}>}
 */
export async function play(guild, { member = null, volume = null } = {}) {
  if (!audioAvailable()) return { ok: false, reason: 'missing' };

  const channel = pickChannel(guild, member);
  if (!channel) return { ok: false, reason: 'empty' };

  const me = await guild.members.fetchMe();
  const missing = missingPermissions(channel, me);
  if (missing.length) return { ok: false, reason: 'permissions', channel, missing };

  // One clip per guild. Restarting beats overlapping two copies of itself.
  end(guild.id);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    // Nothing here listens, and joining undeafened makes the bot look like it
    // might be recording the channel.
    selfDeaf: true
  });

  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
  const session = {
    connection,
    player,
    channelId: channel.id,
    startedAt: new Date().toISOString(),
    timer: null
  };
  session.timer = setTimeout(() => end(guild.id, session), MAX_PLAY_MS);
  sessions.set(guild.id, session);

  // Every one of these means this clip is over or unrecoverable. They are all
  // pinned to `session`, so a late one cannot stop a clip started since.
  player.on(AudioPlayerStatus.Idle, () => end(guild.id, session));
  player.on('error', (err) => {
    console.error('[voice] playback failed:', err.message);
    end(guild.id, session);
  });
  connection.on('error', (err) => {
    console.error('[voice] connection error:', err.message);
    end(guild.id, session);
  });
  // A disconnect is ambiguous: being moved between channels looks the same as
  // being kicked out. Give the reconnect a moment before giving up.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
    } catch {
      end(guild.id, session);
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);

    const resource = createAudioResource(fs.createReadStream(AUDIO_PATH), {
      inputType: StreamType.Arbitrary,
      // Required for setVolume: gain is applied to PCM, before the opus encoder.
      inlineVolume: true
    });
    resource.volume.setVolume(gainFrom(get(), volume));

    connection.subscribe(player);
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, 10_000);
  } catch (err) {
    end(guild.id, session);
    return { ok: false, reason: 'failed', channel, error: err.message };
  }

  return { ok: true, channel };
}
