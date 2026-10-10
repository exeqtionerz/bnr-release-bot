import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function run(cmd, args, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 200_000) err = err.slice(-50_000);
      if (onProgress) { const m = String(d).match(/time=(\d+):(\d+):(\d+\.\d+)/); if (m) onProgress(+m[1] * 3600 + +m[2] * 60 + +m[3]); }
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} falló (${code}): ${err.slice(-800)}`))));
  });
}

export async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file]);
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  return {
    duration: Number(j.format?.duration) || 0,
    hasAudio: j.streams.some((s) => s.codec_type === 'audio'),
    hasVideo: !!v,
    width: v?.width || 0,
    height: v?.height || 0,
  };
}

const H264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-preset', 'veryfast'];
const AAC = ['-c:a', 'aac', '-b:a', '320k', '-ar', '48000'];
const FAST = ['-movflags', '+faststart'];

// Where to start a short clip taken from a full track: skip the intro, land near the first drop.
export function clipStart(duration, clipLen) {
  if (duration <= clipLen + 5) return 0;
  return Math.max(0, Math.min(Math.round(duration * 0.3), Math.floor(duration - clipLen - 2)));
}

// Still cover over a blurred, darkened copy of itself + audio → video (W×H).
export async function renderStill({ image, audio, out, w, h, start = 0, duration = 0, fps = 24, onProgress }) {
  const side = Math.min(w, h) - Math.round(Math.min(w, h) * (w > h ? 0.12 : 0.1));
  const filter =
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=28:2,eq=brightness=-0.18[bg];` +
    `[0:v]scale=${side}:${side}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]`;
  const args = ['-y', '-loop', '1', '-framerate', String(fps), '-i', image];
  if (start) args.push('-ss', String(start));
  if (duration) args.push('-t', String(duration));
  args.push('-i', audio, '-filter_complex', filter, '-map', '[v]', '-map', '1:a', ...H264, '-tune', 'stillimage', '-r', String(fps), ...AAC);
  if (duration) args.push('-af', `afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, duration - 1.5)}:d=1.5`);
  args.push('-shortest', ...FAST, out);
  await run('ffmpeg', args, { onProgress });
  return out;
}

// Any video → 1080×1920 vertical (letterboxed on blur if needed), max length, guaranteed audio.
export async function fitVertical({ video, audio, out, maxDuration = 90, audioStart = 0, onProgress }) {
  const info = await probe(video);
  const useExt = !info.hasAudio && audio;
  const dur = Math.min(info.duration || maxDuration, maxDuration);
  const filter =
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.15[bg];` +
    `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p[v]`;
  const args = ['-y', '-i', video];
  if (useExt) { if (audioStart) args.push('-ss', String(audioStart)); args.push('-i', audio); }
  args.push('-t', String(dur), '-filter_complex', filter, '-map', '[v]');
  if (useExt) args.push('-map', '1:a');
  else if (info.hasAudio) args.push('-map', '0:a');
  else throw new Error('El vídeo no tiene audio y no hay audio para añadirle.');
  args.push(...H264, ...AAC, '-shortest', ...FAST, out);
  await run('ffmpeg', args, { onProgress });
  return out;
}

// Landscape video for YouTube. Re-uses the stream untouched when it already has audio.
export async function prepareWide({ video, audio, out, onProgress }) {
  const info = await probe(video);
  if (info.hasAudio) {
    if (/\.mp4$/i.test(video)) return video;
    await run('ffmpeg', ['-y', '-i', video, '-c', 'copy', ...FAST, out], { onProgress });
    return out;
  }
  if (!audio) throw new Error('El vídeo no tiene audio y no hay audio para añadirle.');
  await run('ffmpeg', ['-y', '-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...AAC, '-shortest', ...FAST, out], { onProgress });
  return out;
}

// Square JPEG ≤ 2 MB for SoundCloud/YouTube thumbnails.
export async function coverJpeg({ image, out, size = 1400 }) {
  await run('ffmpeg', ['-y', '-i', image, '-vf', `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`, '-q:v', '3', out]);
  return out;
}

// 1280×720 JPEG thumbnail for YouTube (max 2 MB).
export async function thumbJpeg({ image, out }) {
  const f = `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,boxblur=24:2,eq=brightness=-0.18[bg];[0:v]scale=640:640:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  await run('ffmpeg', ['-y', '-i', image, '-filter_complex', f, '-q:v', '4', out]);
  return out;
}

export function tmpPath(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name.replace(/[^\w.\- ]+/g, '_'));
}
