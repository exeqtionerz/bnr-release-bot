// One-time authorization helper. Run on your own computer:  npm run auth:<service>
// It opens a local page, you click "Allow" on the platform, and it prints the refresh token to paste into .env.
import http from 'node:http';
import crypto from 'node:crypto';
import { config } from '../src/config.js';

const service = process.argv[2];
const PORT = config.authPort;
const REDIRECT = `http://localhost:${PORT}/callback`;
const state = crypto.randomBytes(12).toString('hex');
const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

const S = {
  dropbox: {
    need: ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET'],
    url: () => `https://www.dropbox.com/oauth2/authorize?${new URLSearchParams({ client_id: config.dropbox.appKey, response_type: 'code', token_access_type: 'offline', redirect_uri: REDIRECT, state })}`,
    exchange: (code) => post('https://api.dropboxapi.com/oauth2/token', { code, grant_type: 'authorization_code', client_id: config.dropbox.appKey, client_secret: config.dropbox.appSecret, redirect_uri: REDIRECT }),
    env: (j) => ({ DROPBOX_REFRESH_TOKEN: j.refresh_token }),
  },
  youtube: {
    need: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'],
    url: () => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: config.youtube.clientId, redirect_uri: REDIRECT, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube', state })}`,
    exchange: (code) => post('https://oauth2.googleapis.com/token', { code, client_id: config.youtube.clientId, client_secret: config.youtube.clientSecret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
    env: (j) => ({ YOUTUBE_REFRESH_TOKEN: j.refresh_token }),
  },
  soundcloud: {
    need: ['SOUNDCLOUD_CLIENT_ID', 'SOUNDCLOUD_CLIENT_SECRET'],
    url: () => `https://secure.soundcloud.com/authorize?${new URLSearchParams({ client_id: config.soundcloud.clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state })}`,
    exchange: (code) => post('https://secure.soundcloud.com/oauth/token', { grant_type: 'authorization_code', client_id: config.soundcloud.clientId, client_secret: config.soundcloud.clientSecret, redirect_uri: REDIRECT, code_verifier: verifier, code }),
    env: (j) => ({ SOUNDCLOUD_REFRESH_TOKEN: j.refresh_token }),
  },
  tiktok: {
    need: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
    url: () => `https://www.tiktok.com/v2/auth/authorize/?${new URLSearchParams({ client_key: config.tiktok.clientKey, response_type: 'code', scope: 'user.info.basic,video.upload,video.publish', redirect_uri: REDIRECT, state, code_challenge: challenge, code_challenge_method: 'S256' })}`,
    exchange: (code) => post('https://open.tiktokapis.com/v2/oauth/token/', { client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret, code, grant_type: 'authorization_code', redirect_uri: REDIRECT, code_verifier: verifier }),
    env: (j) => ({ TIKTOK_REFRESH_TOKEN: j.refresh_token }),
  },
};

async function post(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params) });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error_description || j.error?.message || JSON.stringify(j));
  return j;
}

const s = S[service];
if (!s) { console.log('Uso: npm run auth:dropbox | auth:youtube | auth:soundcloud | auth:tiktok'); process.exit(1); }
const missing = s.need.filter((k) => !process.env[k]);
if (missing.length) { console.log(`Primero rellena en .env: ${missing.join(', ')}`); process.exit(1); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/callback') { res.writeHead(302, { Location: s.url() }); return res.end(); }
  if (u.searchParams.get('state') !== state) { res.end('State incorrecto. Vuelve a empezar.'); return; }
  try {
    const j = await s.exchange(u.searchParams.get('code'));
    const env = s.env(j);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>✅ Listo. Vuelve a la terminal.</h2>');
    console.log('\n✅ Autorizado. Copia esta línea en tu .env:\n');
    for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
    console.log('');
  } catch (e) {
    res.end(`Error: ${e.message}`);
    console.error('❌', e.message);
  }
  server.close();
});
server.listen(PORT, () => {
  console.log(`\nAbre en el navegador:  http://localhost:${PORT}\n(Redirect URI que debes registrar en la app: ${REDIRECT})\n`);
});
