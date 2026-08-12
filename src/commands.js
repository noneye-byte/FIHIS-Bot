import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags
} from 'discord.js';
import * as actions from './actions.js';

/**
 * The Discord command surface.
 *
 * Deliberately narrow: Discord owns the settings that only make sense inside
 * Discord — the destination channel, the ping list and the text-command prefix —
 * plus the run controls (pause, resume, and the on-demand checks). Everything
 * server-side (the watched handle, the poll interval, the source chain, filters,
 * link style and the message template) lives in the web UI alone, so there is
 * exactly one place those are changed and no second surface to keep in sync.
 */
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
  .addSubcommand((s) =>
    s.setName('test').setDescription('Try every configured source and report which ones work')
  )
  .addSubcommand((s) =>
    s
      .setName('play')
      .setDescription('Play the FIHAS clip to whoever is in voice chat')
      .addIntegerOption((o) =>
        o
          .setName('volume')
          .setDescription('Volume for this play only, as a percentage (default: the saved one)')
          .setMinValue(0)
          .setMaxValue(200)
      )
  )
  .addSubcommand((s) => s.setName('stop').setDescription('Stop the clip and leave voice'))
  .addSubcommand((s) =>
    s.setName('help').setDescription('List every command, including the text-prefix versions')
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
      .setName('prefix')
      .setDescription('Text commands, for when slash commands are unavailable')
      .addSubcommand((s) =>
        s
          .setName('set')
          .setDescription('Change the text-command prefix (e.g. !fihas)')
          .addStringOption((o) =>
            o.setName('prefix').setDescription('New prefix, no spaces').setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName('enabled')
          .setDescription('Turn text-prefix commands on or off')
          .addBooleanOption((o) =>
            o.setName('enabled').setDescription('Listen for the prefix?').setRequired(true)
          )
      )
  );

// Anything that hits the network gets deferred first — Discord kills an
// interaction that is not answered within three seconds, and joining a voice
// channel is a handshake of its own.
const SLOW = new Set(['check', 'latest', 'test', 'play']);

export async function handle(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  const key = group ? `${group}.${sub}` : sub;

  if (SLOW.has(key)) await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const payload = await run(interaction, key, sub);
  return interaction.deferred || interaction.replied
    ? interaction.editReply(payload)
    : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

function run(interaction, key, sub) {
  const opts = interaction.options;

  switch (key) {
    case 'status':
      return actions.status(interaction.guildId);
    case 'check':
      return actions.check();
    case 'latest':
      return actions.latest({ ping: opts.getBoolean('ping') ?? false });
    case 'pause':
    case 'resume':
      return actions.pauseResume(key === 'pause');
    case 'test':
      return actions.testSources();
    case 'play':
      return actions.playAudio(interaction.guild, interaction.member, {
        volume: opts.getInteger('volume')
      });
    case 'stop':
      return actions.stopAudio(interaction.guild);
    case 'help':
      return actions.help();
    case 'channel.set':
      return actions.setChannel(interaction.guild, opts.getChannel('channel'));
    case 'ping.add':
    case 'ping.remove': {
      const targets = [];
      const role = opts.getRole('role');
      const user = opts.getUser('user');
      if (role) targets.push({ type: 'role', id: role.id });
      if (user) targets.push({ type: 'user', id: user.id });
      return actions.pingChange(sub === 'add', targets);
    }
    case 'ping.list':
      return actions.pingList();
    case 'ping.clear':
      return actions.pingClear();
    case 'ping.everyone':
      return actions.pingEveryone(interaction.guild, opts.getBoolean('enabled'));
    case 'prefix.set':
      return actions.setPrefix(opts.getString('prefix'));
    case 'prefix.enabled':
      return actions.setPrefixEnabled(opts.getBoolean('enabled'));
    default:
      return { content: `Unknown command: \`${key}\`` };
  }
}
