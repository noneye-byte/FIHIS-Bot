/**
 * Process-wide facts that are neither configuration nor persisted state, shared
 * between startup and the web UI without either importing the other.
 */
export const runtime = {
  /**
   * Whether prefix commands can actually see message text.
   *   'off'      — prefix commands are disabled in the config
   *   'active'   — the Message Content intent was granted
   *   'denied'   — Discord refused it; enable it in the Developer Portal
   *   'restart'  — enabled in the config since boot, needs a container restart
   */
  messageIntent: 'off',

  /**
   * Why the bot is not talking to Discord, when it isn't: `{ code, message }`,
   * or null while healthy. The web UI is the only place an Unraid admin can see
   * this without digging through container logs, so it is deliberately kept
   * reachable even when Discord is unusable — see the startup notes in index.js.
   */
  fault: null,

  /**
   * True when /config could not be written. Settings that look saved in the UI
   * are actually being discarded, which is worth shouting about.
   */
  configReadOnly: false
};

export function setMessageIntent(value) {
  runtime.messageIntent = value;
}

export function setFault(code, message) {
  runtime.fault = code ? { code, message } : null;
}

export function setConfigReadOnly(value) {
  runtime.configReadOnly = Boolean(value);
}
