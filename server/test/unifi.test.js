import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApi } from '../src/app.js';
import { toNetwork, toClient, hostnameOf, findKey } from '../src/unifi.js';

// Fake api.ui.com: one console with one site, a gateway-managed LAN with a DHCP pool, and a few clients.
function fakeUbiquiti() {
  const f = { calls: [], clients: [], keyOk: true };
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
    const base = '/v1/connector/consoles/host1/proxy/network/integration/v1';
    if (u.pathname === `${base}/sites`) return page([{ id: 's1', name: 'Default' }]);
    if (u.pathname === `${base}/sites/s1/networks`) return page(f.networks);
    if (u.pathname === `${base}/sites/s1/clients`) return page(f.clients);
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
  assert.deepEqual(toClient({ ipAddress: '10.0.0.5', macAddress: 'AA:BB:CC:00:00:01', name: 'cam', type: 'WIRELESS' }), { ip: '10.0.0.5', mac: 'AA:BB:CC:00:00:01', name: 'cam', wifi: true });
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
  assert.deepEqual([iot.entries[0].fqdn, iot.entries[0].description], ['', 'Kamera Garaż']);
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
  assert.deepEqual([h[0].action, h[0].actor], ['mac_seen', 'unifi']);
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
