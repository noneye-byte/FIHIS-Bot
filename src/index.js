import os from 'node:os';
import { Client, GatewayIntentBits, Events, REST, Routes, MessageFlags } from 'discord.js';
import * as store from './store.js';
import * as poller from './poller.js';
import * as web from './web/server.js';
import { syncAvatar } from './avatar.js';
import { command, handle as handleCommand, autocomplete } from './commands.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const HEALTH_PORT = Number.parseInt(process.env.HEALTH_PORT || '8080', 10);

if (!TOKEN || !CLIENT_ID) {
  console.error(
    'DISCORD_TOKEN and DISCORD_CLIENT_ID are both required.\n' +
      '  Get them from https://discord.com/developers/applications\n' +
      '  - DISCORD_TOKEN     : Bot -> Reset Token\n' +
      '  - DISCORD_CLIENT_ID : General Information -> Application ID'
  );
  process.exit(1);
}

const config = await store.load();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
poller.attach(client);
web.attach(client);

/* ------------------------------------------------------------ web server */

const server = await web.createServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(HEALTH_PORT, '0.0.0.0', resolve);
});

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return 'localhost';
}

const uiUrl = `http://${lanAddress()}:${HEALTH_PORT}/`;
console.log(`[web] setup UI on ${uiUrl}`);
if (config.webPasswordGenerated) {
  const W = 62;
  const line = (s = '') => `  │ ${s.padEnd(W - 2)} │`;
  console.log(
    [
      '',
      '  ┌' + '─'.repeat(W) + '┐',
      line(),
      line('Setup UI password (generated).'),
      line('Set WEB_PASSWORD to choose your own.'),
      line(),
      line('    ' + config.webPassword),
      line(),
      '  └' + '─'.repeat(W) + '┘',
      ''
    ].join('\n')
  );
}

function closeServer() {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

/* -------------------------------------------------------------- discord */

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = [command.toJSON()];
  if (GUILD_ID) {
    // Guild commands appear instantly; global ones take up to an hour.
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
    console.log(`[discord] registered /fihas in guild ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log('[discord] registered /fihas globally (can take up to an hour to appear)');
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[discord] logged in as ${c.user.tag}`);
  c.user.setPresence({ activities: [{ name: `@${store.get().handle}`, type: 3 }], status: 'online' });

  await syncAvatar(c);

  try {
    await registerCommands();
  } catch (err) {
    console.error('[discord] failed to register slash commands:', err.message);
  }

  if (!store.get().setupCompleted) {
    console.log(`[setup] not configured yet — open ${uiUrl} to finish setup`);
  }
  poller.start();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await autocomplete(interaction);
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'fihas') return;
    if (!interaction.inGuild()) {
      return interaction.reply({
        content: 'Run this in a server, not a DM.',
        flags: MessageFlags.Ephemeral
      });
    }
    await handleCommand(interaction);
  } catch (err) {
    console.error('[discord] interaction failed:', err);
    const content = `Something broke: \`${String(err.message).slice(0, 300)}\``;
    if (interaction.isRepliable()) {
      await (interaction.replied || interaction.deferred
        ? interaction.editReply({ content })
        : interaction.reply({ content, flags: MessageFlags.Ephemeral })
      ).catch(() => {});
    }
  }
});

client.on(Events.Error, (err) => console.error('[discord] client error:', err.message));

/* ------------------------------------------------------------- lifecycle */

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[app] ${signal} received, shutting down`);
    poller.stop();
    await closeServer();
    await store.save();
    await client.destroy();
    process.exit(0);
  });
}

process.on('unhandledRejection', (err) => console.error('[app] unhandled rejection:', err));

try {
  await client.login(TOKEN);
} catch (err) {
  // A bad token is the most common setup mistake, and on Unraid the container
  // log is the only place anyone will see why the bot keeps restarting.
  if (err.code === 'TokenInvalid') {
    console.error(
      'Discord rejected DISCORD_TOKEN.\n' +
        '  - Copy it from the Developer Portal under Bot -> Reset Token.\n' +
        '  - It is NOT the Application ID and NOT the client secret.\n' +
        '  - Resetting the token in the portal invalidates the old one.'
    );
  } else if (err.code === 'DisallowedIntents') {
    console.error('Discord rejected the gateway intents. Update the bot to the latest image.');
  } else {
    console.error('Could not connect to Discord:', err.message);
  }
  // process.exit() while discord.js still holds an open async handle trips a
  // libuv assertion, so tear things down before exiting.
  await client.destroy().catch(() => {});
  poller.stop();
  await closeServer();
  process.exitCode = 1;
}
