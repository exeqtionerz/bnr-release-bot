import { config, enabled } from './config.js';
import { createBot, announce } from './bot.js';
import { detectNew } from './releases.js';
import { load } from './store.js';
import * as instagram from './platforms/instagram.js';

if (!config.telegram.token) {
  console.error('Falta TELEGRAM_BOT_TOKEN en .env');
  process.exit(1);
}

const bot = createBot();
const owner = () => config.telegram.ownerId || load('owner', {}).id;

async function watch() {
  if (!owner() || !config.dropbox.refreshToken) return;
  try {
    const fresh = await detectNew();
    for (const r of fresh) await announce(bot, r, owner());
  } catch (e) {
    console.error('watch:', e.message);
  }
}

async function keepTokensAlive() {
  if (enabled.instagram()) await instagram.refreshToken().catch((e) => console.error('ig refresh:', e.message));
}

await bot.telegram.setMyCommands([
  { command: 'lanzamientos', description: 'Elegir un lanzamiento de Dropbox' },
  { command: 'estado', description: 'Plataformas conectadas' },
  { command: 'menu', description: 'Menú principal' },
]).catch(() => {});

bot.launch({ dropPendingUpdates: true });
console.log('BNR Release Bot en marcha.');

watch();
setInterval(watch, config.dropbox.watchMin * 60_000);
keepTokensAlive();
setInterval(keepTokensAlive, 7 * 24 * 3600_000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
