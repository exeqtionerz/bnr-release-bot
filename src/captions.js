import { config, enabled } from './config.js';

const PLATFORMS = ['youtube', 'instagram', 'tiktok', 'soundcloud'];

function tagify(s) { return '#' + s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase(); }

function artistTags(artist) {
  return artist.split(/\s*(?:&|,|\bx\b|\bft\.?|\bfeat\.?|\bvs\.?)\s*/i).filter(Boolean).map(tagify).join(' ');
}

export function templateCaptions(r) {
  const who = r.artist || r.label || config.label.name;
  const title = r.title || r.name;
  const full = r.artist ? `${r.artist} - ${title}` : title;
  const cat = r.catalog ? ` [${r.catalog}]` : '';
  const tags = `${artistTags(who)} ${config.label.hashtags}`.trim();
  const label = config.label.name;
  return {
    youtube: {
      title: `${full}${cat}`.slice(0, 100),
      description:
        `${full} — out now on ${label}.\n\n` +
        `▶ Stream / download: ${config.label.links}\n\n` +
        `Catalog: ${r.catalog || '-'}\nArtist: ${who}\nLabel: ${label}\n\n${tags}`,
      tags: [...new Set([...who.split(/\s*&\s*|,\s*/), label, 'hardcore', 'uptempo', 'gabber', 'hardcore techno'])].filter(Boolean),
    },
    instagram: { caption: `🔥 OUT NOW 🔥\n${full}${cat}\n\nAvailable on all platforms — link in bio.\n\n${tags}` },
    tiktok: { caption: `${full} 🔥 OUT NOW on ${label} ${tags}`.slice(0, 2200) },
    soundcloud: {
      title: full,
      description: `${full}${cat}\nOut now on ${label}.\n${config.label.links}`,
      tags: `hardcore uptempo gabber "${label}" ${who.split(/\s*&\s*|,\s*/).map((a) => `"${a}"`).join(' ')}`,
      genre: 'Hardcore',
    },
  };
}

// Optional: let Claude write the copy. Falls back to templates on any error.
export async function captions(r) {
  const base = templateCaptions(r);
  if (!enabled.ai()) return base;
  try {
    const prompt =
      `You write release copy for the hardcore/uptempo label ${config.label.name}. Tone: hard, energetic, short, English. ` +
      `Never call the music "extreme hardcore"; say "hardcore & uptempo". No invented facts (no dates, BPM or quotes you were not given).\n` +
      `Release: catalog "${r.catalog}", artist "${r.artist}", title "${r.title}".\n` +
      `Links: ${config.label.links}. Always include these hashtags: ${config.label.hashtags}.\n` +
      `Return ONLY JSON with exactly this shape: ${JSON.stringify(base)}\n` +
      `Keep YouTube title ≤100 chars, TikTok caption ≤300 chars, Instagram caption ≤600 chars.`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': config.anthropic.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.anthropic.model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await res.json();
    const text = j.content?.[0]?.text || '';
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    for (const p of PLATFORMS) base[p] = { ...base[p], ...(parsed[p] || {}) };
    base.youtube.title = String(base.youtube.title).slice(0, 100);
    return base;
  } catch {
    return base;
  }
}

// The single editable text for each platform shown in Telegram.
export function mainText(platform, c) {
  if (platform === 'youtube') return `${c.youtube.title}\n---\n${c.youtube.description}`;
  if (platform === 'soundcloud') return `${c.soundcloud.title}\n---\n${c.soundcloud.description}`;
  return c[platform].caption;
}

export function applyEdit(platform, c, text) {
  if (platform === 'youtube' || platform === 'soundcloud') {
    const [title, ...rest] = text.split(/\n-{3,}\n/);
    c[platform].title = title.trim().slice(0, 100);
    if (rest.length) c[platform].description = rest.join('\n---\n').trim();
  } else {
    c[platform].caption = text.trim();
  }
  return c;
}
