import fs from 'node:fs';
import { Telegraf, Markup } from 'telegraf';
import { config } from './config.js';
import { listReleases, scanRelease, detectNew, ROLE_LABEL } from './releases.js';
import { captions, mainText, applyEdit } from './captions.js';
import { PLATFORMS, SLOT_FILTER, isConfigured, prepare, publish } from './pipeline.js';
import { history, load, save } from './store.js';

const PRIV = ['private', 'unlisted', 'public'];
const PRIV_LABEL = { private: '🔒 Privado', unlisted: '👁 Oculto', public: '🌍 Público' };
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const short = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Telegram callback data is limited to 64 bytes, so long values are stored here and referenced by a short key.
const refs = new Map();
let refN = 0;
function ref(v) { const k = (++refN).toString(36); refs.set(k, v); if (refs.size > 5000) refs.delete(refs.keys().next().value); return k; }

// One open "job" per release card.
const jobs = new Map();
let busy = false;
let lastEditJob = null;

export function createBot() {
  const bot = new Telegraf(config.telegram.token, { handlerTimeout: 3_600_000 });
  const owner = () => config.telegram.ownerId || load('owner', {}).id || '';

  // Only the owner can use the bot. The very first /start (if no owner is set) claims it.
  bot.use(async (ctx, next) => {
    const id = String(ctx.from?.id || '');
    if (!owner()) {
      if (ctx.message?.text?.startsWith('/start')) {
        save('owner', { id });
        await ctx.reply(`✅ Ahora eres el dueño de este bot. Tu ID de Telegram es <code>${id}</code> (puedes ponerlo en TELEGRAM_OWNER_ID).`, { parse_mode: 'HTML' });
      }
      return;
    }
    if (id !== String(owner())) return ctx.reply?.('⛔ Bot privado.').catch(() => {});
    return next();
  });

  const menu = () => Markup.inlineKeyboard([
    [Markup.button.callback('📀 Lanzamientos', 'rel:0')],
    [Markup.button.callback('🔍 Buscar nuevos en Dropbox', 'scan'), Markup.button.callback('⚙️ Estado', 'status')],
  ]);

  bot.start((ctx) => ctx.reply('🔥 <b>BNR Release Bot</b>\nElige un lanzamiento de Dropbox y lo preparo y subo a cada plataforma.', { parse_mode: 'HTML', ...menu() }));
  bot.command('menu', (ctx) => ctx.reply('Menú', menu()));
  bot.command('lanzamientos', (ctx) => showReleases(ctx, 0, false));
  bot.command('estado', (ctx) => ctx.reply(statusText(), { parse_mode: 'HTML' }));
  bot.command('id', (ctx) => ctx.reply(`Tu ID: ${ctx.from.id}`));
  bot.help((ctx) => ctx.reply(
    'Comandos:\n/lanzamientos – elegir un lanzamiento\n/estado – qué plataformas están conectadas\n/menu – menú principal\n\n' +
    'Cuando aparezca una carpeta nueva en Dropbox te aviso solo.',
  ));

  bot.action('status', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(statusText(), { parse_mode: 'HTML' }); });
  bot.action('scan', async (ctx) => {
    await ctx.answerCbQuery('Buscando…');
    const fresh = await detectNew().catch((e) => { ctx.reply(`❌ ${e.message}`); return null; });
    if (!fresh) return;
    if (!fresh.length) return ctx.reply('Nada nuevo desde la última vez. Usa 📀 Lanzamientos para elegir cualquiera.');
    for (const r of fresh) await announce(bot, r, ctx.chat.id);
  });

  bot.action(/^rel:(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); await showReleases(ctx, Number(ctx.match[1]), true); });

  bot.action(/^open:(\w+)$/, async (ctx) => {
    const folder = refs.get(ctx.match[1]);
    if (!folder) return ctx.answerCbQuery('Caducado, vuelve a abrir la lista.');
    await ctx.answerCbQuery('Leyendo carpeta…');
    const msg = await ctx.reply(`⏳ Leyendo <b>${esc(folder.name)}</b>…`, { parse_mode: 'HTML' });
    try {
      const release = await scanRelease(folder);
      const caps = await captions(release);
      const jobId = ref(null);
      jobs.set(jobId, {
        release, caps, choice: structuredClone(release.plan),
        selected: Object.fromEntries(Object.keys(PLATFORMS).map((p) => [p, !history.get(release.id)[p]])),
        privacy: config.youtube.privacy, awaiting: null, chatId: ctx.chat.id,
      });
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, cardText(jobs.get(jobId)), { parse_mode: 'HTML', ...cardKb(jobId) });
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ ${esc(e.message)}`, { parse_mode: 'HTML' });
    }
  });

  const job = (ctx) => { const j = jobs.get(ctx.match[1]); if (!j) ctx.answerCbQuery('Caducado, vuelve a abrir el lanzamiento.'); return j; };
  const redraw = (ctx, id) => ctx.editMessageText(cardText(jobs.get(id)), { parse_mode: 'HTML', ...cardKb(id) }).catch(() => {});

  bot.action(/^tog:(\w+):(\w+)$/, async (ctx) => {
    const j = job(ctx); if (!j) return;
    j.selected[ctx.match[2]] = !j.selected[ctx.match[2]];
    await ctx.answerCbQuery(); await redraw(ctx, ctx.match[1]);
  });
  bot.action(/^priv:(\w+)$/, async (ctx) => {
    const j = job(ctx); if (!j) return;
    j.privacy = PRIV[(PRIV.indexOf(j.privacy) + 1) % PRIV.length];
    await ctx.answerCbQuery(PRIV_LABEL[j.privacy]); await redraw(ctx, ctx.match[1]);
  });
  bot.action(/^card:(\w+)$/, async (ctx) => { const j = job(ctx); if (!j) return; await ctx.answerCbQuery(); await redraw(ctx, ctx.match[1]); });

  // ── change files ──
  bot.action(/^files:(\w+)$/, async (ctx) => {
    const j = job(ctx); if (!j) return; await ctx.answerCbQuery();
    const rows = Object.entries(PLATFORMS).map(([p, m]) => [Markup.button.callback(`${m.icon} ${m.label}`, `fplat:${ctx.match[1]}:${p}`)]);
    rows.push([Markup.button.callback('⬅️ Volver', `card:${ctx.match[1]}`)]);
    await ctx.editMessageText('¿Para qué plataforma quieres cambiar archivos?', Markup.inlineKeyboard(rows));
  });
  bot.action(/^fplat:(\w+):(\w+)$/, async (ctx) => {
    const j = job(ctx); if (!j) return; await ctx.answerCbQuery();
    const [, id, p] = ctx.match;
    const rows = PLATFORMS[p].slots.map((s) => [Markup.button.callback(`${slotName(s)}: ${short(base(j.choice[p][s]) || '—', 34)}`, `fslot:${id}:${p}:${s}`)]);
    rows.push([Markup.button.callback('⬅️ Volver', `files:${id}`)]);
    await ctx.editMessageText(`<b>${PLATFORMS[p].label}</b> — toca lo que quieras cambiar:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
  });
  bot.action(/^fslot:(\w+):(\w+):(\w+)$/, async (ctx) => {
    const j = job(ctx); if (!j) return; await ctx.answerCbQuery();
    const [, id, p, s] = ctx.match;
    const cands = j.release.files.filter(SLOT_FILTER[s]).slice(0, 40);
    const rows = cands.map((f) => [Markup.button.callback(`${j.choice[p][s] === f.path ? '✅ ' : ''}${short(f.rel, 50)}`, `fset:${id}:${p}:${s}:${ref(f.path)}`)]);
    rows.push([Markup.button.callback('🚫 Ninguno', `fset:${id}:${p}:${s}:${ref(null)}`)]);
    rows.push([Markup.button.callback('⬅️ Volver', `fplat:${id}:${p}`)]);
    await ctx.editMessageText(`${slotName(s)} para <b>${PLATFORMS[p].label}</b>:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
  });
  bot.action(/^fset:(\w+):(\w+):(\w+):(\w+)$/, async (ctx) => {
    const j = job(ctx); if (!j) return;
    const [, id, p, s, k] = ctx.match;
    j.choice[p][s] = refs.get(k) ?? null;
    // Instagram and TikTok share one vertical video: keep them in sync.
    if (p === 'instagram' || p === 'tiktok') j.choice[p === 'instagram' ? 'tiktok' : 'instagram'][s] = j.choice[p][s];
    await ctx.answerCbQuery('Cambiado'); await redraw(ctx, id);
  });

  // ── texts ──
  bot.action(/^texts:(\w+)$/, async (ctx) => {
    const j = job(ctx); if (!j) return; await ctx.answerCbQuery();
    for (const p of Object.keys(PLATFORMS).filter((x) => j.selected[x])) {
      await ctx.reply(`${PLATFORMS[p].icon} <b>${PLATFORMS[p].label}</b>\n\n${esc(mainText(p, j.caps))}`, {
        parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Editar', `edit:${ctx.match[1]}:${p}`)]]),
      });
    }
  });
  bot.action(/^edit:(\w+):(\w+)$/, async (ctx) => {
    const j = job(ctx); if (!j) return; await ctx.answerCbQuery();
    j.awaiting = ctx.match[2];
    const hint = ['youtube', 'soundcloud'].includes(j.awaiting) ? '\n(Primera línea = título, luego una línea con --- y la descripción.)' : '';
    await ctx.reply(`Envíame el texto nuevo para ${PLATFORMS[j.awaiting].label}. Te dejo el actual para copiar:${hint}`);
    await ctx.reply(mainText(j.awaiting, j.caps));
    lastEditJob = ctx.match[1];
  });
  bot.on('text', async (ctx, next) => {
    const id = lastEditJob; const j = id && jobs.get(id);
    if (!j?.awaiting || ctx.message.text.startsWith('/')) return next();
    applyEdit(j.awaiting, j.caps, ctx.message.text);
    const p = j.awaiting; j.awaiting = null;
    await ctx.reply(`✅ Texto de ${PLATFORMS[p].label} actualizado.`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Volver al lanzamiento', `cardnew:${id}`)]]));
  });
  bot.action(/^cardnew:(\w+)$/, async (ctx) => {
    const j = job(ctx); if (!j) return; await ctx.answerCbQuery();
    await ctx.reply(cardText(j), { parse_mode: 'HTML', ...cardKb(ctx.match[1]) });
  });

  // ── publish ──
  bot.action(/^go:(\w+)$/, async (ctx) => {
    const j = job(ctx); if (!j) return; await ctx.answerCbQuery();
    const sel = Object.keys(PLATFORMS).filter((p) => j.selected[p]);
    if (!sel.length) return ctx.reply('Marca al menos una plataforma.');
    const lines = sel.map((p) => `${PLATFORMS[p].icon} ${PLATFORMS[p].label}: ${isConfigured(p) ? (p === 'youtube' ? `subida automática (${PRIV_LABEL[j.privacy]})` : p === 'tiktok' && config.tiktok.mode === 'inbox' ? 'borrador en tu app de TikTok' : 'subida automática') : 'te lo dejo listo para subir a mano'}`);
    await ctx.reply(`¿Confirmas?\n<b>${esc(title(j.release))}</b>\n\n${lines.join('\n')}`, {
      parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Sí, publicar', `yes:${ctx.match[1]}`), Markup.button.callback('❌ No', `card:${ctx.match[1]}`)]]),
    });
  });
  bot.action(/^yes:(\w+)$/, async (ctx) => {
    const j = job(ctx); if (!j) return;
    if (busy) return ctx.answerCbQuery('Ya estoy subiendo otro, espera a que termine.');
    await ctx.answerCbQuery('¡Vamos!');
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    busy = true;
    try { await runJob(ctx, j); } finally { busy = false; }
  });

  bot.catch((err, ctx) => { console.error(err); ctx.reply?.(`❌ Error: ${esc(err.message)}`).catch(() => {}); });

  async function showReleases(ctx, page, edit) {
    let list;
    try { list = await listReleases(); } catch (e) { return ctx.reply(`❌ ${e.message}`); }
    const per = 8, pages = Math.max(1, Math.ceil(list.length / per));
    const slice = list.slice(page * per, page * per + per);
    const rows = slice.map((r) => [Markup.button.callback(short(r.name, 60), `open:${ref(r)}`)]);
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️', `rel:${page - 1}`));
    if (page < pages - 1) nav.push(Markup.button.callback('➡️', `rel:${page + 1}`));
    if (nav.length) rows.push(nav);
    const text = `📀 Lanzamientos (${list.length}) — página ${page + 1}/${pages}`;
    return edit ? ctx.editMessageText(text, Markup.inlineKeyboard(rows)) : ctx.reply(text, Markup.inlineKeyboard(rows));
  }

  async function runJob(ctx, j) {
    const chat = ctx.chat.id;
    const st = await ctx.reply('⏳ Empezando…');
    let last = 0;
    const log = (t) => { if (Date.now() - last < 2500) return; last = Date.now(); ctx.telegram.editMessageText(chat, st.message_id, undefined, `⏳ ${t}`).catch(() => {}); };
    const results = [];
    let vertical = null;
    for (const p of Object.keys(PLATFORMS).filter((x) => j.selected[x])) {
      const m = PLATFORMS[p];
      try {
        last = 0; log(`${m.label}: preparando archivos…`);
        const prepared = (p === 'tiktok' && vertical) ? vertical : await prepare(p, j.release, j.choice[p], (t) => log(`${m.label}: ${t}`));
        if (p === 'instagram') vertical = prepared;
        last = 0; log(`${m.label}: subiendo…`);
        const r = await publish(p, j.release, prepared, j.caps, { privacy: j.privacy }, (t) => log(`${m.label}: ${t}`));
        if (r.manual) {
          results.push(`${m.icon} ${m.label}: listo para subir a mano ⬇️`);
          await sendManual(ctx, p, r, j);
        } else if (p === 'tiktok') {
          results.push(`${m.icon} TikTok: ${r.mode === 'inbox' ? 'enviado como borrador a tu app — ábrela, pega el texto y publica' : 'publicado'} ✅`);
          if (r.mode === 'inbox') await ctx.reply(mainText('tiktok', j.caps));
        } else {
          results.push(`${m.icon} ${m.label}: ✅ ${r.url || ''}${p === 'youtube' ? ` (${PRIV_LABEL[r.privacy]})` : ''}`);
        }
      } catch (e) {
        console.error(p, e);
        results.push(`${m.icon} ${m.label}: ❌ ${e.message.slice(0, 300)}`);
      }
    }
    await ctx.telegram.editMessageText(chat, st.message_id, undefined, `🏁 <b>${esc(title(j.release))}</b>\n\n${results.map(esc).join('\n')}`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch(() => ctx.reply(results.join('\n')));
  }

  async function sendManual(ctx, p, r, j) {
    const m = PLATFORMS[p];
    const size = fs.existsSync(r.file) ? fs.statSync(r.file).size : Infinity;
    const cap = `${m.icon} ${m.label} — archivo listo.\nEnlace (4 h): ${r.link}\nGuardado en Dropbox: ${r.dropboxPath}`;
    if (size < 49 * 1024 * 1024) {
      const isVideo = /\.mp4$/i.test(r.file);
      await (isVideo ? ctx.replyWithVideo({ source: r.file }, { caption: cap, supports_streaming: true }) : ctx.replyWithDocument({ source: r.file }, { caption: cap })).catch(() => ctx.reply(cap));
    } else {
      await ctx.reply(cap);
    }
    await ctx.reply(`Texto para ${m.label} (cópialo):`);
    await ctx.reply(mainText(p, j.caps));
  }

  return bot;
}

function slotName(s) { return { video: '🎬 Vídeo', audio: '🎵 Audio', image: '🖼 Portada' }[s]; }
function base(p) { return p ? p.split('/').pop() : ''; }
function title(r) { return [r.catalog, r.artist, r.title].filter(Boolean).join(' · ') || r.name; }

export function cardText(j) {
  const r = j.release;
  const counts = {};
  for (const f of r.files) counts[f.role] = (counts[f.role] || 0) + 1;
  const found = Object.entries(counts).map(([k, v]) => `${ROLE_LABEL[k] || k} ×${v}`).join(' · ') || 'carpeta vacía';
  const done = history.get(r.id);
  const lines = Object.entries(PLATFORMS).map(([p, m]) => {
    const c = j.choice[p];
    const src = c.video ? `vídeo: ${short(base(c.video), 30)}` : (c.image && c.audio && p !== 'soundcloud') ? `portada+audio → vídeo` : '';
    const src2 = p === 'soundcloud' ? `audio: ${short(base(c.audio) || '—', 34)}` : src || '⚠️ faltan archivos';
    const how = isConfigured(p) ? '' : ' · manual';
    const was = done[p] ? ' · ya subido ✔' : '';
    return `${j.selected[p] ? '✅' : '⬜'} ${m.icon} <b>${m.label}</b>${how}${was}\n      ${esc(src2)}`;
  });
  return `📀 <b>${esc(title(r))}</b>\n<i>${esc(r.path)}</i>\n\nEncontrado: ${esc(found)}\n\n${lines.join('\n')}`;
}

export function cardKb(id) {
  const j = jobs.get(id);
  const t = (p) => Markup.button.callback(`${j.selected[p] ? '✅' : '⬜'} ${PLATFORMS[p].label.split(' ')[0]}`, `tog:${id}:${p}`);
  return Markup.inlineKeyboard([
    [t('youtube'), t('instagram')],
    [t('tiktok'), t('soundcloud')],
    [Markup.button.callback(`YouTube: ${PRIV_LABEL[j.privacy]}`, `priv:${id}`)],
    [Markup.button.callback('🗂 Cambiar archivos', `files:${id}`), Markup.button.callback('📝 Textos', `texts:${id}`)],
    [Markup.button.callback('🚀 Preparar y publicar', `go:${id}`)],
  ]);
}

export function statusText() {
  const rows = Object.entries(PLATFORMS).map(([p, m]) => `${m.icon} ${m.label}: ${isConfigured(p) ? '🟢 conectado' : '⚪ manual (te preparo el archivo)'}`);
  return `<b>Estado</b>\n📦 Dropbox: ${config.dropbox.refreshToken ? '🟢' : '🔴 falta'}\n📂 ${esc(config.dropbox.root)}\n${rows.join('\n')}\n🤖 Textos IA: ${config.anthropic.key ? '🟢' : '⚪ plantillas'}`;
}

export async function announce(bot, folder, chatId) {
  await bot.telegram.sendMessage(chatId, `🆕 <b>Nuevo lanzamiento en Dropbox</b>\n${esc(folder.name)}\n<i>${esc(folder.season || '')}</i>`, {
    parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📀 Abrir y preparar', `open:${ref(folder)}`)]]),
  });
}

export { jobs, refs, ref };
