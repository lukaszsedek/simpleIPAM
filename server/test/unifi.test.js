import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApi } from '../src/app.js';
import { toNetwork, toClient, toDevice, hostnameOf, findKey } from '../src/unifi.js';

// Fake api.ui.com: one console with one site, a gateway-managed LAN with a DHCP pool, and a few clients.
function fakeUbiquiti() {
  const f = { calls: [], clients: [], keyOk: true, known: [], puts: [], classicDown: false, devices: [], devicesDown: false };
  const page = (data) => ({ ok: true, status: 200, json: async () => ({ data, offset: 0, limit: 200, count: data.length, totalCount: data.length }), text: async () => '' });
  const net = (over = {}) => ({ id: 'n1', name: 'LAN', vlanId: 1, enabled: true, management: 'GATEWAY',
    ipv4Configuration: { hostIpAddress: '192.168.1.1', prefixLength: 24, dhcpConfiguration: { mode: 'SERVER', ipAddressRange: { start: '192.168.1.100', stop: '192.168.1.199' }, dnsServerIpAddressesOverride: ['1.1.1.1', '9.9.9.9'] } }, ...over });
  f.networks = [net(), { id: 'n2', name: 'IoT', vlanId: 20, enabled: true, management: 'GATEWAY', ipv4Configuration: { hostIpAddress: '10.20.0.1', prefixLength: 24 } }, { id: 'n3', name: 'Unmanaged', vlanId: 30, management: 'UNMANAGED' }];
  f.fetch = async (url, init) => {
    const u = new URL(url);
    f.calls.push(u.pathname);
    assert.equal(u.host, 'api.ui.com');
    if (!f.keyOk || init.headers['x-api-key'] !== 'KEY') return { ok: false, status: 401, text: async () => '', json: async () => ({}) };
    if (u.pathname === '/v1/hosts') return { ok: true, status: 200, json: async () => ({ data: [{ id: 'host1', type: 'console', ipAddress: '1.2.3.4', reportedState: { name: 'Cloud Gateway Fiber' } }, { id: 'host2', reportedState: { hostname: 'UDM7' } }] }) };
    const cbase = '/v1/connector/consoles/host1/proxy/network/api';
    if (u.pathname.startsWith(cbase)) {                       // classic API (aliases)
      if (f.classicDown) return { ok: false, status: 403, text: async () => '', json: async () => ({}) };
      const reply = (data) => ({ ok: true, status: 200, json: async () => ({ meta: { rc: 'ok' }, data }), text: async () => '' });
      if (u.pathname === `${cbase}/self/sites`) return reply([{ name: 'default', desc: 'Default' }]);
      if (u.pathname === `${cbase}/s/default/rest/user` && (init.method ?? 'GET') === 'GET') return reply(f.known);
      if (u.pathname === `${cbase}/s/default/rest/networkconf`) return reply(f.networkconf ?? [{ _id: 'n1', ip_subnet: '192.168.1.1/24' }]);
      const m = u.pathname.match(/\/s\/default\/rest\/user\/(\w+)$/);
      if (m && init.method === 'PUT') { const body = JSON.parse(init.body); f.puts.push({ id: m[1], ...body }); const k = f.known.find((x) => x._id === m[1]); if (k && body.name !== undefined) k.name = body.name; if (k && body.use_fixedip) Object.assign(k, { use_fixedip: true, fixed_ip: body.fixed_ip, network_id: body.network_id }); return reply([{}]); }
    }
    const base = '/v1/connector/consoles/host1/proxy/network/integration/v1';
    if (u.pathname === `${base}/sites`) return page([{ id: 's1', name: 'Default', internalReference: 'default' }]);
    if (u.pathname === `${base}/sites/s1/networks`) return page(f.networks);
    if (u.pathname === `${base}/sites/s1/clients`) return page(f.clients);
    if (u.pathname === `${base}/sites/s1/devices`) return f.devicesDown ? { ok: false, status: 404, text: async () => '', json: async () => ({}) } : page(f.devices);
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
  return f;
}

async function setup() {
  const f = fakeUbiquiti();
  const api = createApi(openDb(':memory:'), { fetch: f.fetch });
  const ctx = {};
  const call = async (m, p, body = {}, q = {}) => { const o = await api(m, p, q, body, ctx); if (ctx.newToken) { ctx.token = ctx.newToken; ctx.newToken = undefined; } return o; };
  await call('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  const tenant = await call('POST', '/api/tenants', { name: 'home' });
  return { f, api, call, tenant };
}
const connect = async ({ call, tenant }) => {
  await call('PUT', '/api/admin/unifi', { api_key: 'KEY', tenant_id: tenant.id });
  const d = await call('POST', '/api/admin/unifi/discover');
  await call('PUT', '/api/admin/unifi', { consoles: [{ id: 'host1', enabled: true }] });
  return d;
};

test('parsers: tolerant network/client mapping and hostname detection', () => {
  const n = toNetwork({ id: 'x', name: ' Guest ', vlanId: 40, ipv4Configuration: { hostIpAddress: '192.168.40.1', prefixLength: 24, dhcpConfiguration: { ipAddressRange: { start: '192.168.40.50', stop: '192.168.40.99' } } } });
  assert.deepEqual([n.name, n.cidr, n.vlan, n.gateway, n.dhcp_start, n.dhcp_end], ['Guest', '192.168.40.0/24', 40, '192.168.40.1', '192.168.40.50', '192.168.40.99']);
  assert.equal(toNetwork({ id: 'y', management: 'UNMANAGED' }), null);
  assert.equal(toNetwork({ id: 'z', vlanId: 5, hostIpAddress: '10.0.0.1', prefixLength: 24 }).cidr, '10.0.0.0/24');   // flat shape works too
  assert.equal(toNetwork({ id: 'o', ipv4Configuration: { hostIpAddress: '10.0.0.1', prefixLength: 24, dhcpConfiguration: { ipAddressRange: { start: '172.16.0.1', stop: '172.16.0.9' } } } }).dhcp_start, '');   // range outside the subnet is dropped
  assert.deepEqual(toClient({ ipAddress: '10.0.0.5', macAddress: 'AA:BB:CC:00:00:01', name: 'cam', type: 'WIRELESS' }), { ip: '10.0.0.5', mac: 'AA:BB:CC:00:00:01', name: 'cam', wifi: true, uplink: '' });
  assert.equal(toClient({ ipAddress: '10.0.0.6', uplinkDeviceId: 'dev1' }).uplink, 'dev1');
  assert.deepEqual(['UCG-Fiber', 'USW-Pro-24', 'U6-Pro', 'weird'].map((m) => toDevice({ model: m, ipAddress: '10.0.0.2' }).type), ['router', 'switch', 'ap', 'other']);
  assert.equal(toDevice({ model: 'x', macAddress: 'aa' }), null);
  assert.equal(toClient({ macAddress: 'aa' }), null);
  assert.equal(hostnameOf('Nas-01'), 'nas-01');
  assert.equal(hostnameOf("Łukasz's iPhone"), '');
  assert.equal(findKey({ a: { b: { c: 1 } } }, 'c'), 1);
});

test('discover lists consoles, key never leaves the server, bad key is reported', async () => {
  const ctx = await setup();
  const { call, f } = ctx;
  await assert.rejects(call('POST', '/api/admin/unifi/discover'), /klucz API/);
  const cfg = await call('PUT', '/api/admin/unifi', { api_key: 'KEY', tenant_id: ctx.tenant.id });
  assert.deepEqual([cfg.key_set, 'api_key' in JSON.parse(JSON.stringify(cfg))], [true, false]);
  const d = await call('POST', '/api/admin/unifi/discover');
  assert.deepEqual(d.consoles.map((c) => [c.id, c.name, c.enabled]), [['host1', 'Cloud Gateway Fiber', false], ['host2', 'UDM7', false]]);
  f.keyOk = false;
  await assert.rejects(call('POST', '/api/admin/unifi/discover'), /Klucz API odrzucony/);
});

test('sync: creates site + networks, static clients become entries, pool clients go to discovered, re-sync is idempotent', async () => {
  const ctx = await setup(); const { call, f } = ctx;
  await connect(ctx);
  f.clients = [
    { id: 'c1', name: 'nas', type: 'WIRED', ipAddress: '192.168.1.10', macAddress: 'aa:bb:cc:00:00:10' },
    { id: 'c2', name: "Łukasz's iPhone", type: 'WIRELESS', ipAddress: '192.168.1.150', macAddress: 'aa:bb:cc:00:00:20' },   // inside the DHCP pool
    { id: 'c3', name: 'Kamera Garaż', type: 'WIRED', ipAddress: '10.20.0.5', macAddress: 'aa:bb:cc:00:00:30' },
    { id: 'c4', name: 'orphan', type: 'WIRED', ipAddress: '172.16.0.9', macAddress: 'aa:bb:cc:00:00:40' },                  // no matching network
    { id: 'c5', name: 'no-ip', type: 'WIRELESS' },
  ];
  const dry = await call('POST', '/api/admin/unifi/sync', { dry_run: true });
  assert.deepEqual([dry.results[0].networks.created, dry.results[0].entries.created, dry.results[0].entries.pooled, dry.results[0].entries.skipped], [2, 2, 1, 1]);
  assert.equal((await call('GET', '/api/overview'))[0].sites.length, 0);          // dry run wrote nothing

  const r = await call('POST', '/api/admin/unifi/sync');
  assert.equal(r.ok, true);
  const tree = await call('GET', '/api/overview');
  const site = tree[0].sites[0];
  assert.equal(site.name, 'Cloud Gateway Fiber');
  const lan = site.networks.find((n) => n.cidr === '192.168.1.0/24');
  assert.deepEqual([lan.name, lan.vlan, lan.gateway, lan.dhcp_start, lan.dhcp_end, lan.dns], ['LAN', 1, '192.168.1.1', '192.168.1.100', '192.168.1.199', '1.1.1.1, 9.9.9.9']);
  assert.ok(site.networks.some((n) => n.cidr === '10.20.0.0/24' && n.vlan === 20));
  assert.equal(site.networks.length, 2);                                           // the unmanaged one is skipped

  const lanFull = await call('GET', `/api/networks/${lan.id}`);
  assert.deepEqual(lanFull.entries.map((e) => [e.ip, e.fqdn, e.mac, e.tags]), [['192.168.1.10', 'nas', 'aa:bb:cc:00:00:10', 'unifi,lan']]);
  const found = await call('GET', `/api/networks/${lan.id}/discovered`);
  assert.deepEqual(found.map((d) => [d.ip, d.name, d.mac]), [['192.168.1.150', "Łukasz's iPhone", 'aa:bb:cc:00:00:20']]);
  const iot = await call('GET', `/api/networks/${site.networks.find((n) => n.vlan === 20).id}`);
  assert.deepEqual([iot.entries[0].fqdn, iot.entries[0].alias, iot.entries[0].description], ['', 'Kamera Garaż', '']);
  assert.equal((await call('GET', `/api/entries/${lanFull.entries[0].id}/history`))[0].actor, 'unifi');

  const again = await call('POST', '/api/admin/unifi/sync');
  assert.deepEqual([again.results[0].networks.created, again.results[0].entries.created, again.results[0].entries.updated], [0, 0, 2]);
  assert.equal((await call('GET', '/api/overview'))[0].sites.length, 1);           // no duplicate site

  // UniFi now reports a different MAC for the NAS: same warning as a scan would raise
  f.clients[0].macAddress = 'aa:bb:cc:00:00:99';
  await call('POST', '/api/admin/unifi/sync');
  const nas = (await call('GET', `/api/networks/${lan.id}`)).entries[0];
  assert.deepEqual([nas.mac_alert, nas.seen_mac, nas.mac], [true, 'aa:bb:cc:00:00:99', 'aa:bb:cc:00:00:10']);   // recorded MAC is kept, mismatch flagged
});

test('sync keeps what the user already has: existing network is only filled in, existing entries are not overwritten', async () => {
  const ctx = await setup(); const { call, f, tenant } = ctx;
  await connect(ctx);
  const site = await call('POST', `/api/tenants/${tenant.id}/sites`, { name: 'Cloud Gateway Fiber' });
  const mine = await call('POST', `/api/sites/${site.id}/networks`, { name: 'Moja sieć', cidr: '192.168.1.0/24', description: 'ręczny opis' });
  await call('POST', `/api/networks/${mine.id}/entries`, { ip: '192.168.1.10', fqdn: 'serwer.lan', mac: 'aa:bb:cc:00:00:01', type: 'server' });
  f.clients = [{ id: 'c1', name: 'nas', ipAddress: '192.168.1.10', macAddress: 'aa:bb:cc:00:00:77', type: 'WIRED' }];
  await call('POST', '/api/admin/unifi/sync');
  const n = await call('GET', `/api/networks/${mine.id}`);
  assert.deepEqual([n.name, n.description, n.vlan, n.gateway, n.dhcp_start], ['Moja sieć', 'ręczny opis', 1, '192.168.1.1', '192.168.1.100']);   // blanks filled, rest untouched
  const [e] = n.entries;
  assert.deepEqual([e.fqdn, e.mac, e.type, e.mac_alert, e.seen_mac], ['serwer.lan', 'aa:bb:cc:00:00:01', 'server', true, 'aa:bb:cc:00:00:77']);   // MAC mismatch flagged, not overwritten
  const h = await call('GET', `/api/entries/${e.id}/history`);
  assert.deepEqual(h.map((x) => [x.action, x.actor]).slice(0, 2), [['update', 'unifi'], ['mac_seen', 'unifi']]);   // alias adopted into the empty field + MAC mismatch trail
  assert.equal(e.alias, 'nas');
});

test('sync requires tenant, consoles and admin; per-console errors do not abort the run', async () => {
  const ctx = await setup(); const { call, f } = ctx;
  await assert.rejects(call('POST', '/api/admin/unifi/sync'), /klucz API/);
  await call('PUT', '/api/admin/unifi', { api_key: 'KEY' });
  await assert.rejects(call('POST', '/api/admin/unifi/sync'), /tenanta/);
  await call('PUT', '/api/admin/unifi', { tenant_id: ctx.tenant.id });
  await assert.rejects(call('POST', '/api/admin/unifi/sync'), /konsolę/);
  await call('POST', '/api/admin/unifi/discover');
  await call('PUT', '/api/admin/unifi', { consoles: [{ id: 'host1', enabled: true }, { id: 'host2', enabled: true }] });
  const r = await call('POST', '/api/admin/unifi/sync');          // host2 has no proxy routes in the fake -> 404
  assert.equal(r.ok, false);
  assert.match(r.results.find((x) => x.console === 'UDM7').errors[0], /404/);
  assert.equal(r.results.find((x) => x.console === 'Cloud Gateway Fiber').errors.length, 0);
  assert.equal((await call('GET', '/api/admin/unifi')).last.ok, false);
});

test('alias sync: UniFi rename flows into simpleIPAM; IPAM edits win conflicts and are never overwritten', async () => {
  const ctx = await setup(); const { call, f } = ctx;
  await connect(ctx);
  f.clients = [{ id: 'c1', name: 'nas', type: 'WIRED', ipAddress: '192.168.1.10', macAddress: 'aa:bb:cc:00:00:10' }];
  const first = await call('POST', '/api/admin/unifi/sync');
  assert.equal(first.results[0].aliases.updated, 0);                               // created with the alias, nothing to merge yet
  const site = (await call('GET', '/api/overview'))[0].sites[0];
  const netId = site.networks.find((n) => n.cidr === '192.168.1.0/24').id;
  const get = async () => (await call('GET', `/api/networks/${netId}`)).entries[0];
  assert.deepEqual([(await get()).alias, (await get()).unifi_name], ['nas', 'nas']);

  f.clients[0].name = 'NAS Salon';                                                  // renamed in UniFi
  const dry = await call('POST', '/api/admin/unifi/sync', { dry_run: true });
  assert.equal(dry.results[0].aliases.updated, 1);
  assert.equal((await get()).alias, 'nas');                                         // preview wrote nothing
  await call('POST', '/api/admin/unifi/sync');
  let e = await get();
  assert.deepEqual([e.alias, e.unifi_name], ['NAS Salon', 'NAS Salon']);
  const h = await call('GET', `/api/entries/${e.id}/history`);
  assert.deepEqual([h[0].actor, h[0].changes.alias], ['unifi', ['nas', 'NAS Salon']]);

  await call('PUT', `/api/entries/${e.id}`, { ip: e.ip, alias: 'Serwer plików' });  // edited in simpleIPAM
  await call('POST', '/api/admin/unifi/sync');                                      // UniFi unchanged: IPAM edit stays
  assert.equal((await get()).alias, 'Serwer plików');

  f.clients[0].name = 'NAS Garaż';                                                  // now both sides differ -> IPAM wins
  const r = await call('POST', '/api/admin/unifi/sync');
  assert.deepEqual([r.results[0].aliases.updated, r.results[0].aliases.conflicts], [0, 1]);
  e = await get();
  assert.deepEqual([e.alias, e.unifi_name], ['Serwer plików', 'NAS Garaż']);

  // API clients that omit alias on PUT keep it; CSV imports without an alias column keep it too
  await call('PUT', `/api/entries/${e.id}`, { ip: e.ip, fqdn: 'nas.lan' });
  assert.equal((await get()).alias, 'Serwer plików');
  await call('POST', `/api/networks/${netId}/import`, { csv: 'ip,fqdn\n192.168.1.10,nas2.lan\n' });
  assert.equal((await get()).alias, 'Serwer plików');
  assert.ok((await call('GET', '/api/search', {}, { q: 'serwer plik' })).length === 1);       // searchable
});

test('diagnose probes the integration and classic APIs with GET only and reports statuses', async () => {
  const ctx = await setup(); const { call, f } = ctx;
  await connect(ctx);
  const methods = [];
  const base = f.fetch;
  f.fetch = async (url, init) => {
    methods.push(init.method ?? 'GET');
    if (new URL(url).pathname.endsWith('/proxy/network/api/self/sites')) return { ok: false, status: 401, json: async () => ({}) };
    return base(url, init);
  };
  // the api instance captured f.fetch at creation: rebuild one sharing the same db is overkill, so exercise probe() directly
  const { probe } = await import('../src/unifi.js');
  const cfg = { api_key: 'KEY' };
  const a = await probe(cfg, 'host1', '/integration/v1/sites', { fetch: f.fetch });
  const b = await probe(cfg, 'host1', '/api/self/sites', { fetch: f.fetch });
  assert.deepEqual([a.ok, a.status, a.count], [true, 200, 1]);
  assert.deepEqual([b.ok, b.status], [false, 401]);
  assert.deepEqual([...new Set(methods)], ['GET']);
  const r = await call('POST', '/api/admin/unifi/diagnose');          // route wiring (fake serves the classic path now)
  assert.deepEqual([r.results[0].console, r.results[0].integration.ok, r.results[0].legacy.status], ['Cloud Gateway Fiber', true, 200]);
});

test('alias push: preview, first manual write verifies, then edits flow to UniFi automatically', async () => {
  const ctx = await setup(); const { call, f } = ctx;
  await connect(ctx);
  f.clients = [{ id: 'c1', name: 'nas', type: 'WIRED', ipAddress: '192.168.1.10', macAddress: 'aa:bb:cc:00:00:10' },
    { id: 'c2', name: 'tv', type: 'WIRED', ipAddress: '192.168.1.11', macAddress: 'aa:bb:cc:00:00:11' }];
  f.known = [{ _id: 'u1', mac: 'aa:bb:cc:00:00:10', name: 'nas' }, { _id: 'u2', mac: 'aa:bb:cc:00:00:11', name: 'tv' }];
  await assert.rejects(call('POST', '/api/admin/unifi/push'), /synchronizację/);            // nothing imported yet
  await call('POST', '/api/admin/unifi/sync');
  const net = (await call('GET', '/api/overview'))[0].sites[0].networks[0];
  const entries = async () => (await call('GET', `/api/networks/${net.id}`)).entries;
  const nas = (await entries()).find((e) => e.ip === '192.168.1.10');

  // automatic push cannot be switched on before a verified manual write
  await assert.rejects(call('PUT', '/api/admin/unifi', { push_aliases: true }), /ręcznie/);

  await call('PUT', `/api/entries/${nas.id}`, { ...nas, alias: 'NAS Salon' });           // edited in simpleIPAM
  assert.equal(f.puts.length, 0);                                                            // automation is off: nothing sent
  const dry = await call('POST', '/api/admin/unifi/push', { dry_run: true });
  assert.deepEqual(dry.results[0].planned, [{ ip: '192.168.1.10', mac: 'aa:bb:cc:00:00:10', from: 'nas', to: 'NAS Salon' }]);
  assert.deepEqual([dry.pushed, f.puts.length], [0, 0]);                                     // preview wrote nothing

  const r = await call('POST', '/api/admin/unifi/push');
  assert.deepEqual([r.ok, r.pushed, f.puts], [true, 1, [{ id: 'u1', name: 'NAS Salon' }]]);
  assert.equal((await entries()).find((e) => e.id === nas.id).unifi_name, 'NAS Salon');
  assert.equal((await call('GET', `/api/entries/${nas.id}/history`))[0].action, 'pushed');
  assert.equal((await call('POST', '/api/admin/unifi/push')).pushed, 0);                     // idempotent
  assert.equal((await call('GET', '/api/admin/unifi')).write_verified, true);

  // now automation may be enabled: an alias saved in simpleIPAM goes out immediately
  await call('PUT', '/api/admin/unifi', { push_aliases: true });
  await call('PUT', `/api/entries/${nas.id}`, { ...nas, alias: 'NAS Garaż' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(f.puts.at(-1), { id: 'u1', name: 'NAS Garaż' });

  // ...and a rename made in UniFi still flows the other way during sync, without being pushed back
  f.clients[1].name = 'Telewizor'; f.known[1].name = 'Telewizor';
  const before = f.puts.length;
  const sync = await call('POST', '/api/admin/unifi/sync');
  assert.equal((await entries()).find((e) => e.ip === '192.168.1.11').alias, 'Telewizor');
  assert.equal(f.puts.length, before);
  assert.equal(sync.push.pushed, 0);
});

test('alias push is careful: unknown clients are skipped, emptied alias never clears UniFi, failures are reported', async () => {
  const ctx = await setup(); const { call, f } = ctx;
  await connect(ctx);
  f.clients = [{ id: 'c1', name: 'nas', type: 'WIRED', ipAddress: '192.168.1.10', macAddress: 'aa:bb:cc:00:00:10' },
    { id: 'c2', name: 'cam', type: 'WIRED', ipAddress: '192.168.1.12', macAddress: 'aa:bb:cc:00:00:12' }];
  f.known = [{ _id: 'u1', mac: 'aa:bb:cc:00:00:10', name: 'nas' }];                           // cam is not a "known" client
  await call('POST', '/api/admin/unifi/sync');
  const net = (await call('GET', '/api/overview'))[0].sites[0].networks[0];
  const es = (await call('GET', `/api/networks/${net.id}`)).entries;
  const [nas, cam] = [es.find((e) => e.ip.endsWith('.10')), es.find((e) => e.ip.endsWith('.12'))];
  await call('PUT', `/api/entries/${cam.id}`, { ...cam, alias: 'Kamera' });
  await call('PUT', `/api/entries/${nas.id}`, { ...nas, alias: '' });                    // cleared in simpleIPAM
  const r = await call('POST', '/api/admin/unifi/push');
  assert.deepEqual([r.pushed, f.puts.length], [0, 0]);
  assert.match(r.results[0].skipped[0].reason, /nie zna/);
  f.known.push({ _id: 'u3', mac: 'aa:bb:cc:00:00:12', name: 'cam' });
  f.classicDown = true;
  const bad = await call('POST', '/api/admin/unifi/push');
  assert.equal(bad.ok, false);
  assert.match(bad.results[0].errors[0], /401\/403/);
  assert.equal((await call('GET', '/api/admin/unifi')).write_verified, false);                // a failed write never verifies
});

test('network devices become entries (typed) and clients show which AP/switch they hang on; missing devices endpoint is harmless', async () => {
  const ctx = await setup(); const { call, f } = ctx;
  await connect(ctx);
  f.devices = [
    { id: 'd1', name: 'UCG-Fiber', model: 'UCG-Fiber', macAddress: 'aa:bb:cc:01:00:01', ipAddress: '192.168.1.1', firmwareVersion: '4.1.0', features: ['gateway'] },
    { id: 'd2', name: 'AP Salon', model: 'U6-Pro', macAddress: 'aa:bb:cc:01:00:02', ipAddress: '192.168.1.2', firmwareVersion: '6.7.0' },
    { id: 'd3', name: 'Switch Rack', model: 'USW-Pro-24', macAddress: 'aa:bb:cc:01:00:03', ipAddress: '192.168.1.3' },
  ];
  f.clients = [{ id: 'c1', name: 'nas', type: 'WIRED', ipAddress: '192.168.1.10', macAddress: 'aa:bb:cc:00:00:10', uplinkDeviceId: 'd3' },
    { id: 'c2', name: 'phone', type: 'WIRELESS', ipAddress: '192.168.1.150', macAddress: 'aa:bb:cc:00:00:15', uplinkDeviceId: 'd2' }];   // pool client
  await call('POST', '/api/admin/unifi/sync');
  const net = (await call('GET', '/api/overview'))[0].sites[0].networks.find((n) => n.cidr === '192.168.1.0/24');
  const es = (await call('GET', `/api/networks/${net.id}`)).entries;
  assert.deepEqual(es.map((e) => [e.ip, e.type, e.alias, e.tags]), [['192.168.1.1', 'router', 'UCG-Fiber', 'unifi,device'], ['192.168.1.2', 'ap', 'AP Salon', 'unifi,device'], ['192.168.1.3', 'switch', 'Switch Rack', 'unifi,device'], ['192.168.1.10', 'other', 'nas', 'unifi,lan']]);
  assert.equal(es[1].description, 'U6-Pro · fw 6.7.0');
  assert.equal(es[3].uplink, 'Switch Rack');
  assert.equal((await call('GET', `/api/networks/${net.id}/discovered`))[0].ip, '192.168.1.150');   // pool client still waits as a new device

  f.clients[0].uplinkDeviceId = 'd2';                                                                // moved to the AP
  await call('POST', '/api/admin/unifi/sync');
  assert.equal((await call('GET', `/api/networks/${net.id}`)).entries.find((e) => e.ip.endsWith('.10')).uplink, 'AP Salon');
  f.devicesDown = true;                                                                              // console without the endpoint
  const r = await call('POST', '/api/admin/unifi/sync');
  assert.equal(r.ok, true);
});

test('DHCP reservations: preview, write fixed IPs for reserved entries, skip unknown clients and networks', async () => {
  const ctx = await setup(); const { call, f } = ctx;
  await connect(ctx);
  f.clients = [{ id: 'c1', name: 'nas', type: 'WIRED', ipAddress: '192.168.1.10', macAddress: 'aa:bb:cc:00:00:10' },
    { id: 'c2', name: 'tv', type: 'WIRED', ipAddress: '192.168.1.11', macAddress: 'aa:bb:cc:00:00:11' }];
  f.known = [{ _id: 'u1', mac: 'aa:bb:cc:00:00:10', name: 'nas' }, { _id: 'u2', mac: 'aa:bb:cc:00:00:11', name: 'tv', use_fixedip: true, fixed_ip: '192.168.1.11', network_id: 'n1' }];
  await assert.rejects(call('POST', '/api/admin/unifi/reserve'), /synchronizację/);
  await call('POST', '/api/admin/unifi/sync');
  const net = (await call('GET', '/api/overview'))[0].sites[0].networks[0];
  const es = (await call('GET', `/api/networks/${net.id}`)).entries;
  for (const e of es.filter((x) => x.ip.endsWith('.10') || x.ip.endsWith('.11'))) await call('PUT', `/api/entries/${e.id}`, { ...e, status: 'reserved' });
  const dry = await call('POST', '/api/admin/unifi/reserve', { dry_run: true });
  assert.deepEqual(dry.results[0].planned.map((p) => [p.ip, p.from, p.to]), [['192.168.1.10', '', '192.168.1.10']]);   // tv already reserved
  assert.equal(f.puts.length, 0);
  const r = await call('POST', '/api/admin/unifi/reserve');
  assert.deepEqual([r.pushed, f.puts.length], [1, 1]);
  assert.deepEqual([f.puts[0].id, f.puts[0].use_fixedip, f.puts[0].fixed_ip, f.puts[0].network_id], ['u1', true, '192.168.1.10', 'n1']);
  assert.equal((await call('POST', '/api/admin/unifi/reserve')).pushed, 0);                  // idempotent
  f.networkconf = [{ _id: 'n9', ip_subnet: '10.9.9.1/24' }];                                 // UniFi has no such network
  f.known[0].use_fixedip = false;
  assert.match((await call('POST', '/api/admin/unifi/reserve', { dry_run: true })).results[0].skipped[0].reason, /sieci o tym CIDR/);
});
