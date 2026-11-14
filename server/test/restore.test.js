import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApi } from '../src/app.js';
import { OLD } from './old-schema.js';

// A real on-disk database + backup folder, with an admin and a plain user logged in.
const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ipam-rs-'));
  const backupDir = join(dir, 'backups');
  const api = createApi(openDb(join(dir, 'ipam.db')), { backupDir, fetch: async () => ({ ok: true }) });
  const client = () => {
    const ctx = {};
    return async (m, p, body = {}, q = {}) => {
      const o = await api(m, p, q, body, ctx);
      if (ctx.newToken) { ctx.token = ctx.newToken; ctx.newToken = undefined; }
      return o;
    };
  };
  const admin = client();
  await admin('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  const bob = client();
  await bob('POST', '/api/auth/register', { username: 'bob', password: 'password123' });
  return { dir, backupDir, api, admin, bob, client };
};
const seed = async (admin) => {
  const t = await admin('POST', '/api/tenants', { name: 'rodzina' });
  const s = await admin('POST', `/api/tenants/${t.id}/sites`, { name: 'dom1' });
  const n = await admin('POST', `/api/sites/${s.id}/networks`, { name: 'LAN', cidr: '10.0.0.0/24' });
  await admin('POST', `/api/networks/${n.id}/entries`, { ip: '10.0.0.5', fqdn: 'nas.lan' });
  return { t, s, n };
};
const entries = async (admin, netId) => (await admin('GET', `/api/networks/${netId}`)).entries.map((e) => e.fqdn);

test('restore from a local backup brings data back, logs everyone out and keeps an undo copy', async () => {
  const { admin, bob, backupDir, client } = await setup();
  const { n } = await seed(admin);
  const bk = await admin('POST', '/api/admin/backups/run');
  assert.equal(bk.ok, true);

  await admin('POST', `/api/networks/${n.id}/entries`, { ip: '10.0.0.6', fqdn: 'later.lan' });   // changes made after the backup
  assert.deepEqual(await entries(admin, n.id), ['nas.lan', 'later.lan']);

  const preview = await admin('POST', '/api/admin/restore/inspect', { name: bk.name });
  assert.equal(preview.current.entries, 2);
  assert.equal(preview.backup.entries, 1);
  assert.equal(preview.you_in_backup, true);
  assert.equal(preview.migrated, false);
  assert.ok(preview.token);

  const res = await admin('POST', '/api/admin/restore/apply', { token: preview.token });
  assert.equal(res.ok, true);

  await assert.rejects(admin('GET', '/api/overview'), /logowanie/);          // sessions were cleared
  await assert.rejects(bob('GET', '/api/overview'), /logowanie/);
  const again = client();
  await again('POST', '/api/auth/login', { username: 'admin', password: 'password123' });
  assert.deepEqual(await entries(again, n.id), ['nas.lan']);                  // the later entry is gone
  assert.match((await again('GET', '/api/audit'))[0].label, /przywrócono z: ipam-.*kopia bezpieczeństwa: ipam-/);

  // the safety copy is a normal backup containing the pre-restore state: restoring it undoes the restore
  const files = (await again('GET', '/api/admin/backups')).files.map((f) => f.name);
  assert.ok(files.includes(res.safety));
  const undo = await again('POST', '/api/admin/restore/inspect', { name: res.safety });
  assert.equal(undo.backup.entries, 2);
  await again('POST', '/api/admin/restore/apply', { token: undo.token });
  const third = client();
  await third('POST', '/api/auth/login', { username: 'admin', password: 'password123' });
  assert.deepEqual(await entries(third, n.id), ['nas.lan', 'later.lan']);
  assert.deepEqual(readdirSync(join(backupDir, '..')).filter((f) => f.includes('.tmp') || f.endsWith('.replaced')), []);   // no leftovers
});

test('restore from an uploaded file, including a pre-tenant database that gets migrated', async () => {
  const { admin, dir } = await setup();
  const old = join(dir, 'old.db');
  const o = new DatabaseSync(old); o.exec(OLD); o.close();
  const preview = await admin('POST', '/api/admin/restore/inspect', { file: readFileSync(old) });
  assert.equal(preview.migrated, true);
  assert.equal(preview.label, 'przesłany plik');
  assert.deepEqual([preview.backup.sites, preview.backup.tenants, preview.backup.entries, preview.backup.users], [2, 1, 1, 2]);
  assert.equal(preview.you_in_backup, false);                                  // "admin" does not exist in that backup
  assert.deepEqual(preview.backup.usernames, ['bob', 'root']);
  await admin('POST', '/api/admin/restore/apply', { token: preview.token });
  await assert.rejects(admin('GET', '/api/overview'), /logowanie/);

  // the live file now holds the migrated old data
  const live = new DatabaseSync(join(dir, 'ipam.db'));
  assert.deepEqual(live.prepare('SELECT name FROM tenants').all().map((r) => r.name), ['Domyślny']);
  assert.deepEqual(live.prepare('SELECT name FROM sites ORDER BY id').all().map((r) => r.name), ['dom1', 'lab2']);
  assert.equal(live.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  live.close();
});

test('inspect rejects non-databases, foreign databases and damaged files without touching the live data', async () => {
  const { admin, dir, backupDir } = await setup();
  const { n } = await seed(admin);
  const reject = (file, re) => assert.rejects(admin('POST', '/api/admin/restore/inspect', { file }), re);
  await reject(Buffer.from('hello world, definitely not sqlite'), /nie jest plik bazy SQLite/);
  await reject(Buffer.alloc(0), /pusty/);

  const foreign = join(dir, 'foreign.db');
  const f = new DatabaseSync(foreign); f.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, t TEXT)'); f.close();
  await reject(readFileSync(foreign), /nie jest kopia simpleIPAM.*brak tabel/);

  const bk = await admin('POST', '/api/admin/backups/run');
  const damaged = readFileSync(join(backupDir, bk.name));
  damaged.fill(0xff, 4096 * 2, 4096 * 4);                                      // trash a couple of pages
  await assert.rejects(admin('POST', '/api/admin/restore/inspect', { file: damaged }), /uszkodzony|nie udało się|nie jest kopia/i);

  await assert.rejects(admin('POST', '/api/admin/restore/inspect', { name: '../../etc/passwd' }), /Nie znaleziono/);
  assert.deepEqual(await entries(admin, n.id), ['nas.lan']);                    // live data untouched
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);     // staged files cleaned up
});

test('apply needs a valid, unexpired preview; only global admins on a session may restore', async () => {
  const { admin, bob, api, backupDir } = await setup();
  await seed(admin);
  const bk = await admin('POST', '/api/admin/backups/run');
  await assert.rejects(bob('POST', '/api/admin/restore/inspect', { name: bk.name }), /uprawnień/);
  await assert.rejects(bob('POST', '/api/admin/restore/apply', { token: 'x' }), /uprawnień/);
  await assert.rejects(admin('POST', '/api/admin/restore/apply', { token: 'nope' }), /wygasła/);

  const preview = await admin('POST', '/api/admin/restore/inspect', { name: bk.name });
  const t = await admin('POST', '/api/me/tokens', { name: 'ci' });
  const viaToken = (m, p, b = {}) => api(m, p, {}, b, { bearer: t.token });
  await assert.rejects(viaToken('POST', '/api/admin/restore/apply', { token: preview.token }), /przeglądarce/);
  await admin('POST', '/api/admin/restore/apply', { token: preview.token });
  await assert.rejects(admin('POST', '/api/admin/restore/apply', { token: preview.token }), /logowanie|wygasła/);   // single use
  assert.ok(existsSync(backupDir));
});

test('restoring is refused for an in-memory database', async () => {
  const api = createApi(openDb(':memory:'));
  const ctx = {};
  await api('POST', '/api/auth/register', {}, { username: 'admin', password: 'password123' }, ctx).then(() => { ctx.token = ctx.newToken; });
  await assert.rejects(api('POST', '/api/admin/restore/inspect', {}, { name: 'x' }, ctx), /w pamięci/);
});

test('staged files left over from a previous run are removed on startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ipam-rs-'));
  const stray = join(dir, 'ipam.db.restore-deadbeef.tmp');
  writeFileSync(stray, 'x');
  createApi(openDb(join(dir, 'ipam.db')), {});
  assert.equal(existsSync(stray), false);
});

test('restore of an encrypted backup: stored passphrase works, an explicit one overrides, wrong one is refused', async () => {
  const { admin } = await setup();
  await seed(admin);
  await admin('PUT', '/api/admin/backups/config', { encrypt: { enabled: true, passphrase: 'correct horse' } });
  const bk = await admin('POST', '/api/admin/backups/run');
  assert.match(bk.name, /\.db\.enc$/);
  const p = await admin('POST', '/api/admin/restore/inspect', { name: bk.name });
  assert.equal(p.backup.networks > 0, true);
  // the passphrase later changes: old copies need the typed one
  await admin('PUT', '/api/admin/backups/config', { encrypt: { passphrase: 'another phrase' } });
  await assert.rejects(admin('POST', '/api/admin/restore/inspect', { name: bk.name }), /Nieprawidłowe hasło/);
  assert.equal((await admin('POST', '/api/admin/restore/inspect', { name: bk.name, passphrase: 'correct horse' })).backup.networks > 0, true);
  const { readFileSync } = await import('node:fs');
  await assert.rejects(admin('POST', '/api/admin/restore/inspect', { file: Buffer.from('SIPAMENC1\n'.padEnd(80, 'x')) }), /Nieprawidłowe hasło/);
});
