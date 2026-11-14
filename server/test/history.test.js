import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApi } from '../src/app.js';
import { parseProcArp, parseArpAn } from '../src/neighbors.js';

const client = (api) => {
  const ctx = { ip: '127.0.0.1' };
  return async (m, p, body = {}, q = {}) => { const o = await api(m, p, q, body, ctx); if (ctx.newToken) { ctx.token = ctx.newToken; ctx.newToken = undefined; } return o; };
};
async function setup() {
  const alive = new Set(), arp = new Map();
  const api = createApi(openDb(':memory:'), { ping: async (ip) => alive.has(ip), neighbors: async () => new Map(arp) });
  const admin = client(api);
  await admin('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  const t = await admin('POST', '/api/tenants', { name: 'home' });
  const site = await admin('POST', `/api/tenants/${t.id}/sites`, { name: 'dom' });
  const net = await admin('POST', `/api/sites/${site.id}/networks`, { name: 'lan', cidr: '10.0.0.0/28' });
  return { api, admin, alive, arp, net };
}

test('entry history records create/update/delete with old and new values and who did it', async () => {
  const { admin, net } = await setup();
  const e = await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.2', fqdn: 'nas.lan', mac: 'aa:bb:cc:dd:ee:01', tags: 'storage' });
  await admin('PUT', `/api/entries/${e.id}`, { ip: '10.0.0.2', fqdn: 'nas2.lan', mac: 'aa:bb:cc:dd:ee:01', tags: 'storage', status: 'reserved' });
  await admin('PUT', `/api/entries/${e.id}`, { ip: '10.0.0.2', fqdn: 'nas2.lan', mac: 'aa:bb:cc:dd:ee:01', tags: 'storage', status: 'reserved' });   // no change: no row
  const h = await admin('GET', `/api/entries/${e.id}/history`);
  assert.deepEqual(h.map((r) => r.action), ['update', 'create']);                      // newest first, no-op update skipped
  assert.deepEqual(h[0].changes, { fqdn: ['nas.lan', 'nas2.lan'], status: ['used', 'reserved'] });
  assert.equal(h[0].actor, 'admin');
  assert.deepEqual(h[1].changes.fqdn, ['', 'nas.lan']);

  await admin('DELETE', `/api/entries/${e.id}`);
  const byIp = await admin('GET', `/api/networks/${net.id}/history`, {}, { ip: '10.0.0.2' });   // survives deletion
  assert.deepEqual(byIp.map((r) => r.action), ['delete', 'update', 'create']);
  assert.deepEqual(byIp[0].changes.fqdn, ['nas2.lan', '']);
  assert.equal((await admin('GET', `/api/networks/${net.id}/history`)).length, 3);
});

test('history also covers CSV import and bulk edits', async () => {
  const { admin, net } = await setup();
  await admin('POST', `/api/networks/${net.id}/import`, { csv: 'ip,fqdn\n10.0.0.3,a.lan\n10.0.0.4,b.lan\n' });
  await admin('POST', `/api/networks/${net.id}/import`, { csv: 'ip,fqdn\n10.0.0.3,renamed.lan\n' });
  const a = (await admin('GET', `/api/networks/${net.id}`)).entries.find((e) => e.ip === '10.0.0.3');
  assert.deepEqual((await admin('GET', `/api/entries/${a.id}/history`)).map((r) => r.action), ['update', 'create']);
  await admin('POST', `/api/networks/${net.id}/entries/bulk`, { ids: [a.id], action: 'update', changes: { status: 'reserved' } });
  assert.deepEqual((await admin('GET', `/api/entries/${a.id}/history`))[0].changes, { status: ['used', 'reserved'] });
});

test('scan detects a changed MAC; accept updates the entry, ignore silences that MAC only', async () => {
  const { admin, alive, arp, net } = await setup();
  const e = await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.2', fqdn: 'cam.lan', mac: 'aa:bb:cc:dd:ee:01' });
  const empty = await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.3', fqdn: 'new.lan' });
  alive.add('10.0.0.2'); alive.add('10.0.0.3'); alive.add('10.0.0.9');
  arp.set('10.0.0.2', 'aa:bb:cc:dd:ee:01'); arp.set('10.0.0.3', 'aa:bb:cc:dd:ee:03'); arp.set('10.0.0.9', 'aa:bb:cc:dd:ee:09');

  const r1 = await admin('POST', `/api/networks/${net.id}/scan`);
  assert.equal(r1.macs, 3);
  let full = await admin('GET', `/api/networks/${net.id}`);
  const get = (id) => full.entries.find((x) => x.id === id);
  assert.equal(get(e.id).mac_alert, false);                                    // same MAC: fine
  assert.deepEqual([get(empty.id).mac_suggest, get(empty.id).seen_mac], [true, 'aa:bb:cc:dd:ee:03']);   // no MAC recorded: suggestion only
  assert.equal(full.stats.mac_alerts, 0);
  assert.equal((await admin('GET', `/api/networks/${net.id}/discovered`))[0].mac, 'aa:bb:cc:dd:ee:09');

  arp.set('10.0.0.2', 'aa:bb:cc:dd:ee:99');                                    // someone replaced the camera
  await admin('POST', `/api/networks/${net.id}/scan`);
  full = await admin('GET', `/api/networks/${net.id}`);
  assert.equal(get(e.id).mac_alert, true);
  assert.equal(full.stats.mac_alerts, 1);
  const issues = await admin('GET', `/api/networks/${net.id}/issues`);
  assert.ok(issues.some((i) => i.level === 'error' && /aa:bb:cc:dd:ee:99/.test(i.text) && /aa:bb:cc:dd:ee:01/.test(i.text)));
  const trail = await admin('GET', `/api/entries/${e.id}/history`);
  assert.deepEqual([trail[0].action, trail[0].actor, trail[0].changes.mac], ['mac_seen', 'skan', ['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:99']]);
  await admin('POST', `/api/networks/${net.id}/scan`);                         // rescanning the same MAC does not repeat the trail
  assert.equal((await admin('GET', `/api/entries/${e.id}/history`)).filter((x) => x.action === 'mac_seen').length, 1);

  await admin('POST', `/api/entries/${e.id}/mac`, { action: 'ignore' });
  full = await admin('GET', `/api/networks/${net.id}`);
  assert.equal(get(e.id).mac_alert, false);
  arp.set('10.0.0.2', 'aa:bb:cc:dd:ee:77');                                    // yet another MAC: alert returns
  await admin('POST', `/api/networks/${net.id}/scan`);
  assert.equal((await admin('GET', `/api/networks/${net.id}`)).entries.find((x) => x.id === e.id).mac_alert, true);

  const acc = await admin('POST', `/api/entries/${e.id}/mac`, { action: 'accept' });
  assert.deepEqual([acc.mac, acc.mac_alert], ['aa:bb:cc:dd:ee:77', false]);
  assert.deepEqual((await admin('GET', `/api/entries/${e.id}/history`))[0].changes.mac, ['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:77']);
  await assert.rejects(admin('POST', `/api/entries/${e.id}/mac`, { action: 'nope' }), /Nieznana/);

  // adopting a discovered host keeps the MAC the scan saw
  const adopted = await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.9' });
  assert.equal((await admin('GET', `/api/networks/${net.id}`)).entries.find((x) => x.id === adopted.id).seen_mac, 'aa:bb:cc:dd:ee:09');
});

test('neighbour table parsers: Linux /proc/net/arp and macOS/BSD arp -an', () => {
  const proc = 'IP address       HW type     Flags       HW address            Mask     Device\n'
    + '192.168.1.1      0x1         0x2         AA:BB:CC:DD:EE:01     *        eth0\n'
    + '192.168.1.7      0x1         0x0         00:00:00:00:00:00     *        eth0\n';
  assert.deepEqual([...parseProcArp(proc)], [['192.168.1.1', 'aa:bb:cc:dd:ee:01']]);
  const bsd = '? (192.168.1.1) at a:b:c:d:e:f on en0 ifscope [ethernet]\n? (192.168.1.9) at (incomplete) on en0 ifscope [ethernet]\n? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]\n';
  assert.deepEqual([...parseArpAn(bsd)], [['192.168.1.1', '0a:0b:0c:0d:0e:0f'], ['224.0.0.251', '01:00:5e:00:00:fb']]);
});

test('expiring entries and a nearly full network show up in issues', async () => {
  const { admin, net } = await setup();   // /28 = 14 usable addresses
  await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.2', fqdn: 'guest.lan', expires_at: '2000-01-01' });
  await admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.3', fqdn: 'later.lan', expires_at: '2999-01-01' });
  await assert.rejects(admin('POST', `/api/networks/${net.id}/entries`, { ip: '10.0.0.4', expires_at: 'jutro' }), /data ważności/);
  let issues = await admin('GET', `/api/networks/${net.id}/issues`);
  assert.ok(issues.some((i) => /guest.lan/.test(i.text) && /wygasł/.test(i.text)));
  assert.ok(!issues.some((i) => /later.lan/.test(i.text)));
  for (let i = 4; i <= 14; i++) await admin('POST', `/api/networks/${net.id}/entries`, { ip: `10.0.0.${i}` });
  issues = await admin('GET', `/api/networks/${net.id}/issues`);
  assert.ok(issues.some((i) => /zajęta w \d+%/.test(i.text)));
});
