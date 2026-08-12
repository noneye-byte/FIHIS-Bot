import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { get, update, PREFIX_RE, VOICE_LIMITS, isFeedEnabled } from './store.js';
import * as poller from './poller.js';
import * as rsshub from './rsshub.js';
import * as voice from './voice.js';
import * as xapi from './sources/xapi.js';
import * as rss from './sources/rss.js';
import { runtime } from './runtime.js';

/**
 * Every command the bot understands, expressed once.
 *
 * Each action returns a message payload ({ content } or { embeds }) rather than
 * touching Discord itself, so the slash commands in commands.js and the prefix
 * commands in prefix.js share one implementation and can never drift apart.
 *
 * Only the Discord-side settings are here — channel, pings and the text-command
 * prefix — alongside the run controls and the read-only views. The watcher's own
 * configuration is edited exclusively in the web UI; webOnly() below is what the
 * commands that used to change it now answer.
 */

const COLOR = 0x1d9bf0;

function text(content) {
  return { content };
}

/** The answer for a setting that only the web UI owns. */
export function webOnly(what) {
  return text(
    `${what ? `\`${what}\` moved to the web UI. ` : ''}Server settings — the watched account, ` +
      'poll interval, sources and RSS feeds, post filters, link style and message template — are ' +
      'changed there (the container maps it to port `8080`). Discord keeps the channel, the ping ' +
      'list, the command prefix, and `pause`/`resume`.'
  );
}

function fmtTime(iso) {
  if (!iso) return 'never';
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;
}

/** "**A**", "**A** and **B**", "**A**, **B** and **C**". */
function listOf(items) {
  const bold = items.map((i) => `**${i}**`);
  if (bold.length < 2) return bold.join('');
  return `${bold.slice(0, -1).join(', ')} and ${bold.at(-1)}`;
}

export function describePings(config) {
  const parts = [];
  if (config.mentionEveryone) parts.push('@everyone');
  for (const p of config.pings) parts.push(p.type === 'user' ? `<@${p.id}>` : `<@&${p.id}>`);
  return parts.length ? parts.join(', ') : '_nobody_';
}

/* -------------------------------------------------------------- read-only */

/** @param {string|null} guildId whose voice state to report, when asked from one */
export function status(guildId = null) {
  const config = get();
  const p = poller.status();
  const embed = new EmbedBuilder()
    .setColor(config.paused ? 0x99aab5 : COLOR)
    .setTitle(`FIHAS Bot — watching @${config.handle}`)
    .addFields(
      { name: 'State', value: config.paused ? '⏸️ Paused' : '▶️ Running', inline: true },
      { name: 'Interval', value: `${config.intervalSeconds}s`, inline: true },
      {
        name: 'Channel',
        value: config.channelId ? `<#${config.channelId}>` : '⚠️ _not set_',
        inline: true
      },
      { name: 'Last check', value: fmtTime(config.lastCheckAt), inline: true },
      { name: 'Last post', value: fmtTime(config.lastPostAt), inline: true },
      { name: 'Source used', value: config.lastSourceUsed ?? '_none yet_', inline: true },
      { name: 'Pinging', value: describePings(config) },
      { name: 'Commands', value: describeCommandModes(config), inline: true }
    );

  const hub = rsshub.status();
  if (hub.bundled) {
    embed.addFields({
      name: 'Built-in RSSHub',
      value: !hub.enabled ? '⚪ disabled' : hub.ready ? `✅ ready on port ${hub.port}` : '⏳ starting',
      inline: true
    });
  }

  const audio = voice.status(guildId ?? config.guildId);
  if (audio.playing) {
    embed.addFields({ name: 'Voice', value: `🔊 playing in <#${audio.channelId}>`, inline: true });
  }

  if (config.lastError) {
    embed.addFields({ name: '⚠️ Last error', value: `\`\`\`${config.lastError.slice(0, 900)}\`\`\`` });
  }
  if (p.consecutiveFailures > 0) {
    embed.setFooter({ text: `${p.consecutiveFailures} consecutive failure(s), backing off` });
  }

  return { embeds: [embed] };
}

function describeCommandModes(config) {
  const parts = ['`/fihas`'];
  if (config.prefixEnabled) {
    parts.push(runtime.messageIntent === 'active' ? `\`${config.prefix}\`` : `\`${config.prefix}\` ⚠️`);
  }
  return parts.join(' · ');
}

export function pingList() {
  return text(`Currently pinging: ${describePings(get())}`);
}

/* ------------------------------------------------------------ slow / live */

export async function check() {
  try {
    const result = await poller.checkNow({ force: true });
    if (result.bootstrap) {
      return text(
        `Bootstrapped: recorded ${result.skipped} existing post(s) from \`${result.sourceUsed}\` without posting. New posts from here on will be announced.`
      );
    }
    const bits = [`Checked via \`${result.sourceUsed}\`.`];
    bits.push(result.posted.length ? `Posted ${result.posted.length} new tweet(s).` : 'Nothing new.');
    if (result.skipped) bits.push(`${result.skipped} filtered out.`);
    return text(bits.join(' '));
  } catch (err) {
    return text(`Check failed:\n\`\`\`${err.message.slice(0, 1800)}\`\`\``);
  }
}

export async function latest({ ping = false } = {}) {
  const config = get();
  try {
    const { tweets, sourceUsed } = await poller.fetchFromSources(config);
    if (!tweets.length) return text('That source returned no posts.');

    const tweet = tweets[0];
    // Reuse the posting path but with pings stripped, so `latest` can be a
    // "show me the link" without waking the whole server.
    await poller.postTweet(ping ? config : { ...config, pings: [], mentionEveryone: false }, tweet);
    return text(
      `Posted the latest tweet (\`${tweet.id}\`, via \`${sourceUsed}\`)${ping ? ' with pings' : ' without pings'}.`
    );
  } catch (err) {
    return text(`Failed:\n\`\`\`${err.message.slice(0, 1800)}\`\`\``);
  }
}

export async function testSources() {
  const config = get();
  const lines = [];

  if (xapi.isConfigured()) {
    try {
      const tweets = await xapi.fetchTweets(config.handle, {});
      lines.push(`✅ \`xapi\` — ${tweets.length} post(s), newest \`${tweets[0]?.id ?? 'n/a'}\``);
    } catch (err) {
      lines.push(`❌ \`xapi\` — ${err.message}`);
    }
  } else {
    lines.push('⚪ `xapi` — no X_BEARER_TOKEN set, skipped');
  }

  let localFailed = false;
  const fetchOpts = rss.optionsFrom(config);
  for (const url of config.source.rssUrls) {
    const local = rsshub.isLocalUrl(url);
    const label = local ? `${url} (built-in RSSHub)` : url;
    if (!isFeedEnabled(config, url)) {
      lines.push(`⚪ \`${label}\` — disabled, skipped`);
      continue;
    }
    try {
      const tweets = await rss.fetchTweets(config.handle, { url, ...fetchOpts });
      lines.push(`✅ \`${label}\` — ${tweets.length} post(s), newest \`${tweets[0].id}\``);
    } catch (err) {
      lines.push(`❌ \`${label}\` — ${err.message}`);
      localFailed ||= local;
    }
  }
  // RSSHub answers 503 for every route failure, and for the X route that is
  // nearly always its `auth_token` cookie — absent, expired or refused.
  if (localFailed) {
    lines.push(
      process.env.TWITTER_AUTH_TOKEN
        ? '\nℹ️ The built-in RSSHub returns 503 when its X route fails, usually because the `TWITTER_AUTH_TOKEN` cookie has expired. Replace it with a fresh `auth_token` and restart the container.'
        : '\nℹ️ The built-in RSSHub needs `TWITTER_AUTH_TOKEN` (the `auth_token` cookie from a logged-in X session) before its X routes work — until then it answers 503.'
    );
  }

  return text(lines.join('\n').slice(0, 1900) || 'No sources configured.');
}

/* ----------------------------------------------------------------- voice */

/**
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember|null} member whoever asked, so their
 *   own channel wins over a busier one somewhere else in the server
 */
export async function playAudio(guild, member, { volume = null } = {}) {
  const [min, max] = VOICE_LIMITS.volume;
  if (volume !== null && (!Number.isFinite(volume) || volume < min || volume > max)) {
    return text(`Volume must be between ${min} and ${max}.`);
  }

  const result = await voice.play(guild, { member, volume });
  if (result.ok) {
    const level = Math.round(voice.gainFrom(get(), volume) * 100);
    return text(
      `🔊 Playing \`${voice.clipName()}\` in <#${result.channel.id}> at **${level}%**` +
        `${volume === null ? '' : ' (just this once)'}. Use \`stop\` to cut it short.`
    );
  }

  switch (result.reason) {
    case 'missing':
      return text(
        `\`${voice.clipName()}\` is not in this image, so there is nothing to play. Rebuild the container from a version that ships it.`
      );
    case 'empty':
      return text('Nobody is in a voice channel, so there is nobody to play it to.');
    case 'permissions':
      return text(
        `I can't play in <#${result.channel.id}> — grant me ${listOf(result.missing)} there first.`
      );
    default:
      return text(`Could not start playback:\n\`\`\`${String(result.error).slice(0, 1800)}\`\`\``);
  }
}

export function stopAudio(guild) {
  return text(
    voice.stop(guild.id) ? '⏹️ Stopped and left the voice channel.' : 'Nothing is playing.'
  );
}

/* ------------------------------------------------------------- mutations */

export async function pauseResume(paused) {
  await update((c) => {
    c.paused = paused;
  });
  if (!paused) poller.restart();
  return text(
    paused
      ? '⏸️ Paused. Polling stops entirely, so anything posted while paused will be announced when you resume.'
      : '▶️ Resumed. Next check is scheduled.'
  );
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildChannel} channel already resolved by the caller
 */
export async function setChannel(guild, channel) {
  if (!channel?.id) return text('I could not find that channel.');
  if (!channel.isTextBased?.()) return text(`<#${channel.id}> is not a text channel.`);

  const me = await guild.members.fetchMe();
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.ViewChannel)) {
    return text(
      `I can't post in <#${channel.id}> — grant me **View Channel** and **Send Messages** there first.`
    );
  }
  await update((c) => {
    c.channelId = channel.id;
  });
  return text(`New posts will go to <#${channel.id}>.`);
}

/** @param {Array<{type: 'role'|'user', id: string}>} targets */
export async function pingChange(adding, targets) {
  if (!targets.length) return text(`Give me a role or a user to ${adding ? 'add' : 'remove'}.`);

  await update((c) => {
    for (const t of targets) {
      const idx = c.pings.findIndex((p) => p.type === t.type && p.id === t.id);
      if (adding && idx === -1) c.pings.push(t);
      if (!adding && idx !== -1) c.pings.splice(idx, 1);
    }
  });

  return text(`${adding ? 'Added' : 'Removed'}. Now pinging: ${describePings(get())}`);
}

export async function pingClear() {
  await update((c) => {
    c.pings = [];
    c.mentionEveryone = false;
  });
  return text('Ping list cleared. New posts will not ping anyone.');
}

export async function pingEveryone(guild, enabled) {
  if (enabled) {
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.MentionEveryone)) {
      return text(
        "I don't have **Mention @everyone** permission, so that ping would silently do nothing. Grant it first."
      );
    }
  }
  await update((c) => {
    c.mentionEveryone = enabled;
  });
  return text(`@everyone pings are now **${enabled ? 'on' : 'off'}**.`);
}

export async function setPrefix(rawPrefix) {
  const prefix = String(rawPrefix ?? '').trim();
  if (!PREFIX_RE.test(prefix)) {
    return text(
      'A prefix must be 1–16 characters with no spaces, `@`, `#` or backticks. For example `!fihas`, `!f` or `fihas!`.'
    );
  }
  await update((c) => {
    c.prefix = prefix;
    c.prefixEnabled = true;
  });
  return text(
    `Prefix commands now answer to \`${prefix}\` — try \`${prefix} status\`.${intentWarning()}`
  );
}

export async function setPrefixEnabled(enabled) {
  const wasEnabled = get().prefixEnabled;
  await update((c) => {
    c.prefixEnabled = enabled;
  });
  if (!enabled) return text('Prefix commands are now **off**. `/fihas` still works.');
  return text(
    `Prefix commands are now **on** — try \`${get().prefix} status\`.${
      wasEnabled ? intentWarning() : intentWarning(true)
    }`
  );
}

/** Explains the Message Content intent when it is missing. */
function intentWarning(justEnabled = false) {
  if (runtime.messageIntent === 'active') return '';
  if (runtime.messageIntent === 'denied') {
    return '\n\n⚠️ Discord is not sending me message text. Enable **MESSAGE CONTENT INTENT** under Bot in the [Developer Portal](https://discord.com/developers/applications), then restart the container.';
  }
  if (justEnabled || runtime.messageIntent === 'off') {
    return '\n\n⚠️ Restart the container to apply — the message intent is only requested at startup.';
  }
  return '';
}

export function help(config = get()) {
  const p = config.prefix;
  return text(
    [
      `**FIHAS Bot — \`${p}\` commands**`,
      'Each of these also exists as a `/fihas` slash command.',
      '',
      '**Run controls**',
      `\`${p} status\` — state, interval, channel, last check/post/error`,
      `\`${p} pause\` · \`${p} resume\` — stop and start polling`,
      `\`${p} check\` — poll right now`,
      `\`${p} latest [ping]\` — post the newest tweet on demand`,
      `\`${p} test\` — try every source and report which work`,
      `\`${p} play [volume]\` — play the clip to whoever is in voice`,
      `\`${p} stop\` — stop the clip and leave voice`,
      '',
      '**Discord settings**',
      `\`${p} channel set #channel\` — where posts go`,
      `\`${p} ping add|remove @role\` · \`${p} ping list|clear\``,
      `\`${p} ping everyone on|off\``,
      `\`${p} prefix <new prefix>\` · \`${p} prefix on|off\``,
      '',
      '**In the web UI only** (port `8080`): the watched account, poll interval,',
      'source mode, RSS feeds and fetch tuning, post-type filters, link style,',
      'the message template, and the default playback volume.',
      '',
      'Requires **Manage Server**.'
    ].join('\n')
  );
}
