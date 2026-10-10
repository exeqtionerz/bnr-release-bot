// Interactive first-time setup, run on the server:  npm run setup
// Asks for the Telegram token and Dropbox app key/secret (typed input is hidden),
// authorizes Dropbox by copy-pasting a code, and writes everything into .env.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ROOT } from '../src/config.js';

const ENV = path.join(ROOT, '.env');
if (!fs.existsSync(ENV)) fs.copyFileSync(path.join(ROOT, '.env.example'), ENV);

function readEnv() { return fs.readFileSync(ENV, 'utf8'); }
function current(k) { const m = readEnv().match(new RegExp(`^${k}=(.*)$`, 'm')); return m ? m[1].trim() : ''; }
function setEnv(k, v) {
  let s = readEnv();
  const line = `${k}=${v}`;
  s = new RegExp(`^${k}=.*$`, 'm').test(s) ? s.replace(new RegExp(`^${k}=.*$`, 'm'), line) : `${s.trimEnd()}\n${line}\n`;
  fs.writeFileSync(ENV, s, { mode: 0o600 });
}

function ask(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (str) => { if (str.includes(q)) rl.output.write(str); else rl.output.write('*'); };
    }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

async function keep(k, label, hidden) {
  const cur = current(k);
  const v = await ask(`${label}${cur ? ' (Enter = dejar el actual)' : ''}: `, hidden);
  if (v) setEnv(k, v);
  return v || cur;
}

console.log('\n=== BNR Release Bot · configuración ===\n(Lo que escribas en los campos secretos no se muestra.)\n');

const tg = await keep('TELEGRAM_BOT_TOKEN', '1) Token de Telegram (de @BotFather)', true);
if (tg) {
  const r = await fetch(`https://api.telegram.org/bot${tg}/getMe`).then((x) => x.json()).catch(() => ({}));
  console.log(r.ok ? `   ✅ Bot: @${r.result.username}` : '   ❌ Token de Telegram inválido, vuelve a ejecutar npm run setup');
}

const key = await keep('DROPBOX_APP_KEY', '2) Dropbox App key', false);
const secret = await keep('DROPBOX_APP_SECRET', '3) Dropbox App secret', true);

if (key && secret && (!current('DROPBOX_REFRESH_TOKEN') || (await ask('¿Volver a autorizar Dropbox? (s/N): ')).toLowerCase() === 's')) {
  const url = `https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(key)}&response_type=code&token_access_type=offline`;
  console.log(`\n4) Abre este enlace, pulsa "Permitir" y copia el código que te da Dropbox:\n\n   ${url}\n`);
  const code = await ask('   Pega aquí el código: ', true);
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: key, client_secret: secret }),
  });
  const j = await res.json();
  if (j.refresh_token) { setEnv('DROPBOX_REFRESH_TOKEN', j.refresh_token); console.log('   ✅ Dropbox autorizado y guardado.'); }
  else console.log(`   ❌ Dropbox: ${j.error_description || JSON.stringify(j)}`);
}

fs.chmodSync(ENV, 0o600);
console.log('\nListo. Ahora ejecuta:  bash deploy/install.sh   (arranca el bot)\nDespués abre tu bot en Telegram y escribe /start\n');
