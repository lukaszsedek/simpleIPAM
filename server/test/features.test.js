import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApi } from '../src/app.js';
import * as totp from '../src/totp.js';
import { codeAt } from '../src/totp.js';
import { readXlsx } from '../src/xlsx-read.js';
import { buildXlsx } from '../src/xlsx.js';

const client = (api) => {
  const ctx = { ip: '127.0.0.1' };
  const call = async (m, p, body = {}, query = {}) => {
    const out = await api(m, p, query, body, ctx);
    if (ctx.newToken) { ctx.token = ctx.newToken; ctx.newToken = undefined; }
    if (ctx.clearToken) { ctx.token = undefined; ctx.clearToken = false; }
    return out;
  };
  call.ctx = ctx;
  return call;
};
async function boot() {
  const api = createApi(openDb(':memory:'));
  const admin = client(api);
  await admin('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  const t = await admin('POST', '/api/tenants', { name: 'home' });
  const site = await admin('POST', `/api/tenants/${t.id}/sites`, { name: 'dom' });
  const net = await admin('POST', `/api/sites/${site.id}/networks`, { name: 'LAN', vlan: 10, cidr: '10.0.0.0/24', dhcp_start: '10.0.0.100', dhcp_end: '10.0.0.150' });
  return { api, admin, site, net };
}

test('TOTP matches the RFC 6238 test vector and tolerates one step of drift', () => {
  const secret = totp.base32(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(codeAt(secret, 1), '287082');                  // T=59 s
  assert.equal(totp.verify(secret, '287082', 59_000), 1);
  assert.equal(totp.verify(secret, '287082', 59_000 + 30_000), 1);   // one step later still accepted
  assert.equal(totp.verify(secret, '287082', 59_000 + 120_000), null);
  assert.equal(totp.verify(secret, 'abc', 59_000), null);
  assert.deepEqual(totp.unbase32(secret), Buffer.from('12345678901234567890'));
});

test('two-factor login: code required, replay and wrong codes refused, recovery codes work once, admin can reset', async () => {
  const { api, admin } = await boot();
  const setup = await admin('POST', '/api/me/totp/setup');
  assert.match(setup.uri, /^otpauth:\/\/totp\/simpleIPAM:admin\?secret=/);
  await assert.rejects(admin('POST', '/api/me/totp/enable', { code: '000000' }), /Nieprawidłowy kod/);
  const step = Math.floor(Date.now() / 30_000);
  const { recovery_codes } = await admin('POST', '/api/me/totp/enable', { code: codeAt(setup.secret, step) });
  assert.equal(recovery_codes.length, 8);
  assert.equal((await admin('GET', '/api/me')).user.totp, true);

  const b = client(api);
  const first = await b('POST', '/api/auth/login', { username: 'admin', password: 'password123' });
  assert.equal(first.totp_required, true);
  assert.equal(b.ctx.token, undefined);                              // no session without the code
  const bad = await b('POST', '/api/auth/login', { username: 'admin', password: 'password123', code: '123456' });
  assert.equal(bad.invalid, true);
  // the code used while enabling cannot be replayed; the next step's code is fine
  const replay = await b('POST', '/api/auth/login', { username: 'admin', password: 'password123', code: codeAt(setup.secret, step) });
  assert.equal(replay.totp_required, true);
  const ok = await b('POST', '/api/auth/login', { username: 'admin', password: 'password123', code: codeAt(setup.secret, step + 1) });
  assert.equal(ok.user.username, 'admin');
  assert.ok(b.ctx.token);

  const c = client(api);
  await c('POST', '/api/auth/login', { username: 'admin', password: 'password123', code: recovery_codes[0] });
  assert.ok(c.ctx.token);
  const d = client(api);
  assert.equal((await d('POST', '/api/auth/login', { username: 'admin', password: 'password123', code: recovery_codes[0] })).totp_required, true);   // used up

  await assert.rejects(admin('POST', '/api/me/totp/disable', { password: 'nope' }), /hasło/);
  await admin('POST', '/api/me/totp/disable', { password: 'password123' });
  const e = client(api);
  assert.equal((await e('POST', '/api/auth/login', { username: 'admin', password: 'password123' })).user.username, 'admin');

  // an admin resets somebody else's lost authenticator
  const u = client(api);
  await u('POST', '/api/auth/register', { username: 'bob', password: 'password123' });
  const s2 = await u('POST', '/api/me/totp/setup');
  await u('POST', '/api/me/totp/enable', { code: codeAt(s2.secret, Math.floor(Date.now() / 30_000)) });
  const bobId = (await admin('GET', '/api/users')).find((x) => x.username === 'bob').id;
  await admin('DELETE', `/api/users/${bobId}/totp`);
  assert.equal((await client(api)('POST', '/api/auth/login', { username: 'bob', password: 'password123' })).user.username, 'bob');
});

test('metrics: Prometheus text per network, scoped to what the token owner can read', async () => {
  const { api, admin, net } = await boot();
  await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.10', fqdn: 'a.lan' });
  const tok = await admin('POST', '/api/me/tokens', { name: 'prom' });
  const prom = { bearer: tok.token, ip: '127.0.0.1' };
  const out = await api('GET', '/api/metrics', {}, {}, prom);
  assert.match(out.contentType, /^text\/plain/);
  assert.match(out.raw, /# TYPE ipam_network_addresses_used gauge/);
  assert.match(out.raw, /ipam_network_addresses_total\{tenant="home",site="dom",network="LAN",cidr="10\.0\.0\.0\/24",vlan="10"\} 254/);
  assert.match(out.raw, /ipam_network_addresses_used\{[^}]*network="LAN"[^}]*\} 1\b/);
  assert.match(out.raw, /ipam_entries\{status="used"\} 1/);
  assert.match(out.raw, /ipam_build_info\{version="dev"\} 1/);
  await assert.rejects(api('GET', '/api/metrics', {}, {}, { ip: '1.1.1.1' }), /logowanie/);     // anonymous scrape refused
  // somebody without access sees no networks
  const bob = client(api);
  await bob('POST', '/api/auth/register', { username: 'bob', password: 'password123' });
  assert.doesNotMatch((await bob('GET', '/api/metrics')).raw, /network="LAN"/);
});

test('import: Excel round trip (export -> import back), dry run, localised headers, semicolon CSV', async () => {
  const { admin, net } = await boot();
  await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.10', fqdn: 'nas.lan', type: 'nas', tags: 'lab', mac: 'aa:bb:cc:dd:ee:ff', description: 'ważny' });
  await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.120', fqdn: 'dyn.lan', status: 'reserved' });
  const x = await admin('GET', `/api/networks/${net.id}/export.xlsx`, {}, { lang: 'pl' });
  const sheets = readXlsx(x.raw);
  assert.equal(sheets[0].name, 'LAN');
  assert.equal(sheets[0].rows[1][1], 'nas.lan');

  // import back into the same network: nothing is lost, rows are matched by IP
  const b64 = x.raw.toString('base64');
  const dry = await admin('POST', `/api/networks/${net.id}/import`, { xlsx: b64, dry_run: true });
  assert.deepEqual([dry.added, dry.updated, dry.dry_run], [0, 2, true]);

  // a hand-made sheet with Polish headers and localised cells
  const sheet = buildXlsx([{ name: 'LAN', rows: [['IP', 'FQDN', 'Typ', 'Status', 'Tagi', 'Ważny do'], ['10.0.0.55', 'cam.lan', 'IoT', 'Rezerwacja DHCP', 'kamera', '2030-01-31'], ['10.0.0.10', 'nas2.lan', '', '', '', '']] }]);
  const r = await admin('POST', `/api/networks/${net.id}/import`, { xlsx: sheet.toString('base64') });
  assert.deepEqual([r.added, r.updated, r.errors.length], [1, 1, 0]);
  const full = await admin('GET', `/api/networks/${net.id}`);
  const cam = full.entries.find((e) => e.ip === '10.0.0.55');
  assert.deepEqual([cam.type, cam.status, cam.tags, cam.expires_at], ['iot', 'reserved', 'kamera', '2030-01-31']);
  const nas = full.entries.find((e) => e.ip === '10.0.0.10');
  assert.deepEqual([nas.fqdn, nas.type, nas.mac, nas.tags], ['nas2.lan', 'nas', 'aa:bb:cc:dd:ee:ff', 'lab']);   // columns missing in the file keep their value

  const semi = await admin('POST', `/api/networks/${net.id}/import`, { csv: 'ip;fqdn;opis\n10.0.0.77;x.lan;z średnikiem\n10.0.0.78;;\n' });
  assert.equal(semi.added, 2);
  await assert.rejects(admin('POST', `/api/networks/${net.id}/import`, { xlsx: Buffer.from('not a zip').toString('base64') }), /xlsx/);
  const bad = await admin('POST', `/api/networks/${net.id}/import`, { csv: 'ip,fqdn\n192.168.9.9,out.lan\n' });
  assert.equal(bad.errors.length, 1);
});

test('bulk: remove tags, set description and expiry; search finds a MAC in any notation', async () => {
  const { admin, net } = await boot();
  const a = await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.10', tags: 'lab,iot', mac: 'aa:bb:cc:dd:ee:ff' });
  const b = await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.11', tags: 'iot' });
  const r = await admin('POST', `/api/networks/${net.id}/entries/bulk`, { ids: [a.id, b.id], action: 'update', changes: { remove_tags: 'iot', add_tags: 'guest', description: 'tymczasowe', expires_at: '2030-05-05' } });
  assert.equal(r.affected, 2);
  const rows = (await admin('GET', `/api/networks/${net.id}`)).entries;
  assert.deepEqual(rows.map((e) => [e.tags, e.description, e.expires_at]), [['lab,guest', 'tymczasowe', '2030-05-05'], ['guest', 'tymczasowe', '2030-05-05']]);
  await assert.rejects(admin('POST', `/api/networks/${net.id}/entries/bulk`, { ids: [a.id], action: 'update', changes: { expires_at: 'jutro' } }), /data ważności/);
  for (const q of ['AA-BB-CC-DD-EE-FF', 'aabb.ccdd.eeff', 'aabbccddeeff', 'bb:cc:dd']) assert.equal((await admin('GET', '/api/search', {}, { q })).length, 1, q);
  assert.equal((await admin('GET', '/api/search', {}, { q: 'guest' })).length, 2);                  // tags
});
