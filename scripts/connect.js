// Connect a platform account, run on the server:  npm run connect -- youtube|instagram|tiktok|soundcloud
// You type the app keys (hidden), open a link, approve, and paste back the code shown on
// https://breakneckrecords.nl/auth.html. The long-lived token is saved straight into .env.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { ROOT } from '../src/config.js';

const REDIRECT = process.env.AUTH_REDIRECT_URI || 'https://breakneckrecords.nl/auth.html';
const ENV = path.join(ROOT, '.env');
const TOKENS = path.join(ROOT, 'data', 'tokens.json');
if (!fs.existsSync(ENV)) fs.copyFileSync(path.join(ROOT, '.env.example'), ENV);

const readEnv = () => fs.readFileSync(ENV, 'utf8');
const current = (k) => (readEnv().match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim() || '';
function setEnv(k, v) {
  let s = readEnv();
  const re = new RegExp(`^${k}=.*$`, 'm');
  s = re.test(s) ? s.replace(re, `${k}=${v}`) : `${s.trimEnd()}\n${k}=${v}\n`;
  fs.writeFileSync(ENV, s, { mode: 0o600 });
}
// Rotated tokens stored by the bot win over .env, so replace them too.
function setStored(service, values) {
  let t = {};
  try { t = JSON.parse(fs.readFileSync(TOKENS, 'utf8')); } catch {}
  t[service] = { ...values, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(TOKENS), { recursive: true });
  fs.writeFileSync(TOKENS, JSON.stringify(t, null, 2));
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
rl._writeToOutput = (str) => { if (!muted || /[\r\n]/.test(str)) rl.output.write(muted ? str.replace(/[^\r\n]/g, '') : str); else rl.output.write('*'.repeat(str.length)); };
rl.on('SIGINT', () => process.exit(130));
function ask(q, hidden = false) {
  return new Promise((resolve) => {
    muted = false; rl.output.write(q); muted = hidden;
    rl.question('', (a) => { muted = false; resolve(a.replace(/[\x00-\x1f]/g, '').trim()); });
  });
}
async function keep(k, label, hidden) {
  const cur = current(k);
  const v = await ask(`${label}${cur ? ' (Enter = dejar el actual)' : ''}: `, hidden);
  if (v) setEnv(k, v);
  return v || cur;
}
// Accepts the bare code or the whole redirected URL.
function cleanCode(s) {
  try { if (/^https?:/.test(s)) { const u = new URL(s); s = u.searchParams.get('code') || s; } } catch {}
  return s.replace(/#_$/, '').trim();
}
async function form(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.error && j.error !== 'ok' && j.error?.code !== 'ok')) throw new Error(j.error_description || j.error_message || j.error?.message || j.message || JSON.stringify(j));
  return j;
}

const state = crypto.randomBytes(8).toString('hex');
const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

const PLATFORMS = {
  async youtube() {
    const id = await keep('YOUTUBE_CLIENT_ID', 'Google Client ID', false);
    const secret = await keep('YOUTUBE_CLIENT_SECRET', 'Google Client secret', true);
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube', state })}`;
    const code = await getCode(url, 'Elige el canal de YouTube de Break Neck Records y pulsa Permitir/Continuar.');
    const j = await form('https://oauth2.googleapis.com/token', { code, client_id: id, client_secret: secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' });
    if (!j.refresh_token) throw new Error('Google no devolvió refresh_token. Quita el acceso de la app en myaccount.google.com/permissions y repite.');
    setEnv('YOUTUBE_REFRESH_TOKEN', j.refresh_token);
    const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${j.access_token}` } }).then((r) => r.json()).catch(() => ({}));
    return `YouTube conectado: ${ch.items?.[0]?.snippet?.title || 'canal OK'}`;
  },

  async instagram() {
    const id = await keep('INSTAGRAM_APP_ID', 'Instagram App ID', false);
    const secret = await keep('INSTAGRAM_APP_SECRET', 'Instagram App secret', true);
    const url = `https://www.instagram.com/oauth/authorize?${new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, response_type: 'code', scope: 'instagram_business_basic,instagram_business_content_publish', state })}`;
    const code = await getCode(url, 'Entra con la cuenta de Instagram de la label y pulsa Permitir.');
    const short = await form('https://api.instagram.com/oauth/access_token', { client_id: id, client_secret: secret, grant_type: 'authorization_code', redirect_uri: REDIRECT, code });
    const long = await fetch(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: secret, access_token: short.access_token })}`).then((r) => r.json());
    if (!long.access_token) throw new Error(long.error?.message || 'No se pudo obtener el token largo');
    const me = await fetch(`https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=${encodeURIComponent(long.access_token)}`).then((r) => r.json()).catch(() => ({}));
    setEnv('INSTAGRAM_USER_ID', String(me.user_id || short.user_id));
    setEnv('INSTAGRAM_ACCESS_TOKEN', long.access_token);
    setStored('instagram', { token: long.access_token });
    return `Instagram conectado: @${me.username || short.user_id}`;
  },

  async tiktok() {
    const key = await keep('TIKTOK_CLIENT_KEY', 'TikTok Client key', false);
    const secret = await keep('TIKTOK_CLIENT_SECRET', 'TikTok Client secret', true);
    const url = `https://www.tiktok.com/v2/auth/authorize/?${new URLSearchParams({ client_key: key, response_type: 'code', scope: 'user.info.basic,video.upload', redirect_uri: REDIRECT, state })}`;
    const code = await getCode(url, 'Entra con la cuenta de TikTok de la label y pulsa Autorizar.');
    const j = await form('https://open.tiktokapis.com/v2/oauth/token/', { client_key: key, client_secret: secret, code: decodeURIComponent(code), grant_type: 'authorization_code', redirect_uri: REDIRECT });
    setEnv('TIKTOK_REFRESH_TOKEN', j.refresh_token);
    setStored('tiktok', { refreshToken: j.refresh_token });
    return 'TikTok conectado (los vídeos llegarán como borrador a tu app de TikTok).';
  },

  async soundcloud() {
    const id = await keep('SOUNDCLOUD_CLIENT_ID', 'SoundCloud Client ID', false);
    const secret = await keep('SOUNDCLOUD_CLIENT_SECRET', 'SoundCloud Client secret', true);
    const url = `https://secure.soundcloud.com/authorize?${new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state })}`;
    const code = await getCode(url, 'Entra con la cuenta de SoundCloud de la label y pulsa Connect.');
    const j = await form('https://secure.soundcloud.com/oauth/token', { grant_type: 'authorization_code', client_id: id, client_secret: secret, redirect_uri: REDIRECT, code_verifier: verifier, code });
    setEnv('SOUNDCLOUD_REFRESH_TOKEN', j.refresh_token);
    setStored('soundcloud', { refreshToken: j.refresh_token });
    const me = await fetch('https://api.soundcloud.com/me', { headers: { Authorization: `OAuth ${j.access_token}`, accept: 'application/json' } }).then((r) => r.json()).catch(() => ({}));
    return `SoundCloud conectado: ${me.username || 'cuenta OK'}`;
  },
};

async function getCode(url, hint) {
  console.log(`\nAbre este enlace (en el móvil o el ordenador):\n\n   ${url}\n\n${hint}\nTe llevará a breakneckrecords.nl con un código: pulsa "Copiar código".\n`);
  return cleanCode(await ask('Pega aquí el código: ', true));
}

const which = (process.argv[2] || '').toLowerCase();
if (!PLATFORMS[which]) {
  console.log('Uso: npm run connect -- youtube | instagram | tiktok | soundcloud');
  rl.close();
  process.exit(1);
}
console.log(`\n=== Conectar ${which} ===\nURL de redirección que debe estar registrada en la app: ${REDIRECT}\n`);
try {
  const msg = await PLATFORMS[which]();
  console.log(`\n✅ ${msg}`);
  try { execSync(`chown bnrbot:bnrbot "${ENV}" "${TOKENS}" 2>/dev/null; systemctl restart bnr-release-bot`, { stdio: 'ignore' }); console.log('   Bot reiniciado con la nueva cuenta.'); } catch { console.log('   Reinicia el bot:  systemctl restart bnr-release-bot'); }
} catch (e) {
  console.log(`\n❌ ${e.message}`);
}
rl.close();
