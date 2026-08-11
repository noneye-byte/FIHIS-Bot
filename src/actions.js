import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { get, update, DEFAULTS, HANDLE_RE, PREFIX_RE } from './store.js';
import * as poller from './poller.js';
import * as rsshub from './rsshub.js';
import * as xapi from './sources/xapi.js';
import * as rss from './sources/rss.js';
import { runtime } from './runtime.js';

/**
 * Every command the bot understands, expressed once.
 *
 * Each action returns a message payload ({ content } or { embeds }) rather than
 * touching Discord itself, so the slash commands in commands.js and the prefix
 * commands in prefix.js share one implementation and can never drift apart.
 */

const COLOR = 0x1d9bf0;

function text(content) {
  return { content };
}

function fmtTime(iso) {
  if (!iso) return 'never';
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;
}

export function describePings(config) {
  const parts = [];
  if (config.mentionEveryone) parts.push('@everyone');
  for (const p of config.pings) parts.push(p.type === 'user' ? `<@${p.id}>` : `<@&${p.id}>`);
  return parts.length ? parts.join(', ') : '_nobody_';
}

/* -------------------------------------------------------------- read-only */

export function status() {
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

export function settings() {
  const config = get();
  const redacted = { ...config, seen: `[${config.seen.length} ids]`, webPassword: '[hidden]' };
  const json = JSON.stringify(redacted, null, 2);
  return text(
    json.length > 1900
      ? `\`\`\`json\n${json.slice(0, 1900)}\n… truncated\n\`\`\``
      : `\`\`\`json\n${json}\n\`\`\``
  );
}

export function pingList() {
  return text(`Currently pinging: ${describePings(get())}`);
}

export function sourceList() {
  const config = get();
  const hub = rsshub.status();
  const lines = [`**Mode:** \`${config.source.mode}\``];
  lines.push(
    `**X API:** ${process.env.X_BEARER_TOKEN ? 'token present' : '_no token — will be skipped_'}`
  );
  if (hub.bundled) {
    lines.push(
      `**Built-in RSSHub:** ${
        !hub.enabled
          ? '_disabled_'
          : hub.ready
            ? `running on \`${hub.url}\``
            : `_starting…_${hub.lastError ? ` (${hub.lastError})` : ''}`
      }`
    );
  }
  lines.push('**RSS chain (tried in order):**');
  lines.push(
    config.source.rssUrls.length
      ? config.source.rssUrls
          .map((u, i) => `${i + 1}. \`${u}\`${rsshub.isLocalUrl(u) ? ' _(built-in)_' : ''}`)
          .join('\n')
      : '_empty_'
  );
  return text(lines.join('\n').slice(0, 1900));
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
  for (const url of config.source.rssUrls) {
    const local = rsshub.isLocalUrl(url);
    const label = local ? `${url} (built-in RSSHub)` : url;
    try {
      const tweets = await rss.fetchTweets(config.handle, { url });
      lines.push(`✅ \`${label}\` — ${tweets.length} post(s), newest \`${tweets[0].id}\``);
    } catch (err) {
      lines.push(`❌ \`${label}\` — ${err.message}`);
      localFailed ||= local;
    }
  }
  // RSSHub answers "Twitter API is not configured" until it gets a session
  // cookie, which is not obvious from the HTTP error the feed parser sees.
  if (localFailed && !process.env.TWITTER_AUTH_TOKEN) {
    lines.push(
      '\nℹ️ The built-in RSSHub needs `TWITTER_AUTH_TOKEN` (the `auth_token` cookie from a logged-in X session) before its X routes work.'
    );
  }

  return text(lines.join('\n').slice(0, 1900) || 'No sources configured.');
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

export async function sourceMode(mode) {
  if (!['auto', 'xapi', 'rss'].includes(mode)) {
    return text('Mode must be `auto`, `xapi` or `rss`.');
  }
  await update((c) => {
    c.source.mode = mode;
  });
  const note =
    mode === 'xapi' && !process.env.X_BEARER_TOKEN
      ? '\n⚠️ `X_BEARER_TOKEN` is not set, so this mode will fail until you add it to the container.'
      : '';
  poller.restart();
  return text(`Source mode set to \`${mode}\`.${note}`);
}

export async function sourceChange(adding, rawUrl) {
  const url = String(rawUrl ?? '').trim();
  if (!url) return text('Give me a feed URL.');
  if (adding && !/^https?:\/\//i.test(url)) {
    return text('That does not look like an http(s) URL.');
  }
  let changed = false;
  await update((c) => {
    const idx = c.source.rssUrls.indexOf(url);
    if (adding && idx === -1) {
      c.source.rssUrls.push(url);
      changed = true;
    }
    if (!adding && idx !== -1) {
      c.source.rssUrls.splice(idx, 1);
      changed = true;
    }
  });
  if (!changed) {
    return text(adding ? 'That URL is already in the list.' : 'That URL was not in the list.');
  }
  return text(`${adding ? 'Added' : 'Removed'} \`${url}\`. Run \`test\` to check it.`);
}

export async function setInterval(rawSeconds) {
  const seconds = Number.parseInt(rawSeconds, 10);
  if (!Number.isFinite(seconds) || seconds < 30 || seconds > 86400) {
    return text('Interval must be a whole number of seconds between 30 and 86400.');
  }
  await update((c) => {
    c.intervalSeconds = seconds;
  });
  poller.restart();
  return text(`Now checking every **${seconds}s**.`);
}

export async function setHandle(rawHandle) {
  const handle = String(rawHandle ?? '').replace(/^@/, '').trim();
  if (!HANDLE_RE.test(handle)) return text('That is not a valid X handle.');

  const previous = get().handle;
  await update((c) => {
    c.handle = handle;
    if (previous.toLowerCase() !== handle.toLowerCase()) {
      // A different account makes the seen-list and high-water mark meaningless;
      // re-bootstrap so we don't dump their backlog.
      c.seen = [];
      c.highWaterMark = null;
      c.bootstrapped = false;
      c.source.rssUrls = c.source.rssUrls.map((u) => u.replace(new RegExp(previous, 'gi'), handle));
    }
  });
  poller.restart();
  return text(
    `Now watching **@${handle}**. RSS URLs containing \`${previous}\` were rewritten — check them with \`source list\`. The next check will re-bootstrap without posting the backlog.`
  );
}

export async function setFilter(type, enabled) {
  if (!['retweets', 'replies', 'quotes'].includes(type)) {
    return text('Type must be `retweets`, `replies` or `quotes`.');
  }
  await update((c) => {
    c.filters[type] = enabled;
  });
  return text(`${type} will now be **${enabled ? 'posted' : 'ignored'}**.`);
}

export async function setLink(style) {
  if (!['fxtwitter', 'vxtwitter'].includes(style)) {
    return text('Style must be `fxtwitter` or `vxtwitter`.');
  }
  await update((c) => {
    c.linkStyle = style;
  });
  return text(`Links will use **${style}.com**.`);
}

export async function setTemplate(template) {
  const trimmed = String(template ?? '').trim();
  if (trimmed && !trimmed.includes('{link}')) {
    return text('The template must include `{link}`, otherwise nothing links to the post.');
  }
  await update((c) => {
    c.messageTemplate = trimmed || DEFAULTS.messageTemplate;
  });
  const config = get();
  const preview = config.messageTemplate
    .replaceAll('{pings}', describePings(config))
    .replaceAll('{handle}', config.handle)
    .replaceAll('{link}', poller.buildLink(config, { handle: config.handle, id: '1234567890123456789' }))
    .replaceAll('{text}', '(tweet text)');
  return text(`Template ${trimmed ? 'updated' : 'reset'}. Preview:\n\n${preview}`);
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
      'Everything here also exists as `/fihas` slash commands and in the web UI.',
      '',
      `\`${p} status\` — state, interval, channel, last check/post/error`,
      `\`${p} check\` — poll right now`,
      `\`${p} latest [ping]\` — post the newest tweet on demand`,
      `\`${p} pause\` · \`${p} resume\` — stop and start polling`,
      `\`${p} test\` — try every source and report which work`,
      `\`${p} settings\` — dump the raw config`,
      `\`${p} channel set #channel\` — where posts go`,
      `\`${p} ping add|remove @role\` · \`${p} ping list|clear\``,
      `\`${p} ping everyone on|off\``,
      `\`${p} source mode auto|xapi|rss\` · \`${p} source add|remove <url>\` · \`${p} source list\``,
      `\`${p} set interval <seconds>\` · \`${p} set handle <handle>\``,
      `\`${p} set filter retweets|replies|quotes on|off\``,
      `\`${p} set link fxtwitter|vxtwitter\` · \`${p} set template <text>\``,
      `\`${p} set prefix <new prefix>\` · \`${p} set prefix off\``,
      '',
      'Requires **Manage Server**.'
    ].join('\n')
  );
}
