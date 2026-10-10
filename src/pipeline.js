import fs from 'node:fs';
import path from 'node:path';
import { config, enabled } from './config.js';
import * as dbx from './dropbox.js';
import * as media from './media.js';
import { history } from './store.js';
import * as youtube from './platforms/youtube.js';
import * as instagram from './platforms/instagram.js';
import * as tiktok from './platforms/tiktok.js';
import * as soundcloud from './platforms/soundcloud.js';

export const PLATFORMS = {
  youtube: { label: 'YouTube', icon: '▶️', slots: ['video', 'audio', 'image'] },
  instagram: { label: 'Instagram Reel', icon: '📸', slots: ['video', 'audio', 'image'] },
  tiktok: { label: 'TikTok', icon: '🎵', slots: ['video', 'audio', 'image'] },
  soundcloud: { label: 'SoundCloud', icon: '☁️', slots: ['audio', 'image'] },
};

export const SLOT_FILTER = {
  video: (f) => f.role.startsWith('video_'),
  audio: (f) => f.role.startsWith('audio_'),
  image: (f) => f.role.startsWith('image_'),
};

export function isConfigured(platform) { return enabled[platform](); }

function workDir(release) {
  const d = path.join(config.tmpDir, (release.catalog || release.name).replace(/[^\w-]+/g, '_'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Downloads each Dropbox file once per release folder.
async function local(release, dropboxPath) {
  if (!dropboxPath) return null;
  const dest = path.join(workDir(release), 'src', path.basename(dropboxPath));
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  return dbx.download(dropboxPath, dest);
}

// Builds the final file(s) for one platform from the chosen sources.
export async function prepare(platform, release, choice, log = () => {}) {
  const dir = workDir(release);
  const out = (n) => path.join(dir, n);
  if (platform === 'soundcloud') {
    if (!choice.audio) throw new Error('Falta el audio para SoundCloud.');
    log('Descargando audio…');
    const audio = await local(release, choice.audio);
    const img = await local(release, choice.image);
    const artwork = img ? await media.coverJpeg({ image: img, out: out('sc-artwork.jpg') }) : null;
    return { file: audio, artwork };
  }

  if (platform === 'youtube') {
    const img = await local(release, choice.image);
    const thumb = img ? await media.thumbJpeg({ image: img, out: out('yt-thumb.jpg') }) : null;
    if (choice.video) {
      log('Descargando vídeo…');
      const v = await local(release, choice.video);
      const a = choice.audio ? await local(release, choice.audio) : null;
      return { file: await media.prepareWide({ video: v, audio: a, out: out('youtube.mp4') }), thumbnail: thumb };
    }
    if (!img || !choice.audio) throw new Error('Para YouTube hace falta un vídeo, o una portada + audio.');
    log('Descargando audio…');
    const a = await local(release, choice.audio);
    log('Generando vídeo 1920×1080 con la portada…');
    return { file: await media.renderStill({ image: img, audio: a, out: out('youtube.mp4'), w: 1920, h: 1080 }), thumbnail: thumb };
  }

  // Instagram + TikTok share the same vertical file.
  const target = out('vertical.mp4');
  const key = JSON.stringify(choice);
  const keyFile = `${target}.json`;
  if (fs.existsSync(target) && fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8') === key) return { file: target };
  const max = config.reelMaxSeconds;
  const a = choice.audio ? await local(release, choice.audio) : null;
  const audioInfo = a ? await media.probe(a) : null;
  const isShort = (choice.audio || '').toLowerCase().match(/video|teaser|preview|snippet|clip/);
  const start = audioInfo && !isShort ? media.clipStart(audioInfo.duration, max) : 0;
  if (choice.video) {
    log('Descargando vídeo vertical…');
    const v = await local(release, choice.video);
    log('Adaptando a 1080×1920…');
    await media.fitVertical({ video: v, audio: a, out: target, maxDuration: max, audioStart: start });
  } else {
    const img = await local(release, choice.image);
    if (!img || !a) throw new Error('Para Reels/TikTok hace falta un vídeo vertical, o una portada + audio.');
    log(`Generando vídeo vertical de ${max}s con la portada…`);
    await media.renderStill({ image: img, audio: a, out: target, w: 1080, h: 1920, start, duration: Math.min(max, audioInfo.duration - start), fps: 30 });
  }
  fs.writeFileSync(keyFile, key);
  return { file: target };
}

// Uploads to the platform, or (if not configured) leaves the file ready in Dropbox for a manual post.
export async function publish(platform, release, prepared, caps, opts = {}, log = () => {}) {
  if (!isConfigured(platform)) {
    const ext = path.extname(prepared.file) || '.mp4';
    const dest = `${config.dropbox.outputDir}/${release.catalog || release.name}/${platform}${ext}`;
    log('Subiendo el archivo listo a Dropbox…');
    const p = await dbx.upload(prepared.file, dest);
    const link = await dbx.temporaryLink(p);
    return { manual: true, dropboxPath: p, link, file: prepared.file };
  }
  let r;
  if (platform === 'youtube') {
    r = await youtube.upload({ file: prepared.file, thumbnail: prepared.thumbnail, title: caps.youtube.title, description: caps.youtube.description, tags: caps.youtube.tags, privacy: opts.privacy, onProgress: (x) => log(`Subiendo a YouTube… ${Math.round(x * 100)}%`) });
  } else if (platform === 'soundcloud') {
    r = await soundcloud.upload({ file: prepared.file, artwork: prepared.artwork, title: caps.soundcloud.title, description: caps.soundcloud.description, tags: caps.soundcloud.tags, genre: caps.soundcloud.genre, sharing: opts.scSharing || 'public' });
  } else if (platform === 'instagram') {
    r = await instagram.uploadReel({ file: prepared.file, caption: caps.instagram.caption, onStatus: (s) => log(`Instagram procesando… (${s})`) });
  } else if (platform === 'tiktok') {
    r = await tiktok.upload({ file: prepared.file, caption: caps.tiktok.caption, mode: config.tiktok.mode });
  }
  history.add(release.id, platform, r);
  return r;
}
