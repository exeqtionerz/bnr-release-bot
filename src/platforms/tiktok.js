import fs from 'node:fs';
import { config } from '../config.js';
import { tokens } from '../store.js';

const API = 'https://open.tiktokapis.com/v2';

async function accessToken() {
  const { clientKey, clientSecret } = config.tiktok;
  const refresh = tokens.get('tiktok', 'refreshToken', config.tiktok.refreshToken);
  const res = await fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refresh }),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(`TikTok token: ${j.error_description || j.error || res.status}`);
  if (j.refresh_token) tokens.set('tiktok', { refreshToken: j.refresh_token });
  return j.access_token;
}

// TikTok chunk rules: 5–64 MB per chunk, the last one may be bigger (up to 128 MB); one chunk if < 64 MB.
export function chunking(size) {
  const MB = 1024 * 1024;
  if (size <= 64 * MB) return { chunk: size, count: 1 };
  const chunk = 10 * MB;
  return { chunk, count: Math.floor(size / chunk) };
}

// mode "inbox": video lands in your TikTok inbox as a draft, you add sound/caption and post (works without app audit).
// mode "direct": posts directly (needs an audited app; unaudited apps can only post as private/SELF_ONLY).
export async function upload({ file, caption, mode = 'inbox', privacy = 'SELF_ONLY' }) {
  const token = await accessToken();
  const size = fs.statSync(file).size;
  const { chunk, count } = chunking(size);
  const source_info = { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: count };
  const endpoint = mode === 'direct' ? `${API}/post/publish/video/init/` : `${API}/post/publish/inbox/video/init/`;
  const body = mode === 'direct'
    ? { post_info: { title: caption.slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false }, source_info }
    : { source_info };
  const init = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body) });
  const j = await init.json();
  if (!init.ok || (j.error && j.error.code !== 'ok')) throw new Error(`TikTok init: ${j.error?.message || init.status}`);
  const { upload_url, publish_id } = j.data;

  const fd = fs.openSync(file, 'r');
  try {
    for (let i = 0; i < count; i++) {
      const start = i * chunk;
      const end = i === count - 1 ? size - 1 : start + chunk - 1;
      const len = end - start + 1;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const r = await fetch(upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(len), 'Content-Range': `bytes ${start}-${end}/${size}` },
        body: buf,
      });
      if (!r.ok && r.status !== 206) throw new Error(`TikTok upload: ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { publish_id, mode };
}
