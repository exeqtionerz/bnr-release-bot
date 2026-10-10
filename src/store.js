import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Small JSON-file store. Survives restarts; one file per "table".
fs.mkdirSync(config.dataDir, { recursive: true });

function file(name) { return path.join(config.dataDir, `${name}.json`); }

export function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return structuredClone(fallback); }
}

export function save(name, value) {
  const f = file(name);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, f);
}

// Rotated OAuth tokens (TikTok/SoundCloud rotate refresh tokens) live here and win over .env.
export const tokens = {
  get(service, key, envValue) {
    const t = load('tokens', {});
    return t[service]?.[key] || envValue;
  },
  set(service, values) {
    const t = load('tokens', {});
    t[service] = { ...(t[service] || {}), ...values, updatedAt: new Date().toISOString() };
    save('tokens', t);
  },
};

// Log of what was published where, per release.
export const history = {
  all() { return load('history', {}); },
  add(releaseId, platform, entry) {
    const h = load('history', {});
    (h[releaseId] ||= {})[platform] = { ...entry, at: new Date().toISOString() };
    save('history', h);
  },
  get(releaseId) { return load('history', {})[releaseId] || {}; },
};
