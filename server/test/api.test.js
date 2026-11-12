import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApi } from '../src/app.js';
import { parseCidr, normalizeCidr, normalizeMac } from '../src/ip.js';

// A "client" is a ctx that carries its session cookie between calls, like a browser would.
const client = (api) => {
  const ctx = { ip: '127.0.0.1' };
  const call = async (m, p, body = {}, query = {}) => {
    const out = await api(m, p, query, body, ctx);
    if (ctx.newToken) { ctx.token = ctx.newToken; ctx.newToken = undefined; }
    if (ctx.clearToken) { ctx.token = undefined; ctx.clearToken = false; }
    return out;
  };
  call.register = (username, password = 'password123') => call('POST', '/api/auth/register', { username, password });
  call.login = (username, password = 'password123') => call('POST', '/api/auth/login', { username, password });
  return call;
};
const boot0 = () => ({ api: null, newClient: (() => { const api = createApi(openDb(':memory:')); return () => client(api); })() });   // empty instance, nobody registered
const boot = async () => {
  const api = createApi(openDb(':memory:'));
  const admin = client(api);
  await admin.register('admin');
  return { api, admin, newClient: () => client(api) };
};
// Creates the site (and its tenant, once) through the API as `c`.
const mkSite = async (c, name, tenant = 'home') => {
  let t = (await c('GET', '/api/overview')).find((x) => x.name === tenant);
  t ??= await c('POST', '/api/tenants', { name: tenant });
  return c('POST', `/api/tenants/${t.id}/sites`, { name });
};
const sitesOf = (overview) => overview.flatMap((t) => t.sites);
const user = async ({ api, newClient }, name) => { const c = newClient(); await c.register(name); return c; };

test('version is exposed to the UI (public /api/me) and in the admin system info', async () => {
  const api = createApi(openDb(':memory:'), { version: '1.2.3', commit: 'abcdef1234' });
  const ctx = {};
  assert.equal((await api('GET', '/api/me', {}, {}, ctx)).version, '1.2.3');       // visible before login
  await api('POST', '/api/auth/register', {}, { username: 'admin', password: 'password123' }, ctx);
  ctx.token = ctx.newToken;
  const sys = await api('GET', '/api/admin/system', {}, {}, ctx);
  assert.deepEqual([sys.version, sys.commit], ['1.2.3', 'abcdef1234']);
  assert.equal((await createApi(openDb(':memory:'))('GET', '/api/me', {}, {})).version, 'dev');
});

test('cidr helpers', () => {
  assert.equal(normalizeCidr('192.168.1.77/24'), '192.168.1.0/24');
  assert.equal(parseCidr('10.0.0.0/24').size, 256);
  assert.equal(parseCidr('bad'), null);
  assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('xyz'), null);
});

test('site -> network -> entry flow, next-free respects gateway and DHCP', async () => {
  const { admin } = await boot();
  const site = await mkSite(admin, 'dom1');
  const net = await admin('POST', `/api/sites/${site.id}/networks`, {
    name: 'LAN', cidr: '192.168.1.0/24', vlan: 10, gateway: '192.168.1.1', dhcp_start: '192.168.1.2', dhcp_end: '192.168.1.99',
  });
  assert.equal((await admin('GET', `/api/networks/${net.id}/next-free`)).ip, '192.168.1.100');
  await admin('POST', `/api/networks/${net.id}/entries`, { ip: '192.168.1.100', fqdn: 'NAS.home.lan', mac: 'AA:BB:CC:DD:EE:FF' });
  assert.equal((await admin('GET', `/api/networks/${net.id}/next-free`)).ip, '192.168.1.101');
  const full = await admin('GET', `/api/networks/${net.id}`);
  assert.equal(full.entries[0].fqdn, 'nas.home.lan');
  assert.equal(full.stats.used, 1);
  assert.equal(full.stats.dhcp, 98);
  assert.equal((await admin('GET', '/api/search', {}, { q: 'nas' }))[0].site_name, 'dom1');
});

test('validation', async () => {
  const { admin } = await boot();
  const site = await mkSite(admin, 's');
  await assert.rejects(admin('POST', `/api/sites/${site.id}/networks`, { name: 'x', cidr: 'nope' }), /CIDR/);
  const net = await admin('POST', `/api/sites/${site.id}/networks`, { name: 'x', cidr: '10.0.0.0/24' });
  await assert.rejects(admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.1.5' }), /należeć/);
  await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.5' });
  await assert.rejects(admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.5' }), /już wpisany/);
});

test('csv export/import roundtrip', async () => {
  const { admin } = await boot();
  const site = await mkSite(admin, 's');
  const net = await admin('POST', `/api/sites/${site.id}/networks`, { name: 'x', cidr: '10.0.0.0/24' });
  const r = await admin('POST', `/api/networks/${net.id}/import`, { csv: 'ip,fqdn,description\n10.0.0.5,a.lan,"with, comma"\n10.9.9.9,bad,\n' });
  assert.equal(r.added, 1);
  assert.equal(r.errors.length, 1);
  assert.match((await admin('GET', `/api/networks/${net.id}/export.csv`)).raw, /"with, comma"/);
});

test('auth: first user is admin, later users start with no access, login/logout/throttle', async () => {
  const env = await boot();
  const { admin, newClient } = env;
  assert.equal((await admin('GET', '/api/me')).user.global_role, 'admin');
  const bob = await user(env, 'bob');
  assert.equal((await bob('GET', '/api/me')).user.global_role, 'none');
  await mkSite(admin, 'dom1');
  assert.deepEqual(sitesOf(await bob('GET', '/api/overview')), []);
  await assert.rejects(mkSite(bob, 'x'), /uprawnień/);

  await assert.rejects(newClient()('GET', '/api/overview'), /logowanie/);
  await bob('POST', '/api/auth/logout');
  await assert.rejects(bob('GET', '/api/overview'), /logowanie/);
  await bob.login('bob');
  await assert.rejects(newClient().register('BOB'), /zajęty/);
  await assert.rejects(newClient().register('x'), /Login/);
  await assert.rejects(newClient().register('shortpw', '123'), /Hasło/);

  const attacker = newClient();
  for (let i = 0; i < 5; i++) await assert.rejects(attacker.login('bob', 'wrong-pass'), /Nieprawidłowy/);
  await assert.rejects(attacker.login('bob'), /Zbyt wiele/);
});

test('roles: global vs site, site-level overrides, none denies', async () => {
  const env = await boot();
  const { admin } = env;
  const bob = await user(env, 'bob');
  const bobId = (await admin('GET', '/api/users')).find((u) => u.username === 'bob').id;
  const s1 = await mkSite(admin, 'dom1');
  const s2 = await mkSite(admin, 'lab2');
  const n1 = await admin('POST', `/api/sites/${s1.id}/networks`, { name: 'LAN', cidr: '10.1.0.0/24' });
  const n2 = await admin('POST', `/api/sites/${s2.id}/networks`, { name: 'LAN', cidr: '10.2.0.0/24' });
  const grant = (siteId, role) => admin('PUT', `/api/users/${bobId}/roles`, { site_id: siteId, role });

  await assert.rejects(bob('GET', `/api/networks/${n1.id}`), /uprawnień/);

  await grant(s1.id, 'reader');
  assert.equal(sitesOf(await bob('GET', '/api/overview')).length, 1);
  assert.equal((await bob('GET', `/api/networks/${n1.id}`)).role, 'reader');
  await assert.rejects(bob('GET', `/api/networks/${n2.id}`), /uprawnień/);
  await assert.rejects(bob('POST', `/api/networks/${n1.id}/entries`, { ip: '10.1.0.5' }), /uprawnień/);

  await grant(s1.id, 'contributor');
  const e = await bob('POST', `/api/networks/${n1.id}/entries`, { ip: '10.1.0.5', fqdn: 'a.lan' });
  await bob('PUT', `/api/entries/${e.id}`, { ip: '10.1.0.5', fqdn: 'b.lan' });
  await assert.rejects(bob('PUT', `/api/networks/${n1.id}`, { name: 'x', cidr: '10.1.0.0/24' }), /uprawnień/);
  assert.deepEqual(await bob('GET', '/api/search', {}, { q: 'lan' }).then((r) => r.map((x) => x.site_name)), ['dom1']);

  await grant(s1.id, 'admin');
  await bob('PUT', `/api/networks/${n1.id}`, { name: 'LAN2', cidr: '10.1.0.0/24' });
  await assert.rejects(bob('DELETE', `/api/sites/${s1.id}`), /uprawnień/);
  await assert.rejects(bob('GET', '/api/users'), /uprawnień/);
  await assert.rejects(bob('GET', '/api/audit'), /uprawnień/);

  // global reader + explicit "none" on one site = can read everything except that site
  await grant(null, 'reader');
  await grant(s1.id, 'none');
  assert.deepEqual(sitesOf(await bob('GET', '/api/overview')).map((s) => s.name), ['lab2']);
  await assert.rejects(bob('GET', `/api/networks/${n1.id}`), /uprawnień/);
  // dropping the site override falls back to the global role
  await admin('DELETE', `/api/users/${bobId}/roles/site/${s1.id}`);
  assert.equal(sitesOf(await bob('GET', '/api/overview')).length, 2);
});

test('admin safety rails', async () => {
  const env = await boot();
  const { admin } = env;
  await user(env, 'bob');
  const users = await admin('GET', '/api/users');
  const adminId = users.find((u) => u.username === 'admin').id;
  const bobId = users.find((u) => u.username === 'bob').id;
  await assert.rejects(admin('PUT', `/api/users/${adminId}/roles`, { site_id: null, role: 'reader' }), /administrator/);
  await assert.rejects(admin('DELETE', `/api/users/${adminId}`), /własnego/);
  await admin('PUT', `/api/users/${bobId}/password`, { password: 'newpassword1' });
  const bob = env.newClient();
  await assert.rejects(bob.login('bob'), /Nieprawidłowy/);
  await bob.login('bob', 'newpassword1');
  await admin('DELETE', `/api/users/${bobId}`);
  await assert.rejects(bob('GET', '/api/me').then((r) => { if (!r.user) throw new Error('logowanie'); }), /logowanie/);
});

test('tenants: hierarchy global -> tenant -> site, most specific role wins', async () => {
  const env = await boot();
  const { admin } = env;
  const bob = await user(env, 'bob');
  const bobId = (await admin('GET', '/api/users')).find((u) => u.username === 'bob').id;
  const ta = await admin('POST', '/api/tenants', { name: 'rodzina' });
  const tb = await admin('POST', '/api/tenants', { name: 'firma' });
  const a1 = await admin('POST', `/api/tenants/${ta.id}/sites`, { name: 'dom1' });
  const a2 = await admin('POST', `/api/tenants/${ta.id}/sites`, { name: 'dom2' });
  const b1 = await admin('POST', `/api/tenants/${tb.id}/sites`, { name: 'dom1' }); // same name, other tenant
  await assert.rejects(admin('POST', `/api/tenants/${ta.id}/sites`, { name: 'dom1' }), /już istnieje/);
  const set = (body) => admin('PUT', `/api/users/${bobId}/roles`, body);

  await set({ tenant_id: ta.id, role: 'contributor' });
  assert.deepEqual(sitesOf(await bob('GET', '/api/overview')).map((s) => [s.id, s.role]), [[a1.id, 'contributor'], [a2.id, 'contributor']]);
  await assert.rejects(bob('POST', `/api/tenants/${tb.id}/sites`, { name: 'x' }), /uprawnień/);

  await set({ site_id: a2.id, role: 'none' });           // site beats tenant
  assert.deepEqual(sitesOf(await bob('GET', '/api/overview')).map((s) => s.id), [a1.id]);
  await set({ tenant_id: ta.id, role: 'admin' });        // tenant admin can manage sites in the tenant only
  const a3 = await bob('POST', `/api/tenants/${ta.id}/sites`, { name: 'dom3' });
  await bob('DELETE', `/api/sites/${a3.id}`);
  await assert.rejects(bob('DELETE', `/api/sites/${b1.id}`), /uprawnień/);
  await assert.rejects(bob('POST', '/api/tenants', { name: 'nowy' }), /uprawnień/);
  await assert.rejects(bob('DELETE', `/api/tenants/${ta.id}`), /uprawnień/);

  await set({ role: 'reader' });                          // global reader sees the other tenant read-only
  assert.equal(sitesOf(await bob('GET', '/api/overview')).find((s) => s.id === b1.id).role, 'reader');
  await admin('DELETE', `/api/users/${bobId}/roles/tenant/${ta.id}`);
  assert.equal(sitesOf(await bob('GET', '/api/overview')).find((s) => s.id === a1.id).role, 'reader');

  await admin('DELETE', `/api/tenants/${tb.id}`);         // cascades
  assert.equal(sitesOf(await admin('GET', '/api/overview')).some((s) => s.id === b1.id), false);
});

test('issues detect duplicates, DHCP overlap and overlapping networks', async () => {
  const { admin } = await boot();
  const site = await mkSite(admin, 'dom1');
  const net = await admin('POST', `/api/sites/${site.id}/networks`, { name: 'LAN', cidr: '10.0.0.0/24', dhcp_start: '10.0.0.100', dhcp_end: '10.0.0.150' });
  await admin('POST', `/api/sites/${site.id}/networks`, { name: 'Overlap', cidr: '10.0.0.0/25' });
  await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.10', fqdn: 'a.lan', mac: 'aa:aa:aa:aa:aa:aa' });
  await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.11', fqdn: 'a.lan', mac: 'aa:aa:aa:aa:aa:aa' });
  await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.120', fqdn: 'b.lan' });
  const text = (await admin('GET', `/api/networks/${net.id}/issues`)).map((i) => i.text).join('\n');
  assert.match(text, /Duplikat MAC/);
  assert.match(text, /FQDN a\.lan występuje 2×/);
  assert.match(text, /10\.0\.0\.120.*puli DHCP/);
  assert.match(text, /Nakłada się/);
});

test('dns exports, backup, registration switch', async () => {
  const env = await boot();
  const { admin, newClient } = env;
  const site = await mkSite(admin, 'dom1');
  const net = await admin('POST', `/api/sites/${site.id}/networks`, { name: 'LAN', cidr: '10.0.0.0/24' });
  await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.5', fqdn: 'nas.home.lan', mac: 'aa:bb:cc:dd:ee:ff' });
  assert.match((await admin('GET', `/api/networks/${net.id}/export/hosts`)).raw, /10\.0\.0\.5\tnas\.home\.lan nas/);
  const dm = (await admin('GET', `/api/networks/${net.id}/export/dnsmasq`)).raw;
  assert.match(dm, /host-record=nas\.home\.lan,10\.0\.0\.5/);
  assert.match(dm, /dhcp-host=aa:bb:cc:dd:ee:ff,10\.0\.0\.5,nas/);
  assert.match((await admin('GET', `/api/networks/${net.id}/export/bind`)).raw, /nas\.home\.lan\.\tIN\tA\t10\.0\.0\.5/);
  await assert.rejects(admin('GET', `/api/networks/${net.id}/export/zzz`), /format/);

  const backup = await admin('GET', '/api/admin/backup');
  assert.equal(backup.raw.subarray(0, 15).toString(), 'SQLite format 3');
  const bob = await user(env, 'bob');
  await assert.rejects(bob('GET', '/api/admin/backup'), /uprawnień/);

  assert.equal((await newClient()('GET', '/api/me')).registration_open, true);
  await admin('PUT', '/api/settings', { registration_open: false });
  assert.equal((await newClient()('GET', '/api/me')).registration_open, false);
  await assert.rejects(newClient().register('carol'), /wyłączona/);
  assert.equal((await newClient()('GET', '/api/health')).ok, true);
});

test('api tokens: bearer auth carries user roles, shown once, session-only management', async () => {
  const env = await boot();
  const { admin, api } = env;
  const t = await admin('POST', '/api/me/tokens', { name: 'script' });
  assert.match(t.token, /^ipam_/);
  assert.deepEqual((await admin('GET', '/api/me/tokens')).map((x) => x.name), ['script']);
  assert.equal(JSON.stringify(await admin('GET', '/api/me/tokens')).includes(t.token), false);

  const viaToken = (token) => (m, p, body = {}, query = {}) => api(m, p, query, body, { bearer: token });
  const bot = viaToken(t.token);
  assert.equal((await bot('GET', '/api/me')).user.username, 'admin');
  await assert.rejects(bot('POST', '/api/me/tokens', { name: 'x' }), /przeglądarce/);
  await assert.rejects(viaToken('ipam_nope')('GET', '/api/overview'), /logowanie/);

  const bob = await user(env, 'bob');
  const bobTok = await bob('POST', '/api/me/tokens', { name: 'b' });
  await assert.rejects(viaToken(bobTok.token)('GET', '/api/users'), /uprawnień/);   // token = bob's rights, not admin's

  await admin('DELETE', `/api/me/tokens/${t.id}`);
  await assert.rejects(bot('GET', '/api/me/tokens'), /logowanie/);
  assert.match((await admin('GET', '/api/audit')).map((a) => a.actor).join(), /admin/);
});

test('free blocks skip networks of the site', async () => {
  const { admin } = await boot();
  const site = await mkSite(admin, 'dom1');
  await admin('POST', `/api/sites/${site.id}/networks`, { name: 'a', cidr: '10.0.0.0/24' });
  await admin('POST', `/api/sites/${site.id}/networks`, { name: 'b', cidr: '10.0.1.128/25' });
  const free = await admin('GET', `/api/sites/${site.id}/free-blocks`, {}, { within: '10.0.0.0/16', prefix: '24' });
  assert.deepEqual(free.slice(0, 3), ['10.0.2.0/24', '10.0.3.0/24', '10.0.4.0/24']);
  const small = await admin('GET', `/api/sites/${site.id}/free-blocks`, {}, { within: '10.0.1.0/24', prefix: '26' });
  assert.deepEqual(small, ['10.0.1.0/26', '10.0.1.64/26']);
  await assert.rejects(admin('GET', `/api/sites/${site.id}/free-blocks`, {}, { within: 'x', prefix: '24' }), /zakres/);
});

test('bulk update/delete', async () => {
  const env = await boot();
  const { admin } = env;
  const site = await mkSite(admin, 'dom1');
  const net = await admin('POST', `/api/sites/${site.id}/networks`, { name: 'x', cidr: '10.0.0.0/24' });
  const ids = [];
  for (const ip of ['10.0.0.2', '10.0.0.3', '10.0.0.4']) ids.push((await admin('POST', `/api/networks/${net.id}/entries`, { ip, tags: 'a' })).id);
  const r = await admin('POST', `/api/networks/${net.id}/entries/bulk`, { ids: ids.slice(0, 2), action: 'update', changes: { type: 'iot', status: 'reserved', add_tags: 'Kuchnia, a' } });
  assert.equal(r.affected, 2);
  const rows = (await admin('GET', `/api/networks/${net.id}`)).entries;
  assert.deepEqual(rows.map((e) => [e.type, e.status, e.tags]), [['iot', 'reserved', 'a,kuchnia'], ['iot', 'reserved', 'a,kuchnia'], ['other', 'used', 'a']]);
  await assert.rejects(admin('POST', `/api/networks/${net.id}/entries/bulk`, { ids: ids, action: 'update', changes: { type: 'nope' } }), /typ/);
  const reader = await user(env, 'bob');
  await assert.rejects(reader('POST', `/api/networks/${net.id}/entries/bulk`, { ids, action: 'delete' }), /uprawnień/);
  assert.equal((await admin('POST', `/api/networks/${net.id}/entries/bulk`, { ids, action: 'delete' })).affected, 3);
});

test('scan records last_seen and discovered hosts; scheduler only scans auto_scan networks', async () => {
  const alive = new Set(['10.0.0.2', '10.0.0.9']);
  const pinged = [];
  const api = createApi(openDb(':memory:'), { ping: async (ip) => { pinged.push(ip); return alive.has(ip); } });
  const admin = client(api);
  await admin.register('admin');
  const site = await mkSite(admin, 'dom1');
  const manual = await admin('POST', `/api/sites/${site.id}/networks`, { name: 'manual', cidr: '10.0.0.0/28' });
  const auto = await admin('POST', `/api/sites/${site.id}/networks`, { name: 'auto', cidr: '10.0.1.0/28', auto_scan: true });
  await admin('POST', `/api/networks/${manual.id}/entries`, { ip: '10.0.0.2', fqdn: 'known.lan' });

  const res = await admin('POST', `/api/networks/${manual.id}/scan`);
  assert.deepEqual(res.alive, [{ ip: '10.0.0.2', known: true }, { ip: '10.0.0.9', known: false }]);
  const full = await admin('GET', `/api/networks/${manual.id}`);
  assert.ok(full.entries[0].last_seen);
  assert.equal(full.stats.new_hosts, 1);
  const found = await admin('GET', `/api/networks/${manual.id}/discovered`);
  assert.deepEqual(found.map((d) => d.ip), ['10.0.0.9']);

  await admin('POST', `/api/networks/${manual.id}/entries`, { ip: '10.0.0.9' });   // adding it clears the notice
  assert.equal((await admin('GET', `/api/networks/${manual.id}/discovered`)).length, 0);

  pinged.length = 0; alive.clear(); alive.add('10.0.1.5');
  await api.runScheduledScans();
  assert.ok(pinged.length > 0 && pinged.every((ip) => ip.startsWith('10.0.1.')));
  const [d] = await admin('GET', `/api/networks/${auto.id}/discovered`);
  assert.equal(d.ip, '10.0.1.5');
  await admin('POST', `/api/discovered/${d.id}/dismiss`);
  assert.equal((await admin('GET', `/api/networks/${auto.id}/discovered`)).length, 0);
});

test('first run: setup screen flag, first account is Admin, later sign-ups start with no access until an admin assigns a role', async () => {
  const env = await boot0();
  const { newClient } = env;
  const anon = newClient();
  assert.equal((await anon('GET', '/api/me')).setup_required, true);

  const admin = newClient();
  const first = await admin.register('admin');
  assert.equal(first.first, true);
  assert.equal(first.user.global_role, 'admin');
  assert.equal((await anon('GET', '/api/me')).setup_required, false);

  const eve = newClient();
  const second = await eve.register('eve');
  assert.equal(second.first, false);
  assert.equal(second.user.global_role, 'none');                      // default role
  assert.deepEqual(second.user.site_roles, {});
  assert.deepEqual(sitesOf(await eve('GET', '/api/overview')), []);   // sees nothing
  await assert.rejects(eve('GET', '/api/users'), /uprawnień/);

  assert.equal((await admin('GET', '/api/me')).user.pending_users, 1);
  assert.equal((await eve('GET', '/api/me')).user.pending_users, undefined);   // only admins see the count
  const users = await admin('GET', '/api/users');
  assert.deepEqual(users.map((u) => [u.username, u.no_roles]), [['admin', false], ['eve', true]]);

  const eveId = users.find((u) => u.username === 'eve').id;
  await admin('PUT', `/api/users/${eveId}/roles`, { role: 'reader' });
  assert.equal((await admin('GET', '/api/me')).user.pending_users, 0);
  assert.equal((await eve('GET', '/api/me')).user.global_role, 'reader');
});
