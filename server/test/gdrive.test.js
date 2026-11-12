import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApi } from '../src/app.js';
import { runBackup, loadConfig } from '../src/backup.js';

// Minimal fake of Google's OAuth + Drive endpoints.
function fakeGoogle() {
  const g = { files: [], folders: [], tokenCalls: [], uploads: [], deleted: [], revoked: [], devicePending: true };
  const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const form = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
    if (u.pathname === '/token') {
      g.tokenCalls.push(form);
      if (form.grant_type === 'authorization_code') {
        if (!form.code_verifier || form.code !== 'good') return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: 'at1', expires_in: 3600, refresh_token: 'rt1', id_token: `x.${Buffer.from('{"email":"me@example.com"}').toString('base64url')}.y` });
      }
      if (form.grant_type === 'refresh_token') return form.refresh_token === 'rt1' ? json({ access_token: 'at2', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
      if (form.grant_type.includes('device_code')) return g.devicePending ? json({ error: 'authorization_pending' }, 428)
        : json({ access_token: 'at1', refresh_token: 'rt1', id_token: `x.${Buffer.from('{"email":"tv@example.com"}').toString('base64url')}.y` });
    }
    if (u.pathname === '/device/code') return json({ device_code: 'dc', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 });
    if (u.pathname === '/revoke') { g.revoked.push(form.token); return json({}); }
    assert.equal(init.headers.authorization, 'Bearer at2');
    if (u.pathname.startsWith('/drive/v3/files/') && u.searchParams.get('alt') === 'media') {
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('DBBYTES') };
    }
    if (u.pathname === '/drive/v3/files' && init.method === 'GET') {
      const q = u.searchParams.get('q');
      if (q.startsWith("mimeType='application/vnd.google-apps.folder'")) return json({ files: g.folders.map((id) => ({ id })) });
      return json({ files: g.files.map((f) => ({ id: f.id, name: f.name, size: '7' })).reverse() });
    }
    if (u.pathname === '/drive/v3/files' && init.method === 'POST') { g.folders.push('folder1'); return json({ id: 'folder1' }); }
    if (u.pathname === '/upload/drive/v3/files') {
      const body = init.body.toString('latin1');
      const name = /"name":"([^"]+)"/.exec(body)[1];
      assert.match(body, /"parents":\["folder1"\]/);
      assert.match(init.headers['content-type'], /^multipart\/related; boundary=/);
      g.uploads.push(name);
      g.files.push({ id: `f${g.files.length}`, name });
      return json({ id: `f${g.files.length - 1}` });
    }
    if (init.method === 'DELETE') { g.deleted.push(u.pathname.split('/').pop()); g.files = g.files.filter((f) => f.id !== u.pathname.split('/').pop()); return json({}, 200); }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  return g;
}

function setup(g) {
  const db = openDb(':memory:');
  const api = createApi(db, { fetch: g.fetch });
  const ctx = {};
  const call = async (m, p, body = {}, q = {}) => { const o = await api(m, p, q, body, ctx); if (ctx.newToken) { ctx.token = ctx.newToken; ctx.newToken = undefined; } return o; };
  return { db, call };
}

test('redirect flow: connect -> callback stores refresh token (PKCE + state), secrets never exposed', async () => {
  const g = fakeGoogle(); const { db, call } = setup(g);
  await call('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  await assert.rejects(call('POST', '/api/admin/backups/gdrive/connect', { origin: 'http://localhost:8080' }), /Client ID/);
  await call('PUT', '/api/admin/backups/config', { provider: 'gdrive', gdrive: { client_id: 'cid', client_secret: 'sec' } });
  await assert.rejects(call('PUT', '/api/admin/backups/config', { remote_enabled: true }), /połącz konto/);

  const { url, redirect_uri } = await call('POST', '/api/admin/backups/gdrive/connect', { origin: 'http://localhost:8080' });
  assert.equal(redirect_uri, 'http://localhost:8080/api/admin/backups/gdrive/callback');
  const q = new URL(url).searchParams;
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('scope'), /drive\.file/);
  assert.doesNotMatch(q.get('scope'), /auth\/drive(\s|$)/);   // never the full-Drive scope

  assert.equal((await call('GET', '/api/admin/backups/gdrive/callback', {}, { code: 'good', state: 'forged' })).redirect, '/#/admin/backups?gdrive=state');
  const ok = await call('GET', '/api/admin/backups/gdrive/callback', {}, { code: 'good', state: q.get('state') });
  assert.equal(ok.redirect, '/#/admin/backups?gdrive=ok');
  assert.ok(g.tokenCalls[0].code_verifier);
  // state is single-use
  assert.equal((await call('GET', '/api/admin/backups/gdrive/callback', {}, { code: 'good', state: q.get('state') })).redirect, '/#/admin/backups?gdrive=state');

  const pub = (await call('GET', '/api/admin/backups')).config.gdrive;
  assert.deepEqual([pub.connected, pub.email, pub.secret_set], [true, 'me@example.com', true]);
  assert.equal(JSON.stringify(pub).includes('rt1') || JSON.stringify(pub).includes('sec"'), false);
  assert.equal(loadConfig(db).gdrive.refresh_token, 'rt1');

  // changing the OAuth client invalidates the stored authorisation
  await call('PUT', '/api/admin/backups/config', { gdrive: { client_id: 'other' } });
  assert.equal((await call('GET', '/api/admin/backups')).config.gdrive.connected, false);
});

test('device flow, upload with folder creation + retention, disconnect revokes', async () => {
  const g = fakeGoogle(); const { db, call } = setup(g);
  await call('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  await call('PUT', '/api/admin/backups/config', { provider: 'gdrive', gdrive: { client_id: 'cid', client_secret: 'sec', keep: 2 } });
  const d = await call('POST', '/api/admin/backups/gdrive/device/start');
  assert.equal(d.user_code, 'ABCD-EFGH');
  assert.equal(d.device_code, undefined);                      // never leaves the server
  assert.equal((await call('POST', '/api/admin/backups/gdrive/device/poll')).status, 'pending');
  g.devicePending = false;
  assert.deepEqual(await call('POST', '/api/admin/backups/gdrive/device/poll'), { status: 'connected', email: 'tv@example.com' });
  await call('PUT', '/api/admin/backups/config', { remote_enabled: true });

  for (const day of ['01', '02', '03']) {
    const r = await runBackup(db, { fetch: g.fetch, now: new Date(`2026-04-${day}T10:00:00Z`) });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  assert.equal(g.folders.length, 1);                            // folder created once, then found by name
  assert.deepEqual(g.uploads, ['ipam-20260401-100000.db', 'ipam-20260402-100000.db', 'ipam-20260403-100000.db']);
  assert.deepEqual(g.deleted, ['f0']);                          // keep=2 -> the oldest is pruned
  g.files.push({ id: 'mine', name: 'holiday-photos.zip' });     // foreign files in the folder are never deleted
  await runBackup(db, { fetch: g.fetch, now: new Date('2026-04-04T10:00:00Z') });
  assert.ok(!g.deleted.includes('mine'));

  await call('POST', '/api/admin/backups/gdrive/disconnect');
  assert.deepEqual(g.revoked, ['rt1']);
  const cfg = (await call('GET', '/api/admin/backups')).config;
  assert.deepEqual([cfg.gdrive.connected, cfg.remote_enabled], [false, false]);
});

test('expired/revoked authorisation gives a clear message; non-admins and API tokens are refused', async () => {
  const g = fakeGoogle(); const { db, call } = setup(g);
  await call('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  await call('PUT', '/api/admin/backups/config', { provider: 'gdrive', gdrive: { client_id: 'cid', client_secret: 'sec' } });
  const cfg = loadConfig(db); cfg.gdrive.refresh_token = 'revoked';
  db.prepare("INSERT INTO settings (key,value) VALUES ('backup_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ ...cfg, remote_enabled: true }));
  const r = await runBackup(db, { fetch: g.fetch });
  assert.equal(r.remote.ok, false);
  assert.match(r.remote.message, /połącz konto ponownie/);

  const bob = createApi(db, { fetch: g.fetch });
  await assert.rejects(bob('POST', '/api/admin/backups/gdrive/connect', {}, { origin: 'http://x' }, {}), /Wymagane logowanie/);
});

test('restore from Drive: lists only our backups, downloads only ids from that listing', async () => {
  const { listDrive, downloadDrive } = await import('../src/gdrive.js');
  const g = fakeGoogle(); g.folders.push('folder1');
  g.files.push({ id: 'a', name: 'ipam-20260401-100000.db' }, { id: 'b', name: 'notes.txt' }, { id: 'c', name: 'ipam-20260402-100000.db' });
  const cfg = { client_id: 'c', client_secret: 's', refresh_token: 'rt1' };
  const list = await listDrive(cfg, { fetch: g.fetch });
  assert.deepEqual(list.map((f) => f.id), ['c', 'a']);
  assert.equal((await downloadDrive(cfg, 'a', { fetch: g.fetch })).data.toString(), 'DBBYTES');
  await assert.rejects(downloadDrive(cfg, 'b', { fetch: g.fetch }), /Nie znaleziono/);
  await assert.rejects(downloadDrive(cfg, 'zzz', { fetch: g.fetch }), /Nie znaleziono/);
});
