import fs from 'node:fs';
import { config } from '../config.js';

async function accessToken() {
  const { clientId, clientSecret, refreshToken } = config.youtube;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`YouTube token: ${j.error_description || j.error || res.status}`);
  return j.access_token;
}

// Resumable upload in 16 MB chunks (survives big files on slow links).
export async function upload({ file, title, description, tags = [], privacy = config.youtube.privacy, thumbnail, onProgress }) {
  const token = await accessToken();
  const size = fs.statSync(file).size;
  const meta = {
    snippet: { title: title.slice(0, 100), description: description.slice(0, 5000), tags: tags.slice(0, 30), categoryId: '10' },
    status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, embeddable: true },
  };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/*' },
    body: JSON.stringify(meta),
  });
  if (!init.ok) throw new Error(`YouTube init: ${init.status} ${(await init.text()).slice(0, 300)}`);
  const url = init.headers.get('location');

  const CHUNK = 16 * 1024 * 1024;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(CHUNK);
  let offset = 0, result = null;
  try {
    while (offset < size) {
      const n = fs.readSync(fd, buf, 0, CHUNK, offset);
      const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(n), 'Content-Range': `bytes ${offset}-${offset + n - 1}/${size}` },
        body: buf.subarray(0, n),
      });
      if (res.status === 308) {
        const range = res.headers.get('range');
        offset = range ? Number(range.split('-')[1]) + 1 : offset + n;
      } else if (res.ok) {
        result = await res.json();
        offset = size;
      } else {
        throw new Error(`YouTube upload: ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
      onProgress?.(Math.min(offset / size, 1));
    }
  } finally {
    fs.closeSync(fd);
  }

  let thumbOk = false;
  if (thumbnail && result?.id) {
    const t = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${result.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
      body: fs.readFileSync(thumbnail),
    });
    thumbOk = t.ok; // fails silently on channels that are not phone-verified
  }
  return { id: result.id, url: `https://youtu.be/${result.id}`, privacy, thumbnail: thumbOk };
}
