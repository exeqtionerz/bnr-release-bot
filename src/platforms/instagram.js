import fs from 'node:fs';
import { config } from '../config.js';
import { tokens } from '../store.js';

// Instagram API with Instagram Login (graph.instagram.com) — needs a Professional (Creator/Business) account.
const GRAPH = 'https://graph.instagram.com/v21.0';

function token() { return tokens.get('instagram', 'token', config.instagram.token); }

// Long-lived tokens last 60 days; refreshing extends them. Called on start and weekly.
export async function refreshToken() {
  const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token())}`);
  const j = await res.json();
  if (res.ok && j.access_token) tokens.set('instagram', { token: j.access_token });
  return res.ok;
}

async function api(method, p, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: token() });
  const url = method === 'GET' ? `${GRAPH}/${p}?${body}` : `${GRAPH}/${p}`;
  const res = await fetch(url, method === 'GET' ? {} : { method, body });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(`Instagram ${p}: ${j.error?.message || res.status}`);
  return j;
}

// Reel upload without needing a public URL: resumable upload straight from disk.
export async function uploadReel({ file, caption, shareToFeed = true, onStatus }) {
  const userId = config.instagram.userId;
  const c = await api('POST', `${userId}/media`, { media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: String(shareToFeed) });
  const size = fs.statSync(file).size;
  const up = await fetch(`https://rupload.facebook.com/ig-api-upload/v21.0/${c.id}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${token()}`, offset: '0', file_size: String(size), 'Content-Type': 'application/octet-stream' },
    body: await fs.openAsBlob(file),
    duplex: 'half',
  });
  if (!up.ok) throw new Error(`Instagram upload: ${up.status} ${(await up.text()).slice(0, 300)}`);

  // Instagram processes the video before it can be published.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const s = await api('GET', c.id, { fields: 'status_code,status' });
    onStatus?.(s.status_code);
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram procesando: ${s.status || s.status_code}`);
    if (i === 59) throw new Error('Instagram tardó demasiado en procesar el vídeo.');
  }
  const pub = await api('POST', `${userId}/media_publish`, { creation_id: c.id });
  let url = '';
  try { url = (await api('GET', pub.id, { fields: 'permalink' })).permalink; } catch { /* optional */ }
  return { id: pub.id, url };
}
