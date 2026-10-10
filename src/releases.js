import { config } from './config.js';
import * as dbx from './dropbox.js';
import { load, save } from './store.js';

const AUDIO = /\.(wav|mp3|flac|aiff?|m4a)$/i;
const IMAGE = /\.(png|jpe?g|webp)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm)$/i;

// "BNR 070 - Exeqtionerz & Brain Damage - Voices In The Chaos"
// "BNR 062 Releaser - The Feeling", "BNR 072 - DJ NANDO - GABBER FOR GLORY (MASTERS)"
export function parseReleaseName(name) {
  const m = name.match(/^\s*([A-Z]{2,5})\s*[-_ ]?\s*0*(\d{1,4})\s*[-–—]?\s*(.*)$/i);
  if (!m) return { catalog: '', artist: '', title: name.trim(), raw: name };
  const catalog = `${m[1].toUpperCase()} ${m[2].padStart(3, '0')}`;
  const rest = m[3].replace(/\((masters?|final|wav|mastered)\)/gi, '').replace(/\s+/g, ' ').trim();
  const parts = rest.split(/\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
  let artist = '', title = '';
  if (parts.length >= 2) { artist = parts[0]; title = parts.slice(1).join(' - '); }
  else { title = parts[0] || ''; }
  return { catalog, artist: smartCase(artist), title: smartCase(title), raw: name };
}

// "GABBER FOR GLORY" → "Gabber For Glory"; leaves mixed-case names alone ("DJ" stays "DJ").
function smartCase(s) {
  if (!s || s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bDj\b/g, 'DJ').replace(/\bMc\b/g, 'MC');
}

export function classify(file) {
  const n = file.name.toLowerCase();
  const p = (file.path || '').toLowerCase();
  if (AUDIO.test(n)) {
    if (/video|teaser|preview|snippet|clip/.test(n)) return 'audio_short';
    if (/extended|original mix/.test(n)) return 'audio_extended';
    if (/radio/.test(n)) return 'audio_radio';
    if (/stem|acapella|acappella|instrumental/.test(n)) return 'audio_other';
    return 'audio_master';
  }
  if (IMAGE.test(n)) {
    if (/stor(y|ies)|9[-x:]16|vertical|reel/.test(n)) return 'image_vertical';
    if (/4[-x:]3|16[-x:]9|wide|youtube|banner|header/.test(n)) return 'image_wide';
    return 'image_square';
  }
  if (VIDEO.test(n)) {
    if (/canvas/.test(n)) return 'video_canvas';
    if (/stor(y|ies)|reel|tiktok|vertical|9[-x:]16|short/.test(n)) return 'video_vertical';
    if (/youtube|wide|hd|16[-x:]9|landscape|send/.test(n) || /\/videos\//.test(p)) return 'video_wide';
    return 'video_other';
  }
  return 'other';
}

export const ROLE_LABEL = {
  audio_extended: '🎵 Extended', audio_master: '🎵 Master', audio_radio: '🎵 Radio edit', audio_short: '🎵 Audio vídeo',
  audio_other: '🎵 Otro audio', image_square: '🖼 Portada', image_vertical: '🖼 Portada stories', image_wide: '🖼 Portada horizontal',
  video_vertical: '🎬 Vídeo vertical', video_wide: '🎬 Vídeo horizontal', video_canvas: '🎬 Canvas', video_other: '🎬 Vídeo', other: '📄 Otro',
};

// Score helpers: prefer files higher in the tree and bigger ones (finished renders tend to be larger).
function pick(files, roles, prefer = []) {
  const cands = files.filter((f) => roles.includes(f.role));
  if (!cands.length) return null;
  const score = (f) => {
    let s = 0;
    roles.forEach((r, i) => { if (f.role === r) s += (roles.length - i) * 1000; });
    prefer.forEach((re, i) => { if (re.test(f.name.toLowerCase())) s += (prefer.length - i) * 100; });
    s -= f.depth * 10;
    s += Math.min(f.size / 1e8, 9);
    return s;
  };
  return [...cands].sort((a, b) => score(b) - score(a))[0];
}

// Default file choice per platform. The user can change any of them in Telegram.
export function plan(files) {
  const cover = pick(files, ['image_square', 'image_wide', 'image_vertical']);
  const coverV = pick(files, ['image_vertical', 'image_square']);
  const coverW = pick(files, ['image_wide', 'image_square']);
  const full = pick(files, ['audio_extended', 'audio_master', 'audio_radio']);
  const short = pick(files, ['audio_short', 'audio_radio', 'audio_master', 'audio_extended']);
  const vWide = pick(files, ['video_wide', 'video_other'], [/youtube/, /hd/, /audio/, /send/]);
  const vVert = pick(files, ['video_vertical'], [/audio/, /reel/, /^stories\.mp4$/]);
  return {
    youtube: { video: vWide?.path || null, audio: full?.path || null, image: coverW?.path || null },
    instagram: { video: vVert?.path || null, audio: short?.path || null, image: coverV?.path || null },
    tiktok: { video: vVert?.path || null, audio: short?.path || null, image: coverV?.path || null },
    soundcloud: { audio: full?.path || null, image: cover?.path || null },
  };
}

export async function scanRelease(folder) {
  const all = await dbx.listFolder(folder.path, { recursive: true });
  const base = folder.path.toLowerCase();
  const files = all
    .filter((x) => x.tag === 'file')
    .map((x) => {
      const rel = x.path.slice(folder.path.length + 1);
      return { ...x, rel, depth: rel.split('/').length - 1, role: classify(x) };
    })
    .filter((x) => x.path.toLowerCase().startsWith(base));
  return { ...parseReleaseName(folder.name), id: folder.id, name: folder.name, path: folder.path, season: folder.season, files, plan: plan(files) };
}

// Lists "Season X/<release>" folders (also accepts releases placed directly in the root).
export async function listReleases() {
  const top = await dbx.listFolder(config.dropbox.root);
  const out = [];
  for (const d of top.filter((x) => x.tag === 'folder')) {
    if (/^season\s*\d+/i.test(d.name)) {
      const inner = await dbx.listFolder(d.path);
      for (const r of inner.filter((x) => x.tag === 'folder')) out.push({ ...r, season: d.name });
    } else {
      out.push({ ...d, season: '' });
    }
  }
  return out.sort((a, b) => sortKey(b.name) - sortKey(a.name) || a.name.localeCompare(b.name));
}

function sortKey(name) { const m = name.match(/\d{2,4}/); return m ? Number(m[0]) : 0; }

// Returns release folders not seen before. The first run only records what exists (no spam).
export async function detectNew() {
  const state = load('seen', { initialized: false, ids: [] });
  const list = await listReleases();
  const seen = new Set(state.ids);
  const fresh = state.initialized ? list.filter((r) => !seen.has(r.id)) : [];
  save('seen', { initialized: true, ids: list.map((r) => r.id) });
  return fresh;
}
