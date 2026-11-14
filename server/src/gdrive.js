// Google Drive as a backup destination, authorised once by the user (OAuth 2.0 "on behalf of").
// Scope drive.file: the app can only see and manage files/folders it created itself, never the rest of the Drive.
// No SDK: plain fetch against Google's OAuth and Drive v3 endpoints (fetch is injectable for tests).
import { createHash, randomBytes } from 'node:crypto';
import { isBackupName } from './backup-names.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEVICE_URL = 'https://oauth2.googleapis.com/device/code';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
export const DEFAULT_FOLDER = 'simpleIPAM backups';

export class GoogleError extends Error {}
const short = (s) => String(s).replace(/\s+/g, ' ').slice(0, 300);

// ---------- authorisation ----------
export function newPkce() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authUrl({ clientId, redirectUri, state, challenge, scope = SCOPES, offline = true }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, state,
    code_challenge: challenge, code_challenge_method: 'S256',
    ...(offline ? { access_type: 'offline',   // we need a refresh token ...
      prompt: 'consent' } : {}),                // ... and Google only issues one when consent is shown
  });
  return `${AUTH_URL}?${q}`;
}

export async function postForm(fetch, url, params) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params), signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const emailOf = (idToken) => {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url')).email ?? ''; } catch { return ''; }
};
const failure = (data, fallback) => new GoogleError(short(data.error_description || data.error || fallback));

// Authorization-code (redirect) flow, step 2.
export async function exchangeCode(cfg, { code, redirectUri, verifier }, { fetch = globalThis.fetch } = {}) {
  const r = await postForm(fetch, TOKEN_URL, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
    client_id: cfg.client_id, client_secret: cfg.client_secret,
  });
  if (!r.ok) throw failure(r.data, `Google ${r.status}`);
  if (!r.data.refresh_token) throw new GoogleError('Google nie zwrócił refresh tokenu — cofnij dostęp aplikacji w koncie Google (myaccount.google.com/permissions) i połącz ponownie');
  return { refresh_token: r.data.refresh_token, email: emailOf(r.data.id_token) };
}

// Device-code flow (for installs that cannot register a redirect URI, e.g. plain http on a LAN address).
export async function startDevice(cfg, { fetch = globalThis.fetch } = {}) {
  const r = await postForm(fetch, DEVICE_URL, { client_id: cfg.client_id, scope: SCOPES });
  if (!r.ok) throw failure(r.data, `Google ${r.status}`);
  const { device_code, user_code, verification_url, expires_in, interval } = r.data;
  return { device_code, user_code, verification_url, expires_in, interval: interval ?? 5 };
}

export async function pollDevice(cfg, deviceCode, { fetch = globalThis.fetch } = {}) {
  const r = await postForm(fetch, TOKEN_URL, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode,
    client_id: cfg.client_id, client_secret: cfg.client_secret,
  });
  if (r.ok) {
    if (!r.data.refresh_token) throw new GoogleError('Google nie zwrócił refresh tokenu');
    return { status: 'connected', refresh_token: r.data.refresh_token, email: emailOf(r.data.id_token) };
  }
  const e = r.data.error;
  if (e === 'authorization_pending') return { status: 'pending' };
  if (e === 'slow_down') return { status: 'slow_down' };
  if (e === 'access_denied') return { status: 'denied' };
  if (e === 'expired_token') return { status: 'expired' };
  throw failure(r.data, `Google ${r.status}`);
}

export async function revoke(token, { fetch = globalThis.fetch } = {}) {
  try { await postForm(fetch, REVOKE_URL, { token }); } catch { /* best effort: it is also removed locally */ }
}

// ---------- API access ----------
const tokens = new Map();   // refresh token -> { access, exp }

async function accessToken(cfg, { fetch, now }) {
  const hit = tokens.get(cfg.refresh_token);
  if (hit && hit.exp > now.getTime() + 60_000) return hit.access;
  const r = await postForm(fetch, TOKEN_URL, {
    grant_type: 'refresh_token', refresh_token: cfg.refresh_token, client_id: cfg.client_id, client_secret: cfg.client_secret,
  });
  if (!r.ok) {
    tokens.delete(cfg.refresh_token);
    if (r.data.error === 'invalid_grant') throw new GoogleError('Autoryzacja Google wygasła lub została cofnięta — połącz konto ponownie');
    throw failure(r.data, `Google ${r.status}`);
  }
  tokens.set(cfg.refresh_token, { access: r.data.access_token, exp: now.getTime() + (r.data.expires_in ?? 3600) * 1000 });
  return r.data.access_token;
}

async function call(fetch, token, method, url, { json, body, type } = {}) {
  const res = await fetch(url, {
    method, signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : type ? { 'content-type': type } : {}) },
    body: json ? JSON.stringify(json) : body,
  });
  if (res.status === 204) return {};
  const text = await res.text();
  if (!res.ok) { const e = new GoogleError(`Google Drive ${res.status}: ${short(text)}`); e.status = res.status; throw e; }
  return text ? JSON.parse(text) : {};
}

const quote = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Finds (or creates) the backup folder by name. drive.file only lets us see folders created by this app, so a
// same-named folder the user made by hand is never touched.
async function findFolder(cfg, token, { fetch }) {
  const q = `mimeType='${FOLDER_MIME}' and name='${quote(cfg.folder_name || DEFAULT_FOLDER)}' and trashed=false`;
  const found = await call(fetch, token, 'GET', `${API}/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`);
  return found.files?.[0]?.id ?? null;
}
async function ensureFolder(cfg, token, { fetch }) {
  return (await findFolder(cfg, token, { fetch }))
    ?? (await call(fetch, token, 'POST', `${API}/files?fields=id`, { json: { name: cfg.folder_name || DEFAULT_FOLDER, mimeType: FOLDER_MIME } })).id;
}

function multipart(meta, data) {
  const b = `simpleipam-${randomBytes(12).toString('hex')}`;
  const head = Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/octet-stream\r\n\r\n`);
  return { body: Buffer.concat([head, data, Buffer.from(`\r\n--${b}--`)]), type: `multipart/related; boundary=${b}` };
}

// Keeps the newest `keep` backup files in the folder (0 = keep everything). Only files that look like our
// own backups (ipam-YYYYMMDD-HHMMSS.db) are ever deleted.
async function prune(cfg, token, folderId, { fetch }) {
  const keep = Number(cfg.keep ?? 14);
  if (!keep) return 0;
  const q = `'${folderId}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`;
  const list = await call(fetch, token, 'GET', `${API}/files?${new URLSearchParams({ q, fields: 'files(id,name)', orderBy: 'createdTime desc', pageSize: '1000' })}`);
  const stale = (list.files ?? []).filter((f) => isBackupName(f.name)).slice(keep);
  for (const f of stale) await call(fetch, token, 'DELETE', `${API}/files/${f.id}`);
  return stale.length;
}

export async function putDrive(cfg, name, body, { fetch = globalThis.fetch, now = new Date() } = {}) {
  const token = await accessToken(cfg, { fetch, now });
  const folderId = await ensureFolder(cfg, token, { fetch });
  const m = multipart({ name, parents: [folderId] }, body);
  const file = await call(fetch, token, 'POST', `${UPLOAD}/files?uploadType=multipart&fields=id`, { body: m.body, type: m.type });
  const pruned = await prune(cfg, token, folderId, { fetch }).catch(() => 0);   // retention must never fail an upload
  return { id: file.id, pruned };
}

// Backups in our Drive folder, newest first (for the restore picker).
export async function listDrive(cfg, { fetch = globalThis.fetch, now = new Date() } = {}) {
  const token = await accessToken(cfg, { fetch, now });
  const folderId = await findFolder(cfg, token, { fetch });
  if (!folderId) return [];
  const q = `'${folderId}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`;
  const list = await call(fetch, token, 'GET', `${API}/files?${new URLSearchParams({ q, fields: 'files(id,name,size,createdTime)', orderBy: 'createdTime desc', pageSize: '1000' })}`);
  return (list.files ?? []).filter((f) => isBackupName(f.name)).map((f) => ({ id: f.id, name: f.name, size: Number(f.size ?? 0), created: f.createdTime }));
}

// Only ids that appear in our own folder listing can be downloaded.
export async function downloadDrive(cfg, id, { fetch = globalThis.fetch, now = new Date() } = {}) {
  const f = (await listDrive(cfg, { fetch, now })).find((x) => x.id === id);
  if (!f) throw new GoogleError('Nie znaleziono tej kopii na Dysku Google');
  const token = await accessToken(cfg, { fetch, now });
  const res = await fetch(`${API}/files/${encodeURIComponent(id)}?alt=media`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new GoogleError(`Google Drive ${res.status}`);
  return { name: f.name, data: Buffer.from(await res.arrayBuffer()) };
}
