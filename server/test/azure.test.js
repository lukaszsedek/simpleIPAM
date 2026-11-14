import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApi } from '../src/app.js';
import { toSubnets, toInterfaces, toFrontends, hostnameOf, resourceGroup } from '../src/azure.js';

const DIR = '11111111-1111-1111-1111-111111111111', APP = '22222222-2222-2222-2222-222222222222';
const SUB = '33333333-3333-3333-3333-333333333333';
const RG = `/subscriptions/${SUB}/resourceGroups/rg-prod`;
const subnet = (vnet, name, prefix) => ({ id: `${RG}/providers/Microsoft.Network/virtualNetworks/${vnet}/subnets/${name}`, name, properties: { addressPrefix: prefix } });
const SN_APP = subnet('vnet-hub', 'snet-app', '10.10.1.0/24');

// Fake login.microsoftonline.com + management.azure.com for one subscription.
function fakeAzure() {
  const f = { calls: [], secretOk: true, denied: false, pages: false };
  const json = (data, status = 200) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  f.vnets = [
    { id: `${RG}/providers/Microsoft.Network/virtualNetworks/vnet-hub`, name: 'vnet-hub', location: 'westeurope', properties: { addressSpace: { addressPrefixes: ['10.10.0.0/16'] }, subnets: [SN_APP, subnet('vnet-hub', 'snet-data', '10.10.2.0/24'), { ...subnet('vnet-hub', 'v6', 'x'), properties: { addressPrefixes: ['fd00::/64'] } }, subnet('vnet-hub', 'huge', '10.0.0.0/8')] } },
    { id: `${RG}/providers/Microsoft.Network/virtualNetworks/vnet-dup`, name: 'vnet-dup', location: 'westeurope', properties: { subnets: [subnet('vnet-dup', 'same', '10.10.1.0/24')] } },
  ];
  f.nics = [
    { id: `${RG}/providers/Microsoft.Network/networkInterfaces/nic-web`, name: 'nic-web', properties: { macAddress: '00-0D-3A-AA-BB-CC', virtualMachine: { id: `${RG}/providers/Microsoft.Compute/virtualMachines/VM-Web_01` },
      ipConfigurations: [{ properties: { privateIPAddress: '10.10.1.4', primary: true, privateIPAllocationMethod: 'Dynamic', subnet: { id: SN_APP.id.toUpperCase() } } }, { properties: { privateIPAddress: '10.10.1.5', primary: false, privateIPAllocationMethod: 'Static', subnet: { id: SN_APP.id } } }] } },
    { id: `${RG}/providers/Microsoft.Network/networkInterfaces/pe-sql.nic`, name: 'pe-sql.nic', properties: { macAddress: '00-0D-3A-00-00-01', privateEndpoint: { id: `${RG}/providers/Microsoft.Network/privateEndpoints/pe-sql` }, ipConfigurations: [{ properties: { privateIPAddress: '10.10.2.4', subnet: { id: subnet('vnet-hub', 'snet-data', '').id } } }] } },
    { id: `${RG}/providers/Microsoft.Network/networkInterfaces/orphan`, name: 'orphan', properties: { ipConfigurations: [{ properties: { privateIPAddress: '172.31.0.4' } }] } },
  ];
  f.lbs = [{ id: `${RG}/providers/Microsoft.Network/loadBalancers/lb-int`, name: 'lb-int', properties: { frontendIPConfigurations: [{ name: 'fe1', properties: { privateIPAddress: '10.10.1.10', subnet: { id: SN_APP.id } } }, { name: 'public', properties: {} }] } }];
  f.fetch = async (url, init = {}) => {
    const u = new URL(url);
    f.calls.push(`${init.method ?? 'GET'} ${u.host}${u.pathname}`);
    if (u.host === 'login.microsoftonline.com') {
      assert.equal(u.pathname, `/${DIR}/oauth2/v2.0/token`);
      const b = new URLSearchParams(init.body);
      assert.equal(b.get('grant_type'), 'client_credentials');
      assert.equal(b.get('scope'), 'https://management.azure.com/.default');
      if (!f.secretOk || b.get('client_secret') !== 'S3CRET' || b.get('client_id') !== APP) return json({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: abc\r\nTimestamp: now' }, 401);
      return json({ access_token: 'TOKEN', expires_in: 3599 });
    }
    assert.equal(u.host, 'management.azure.com');
    assert.equal(init.headers.authorization, 'Bearer TOKEN');
    if (f.denied && u.pathname.includes('/providers/')) return json({}, 403);
    if (u.pathname === '/subscriptions') return json({ value: [{ subscriptionId: SUB, displayName: 'Prod', state: 'Enabled' }, { subscriptionId: 'dead', displayName: 'Old', state: 'Disabled' }] });
    const base = `/subscriptions/${SUB}/providers/Microsoft.Network`;
    if (u.pathname === `${base}/virtualNetworks`) {
      if (f.pages && !u.searchParams.has('page')) return json({ value: [f.vnets[0]], nextLink: `https://management.azure.com${base}/virtualNetworks?api-version=2024-05-01&page=2` });
      return json({ value: f.pages ? [f.vnets[1]] : f.vnets });
    }
    if (u.pathname === `${base}/networkInterfaces`) return json({ value: f.nics });
    if (u.pathname === `${base}/loadBalancers`) return json({ value: f.lbs });
    return json({}, 404);
  };
  return f;
}

async function setup() {
  const f = fakeAzure();
  const api = createApi(openDb(':memory:'), { fetch: f.fetch });
  const ctx = {};
  const call = async (m, p, body = {}, q = {}) => { const o = await api(m, p, q, body, ctx); if (ctx.newToken) { ctx.token = ctx.newToken; ctx.newToken = undefined; } return o; };
  await call('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  const tenant = await call('POST', '/api/tenants', { name: 'cloud' });
  return { f, api, call, tenant };
}
const connect = async ({ call, tenant }) => {
  await call('PUT', '/api/admin/azure', { directory_id: DIR, client_id: APP, client_secret: 'S3CRET', tenant_id: tenant.id });
  const d = await call('POST', '/api/admin/azure/discover');
  await call('PUT', '/api/admin/azure', { subscriptions: [{ id: SUB, enabled: true }] });
  return d;
};

test('parsers: subnets (IPv4 only), interfaces by VM / private endpoint, load balancer frontends', () => {
  const [hub] = fakeAzure().vnets;
  assert.deepEqual(toSubnets(hub).map((s) => s.cidr), ['10.10.1.0/24', '10.10.2.0/24', '10.0.0.0/8']);
  const [web, pe] = fakeAzure().nics;
  const rows = toInterfaces(web);
  assert.deepEqual(rows.map((r) => [r.ip, r.name, r.kind, r.primary, r.method]), [['10.10.1.4', 'VM-Web_01', 'vm', true, 'Dynamic'], ['10.10.1.5', 'VM-Web_01', 'vm', false, 'Static']]);
  assert.equal(toInterfaces(pe)[0].name, 'pe-sql');
  assert.equal(toInterfaces(pe)[0].kind, 'private-endpoint');
  assert.deepEqual(toFrontends(fakeAzure().lbs[0]).map((r) => [r.ip, r.name]), [['10.10.1.10', 'lb-int/fe1']]);
  assert.equal(hostnameOf('VM-Web_01 (prod)'), 'vm-web_01-prod');
  assert.equal(resourceGroup(RG), 'rg-prod');
});

test('azure: credentials are write-only, discover lists enabled subscriptions, bad secret gives the AAD reason', async () => {
  const s = await setup();
  const d = await connect(s);
  assert.equal(d.secret_set, true);
  assert.equal(d.client_secret, undefined);
  assert.deepEqual(d.subscriptions.map((x) => [x.id, x.name]), [[SUB, 'Prod']]);        // disabled subscription is not offered
  const kept = await s.call('PUT', '/api/admin/azure', { auto_sync: true });             // no secret in the body = keep
  assert.equal(kept.secret_set, true);
  await assert.rejects(s.call('PUT', '/api/admin/azure', { directory_id: 'nope' }), /GUID/);
  s.f.secretOk = false;
  await assert.rejects(s.call('POST', '/api/admin/azure/discover'), (e) => /Invalid client secret/.test(e.message) && !/Trace ID/.test(e.message));
  const plain = createApi(openDb(':memory:'), { fetch: s.f.fetch });
  await assert.rejects(plain('GET', '/api/admin/azure', {}, {}, {}), /zalog|Zaloguj|401|Wymagane/i);
});

test('azure sync: subscription → location, subnets → networks (.1 gateway), NICs and load balancers → entries; dry run writes nothing', async () => {
  const s = await setup();
  await connect(s);
  const dry = await s.call('POST', '/api/admin/azure/sync', { dry_run: true });
  assert.equal(dry.dry, true);
  assert.deepEqual(dry.results[0].networks, { created: 2, updated: 0, skipped: 2 });     // the IPv6 subnet never reaches the importer; the /8 and the duplicate CIDR are skipped
  assert.equal((await s.call('GET', '/api/overview'))[0].sites.length, 0);

  const r = await s.call('POST', '/api/admin/azure/sync', {});
  assert.equal(r.ok, false);                                                             // skipped /8 + duplicate are reported
  assert.ok(r.results[0].errors.some((e) => /większa niż \/16/.test(e)));
  assert.ok(r.results[0].errors.some((e) => /już zaimportowano/.test(e)));
  assert.equal(r.results[0].entries.created, 4);                                         // 2 NIC IPs + private endpoint + LB frontend; the orphan IP is skipped
  assert.equal(r.results[0].entries.skipped, 1);

  const [t] = await s.call('GET', '/api/overview');
  const [site] = t.sites;
  assert.equal(site.name, 'Prod');
  const nets = Object.fromEntries(site.networks.map((n) => [n.cidr, n]));
  assert.equal(nets['10.10.1.0/24'].name, 'vnet-hub / snet-app');
  assert.equal(nets['10.10.1.0/24'].gateway, '10.10.1.1');
  const full = await s.call('GET', `/api/networks/${nets['10.10.1.0/24'].id}`);
  const byIp = Object.fromEntries(full.entries.map((e) => [e.ip, e]));
  assert.deepEqual([byIp['10.10.1.4'].fqdn, byIp['10.10.1.4'].alias, byIp['10.10.1.4'].mac, byIp['10.10.1.4'].type, byIp['10.10.1.4'].tags], ['vm-web_01', 'VM-Web_01', '00:0d:3a:aa:bb:cc', 'vm', 'azure,vm']);
  assert.equal(byIp['10.10.1.5'].fqdn, '');                                              // secondary IP config: no second FQDN
  assert.match(byIp['10.10.1.5'].description, /Static/);
  assert.equal(byIp['10.10.1.10'].alias, 'lb-int/fe1');
  const data = await s.call('GET', `/api/networks/${nets['10.10.2.0/24'].id}`);
  assert.equal(data.entries[0].alias, 'pe-sql');

  // second run is idempotent and keeps what a person edited
  await s.call('PUT', `/api/entries/${byIp['10.10.1.4'].id}`, { ...byIp['10.10.1.4'], description: 'moje' });
  const again = await s.call('POST', '/api/admin/azure/sync', {});
  assert.deepEqual([again.results[0].networks.created, again.results[0].entries.created, again.results[0].entries.updated], [0, 0, 0]);
  assert.equal((await s.call('GET', `/api/networks/${nets['10.10.1.0/24'].id}`)).entries.find((e) => e.ip === '10.10.1.4').description, 'moje');
  // the location is found by subscription id even after a rename
  await s.call('PUT', `/api/sites/${site.id}`, { name: 'Produkcja' });
  await s.call('POST', '/api/admin/azure/sync', {});
  assert.deepEqual((await s.call('GET', '/api/overview'))[0].sites.map((x) => x.name), ['Produkcja']);
  assert.ok(s.f.calls.every((c) => !c.startsWith('POST management') && !c.startsWith('PUT') && !c.startsWith('DELETE')));   // read-only
});

test('azure: pagination follows nextLink only on management.azure.com; 403 and diagnose explain missing Reader role', async () => {
  const s = await setup();
  await connect(s);
  s.f.pages = true;
  const r = await s.call('POST', '/api/admin/azure/sync', {});
  assert.equal(r.results[0].networks.created, 2);                                        // both pages were read
  const ok = await s.call('POST', '/api/admin/azure/diagnose');
  assert.deepEqual([ok.results[0].vnets, ok.results[0].interfaces, ok.results[0].load_balancers], [2, 3, 1]);
  s.f.denied = true;
  const bad = await s.call('POST', '/api/admin/azure/diagnose');
  assert.equal(bad.results[0].vnets, null);
  assert.match(bad.results[0].errors[0], /Reader/);
  const sync = await s.call('POST', '/api/admin/azure/sync', {});
  assert.equal(sync.ok, false);
  assert.match(sync.results[0].errors[0], /Reader/);
});
