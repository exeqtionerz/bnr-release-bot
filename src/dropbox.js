import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from './config.js';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

let access = { token: '', exp: 0 };
let pathRoot = null; // set for team accounts so paths resolve from the team root

// Header values must be ASCII; Dropbox wants non-ASCII escaped as \uXXXX.
export function headerJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

async function token() {
  if (access.token && Date.now() < access.exp - 60_000) return access.token;
  const { appKey, appSecret, refreshToken } = config.dropbox;
  if (!appKey || !refreshToken) throw new Error('Dropbox no está configurado (DROPBOX_APP_KEY / DROPBOX_REFRESH_TOKEN).');
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey, client_secret: appSecret }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Dropbox token: ${j.error_description || res.status}`);
  access = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  if (pathRoot === null) await detectPathRoot();
  return access.token;
}

async function detectPathRoot() {
  pathRoot = '';
  try {
    const res = await fetch(`${API}/users/get_current_account`, { method: 'POST', headers: { Authorization: `Bearer ${access.token}` } });
    const j = await res.json();
    const ri = j.root_info;
    if (ri && ri.root_namespace_id && ri.root_namespace_id !== ri.home_namespace_id) {
      pathRoot = headerJson({ '.tag': 'root', root: ri.root_namespace_id });
    }
  } catch { /* personal account: no path root needed */ }
}

async function headers(extra = {}) {
  const h = { Authorization: `Bearer ${await token()}`, ...extra };
  if (pathRoot) h['Dropbox-API-Path-Root'] = pathRoot;
  return h;
}

async function rpc(endpoint, body) {
  const res = await fetch(`${API}/${endpoint}`, {
    method: 'POST',
    headers: await headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Dropbox ${endpoint}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

export async function listFolder(p, { recursive = false } = {}) {
  let r = await rpc('files/list_folder', { path: p, recursive, include_mounted_folders: true, limit: 2000 });
  const entries = [...r.entries];
  while (r.has_more) {
    r = await rpc('files/list_folder/continue', { cursor: r.cursor });
    entries.push(...r.entries);
  }
  return entries.map((x) => ({
    tag: x['.tag'],
    name: x.name,
    path: x.path_display || x.path_lower,
    id: x.id,
    size: x.size || 0,
    modified: x.server_modified || x.client_modified || '',
  }));
}

export async function temporaryLink(p) {
  const r = await rpc('files/get_temporary_link', { path: p });
  return r.link;
}

export async function download(p, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(`${CONTENT}/files/download`, {
    method: 'POST',
    headers: await headers({ 'Dropbox-API-Arg': headerJson({ path: p }) }),
  });
  if (!res.ok) throw new Error(`Dropbox download ${p}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return dest;
}

// Chunked upload session — works for any size (Dropbox single-call limit is 150 MB).
export async function upload(local, dropboxPath) {
  const CHUNK = 8 * 1024 * 1024;
  const size = fs.statSync(local).size;
  const fd = fs.openSync(local, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let offset = 0;
    let n = fs.readSync(fd, buf, 0, CHUNK, 0);
    const start = await fetch(`${CONTENT}/files/upload_session/start`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerJson({ close: false }) }),
      body: buf.subarray(0, n),
    });
    if (!start.ok) throw new Error(`Dropbox upload start: ${start.status} ${await start.text()}`);
    const { session_id } = await start.json();
    offset += n;
    while (offset < size) {
      n = fs.readSync(fd, buf, 0, CHUNK, offset);
      const r = await fetch(`${CONTENT}/files/upload_session/append_v2`, {
        method: 'POST',
        headers: await headers({ 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerJson({ cursor: { session_id, offset }, close: false }) }),
        body: buf.subarray(0, n),
      });
      if (!r.ok) throw new Error(`Dropbox upload append: ${r.status} ${await r.text()}`);
      offset += n;
    }
    const fin = await fetch(`${CONTENT}/files/upload_session/finish`, {
      method: 'POST',
      headers: await headers({
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': headerJson({ cursor: { session_id, offset }, commit: { path: dropboxPath, mode: 'overwrite', mute: true } }),
      }),
    });
    if (!fin.ok) throw new Error(`Dropbox upload finish: ${fin.status} ${await fin.text()}`);
    return (await fin.json()).path_display;
  } finally {
    fs.closeSync(fd);
  }
}

export async function whoami() {
  const res = await fetch(`${API}/users/get_current_account`, { method: 'POST', headers: await headers() });
  if (!res.ok) throw new Error(`Dropbox: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
