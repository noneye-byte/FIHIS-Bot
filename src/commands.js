import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  MessageFlags
} from 'discord.js';
import { get, update, DEFAULTS } from './store.js';
import * as poller from './poller.js';
import * as xapi from './sources/xapi.js';
import * as rss from './sources/rss.js';

export const command = new SlashCommandBuilder()
  .setName('fihas')
  .setDescription('Control the FIHAS tweet watcher')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('status').setDescription('Show watcher status and last activity'))
  .addSubcommand((s) => s.setName('check').setDescription('Poll for new posts right now'))
  .addSubcommand((s) =>
    s
      .setName('latest')
      .setDescription('Post the most recent tweet to the channel, even if already seen')
      .addBooleanOption((o) =>
        o.setName('ping').setDescription('Include the configured pings (default: false)')
      )
  )
  .addSubcommand((s) => s.setName('pause').setDescription('Stop posting new tweets'))
  .addSubcommand((s) => s.setName('resume').setDescription('Resume posting new tweets'))
  .addSubcommand((s) => s.setName('settings').setDescription('Dump the full configuration'))
  .addSubcommand((s) =>
    s
      .setName('test')
      .setDescription('Try every configured source and report which ones work')
  )
  .addSubcommandGroup((g) =>
    g
      .setName('channel')
      .setDescription('Where tweets get posted')
      .addSubcommand((s) =>
        s
          .setName('set')
          .setDescription('Set the destination channel')
          .addChannelOption((o) =>
            o
              .setName('channel')
              .setDescription('Channel to post in')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(true)
          )
      )
  )
  .addSubcommandGroup((g) =>
    g
      .setName('ping')
      .setDescription('Who gets pinged')
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Add a role or user to the ping list')
          .addRoleOption((o) => o.setName('role').setDescription('Role to ping'))
          .addUserOption((o) => o.setName('user').setDescription('User to ping'))
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove a role or user from the ping list')
          .addRoleOption((o) => o.setName('role').setDescription('Role to stop pinging'))
          .addUserOption((o) => o.setName('user').setDescription('User to stop pinging'))
      )
      .addSubcommand((s) => s.setName('list').setDescription('Show the ping list'))
      .addSubcommand((s) => s.setName('clear').setDescription('Remove everyone from the ping list'))
      .addSubcommand((s) =>
        s
          .setName('everyone')
          .setDescription('Toggle @everyone on new posts')
          .addBooleanOption((o) =>
            o.setName('enabled').setDescription('Ping @everyone?').setRequired(true)
          )
      )
  )
  .addSubcommandGroup((g) =>
    g
      .setName('source')
      .setDescription('Where tweets are read from')
      .addSubcommand((s) =>
        s
          .setName('mode')
          .setDescription('Choose the fetch strategy')
          .addStringOption((o) =>
            o
              .setName('mode')
              .setDescription('auto tries the X API then falls back to RSS')
              .setRequired(true)
              .addChoices(
                { name: 'auto (X API, then RSS)', value: 'auto' },
                { name: 'xapi (official X API only)', value: 'xapi' },
                { name: 'rss (RSS mirrors only)', value: 'rss' }
              )
          )
      )
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Add an RSS feed URL to the fallback chain')
          .addStringOption((o) =>
            o.setName('url').setDescription('RSS feed URL').setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove an RSS feed URL')
          .addStringOption((o) =>
            o.setName('url').setDescription('RSS feed URL').setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((s) => s.setName('list').setDescription('Show the source chain'))
  )
  .addSubcommandGroup((g) =>
    g
      .setName('set')
      .setDescription('Tune the watcher')
      .addSubcommand((s) =>
        s
          .setName('interval')
          .setDescription('Seconds between checks (minimum 30)')
          .addIntegerOption((o) =>
            o
              .setName('seconds')
              .setDescription('Polling interval')
              .setRequired(true)
              .setMinValue(30)
              .setMaxValue(86400)
          )
      )
      .addSubcommand((s) =>
        s
          .setName('handle')
          .setDescription('Which X account to watch')
          .addStringOption((o) =>
            o.setName('handle').setDescription('Handle without the @').setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName('filter')
          .setDescription('Include or exclude a post type')
          .addStringOption((o) =>
            o
              .setName('type')
              .setDescription('Which post type')
              .setRequired(true)
              .addChoices(
                { name: 'retweets', value: 'retweets' },
                { name: 'replies', value: 'replies' },
                { name: 'quotes', value: 'quotes' }
              )
          )
          .addBooleanOption((o) =>
            o.setName('enabled').setDescription('Post them?').setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName('link')
          .setDescription('Which embed-fixing mirror to link')
          .addStringOption((o) =>
            o
              .setName('style')
              .setDescription('Link style')
              .setRequired(true)
              .addChoices(
                { name: 'fxtwitter.com', value: 'fxtwitter' },
                { name: 'vxtwitter.com', value: 'vxtwitter' }
              )
          )
      )
      .addSubcommand((s) =>
        s
          .setName('template')
          .setDescription('Message template. Placeholders: {pings} {handle} {link} {text}')
          .addStringOption((o) =>
            o.setName('template').setDescription('Leave empty to reset to default')
          )
      )
  );

const COLOR = 0x1d9bf0;

function fmtTime(iso) {
  if (!iso) return 'never';
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;
}

function describePings(config) {
  const parts = [];
  if (config.mentionEveryone) parts.push('@everyone');
  for (const p of config.pings) parts.push(p.type === 'user' ? `<@${p.id}>` : `<@&${p.id}>`);
  return parts.length ? parts.join(', ') : '_nobody_';
}

export async function handle(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  const key = group ? `${group}.${sub}` : sub;

  switch (key) {
    case 'status':
      return handleStatus(interaction);
    case 'check':
      return handleCheck(interaction);
    case 'latest':
      return handleLatest(interaction);
    case 'pause':
    case 'resume':
      return handlePauseResume(interaction, key === 'pause');
    case 'settings':
      return handleSettings(interaction);
    case 'test':
      return handleTest(interaction);
    case 'channel.set':
      return handleChannelSet(interaction);
    case 'ping.add':
    case 'ping.remove':
      return handlePingChange(interaction, sub === 'add');
    case 'ping.list':
      return reply(interaction, `Currently pinging: ${describePings(get())}`);
    case 'ping.clear':
      await update((c) => {
        c.pings = [];
        c.mentionEveryone = false;
      });
      return reply(interaction, 'Ping list cleared. New posts will not ping anyone.');
    case 'ping.everyone':
      return handlePingEveryone(interaction);
    case 'source.mode':
      return handleSourceMode(interaction);
    case 'source.add':
    case 'source.remove':
      return handleSourceChange(interaction, sub === 'add');
    case 'source.list':
      return handleSourceList(interaction);
    case 'set.interval':
      return handleSetInterval(interaction);
    case 'set.handle':
      return handleSetHandle(interaction);
    case 'set.filter':
      return handleSetFilter(interaction);
    case 'set.link':
      return handleSetLink(interaction);
    case 'set.template':
      return handleSetTemplate(interaction);
    default:
      return reply(interaction, `Unknown command: \`${key}\``);
  }
}

function reply(interaction, content, { ephemeral = true } = {}) {
  const payload = { content, flags: ephemeral ? MessageFlags.Ephemeral : undefined };
  return interaction.replied || interaction.deferred
    ? interaction.editReply({ content })
    : interaction.reply(payload);
}

async function handleStatus(interaction) {
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
      { name: 'Pinging', value: describePings(config) }
    );

  if (config.lastError) {
    embed.addFields({ name: '⚠️ Last error', value: `\`\`\`${config.lastError.slice(0, 900)}\`\`\`` });
  }
  if (p.consecutiveFailures > 0) {
    embed.setFooter({ text: `${p.consecutiveFailures} consecutive failure(s), backing off` });
  }

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleCheck(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await poller.checkNow({ force: true });
    if (result.bootstrap) {
      return interaction.editReply(
        `Bootstrapped: recorded ${result.skipped} existing post(s) from \`${result.sourceUsed}\` without posting. New posts from here on will be announced.`
      );
    }
    const bits = [`Checked via \`${result.sourceUsed}\`.`];
    bits.push(result.posted.length ? `Posted ${result.posted.length} new tweet(s).` : 'Nothing new.');
    if (result.skipped) bits.push(`${result.skipped} filtered out.`);
    return interaction.editReply(bits.join(' '));
  } catch (err) {
    return interaction.editReply(`Check failed:\n\`\`\`${err.message.slice(0, 1800)}\`\`\``);
  }
}

async function handleLatest(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const config = get();
  const withPing = interaction.options.getBoolean('ping') ?? false;
  try {
    const { tweets, sourceUsed } = await poller.fetchFromSources(config);
    if (!tweets.length) return interaction.editReply('That source returned no posts.');

    const tweet = tweets[0];
    if (withPing) {
      await poller.postTweet(config, tweet);
    } else {
      // Reuse the posting path but with pings stripped, so /latest can be used
      // as a "show me the link" without waking the whole server.
      await poller.postTweet({ ...config, pings: [], mentionEveryone: false }, tweet);
    }
    return interaction.editReply(
      `Posted the latest tweet (\`${tweet.id}\`, via \`${sourceUsed}\`)${withPing ? ' with pings' : ' without pings'}.`
    );
  } catch (err) {
    return interaction.editReply(`Failed:\n\`\`\`${err.message.slice(0, 1800)}\`\`\``);
  }
}

async function handlePauseResume(interaction, paused) {
  await update((c) => {
    c.paused = paused;
  });
  if (!paused) poller.restart();
  return reply(
    interaction,
    paused
      ? '⏸️ Paused. Polling stops entirely, so anything posted while paused will be announced when you resume.'
      : '▶️ Resumed. Next check is scheduled.'
  );
}

async function handleSettings(interaction) {
  const config = get();
  const redacted = { ...config, seen: `[${config.seen.length} ids]` };
  const json = JSON.stringify(redacted, null, 2);
  const body =
    json.length > 1900
      ? `\`\`\`json\n${json.slice(0, 1900)}\n… truncated\n\`\`\``
      : `\`\`\`json\n${json}\n\`\`\``;
  return interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
}

async function handleTest(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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

  for (const url of config.source.rssUrls) {
    try {
      const tweets = await rss.fetchTweets(config.handle, { url });
      lines.push(`✅ \`${url}\` — ${tweets.length} post(s), newest \`${tweets[0].id}\``);
    } catch (err) {
      lines.push(`❌ \`${url}\` — ${err.message}`);
    }
  }

  return interaction.editReply(lines.join('\n').slice(0, 1900) || 'No sources configured.');
}

async function handleChannelSet(interaction) {
  const channel = interaction.options.getChannel('channel');
  const me = await interaction.guild.members.fetchMe();
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.ViewChannel)) {
    return reply(
      interaction,
      `I can't post in <#${channel.id}> — grant me **View Channel** and **Send Messages** there first.`
    );
  }
  await update((c) => {
    c.channelId = channel.id;
  });
  return reply(interaction, `New posts will go to <#${channel.id}>.`);
}

async function handlePingChange(interaction, adding) {
  const role = interaction.options.getRole('role');
  const user = interaction.options.getUser('user');
  if (!role && !user) return reply(interaction, 'Give me a role or a user to add.');

  const targets = [];
  if (role) targets.push({ type: 'role', id: role.id });
  if (user) targets.push({ type: 'user', id: user.id });

  await update((c) => {
    for (const t of targets) {
      const idx = c.pings.findIndex((p) => p.type === t.type && p.id === t.id);
      if (adding && idx === -1) c.pings.push(t);
      if (!adding && idx !== -1) c.pings.splice(idx, 1);
    }
  });

  return reply(
    interaction,
    `${adding ? 'Added' : 'Removed'}. Now pinging: ${describePings(get())}`
  );
}

async function handlePingEveryone(interaction) {
  const enabled = interaction.options.getBoolean('enabled');
  if (enabled) {
    const me = await interaction.guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.MentionEveryone)) {
      return reply(
        interaction,
        "I don't have **Mention @everyone** permission, so that ping would silently do nothing. Grant it first."
      );
    }
  }
  await update((c) => {
    c.mentionEveryone = enabled;
  });
  return reply(interaction, `@everyone pings are now **${enabled ? 'on' : 'off'}**.`);
}

async function handleSourceMode(interaction) {
  const mode = interaction.options.getString('mode');
  await update((c) => {
    c.source.mode = mode;
  });
  const note =
    mode === 'xapi' && !process.env.X_BEARER_TOKEN
      ? '\n⚠️ `X_BEARER_TOKEN` is not set, so this mode will fail until you add it to the container.'
      : '';
  poller.restart();
  return reply(interaction, `Source mode set to \`${mode}\`.${note}`);
}

async function handleSourceChange(interaction, adding) {
  const url = interaction.options.getString('url').trim();
  if (adding && !/^https?:\/\//i.test(url)) {
    return reply(interaction, 'That does not look like an http(s) URL.');
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
  if (!changed) return reply(interaction, adding ? 'That URL is already in the list.' : 'That URL was not in the list.');
  return reply(
    interaction,
    `${adding ? 'Added' : 'Removed'} \`${url}\`. Run \`/fihas test\` to check it.`
  );
}

async function handleSourceList(interaction) {
  const config = get();
  const lines = [`**Mode:** \`${config.source.mode}\``];
  lines.push(
    `**X API:** ${process.env.X_BEARER_TOKEN ? 'token present' : '_no token — will be skipped_'}`
  );
  lines.push('**RSS chain (tried in order):**');
  lines.push(
    config.source.rssUrls.length
      ? config.source.rssUrls.map((u, i) => `${i + 1}. \`${u}\``).join('\n')
      : '_empty_'
  );
  return reply(interaction, lines.join('\n').slice(0, 1900));
}

async function handleSetInterval(interaction) {
  const seconds = interaction.options.getInteger('seconds');
  await update((c) => {
    c.intervalSeconds = seconds;
  });
  poller.restart();
  return reply(interaction, `Now checking every **${seconds}s**.`);
}

async function handleSetHandle(interaction) {
  const handle = interaction.options.getString('handle').replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    return reply(interaction, 'That is not a valid X handle.');
  }
  const config = get();
  const previous = config.handle;
  await update((c) => {
    c.handle = handle;
    if (previous.toLowerCase() !== handle.toLowerCase()) {
      // Different account means the seen-list and high-water mark are
      // meaningless; re-bootstrap so we don't dump their backlog.
      c.seen = [];
      c.highWaterMark = null;
      c.bootstrapped = false;
      c.source.rssUrls = c.source.rssUrls.map((u) =>
        u.replace(new RegExp(previous, 'gi'), handle)
      );
    }
  });
  poller.restart();
  return reply(
    interaction,
    `Now watching **@${handle}**. RSS URLs containing \`${previous}\` were rewritten — check them with \`/fihas source list\`. The next check will re-bootstrap without posting the backlog.`
  );
}

async function handleSetFilter(interaction) {
  const type = interaction.options.getString('type');
  const enabled = interaction.options.getBoolean('enabled');
  await update((c) => {
    c.filters[type] = enabled;
  });
  return reply(interaction, `${type} will now be **${enabled ? 'posted' : 'ignored'}**.`);
}

async function handleSetLink(interaction) {
  const style = interaction.options.getString('style');
  await update((c) => {
    c.linkStyle = style;
  });
  return reply(interaction, `Links will use **${style === 'vxtwitter' ? 'vxtwitter.com' : 'fxtwitter.com'}**.`);
}

async function handleSetTemplate(interaction) {
  const template = interaction.options.getString('template');
  await update((c) => {
    c.messageTemplate = template?.trim() || DEFAULTS.messageTemplate;
  });
  const preview = poller
    .buildLink(get(), { handle: get().handle, id: '1234567890123456789' });
  const rendered = get()
    .messageTemplate.replaceAll('{pings}', describePings(get()))
    .replaceAll('{handle}', get().handle)
    .replaceAll('{link}', preview)
    .replaceAll('{text}', '(tweet text)');
  return reply(interaction, `Template ${template ? 'updated' : 'reset'}. Preview:\n\n${rendered}`);
}

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'url') return interaction.respond([]);
  const urls = get().source.rssUrls.filter((u) =>
    u.toLowerCase().includes(focused.value.toLowerCase())
  );
  return interaction.respond(urls.slice(0, 25).map((u) => ({ name: u.slice(0, 100), value: u })));
}
