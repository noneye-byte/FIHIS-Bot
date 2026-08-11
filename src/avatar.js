import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { get, update } from './store.js';
import { LOGO_PATH } from './web/server.js';

/**
 * Uploads FIHAS.jpg as the bot's avatar, but only when it differs from what we
 * last uploaded. Discord rate-limits avatar changes hard (and bans on abuse),
 * so re-uploading on every container restart would eventually lock the bot out.
 */
export async function syncAvatar(client) {
  let bytes;
  try {
    bytes = await fs.readFile(LOGO_PATH);
  } catch {
    return; // No logo shipped; leave whatever is set in the portal.
  }

  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const config = get();
  if (config.avatarHash === hash) return;

  try {
    await client.user.setAvatar(bytes);
    await update((c) => {
      c.avatarHash = hash;
    });
    console.log('[avatar] bot profile picture updated from FIHAS.jpg');
  } catch (err) {
    // Almost always a 429. Not worth failing startup over.
    console.warn('[avatar] could not update profile picture:', err.message);
  }
}
