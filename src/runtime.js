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
  messageIntent: 'off'
};

export function setMessageIntent(value) {
  runtime.messageIntent = value;
}
