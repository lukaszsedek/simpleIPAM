import { mkdtempSync, readFileSync, rmSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { putS3 } from './s3.js';
import { putGcs, parseServiceAccount } from './gcs.js';
import { HttpError } from './errors.js';

// ---------- snapshots ----------
// VACUUM INTO writes a consistent snapshot of a live WAL database into a new file.
export function snapshotBuffer(db) {
  const dir = mkdtempSync(join(tmpdir(), 'ipam-'));
  try {
    const file = join(dir, 'snapshot.db');
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
export const backupName = (d = new Date()) => `ipam-${stamp(d)}.db`;
// also matches the short names written by earlier versions
export const isBackupName = (n) => /^ipam-(\d{8}-\d{6}|\d{4}-\d{2}-\d{2})\.db$/.test(n);

export function listLocal(dir) {
  if (!dir) return [];
  try {
    return readdirSync(dir).filter(isBackupName).sort().reverse()
      .map((name) => { const s = statSync(join(dir, name)); return { name, size: s.size, mtime: s.mtime.toISOString() }; });
  } catch { return []; }
}
function prune(dir, keep) {
  for (const f of listLocal(dir).slice(keep)) rmSync(join(dir, f.name), { force: true });
}

// ---------- configuration (stored in the settings table) ----------
const DEFAULTS = {
  provider: 'none', remote_enabled: false, local_keep: 7,
  s3: { endpoint: '', region: '', bucket: '', prefix: '', access_key: '', secret_key: '' },
  gcs: { bucket: '', prefix: '', service_account_json: '' },
};
const getSetting = (db, key) => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
const setSetting = (db, key, value) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);

export function loadConfig(db) {
  let saved = {};
  try { saved = JSON.parse(getSetting(db, 'backup_config') ?? '{}'); } catch { /* fall back to defaults */ }
  return { ...DEFAULTS, ...saved, s3: { ...DEFAULTS.s3, ...saved.s3 }, gcs: { ...DEFAULTS.gcs, ...saved.gcs } };
}

// Secrets never leave the server: the UI only learns whether they are set.
export function publicConfig(cfg) {
  const { secret_key, ...s3 } = cfg.s3;
  const { service_account_json, ...gcs } = cfg.gcs;
  let email = '';
  try { email = JSON.parse(service_account_json).client_email ?? ''; } catch { /* unset */ }
  return { ...cfg, s3: { ...s3, secret_set: !!secret_key }, gcs: { ...gcs, secret_set: !!service_account_json, client_email: email } };
}

const bad = (m) => new HttpError(400, m);
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max);
function prefixOf(v) {
  const p = text(v, 200).replace(/^\/+/, '');
  if (p.split('/').includes('..')) throw bad('Prefiks nie może zawierać ".."');
  return p && !p.endsWith('/') ? `${p}/` : p;
}

export function saveConfig(db, input) {
  const cfg = loadConfig(db);
  if (input.provider !== undefined) {
    if (!['none', 's3', 'gcs'].includes(input.provider)) throw bad('Nieznany dostawca');
    cfg.provider = input.provider;
  }
  if (input.remote_enabled !== undefined) cfg.remote_enabled = !!input.remote_enabled;
  if (input.local_keep !== undefined) {
    const n = Number(input.local_keep);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw bad('Liczba kopii lokalnych: 1–365');
    cfg.local_keep = n;
  }
  const s3 = input.s3 ?? {};
  for (const k of ['region', 'bucket', 'access_key']) if (s3[k] !== undefined) cfg.s3[k] = text(s3[k], 200);
  if (s3.prefix !== undefined) cfg.s3.prefix = prefixOf(s3.prefix);
  if (s3.endpoint !== undefined) {
    const e = text(s3.endpoint, 300);
    if (e && !/^https?:\/\/[^/\s]+/.test(e)) throw bad('Endpoint musi zaczynać się od http:// lub https://');
    cfg.s3.endpoint = e;
  }
  if (text(s3.secret_key, 500)) cfg.s3.secret_key = text(s3.secret_key, 500);          // blank = keep the stored secret
  const gcs = input.gcs ?? {};
  if (gcs.bucket !== undefined) cfg.gcs.bucket = text(gcs.bucket, 200);
  if (gcs.prefix !== undefined) cfg.gcs.prefix = prefixOf(gcs.prefix);
  if (text(gcs.service_account_json, 20_000)) {
    try { parseServiceAccount(gcs.service_account_json); } catch (e) { throw bad(e.message); }
    cfg.gcs.service_account_json = gcs.service_account_json.trim();
  }

  const bucketOk = (b) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(b) && b.length <= 222;
  if (cfg.provider === 's3' && (cfg.s3.bucket || cfg.remote_enabled) && !bucketOk(cfg.s3.bucket)) throw bad('Nieprawidłowa nazwa bucketa S3');
  if (cfg.provider === 'gcs' && (cfg.gcs.bucket || cfg.remote_enabled) && !bucketOk(cfg.gcs.bucket)) throw bad('Nieprawidłowa nazwa bucketa GCS');
  if (cfg.remote_enabled) assertRemoteReady(cfg);
  setSetting(db, 'backup_config', JSON.stringify(cfg));
  return cfg;
}

function assertRemoteReady(cfg) {
  if (cfg.provider === 's3' && !(cfg.s3.access_key && cfg.s3.secret_key)) throw bad('Podaj Access Key i Secret Key dla S3');
  if (cfg.provider === 'gcs' && !cfg.gcs.service_account_json) throw bad('Wklej klucz konta usługi (JSON) dla GCS');
  if (cfg.provider === 'none') throw bad('Wybierz dostawcę (S3 lub GCS), zanim włączysz zdalne kopie');
}

// ---------- running backups ----------
export function uploadRemote(cfg, name, body, deps = {}) {
  assertRemoteReady(cfg);
  if (cfg.provider === 's3') return putS3(cfg.s3, `${cfg.s3.prefix}${name}`, body, deps);
  return putGcs(cfg.gcs, `${cfg.gcs.prefix}${name}`, body, { fetch: deps.fetch, now: deps.now, base: deps.gcsBase });
}

export async function testRemote(cfg, deps = {}) {
  await uploadRemote(cfg, 'simpleipam-connection-test.txt', Buffer.from(`simpleIPAM connection test ${new Date().toISOString()}\n`), deps);
}

// Snapshot -> local file (if dir) -> remote (if enabled). Remote failure does not lose the local copy.
export async function runBackup(db, { dir, trigger = 'manual', now = new Date(), ...deps } = {}) {
  const cfg = loadConfig(db);
  const body = snapshotBuffer(db);
  const name = backupName(now);
  const result = { at: now.toISOString(), day: now.toISOString().slice(0, 10), trigger, name, size: body.length, ok: true, local: null, remote: null };
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), body);
      prune(dir, cfg.local_keep);
      result.local = { ok: true };
    } catch (e) { result.local = { ok: false, message: String(e.message).slice(0, 300) }; result.ok = false; }
  }
  if (cfg.remote_enabled && cfg.provider !== 'none') {
    try { await uploadRemote(cfg, name, body, { ...deps, now }); result.remote = { ok: true, provider: cfg.provider }; }
    catch (e) { result.remote = { ok: false, provider: cfg.provider, message: String(e.message).slice(0, 300) }; result.ok = false; }
  }
  setSetting(db, 'backup_last', JSON.stringify(result));
  return result;
}

export const lastBackup = (db) => { try { return JSON.parse(getSetting(db, 'backup_last') ?? 'null'); } catch { return null; } };

// One automatic backup per UTC day. A failed day is not retried automatically (it would flood the local copies); use "Run now".
export async function runDailyIfDue(db, opts = {}) {
  const now = opts.now ?? new Date();
  if (lastBackup(db)?.day === now.toISOString().slice(0, 10)) return null;
  return runBackup(db, { ...opts, trigger: 'auto', now });
}
