import { PermissionFlagsBits } from 'discord.js';
import { get } from './store.js';
import * as actions from './actions.js';

/**
 * Text-prefix commands — the fallback for servers where slash commands do not
 * show up (global registration lag, a missing `applications.commands` scope, or
 * an integration permission that hides them).
 *
 * Same actions, same permission requirement (Manage Server) as `/fihas`; the
 * only differences are that replies are public and that Discord must grant the
 * Message Content intent for the bot to read the text at all.
 *
 * The surface is the Discord-side one: run controls, the channel, the ping list
 * and the prefix itself. Server settings belong to the web UI, and the commands
 * that used to change them from here now point at it.
 */

// Never echo a mention out of a reply: several actions quote the ping list back,
// and a stray <@&id> in there would ping the whole role.
const SILENT = { parse: [], repliedUser: false };

const TRUE_WORDS = new Set(['on', 'true', 'yes', 'y', 'enable', 'enabled', '1']);
const FALSE_WORDS = new Set(['off', 'false', 'no', 'n', 'disable', 'disabled', '0']);

/**
 * Splits a message into command arguments if it is addressed to us.
 * @returns {{args: string[], rest: (n: number) => string}|null}
 */
export function parse(content, prefix) {
  const trimmed = String(content ?? '').trimStart();
  if (!prefix || !trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return null;

  const after = trimmed.slice(prefix.length);
  // A prefix ending in a word character must be followed by a space, so `!fihas`
  // does not swallow `!fihasburger`. One ending in punctuation may not be.
  if (after && !/^\s/.test(after) && /\w$/.test(prefix)) return null;

  const body = after.trim();
  const args = body.length ? body.split(/\s+/) : [];
  return {
    args,
    // Everything from argument n onwards, verbatim — templates keep their spacing.
    rest(n) {
      let out = body;
      for (let i = 0; i < n; i++) {
        const idx = out.search(/\s/);
        if (idx === -1) return '';
        out = out.slice(idx).trimStart();
      }
      return out;
    }
  };
}

function parseBool(word, fallback = null) {
  const value = String(word ?? '').toLowerCase();
  if (TRUE_WORDS.has(value)) return true;
  if (FALSE_WORDS.has(value)) return false;
  return fallback;
}

function resolveChannel(guild, token = '') {
  const id = token.match(/^<#(\d+)>$/)?.[1] ?? (/^\d{5,25}$/.test(token) ? token : null);
  if (id) return guild.channels.cache.get(id) ?? null;
  const name = token.replace(/^#/, '').toLowerCase();
  return guild.channels.cache.find((ch) => ch.name?.toLowerCase() === name) ?? null;
}

/** Turns `@role` / `@user` mentions or raw IDs into ping-list entries. */
function resolvePingTargets(guild, tokens) {
  const targets = [];
  for (const token of tokens) {
    const roleId = token.match(/^<@&(\d+)>$/)?.[1];
    const userId = token.match(/^<@!?(\d+)>$/)?.[1];
    if (roleId) {
      targets.push({ type: 'role', id: roleId });
    } else if (userId) {
      targets.push({ type: 'user', id: userId });
    } else if (/^\d{5,25}$/.test(token)) {
      // A bare ID is far more often a role here, so prefer that reading.
      targets.push({ type: guild.roles.cache.has(token) ? 'role' : 'user', id: token });
    } else {
      const role = guild.roles.cache.find(
        (r) => r.name.toLowerCase() === token.replace(/^@/, '').toLowerCase()
      );
      if (role) targets.push({ type: 'role', id: role.id });
    }
  }
  return targets;
}

const UNKNOWN = (prefix, what) => ({
  content: `Unknown command \`${what}\`. Try \`${prefix} help\`.`
});

/**
 * Runs a parsed prefix command.
 * @param {import('discord.js').Guild} guild
 * @param {{args: string[], rest: (n: number) => string}} parsed
 * @param {import('discord.js').GuildMember|null} member whoever sent it, so
 *   `play` can prefer the voice channel they are already sitting in
 * @returns {Promise<object>} a message payload
 */
export async function dispatch(guild, parsed, member = null) {
  const config = get();
  const [head = '', ...tail] = parsed.args;
  const cmd = head.toLowerCase();
  const sub = (tail[0] ?? '').toLowerCase();

  switch (cmd) {
    case '':
    case 'help':
    case 'commands':
    case '?':
      return actions.help(config);
    case 'status':
      return actions.status(guild?.id ?? null);
    case 'check':
    case 'poll':
      return actions.check();
    case 'latest':
      return actions.latest({ ping: parseBool(tail[0], false) || sub === 'ping' });
    case 'pause':
      return actions.pauseResume(true);
    case 'resume':
    case 'unpause':
      return actions.pauseResume(false);
    case 'test':
      return actions.testSources();

    case 'play':
    case 'sound':
      // `play 40` sets the volume for this play only; anything else is ignored
      // rather than rejected, so `play loud` still plays.
      return actions.playAudio(guild, member, {
        volume: /^\d+$/.test(tail[0] ?? '') ? Number.parseInt(tail[0], 10) : null
      });
    case 'stop':
      return actions.stopAudio(guild);

    case 'channel': {
      // `channel set #x` and `channel #x` both read naturally.
      const token = sub === 'set' ? tail[1] : tail[0];
      if (!token) return { content: `Usage: \`${config.prefix} channel set #channel\`` };
      return actions.setChannel(guild, resolveChannel(guild, token));
    }

    case 'ping':
      switch (sub) {
        case 'add':
        case 'remove':
          return actions.pingChange(sub === 'add', resolvePingTargets(guild, tail.slice(1)));
        case 'list':
          return actions.pingList();
        case 'clear':
          return actions.pingClear();
        case 'everyone': {
          const enabled = parseBool(tail[1]);
          if (enabled === null) {
            return { content: `Usage: \`${config.prefix} ping everyone on|off\`` };
          }
          return actions.pingEveryone(guild, enabled);
        }
        default:
          return { content: `Usage: \`${config.prefix} ping add|remove|list|clear|everyone\`` };
      }

    case 'prefix': {
      if (!sub) return { content: `The prefix is \`${config.prefix}\`.` };
      const toggle = parseBool(sub);
      if (toggle !== null) return actions.setPrefixEnabled(toggle);
      // The raw remainder, so a prefix with a space in it is rejected rather
      // than silently truncated to its first word.
      return actions.setPrefix(sub === 'set' ? parsed.rest(2) : parsed.rest(1));
    }

    // `set` used to carry the watcher's own settings, which the web UI now owns
    // outright. The prefix is the one thing under it that is still a Discord
    // setting, so that spelling keeps working and the rest says where to go.
    case 'set':
      if (sub === 'prefix') {
        const toggle = parseBool(tail[1]);
        if (toggle !== null) return actions.setPrefixEnabled(toggle);
        return actions.setPrefix(parsed.rest(2));
      }
      return actions.webOnly(sub ? `set ${sub}` : 'set');

    case 'settings':
    case 'config':
    case 'source':
      return actions.webOnly(cmd);

    default:
      return UNKNOWN(config.prefix, cmd);
  }
}

// Commands that hit the network; show a typing indicator so the channel does
// not look dead while a feed times out or a voice handshake completes.
const SLOW = new Set(['check', 'poll', 'latest', 'test', 'play', 'sound']);

/** Wired to Events.MessageCreate. Ignores anything not addressed to us. */
export async function handleMessage(message) {
  const config = get();
  if (!config.prefixEnabled) return;
  if (message.author?.bot || !message.inGuild?.()) return;

  const parsed = parse(message.content, config.prefix);
  if (!parsed) return;

  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    return reply(message, { content: 'You need the **Manage Server** permission to do that.' });
  }

  if (SLOW.has((parsed.args[0] ?? '').toLowerCase())) {
    await message.channel.sendTyping().catch(() => {});
  }

  try {
    return await reply(message, await dispatch(message.guild, parsed, message.member));
  } catch (err) {
    console.error('[prefix] command failed:', err);
    return reply(message, { content: `Something broke: \`${String(err.message).slice(0, 300)}\`` });
  }
}

async function reply(message, payload) {
  const body = { ...payload, allowedMentions: SILENT };
  try {
    return await message.reply(body);
  } catch {
    // The original message may be gone, or replies may be blocked; a plain
    // send still gets the answer to the person who asked.
    return message.channel.send(body).catch(() => {});
  }
}
