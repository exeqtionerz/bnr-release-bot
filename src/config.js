import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tiny .env loader (no dependency). Existing env vars win.
export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

const e = (k, d = '') => (process.env[k] ?? d).trim();

export const config = {
  telegram: { token: e('TELEGRAM_BOT_TOKEN'), ownerId: e('TELEGRAM_OWNER_ID') },
  dropbox: {
    appKey: e('DROPBOX_APP_KEY'),
    appSecret: e('DROPBOX_APP_SECRET'),
    refreshToken: e('DROPBOX_REFRESH_TOKEN'),
    root: e('DROPBOX_RELEASES_ROOT', '/Break Neck Records/BNR RELEASES'),
    outputDir: e('DROPBOX_OUTPUT_DIR', '/Break Neck Records/BNR BOT'),
    watchMin: Number(e('WATCH_INTERVAL_MIN', '15')) || 15,
  },
  youtube: {
    clientId: e('YOUTUBE_CLIENT_ID'),
    clientSecret: e('YOUTUBE_CLIENT_SECRET'),
    refreshToken: e('YOUTUBE_REFRESH_TOKEN'),
    privacy: e('YOUTUBE_DEFAULT_PRIVACY', 'private'),
  },
  instagram: { userId: e('INSTAGRAM_USER_ID'), token: e('INSTAGRAM_ACCESS_TOKEN') },
  tiktok: { clientKey: e('TIKTOK_CLIENT_KEY'), clientSecret: e('TIKTOK_CLIENT_SECRET'), refreshToken: e('TIKTOK_REFRESH_TOKEN'), mode: e('TIKTOK_MODE', 'inbox') },
  reelMaxSeconds: Number(e('REEL_MAX_SECONDS', '60')) || 60,
  soundcloud: { clientId: e('SOUNDCLOUD_CLIENT_ID'), clientSecret: e('SOUNDCLOUD_CLIENT_SECRET'), refreshToken: e('SOUNDCLOUD_REFRESH_TOKEN') },
  anthropic: { key: e('ANTHROPIC_API_KEY'), model: e('ANTHROPIC_MODEL', 'claude-sonnet-4-5') },
  label: {
    name: e('LABEL_NAME', 'Break Neck Records'),
    hashtags: e('LABEL_HASHTAGS', '#hardcore #uptempo #breakneckrecords #gabber #hardcoretechno'),
    links: e('LABEL_LINKS', 'https://breakneckrecords.nl'),
  },
  authPort: Number(e('AUTH_PORT', '8765')) || 8765,
  dataDir: e('DATA_DIR') || path.join(ROOT, 'data'),
  tmpDir: e('TMP_DIR') || path.join(ROOT, 'tmp'),
};

export const enabled = {
  youtube: () => !!(config.youtube.clientId && config.youtube.clientSecret && config.youtube.refreshToken),
  instagram: () => !!(config.instagram.userId && config.instagram.token),
  tiktok: () => !!(config.tiktok.clientKey && config.tiktok.clientSecret && config.tiktok.refreshToken),
  soundcloud: () => !!(config.soundcloud.clientId && config.soundcloud.clientSecret && config.soundcloud.refreshToken),
  ai: () => !!config.anthropic.key,
};
