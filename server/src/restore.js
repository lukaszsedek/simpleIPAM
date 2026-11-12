import { DatabaseSync } from 'node:sqlite';
import { openSync, readSync, closeSync, rmSync } from 'node:fs';
import { openDb } from './db.js';
import { HttpError } from './errors.js';

const REQUIRED = ['users', 'sites', 'networks', 'entries', 'role_assignments', 'audit'];
const MAGIC = Buffer.from('SQLite format 3\0');

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const n = (db, sql) => db.prepare(sql).get().n;

// What a database contains, for the before/after comparison in the restore dialog.
export function summarize(db) {
  return {
    tenants: hasTable(db, 'tenants') ? n(db, 'SELECT COUNT(*) AS n FROM tenants') : 0,
    sites: n(db, 'SELECT COUNT(*) AS n FROM sites'),
    networks: n(db, 'SELECT COUNT(*) AS n FROM networks'),
    entries: n(db, 'SELECT COUNT(*) AS n FROM entries'),
    users: n(db, 'SELECT COUNT(*) AS n FROM users'),
    admins: n(db, "SELECT COUNT(*) AS n FROM role_assignments WHERE role='admin' AND site_id IS NULL"
      + (db.prepare('PRAGMA table_info(role_assignments)').all().some((c) => c.name === 'tenant_id') ? ' AND tenant_id IS NULL' : '')),
    usernames: db.prepare('SELECT username FROM users ORDER BY username').all().map((r) => r.username),
  };
}

// Checks that `path` is a healthy simpleIPAM database and brings it to the current schema in place
// (older backups are migrated here, before anything live is touched). Throws HttpError(400) otherwise.
export function validateAndPrepare(path) {
  const fd = openSync(path, 'r');
  const head = Buffer.alloc(16);
  try { readSync(fd, head, 0, 16, 0); } finally { closeSync(fd); }
  if (!head.equals(MAGIC)) throw new HttpError(400, 'To nie jest plik bazy SQLite');

  let migrated;
  const raw = new DatabaseSync(path);                      // a private staged copy, safe to open read-write
  try {
    const missing = REQUIRED.filter((t) => !hasTable(raw, t));
    if (missing.length) throw new HttpError(400, `To nie jest kopia simpleIPAM (brak tabel: ${missing.join(', ')})`);
    const check = raw.prepare('PRAGMA integrity_check').all();
    if (!(check.length === 1 && check[0].integrity_check === 'ok')) throw new HttpError(400, 'Plik jest uszkodzony (integrity_check nie przeszedł)');
    migrated = !hasTable(raw, 'tenants');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Nie udało się odczytać pliku jako bazy SQLite');
  } finally { raw.close(); }

  const db = openDb(path);                                 // runs the schema upgrade
  try {
    const summary = summarize(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA journal_mode = DELETE');              // leave one self-contained file
    return { summary, migrated };
  } finally {
    db.close();
    for (const ext of ['-wal', '-shm', '.pre-tenants.bak']) rmSync(path + ext, { force: true });
  }
}
