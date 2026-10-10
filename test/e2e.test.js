// End-to-end: fake Dropbox + fake YouTube/SoundCloud/Instagram/TikTok (stubbed fetch), real ffmpeg, fake Telegram.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'bnrbot-'));
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_OWNER_ID: '42',
  DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's', DROPBOX_REFRESH_TOKEN: 'r',
  DROPBOX_RELEASES_ROOT: '/BNR RELEASES', DROPBOX_OUTPUT_DIR: '/BNR BOT',
  YOUTUBE_CLIENT_ID: 'y', YOUTUBE_CLIENT_SECRET: 'y', YOUTUBE_REFRESH_TOKEN: 'y',
  SOUNDCLOUD_CLIENT_ID: 'c', SOUNDCLOUD_CLIENT_SECRET: 'c', SOUNDCLOUD_REFRESH_TOKEN: 'c0',
  TIKTOK_CLIENT_KEY: 't', TIKTOK_CLIENT_SECRET: 't', TIKTOK_REFRESH_TOKEN: 't0',
  DATA_DIR: path.join(W, 'data'), TMP_DIR: path.join(W, 'tmp'), REEL_MAX_SECONDS: '8',
});

// ── fixtures made with ffmpeg ──
const FX = path.join(W, 'fx');
fs.mkdirSync(FX);
const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
before(() => {
  ff('-f', 'lavfi', '-i', 'color=c=red:s=1500x1500', '-frames:v', '1', path.join(FX, 'cover.png'));
  ff('-f', 'lavfi', '-i', 'color=c=blue:s=1080x1920', '-frames:v', '1', path.join(FX, 'stories.png'));
  ff('-f', 'lavfi', '-i', 'sine=f=220:d=20', '-ar', '44100', path.join(FX, 'full.wav'));
  ff('-f', 'lavfi', '-i', 'sine=f=440:d=6', '-ar', '44100', path.join(FX, 'short.wav'));
  ff('-f', 'lavfi', '-i', 'testsrc=s=720x1280:d=5:r=30', '-pix_fmt', 'yuv420p', path.join(FX, 'Stories.mp4')); // no audio
});

const REL = '/BNR RELEASES/Season 4/BNR 099 - Test Artist & Other - Test Track';
const TREE = {
  '/BNR RELEASES': [{ '.tag': 'folder', name: 'Season 4', path_display: '/BNR RELEASES/Season 4', id: 'id:s4' }],
  '/BNR RELEASES/Season 4': [{ '.tag': 'folder', name: 'BNR 099 - Test Artist & Other - Test Track', path_display: REL, id: 'id:r99' }],
};
const FILES = {
  [`${REL}/Cover.png`]: 'cover.png',
  [`${REL}/Cover/Test Stories.png`]: 'stories.png',
  [`${REL}/Test Track (Extended Mix).wav`]: 'full.wav',
  [`${REL}/Test Track - Video.wav`]: 'short.wav',
  [`${REL}/videos/Stories.mp4`]: 'Stories.mp4',
};

const calls = [];
const uploaded = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
  const body = async () => { const b = opts.body; if (!b) return Buffer.alloc(0); if (Buffer.isBuffer(b) || b instanceof Uint8Array) return Buffer.from(b); if (b instanceof Blob) return Buffer.from(await b.arrayBuffer()); return Buffer.from(String(b)); };
  calls.push(url.replace(/\?.*/, ''));
  // Dropbox
  if (url.endsWith('/oauth2/token') && url.includes('dropbox')) return json({ access_token: 'AT', expires_in: 14400 });
  if (url.endsWith('/users/get_current_account')) return json({ name: { display_name: 'Test' }, root_info: { root_namespace_id: '1', home_namespace_id: '1' } });
  if (url.endsWith('/files/list_folder')) {
    const { path: p, recursive } = JSON.parse(opts.body);
    if (recursive) {
      return json({ has_more: false, entries: Object.entries(FILES).filter(([k]) => k.startsWith(p + '/')).map(([k, v]) => ({ '.tag': 'file', name: k.split('/').pop(), path_display: k, id: 'id:' + v, size: fs.statSync(path.join(FX, v)).size })) });
    }
    return json({ has_more: false, entries: TREE[p] || [] });
  }
  if (url.endsWith('/files/download')) {
    const { path: p } = JSON.parse(opts.headers['Dropbox-API-Arg'].replace(/\\u([0-9a-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
    return new Response(fs.readFileSync(path.join(FX, FILES[p])));
  }
  if (url.endsWith('/upload_session/start')) { uploaded.cur = [await body()]; return json({ session_id: 'S' }); }
  if (url.endsWith('/upload_session/append_v2')) { uploaded.cur.push(await body()); return json({}); }
  if (url.endsWith('/upload_session/finish')) {
    const arg = JSON.parse(opts.headers['Dropbox-API-Arg']);
    uploaded[arg.commit.path] = Buffer.concat(uploaded.cur).length;
    return json({ path_display: arg.commit.path });
  }
  if (url.endsWith('/files/get_temporary_link')) return json({ link: 'https://dl.dropbox.test/x' });
  // YouTube
  if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'YT' });
  if (url.includes('/upload/youtube/v3/videos')) return new Response(null, { status: 200, headers: { location: 'https://yt.test/session' } });
  if (url === 'https://yt.test/session') { const b = await body(); uploaded.youtube = (uploaded.youtube || 0) + b.length; return json({ id: 'VID123' }); }
  if (url.includes('/thumbnails/set')) return json({});
  // SoundCloud
  if (url === 'https://secure.soundcloud.com/oauth/token') return json({ access_token: 'SC', refresh_token: 'c1' });
  if (url === 'https://api.soundcloud.com/tracks') {
    const f = opts.body; uploaded.soundcloud = { title: f.get('track[title]'), asset: f.get('track[asset_data]').size, art: !!f.get('track[artwork_data]') };
    return json({ id: 7, permalink_url: 'https://soundcloud.com/bnr/test' });
  }
  // TikTok
  if (url === 'https://open.tiktokapis.com/v2/oauth/token/') return json({ access_token: 'TT', refresh_token: 't1' });
  if (url.includes('/inbox/video/init/')) { uploaded.tiktokInit = JSON.parse(opts.body); return json({ data: { upload_url: 'https://tt.test/up', publish_id: 'P1' }, error: { code: 'ok' } }); }
  if (url === 'https://tt.test/up') { uploaded.tiktok = (await body()).length; return new Response(null, { status: 201 }); }
  if (url.startsWith('https://api.telegram.org')) throw new Error('telegram should be stubbed');
  return realFetch(url, opts);
};

const sent = [];
let bot;
let upd = 0;
async function send(update) { await bot.handleUpdate({ update_id: ++upd, ...update }); }
const from = { id: 42, is_bot: false, first_name: 'M' };
const chat = { id: 42, type: 'private' };
const msg = (text) => send({ message: { message_id: upd + 1000, date: 0, chat, from, text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}) } });
const click = (data) => send({ callback_query: { id: String(upd), from, chat_instance: 'c', data, message: { message_id: 1, date: 0, chat, text: 'x' } } });
const lastKb = () => [...sent].reverse().find((s) => s.payload.reply_markup?.inline_keyboard)?.payload.reply_markup.inline_keyboard.flat() || [];
const button = (re) => lastKb().find((b) => re.test(b.text));

test('full release flow in Telegram', { timeout: 240_000 }, async () => {
  const { createBot } = await import('../src/bot.js');
  bot = createBot();
  bot.botInfo = { id: 1, is_bot: true, username: 'bnr_test_bot', first_name: 'BNR' };
  const { Telegram } = await import('telegraf');
  Telegram.prototype.callApi = async function (method, payload) {
    sent.push({ method, payload });
    return method === 'sendMessage' || method.startsWith('send') ? { message_id: sent.length, chat, date: 0, text: payload.text } : true;
  };

  // Strangers are ignored
  await send({ message: { message_id: 1, date: 0, chat: { id: 9, type: 'private' }, from: { id: 9, first_name: 'X' }, text: 'hola' } });
  assert.match(sent.at(-1).payload.text, /privado/i);

  await msg('/start');
  assert.match(sent.at(-1).payload.text, /BNR Release Bot/);

  await click('rel:0');
  const relBtn = button(/BNR 099/);
  assert.ok(relBtn, 'release listed');

  await click(relBtn.callback_data);
  const card = sent.filter((s) => s.method === 'editMessageText').at(-1).payload.text;
  assert.match(card, /BNR 099 · Test Artist &amp; Other · Test Track/);
  assert.match(card, /Stories\.mp4/);
  const jobId = button(/Preparar y publicar/).callback_data.split(':')[1];

  // Edit the TikTok text
  await click(`edit:${jobId}:tiktok`);
  await msg('Nuevo texto TikTok #bnr');
  assert.match(sent.find((s) => /actualizado/.test(s.payload.text || ''))?.payload.text, /TikTok/);

  // Instagram is not configured → manual mode (file goes to Dropbox + Telegram)
  await click(`go:${jobId}`);
  assert.match(sent.at(-1).payload.text, /Instagram Reel: te lo dejo listo/);
  await click(`yes:${jobId}`);

  const final = sent.filter((s) => s.method === 'editMessageText').at(-1).payload.text;
  console.log(final);
  assert.match(final, /YouTube: ✅ https:\/\/youtu\.be\/VID123/);
  assert.match(final, /SoundCloud: ✅ https:\/\/soundcloud\.com\/bnr\/test/);
  assert.match(final, /TikTok: enviado como borrador/);
  assert.match(final, /Instagram Reel: listo para subir a mano/);

  // Uploaded payloads look right
  assert.ok(uploaded.youtube > 10_000, 'youtube got a real video');
  assert.equal(uploaded.soundcloud.title, 'Test Artist & Other - Test Track');
  assert.ok(uploaded.soundcloud.asset > 1_000_000 && uploaded.soundcloud.art);
  assert.equal(uploaded.tiktokInit.source_info.video_size, uploaded.tiktok);
  assert.ok(uploaded['/BNR BOT/BNR 099/instagram.mp4'] > 10_000);
  assert.ok(sent.some((s) => s.method === 'sendVideo'), 'manual reel sent to Telegram');
  assert.ok(sent.some((s) => s.payload.text === 'Nuevo texto TikTok #bnr'), 'edited TikTok text sent for copy');

  // Rotated refresh tokens persisted
  const tok = JSON.parse(fs.readFileSync(path.join(W, 'data', 'tokens.json'), 'utf8'));
  assert.equal(tok.soundcloud.refreshToken, 'c1');
  assert.equal(tok.tiktok.refreshToken, 't1');

  // Generated vertical video: 1080×1920, has audio, capped to REEL_MAX_SECONDS
  const { probe } = await import('../src/media.js');
  const v = await probe(path.join(W, 'tmp', 'BNR_099', 'vertical.mp4'));
  assert.equal(v.width, 1080); assert.equal(v.height, 1920); assert.ok(v.hasAudio); assert.ok(v.duration <= 8.5);
  const y = await probe(path.join(W, 'tmp', 'BNR_099', 'youtube.mp4'));
  assert.ok(y.hasAudio && y.hasVideo);

  // History marks it as done
  await click(relBtn.callback_data);
  assert.match(sent.filter((s) => s.method === 'editMessageText').at(-1).payload.text, /ya subido/);
});

test('new-release watcher only announces folders that appear later', async () => {
  const { detectNew } = await import('../src/releases.js');
  fs.rmSync(path.join(W, 'data', 'seen.json'), { force: true });
  assert.equal((await detectNew()).length, 0); // first run just records
  TREE['/BNR RELEASES/Season 4'].push({ '.tag': 'folder', name: 'BNR 100 - New - One', path_display: '/BNR RELEASES/Season 4/BNR 100 - New - One', id: 'id:r100' });
  const fresh = await detectNew();
  assert.deepEqual(fresh.map((f) => f.name), ['BNR 100 - New - One']);
  assert.equal((await detectNew()).length, 0);
});

test('still render for YouTube when no video exists', { timeout: 120_000 }, async () => {
  const { prepare } = await import('../src/pipeline.js');
  const { probe } = await import('../src/media.js');
  const release = { catalog: 'BNR 101', name: 'x', id: 'id:x' };
  const r = await prepare('youtube', release, { video: null, audio: `${REL}/Test Track (Extended Mix).wav`, image: `${REL}/Cover.png` });
  const p = await probe(r.file);
  assert.equal(p.width, 1920); assert.equal(p.height, 1080); assert.ok(p.hasAudio);
  assert.ok(Math.abs(p.duration - 20) < 1.5);
  assert.ok(fs.existsSync(r.thumbnail));
});
