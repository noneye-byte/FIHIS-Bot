import os from 'node:os';
import { Client, GatewayIntentBits, Events, REST, Routes, MessageFlags } from 'discord.js';
import * as store from './store.js';
import * as poller from './poller.js';
import * as web from './web/server.js';
import * as rsshub from './rsshub.js';
import * as voice from './voice.js';
import { syncAvatar } from './avatar.js';
import { command, handle as handleCommand } from './commands.js';
import { handleMessage } from './prefix.js';
import { setMessageIntent, setFault } from './runtime.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const HEALTH_PORT = Number.parseInt(process.env.HEALTH_PORT || '8080', 10);

const config = await store.load();

/* ------------------------------------------------------------ bundled rsshub */

// Started before Discord so it has a head start on its own boot; the poller
// falls through to the other feeds until it answers.
rsshub.configure({ authToken: config.twitterAuthToken });
rsshub.start();

/* ------------------------------------------------------------ web server */

// Started before Discord and never stopped on a Discord failure. The setup UI
// is the only diagnostic an Unraid admin has without opening the container log,
// so a bad token must not take it offline — that turns one broken setting into
// "the WebUI is gone", which is a much harder thing to debug.
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

let client = null;
// Reading message text needs a privileged intent, so it is only requested when
// prefix commands are actually turned on.
let wantMessageContent = config.prefixEnabled;

function buildClient(withMessageContent) {
  // GuildVoiceStates is not privileged, but without it discord.js never caches
  // who is in which voice channel, so `play` would think every channel is empty.
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
  if (withMessageContent) {
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  }

  const c = new Client({ intents });
  poller.attach(c);
  web.attach(c);

  c.once(Events.ClientReady, onReady);
  c.on(Events.InteractionCreate, onInteraction);
  c.on(Events.MessageCreate, (message) => {
    handleMessage(message).catch((err) => console.error('[prefix] handler failed:', err));
  });
  c.on(Events.Error, (err) => console.error('[discord] client error:', err.message));
  return c;
}

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

async function onReady(c) {
  console.log(`[discord] logged in as ${c.user.tag}`);
  c.user.setPresence({ activities: [{ name: `@${store.get().handle}`, type: 3 }], status: 'online' });

  await syncAvatar(c);

  try {
    await registerCommands();
  } catch (err) {
    console.error('[discord] failed to register slash commands:', err.message);
    console.error(
      `[discord] text commands still work — try "${store.get().prefix} status" in a channel.`
    );
  }

  const cfg = store.get();
  if (cfg.prefixEnabled && wantMessageContent) {
    console.log(`[discord] text commands enabled — try "${cfg.prefix} help"`);
  }

  if (!cfg.setupCompleted) {
    console.log(`[setup] not configured yet — open ${uiUrl} to finish setup`);
  }
  poller.start();
}

async function onInteraction(interaction) {
  try {
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
}

/* ------------------------------------------------------------- lifecycle */

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[app] ${signal} received, shutting down`);
    poller.stop();
    // Leave voice before the gateway goes away, or the bot lingers as a ghost
    // member of the channel until Discord times the session out.
    voice.stopAll();
    rsshub.stop();
    await closeServer();
    await store.save();
    await client?.destroy();
    process.exit(0);
  });
}

process.on('unhandledRejection', (err) => console.error('[app] unhandled rejection:', err));

/* ----------------------------------------------------------------- login */

async function login() {
  client = buildClient(wantMessageContent);
  try {
    await client.login(TOKEN);
    setMessageIntent(wantMessageContent ? 'active' : 'off');
    return;
  } catch (err) {
    if (err.code !== 'DisallowedIntents' || !wantMessageContent) throw err;
  }

  // Prefix commands are opt-out, so a portal that has not granted the Message
  // Content intent must not stop the bot from starting at all: log what to fix
  // and come up without it. /fihas and the web UI are unaffected.
  console.error(
    'Discord refused the Message Content intent, which text-prefix commands need.\n' +
      '  Enable it at https://discord.com/developers/applications\n' +
      '    -> your app -> Bot -> Privileged Gateway Intents -> MESSAGE CONTENT INTENT\n' +
      '  then restart this container. Starting without it: /fihas and the web UI still work.'
  );
  setMessageIntent('denied');
  await client.destroy().catch(() => {});
  wantMessageContent = false;
  client = buildClient(false);
  await client.login(TOKEN);
}

// A Discord problem is a configuration problem, and the container is where the
// configuration gets fixed. Exiting here used to take the setup UI down with it,
// so the one page that could explain the failure disappeared exactly when it was
// needed — and on Unraid the container then restart-looped, which reads as "the
// WebUI stopped working" rather than "the token is wrong". Record the fault,
// leave the UI serving, and let /healthz report unhealthy.
if (!TOKEN || !CLIENT_ID) {
  const missing = [!TOKEN && 'DISCORD_TOKEN', !CLIENT_ID && 'DISCORD_CLIENT_ID']
    .filter(Boolean)
    .join(' and ');
  console.error(
    `${missing} ${!TOKEN && !CLIENT_ID ? 'are' : 'is'} not set — the bot cannot reach Discord.\n` +
      '  Get them from https://discord.com/developers/applications\n' +
      '  - DISCORD_TOKEN     : Bot -> Reset Token\n' +
      '  - DISCORD_CLIENT_ID : General Information -> Application ID\n' +
      `  On Unraid: Docker -> FIHAS-Bot -> Edit. The setup UI stays up on ${uiUrl}`
  );
  setFault('MissingCredentials', `${missing} not set on the container.`);
} else {
  try {
    await login();
  } catch (err) {
    // A bad token is the most common setup mistake, and on Unraid the container
    // log is the second place anyone will look after the UI itself.
    if (err.code === 'TokenInvalid') {
      console.error(
        'Discord rejected DISCORD_TOKEN.\n' +
          '  - Copy it from the Developer Portal under Bot -> Reset Token.\n' +
          '  - It is NOT the Application ID and NOT the client secret.\n' +
          '  - Resetting the token in the portal invalidates the old one.'
      );
      setFault('TokenInvalid', 'Discord rejected DISCORD_TOKEN. Reset it in the Developer Portal.');
    } else if (err.code === 'DisallowedIntents') {
      console.error('Discord rejected the gateway intents. Update the bot to the latest image.');
      setFault('DisallowedIntents', 'Discord rejected the gateway intents. Update the image.');
    } else {
      console.error('Could not connect to Discord:', err.message);
      setFault(err.code || 'LoginFailed', `Could not connect to Discord: ${err.message}`);
    }
    // discord.js keeps async handles open after a failed login; drop the client
    // so nothing retries against it behind our back, and unhook the modules
    // still holding a reference to the dead one.
    await client?.destroy().catch(() => {});
    client = null;
    poller.attach(null);
    web.attach(null);
    poller.stop();
    console.error(`[app] staying up so the setup UI is still reachable on ${uiUrl}`);
  }
}
