import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { tokens } from '../store.js';

// SoundCloud OAuth 2.1 rotates the refresh token on every use, so we persist the new one.
async function accessToken() {
  const { clientId, clientSecret } = config.soundcloud;
  const refresh = tokens.get('soundcloud', 'refreshToken', config.soundcloud.refreshToken);
  const res = await fetch('https://secure.soundcloud.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json; charset=utf-8' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refresh }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`SoundCloud token: ${j.error_description || j.error || res.status}`);
  if (j.refresh_token) tokens.set('soundcloud', { refreshToken: j.refresh_token });
  return j.access_token;
}

export async function upload({ file, artwork, title, description, tags, genre = 'Hardcore', sharing = 'public' }) {
  const token = await accessToken();
  const form = new FormData();
  form.append('track[title]', title);
  form.append('track[description]', description || '');
  form.append('track[genre]', genre);
  form.append('track[tag_list]', tags || '');
  form.append('track[sharing]', sharing);
  form.append('track[downloadable]', 'false');
  form.append('track[asset_data]', await fs.openAsBlob(file), path.basename(file));
  if (artwork) form.append('track[artwork_data]', await fs.openAsBlob(artwork, { type: 'image/jpeg' }), 'artwork.jpg');
  const res = await fetch('https://api.soundcloud.com/tracks', {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}`, accept: 'application/json; charset=utf-8' },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SoundCloud upload: ${res.status} ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return { id: j.id, url: j.permalink_url, sharing };
}
