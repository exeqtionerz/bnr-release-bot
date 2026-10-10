// npm run check — verifies every configured service without publishing anything.
import { config, enabled } from '../src/config.js';
import * as dbx from '../src/dropbox.js';
import { listReleases } from '../src/releases.js';
import { execSync } from 'node:child_process';

const ok = (m) => console.log('🟢', m), bad = (m) => console.log('🔴', m), off = (m) => console.log('⚪', m);

try { execSync('ffmpeg -version', { stdio: 'ignore' }); ok('ffmpeg instalado'); } catch { bad('ffmpeg NO instalado (sudo apt install ffmpeg)'); }

if (!config.telegram.token) bad('Telegram: falta TELEGRAM_BOT_TOKEN');
else {
  const r = await fetch(`https://api.telegram.org/bot${config.telegram.token}/getMe`).then((x) => x.json()).catch(() => ({}));
  r.ok ? ok(`Telegram: @${r.result.username}`) : bad('Telegram: token inválido');
}

try {
  const me = await dbx.whoami();
  ok(`Dropbox: ${me.name?.display_name || me.email}`);
  const list = await listReleases();
  ok(`Dropbox: ${list.length} lanzamientos en "${config.dropbox.root}" (último: ${list[0]?.name || '-'})`);
} catch (e) { bad(`Dropbox: ${e.message}`); }

for (const p of ['youtube', 'instagram', 'tiktok', 'soundcloud']) enabled[p]() ? ok(`${p}: credenciales puestas`) : off(`${p}: sin conectar (modo manual)`);
enabled.ai() ? ok('Textos IA: activado') : off('Textos IA: plantillas');
