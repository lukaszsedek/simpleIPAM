import { ipToInt, intToIp, parseCidr, normalizeCidr, inCidr, usableRange, normalizeMac, networkAddr, broadcastAddr, mergeRanges, freeBlocks, findFree } from './ip.js';
import { execFile } from 'node:child_process';

import { HttpError } from './errors.js';
import { createAuth, RANK, ROLES } from './auth.js';
import * as notify from './notify.js';
import { snapshotBuffer, backupName, listLocal, isBackupName, loadConfig, saveConfig, publicConfig, runBackup, runDailyIfDue, lastBackup, testRemote, setGdriveAuth } from './backup.js';
import * as gd from './gdrive.js';
import * as gl from './google-login.js';
import { isEncrypted, decrypt } from './backup-crypto.js';
import { buildOpenApi, DOCS_HTML } from './openapi.js';
import { readNeighbors } from './neighbors.js';
import { buildXlsx } from './xlsx.js';
import { lookup } from 'node:dns/promises';
import * as unifi from './unifi.js';
import * as azure from './azure.js';
import { readFileSync, rmSync, existsSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { summarize, validateAndPrepare } from './restore.js';
import { join, dirname, basename } from 'node:path';

export { HttpError };
const bad = (m) => new HttpError(400, m);
const TYPES = ['server', 'vm', 'container', 'router', 'switch', 'ap', 'iot', 'printer', 'pc', 'phone', 'nas', 'other'];
const STATUSES = ['used', 'reserved', 'free'];

// opts: version/commit (shown in the UI), ping(ip) -> Promise<boolean>, fetch (cloud uploads), backupDir (local backup folder; falsy disables) and gcsBase
// can be injected (tests); ping defaults to the system ping binary.
export function createApi(db, opts = {}) {
  const auth = createAuth(db);
  // Set by handle() before each request; log() is only called from synchronous handler code, so it cannot interleave.
  let actor = '';
  const log = (action, entity, label) =>
    db.prepare('INSERT INTO audit (action, entity, label, actor) VALUES (?,?,?,?)').run(action, entity, label, actor);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const must = (row, what) => { if (!row) throw new HttpError(404, `${what} nie istnieje`); return row; };
  const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
  const sessionOnly = (ctx) => { if (ctx.viaToken) throw new HttpError(403, 'Ta operacja wymaga zalogowania w przeglądarce, nie tokenu API'); };
  const forbidden = () => new HttpError(403, 'Brak uprawnień do tej operacji');
  const tenantIdOf = (siteId) => one('SELECT tenant_id FROM sites WHERE id=?', siteId)?.tenant_id;
  const roleAt = (user, siteId) => auth.effective(auth.rolesOf(user.id), siteId, tenantIdOf(siteId));
  const need = (user, siteId, min) => { if (RANK[roleAt(user, siteId)] < RANK[min]) throw forbidden(); };
  const needTenant = (user, tenantId, min) => {
    if (RANK[auth.effectiveTenant(auth.rolesOf(user.id), tenantId)] < RANK[min]) throw forbidden();
  };
  const needGlobalAdmin = (user) => { if (auth.rolesOf(user.id).global !== 'admin') throw forbidden(); };
  const visibleSiteIds = (user) => {
    const roles = auth.rolesOf(user.id);
    return all('SELECT id, tenant_id FROM sites').filter((s) => RANK[auth.effective(roles, s.id, s.tenant_id)] >= RANK.reader).map((s) => s.id);
  };
  const unique = (fn) => {
    try { return fn(); } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Taki wpis już istnieje');
      throw e;
    }
  };

  // ---------- sites ----------
  function siteInput(b) {
    const name = str(b.name, 80);
    if (!name) throw bad('Nazwa lokalizacji jest wymagana');
    return { name, description: str(b.description), icon: str(b.icon, 20) || 'home' };
  }

  // ---------- networks ----------
  function netInput(b) {
    const name = str(b.name, 80);
    if (!name) throw bad('Nazwa sieci jest wymagana');
    const cidr = normalizeCidr(b.cidr);
    if (!cidr) throw bad('Nieprawidłowy CIDR (np. 192.168.1.0/24, min. /8)');
    if (parseCidr(cidr).prefix < 16) throw bad('Maksymalny rozmiar sieci to /16');
    let vlan = null;
    if (b.vlan !== '' && b.vlan != null) {
      vlan = Number(b.vlan);
      if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) throw bad('VLAN musi być w zakresie 1–4094');
    }
    const ipField = (key, label) => {
      const v = str(b[key], 15);
      if (v && !inCidr(v, cidr)) throw bad(`${label} musi należeć do sieci ${cidr}`);
      return v;
    };
    const gwIn = str(b.gateway, 15);
    const [glo, ghi] = usableRange(cidr);
    const gateway = gwIn === 'first' ? intToIp(glo) : gwIn === 'last' ? intToIp(ghi) : ipField('gateway', 'Brama');
    if (gateway && (gateway === networkAddr(cidr) || gateway === broadcastAddr(cidr))) throw bad('Brama nie może być adresem sieci ani adresem rozgłoszeniowym');
    const dhcp_start = ipField('dhcp_start', 'Początek DHCP');
    const dhcp_end = ipField('dhcp_end', 'Koniec DHCP');
    if (!!dhcp_start !== !!dhcp_end) throw bad('Podaj oba końce zakresu DHCP');
    if (dhcp_start && ipToInt(dhcp_start) > ipToInt(dhcp_end)) throw bad('Początek DHCP jest większy niż koniec');
    return { name, cidr, vlan, gateway, dhcp_start, dhcp_end, dns: str(b.dns, 200), description: str(b.description), auto_scan: b.auto_scan ? 1 : 0 };
  }

  // Consistency warnings of one network, computed on the fly (also feeds the sidebar counters and the all-networks list).
  function issuesOf(net) {
    const issues = [];
    const entries = all('SELECT * FROM entries WHERE network_id=? ORDER BY ip_num', net.id);
    const group = (rows, key) => {
      const m = new Map();
      for (const r of rows) if (r[key]) m.set(r[key], [...(m.get(r[key]) ?? []), r]);
      return [...m].filter(([, v]) => v.length > 1);
    };
    for (const e of entries.filter(macAlert)) issues.push({ level: 'error', text: `${e.ip} (${e.fqdn || 'bez nazwy'}): skan widzi MAC ${e.seen_mac}, a wpis ma ${e.mac} — urządzenie wymienione albo adres przejęty?` });
    for (const [mac, rows] of group(entries, 'mac')) {
      issues.push({ level: 'error', text: `Duplikat MAC ${mac}: ${rows.map((r) => r.ip).join(', ')}` });
    }
    // A host showing up at a new address with the MAC of a known entry: the device moved (DHCP lease, manual change) or the address is used twice.
    for (const d of all("SELECT * FROM discovered WHERE network_id=? AND dismissed=0 AND mac!='' AND ip!=?", net.id, net.gateway ?? '')) {
      const known = entries.find((e) => e.mac && e.mac.toLowerCase() === d.mac.toLowerCase() && e.ip !== d.ip);
      if (known) issues.push({ level: 'warn', text: `Nowy host ${d.ip} ma MAC ${d.mac} znanego urządzenia ${known.ip} (${known.fqdn || known.alias || 'bez nazwy'}) — zmienił adres albo ten sam sprzęt ma dwa adresy` });
    }
    const siteEntries = all(`SELECT e.* FROM entries e JOIN networks n ON n.id=e.network_id WHERE n.site_id=? AND e.status!='free'`, net.site_id);
    for (const [fqdn, rows] of group(siteEntries, 'fqdn')) {
      if (rows.some((r) => r.network_id === net.id)) issues.push({ level: 'warn', text: `FQDN ${fqdn} występuje ${rows.length}× w lokalizacji: ${rows.map((r) => r.ip).join(', ')}` });
    }
    // Inside the pool a plain "used" entry is a dynamic lease (a conflicting static address cannot be told apart), so it is not flagged.
    // Outside the pool every address is static, so there is nothing to reserve.
    const inPool = (e) => net.dhcp_start && e.ip_num >= ipToInt(net.dhcp_start) && e.ip_num <= ipToInt(net.dhcp_end);
    for (const e of entries) if (e.status === 'reserved' && !inPool(e)) {
      issues.push({ level: 'warn', text: `${e.ip} (${e.fqdn || 'bez nazwy'}) ma status „Zarezerwowany”, ale leży poza pulą DHCP — adres poza pulą jest statyczny, więc nie ma czego rezerwować (zmień status na „Statyczny”)` });
    }
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    for (const e of entries) if (e.expires_at && e.status !== 'free' && e.expires_at <= soon) {
      issues.push({ level: e.expires_at < today ? 'warn' : 'info', text: `${e.ip} (${e.alias || e.fqdn || 'bez nazwy'}): ${e.expires_at < today ? 'wpis wygasł' : 'wpis wygasa'} ${e.expires_at} — usuń go lub przedłuż ważność` });
    }
    // Growth forecast: addresses taken per day over the last 60 days (from the history of created entries) vs. what is left.
    {
      const c = parseCidr(net.cidr);
      const cap = Math.max(0, c.last - c.first - 1);
      const used = entries.filter((e) => e.status !== 'free').length;
      const added = one(`SELECT COUNT(*) AS n FROM entry_history WHERE network_id=? AND action='create' AND ts >= datetime('now','-60 days')`, net.id).n;
      const left = cap - used;
      if (cap > 0 && left <= 0) issues.push({ level: 'error', text: 'Sieć jest zapełniona — brak wolnych adresów' });
      else if (cap > 0 && used / cap >= 0.9) issues.push({ level: 'warn', text: `Sieć zajęta w ${Math.round(100 * used / cap)}% — zostało ${left} adresów` });
      else if (added >= 3 && left > 0) {
        const days = Math.round(left / (added / 60));
        if (days <= 180) issues.push({ level: 'info', text: `Przy obecnym tempie (${added} nowych wpisów w 60 dni) wolne adresy skończą się za ok. ${days} dni` });
      }
    }
    if (net.gateway && net.dhcp_start && ipToInt(net.gateway) >= ipToInt(net.dhcp_start) && ipToInt(net.gateway) <= ipToInt(net.dhcp_end)) {
      issues.push({ level: 'warn', text: `Brama ${net.gateway} leży w puli DHCP — serwer DHCP może oddać ją innemu urządzeniu` });
    }
    if (net.vlan) {
      const tenantId = tenantIdOf(net.site_id);
      const registry = all('SELECT * FROM vlans WHERE tenant_id=?', tenantId);
      if (registry.length && !registry.some((v) => v.vid === net.vlan && (v.site_id == null || v.site_id === net.site_id))) {
        issues.push({ level: 'info', text: `VLAN ${net.vlan} nie jest zdefiniowany w rejestrze VLAN-ów tenanta` });
      }
      for (const o of all('SELECT name, cidr FROM networks WHERE site_id=? AND id!=? AND vlan=?', net.site_id, net.id, net.vlan)) {
        issues.push({ level: 'warn', text: `VLAN ${net.vlan} jest przypisany także do sieci „${o.name}” (${o.cidr}) w tej samej lokalizacji` });
      }
    }
    const me = parseCidr(net.cidr);
    for (const o of all('SELECT * FROM networks WHERE site_id=? AND id!=?', net.site_id, net.id)) {
      const c = parseCidr(o.cidr);
      if (me.first <= c.last && c.first <= me.last) issues.push({ level: 'error', text: `Nakłada się z siecią „${o.name}” (${o.cidr}) w tej samej lokalizacji` });
    }
    return issues;
  }

  function netStats(n) {
    const c = parseCidr(n.cidr);
    const [lo, hi] = usableRange(n.cidr);
    const total = hi - lo + 1;
    const dhcp = n.dhcp_start ? ipToInt(n.dhcp_end) - ipToInt(n.dhcp_start) + 1 : 0;
    const row = one(`SELECT COUNT(*) AS used,
        SUM(status='reserved') AS reserved FROM entries WHERE network_id=? AND status!='free'`, n.id);
    // Outside the DHCP pool an address is static; inside it is a dynamic lease ("used") or a DHCP reservation.
    const [ps, pe] = n.dhcp_start ? [ipToInt(n.dhcp_start), ipToInt(n.dhcp_end)] : [1, 0];
    const split = one(`SELECT SUM(ip_num NOT BETWEEN ? AND ?) AS static_n, SUM(ip_num BETWEEN ? AND ? AND status='reserved') AS dhcp_reserved,
        SUM(ip_num BETWEEN ? AND ? AND status='used') AS dynamic_n FROM entries WHERE network_id=? AND status!='free'`, ps, pe, ps, pe, ps, pe, n.id);
    const issues = issuesOf(n).filter((i) => i.level !== 'info').length;
    const fresh = one("SELECT COUNT(*) AS n FROM discovered WHERE network_id=? AND dismissed=0 AND ip!=?", n.id, n.gateway).n;
    // the gateway occupies an address even without an entry
    const infra = n.gateway && !one('SELECT 1 FROM entries WHERE network_id=? AND ip=?', n.id, n.gateway) ? 1 : 0;
    const alerts = all('SELECT mac, seen_mac, mac_ack FROM entries WHERE network_id=? AND seen_mac!=\'\'', n.id).filter(macAlert).length;
    return { total, dhcp, used: row.used, reserved: row.reserved ?? 0, static: split.static_n ?? 0, dhcp_reserved: split.dhcp_reserved ?? 0, dynamic: split.dynamic_n ?? 0, issues, infra, prefix: c.prefix, new_hosts: fresh, mac_alerts: alerts };
  }

  // ---------- entries ----------
  function entryInput(b, net, existingId = null) {
    const ip = str(b.ip, 15);
    const n = ipToInt(ip);
    if (n === null || !inCidr(ip, net.cidr)) throw bad(`Adres IP musi należeć do ${net.cidr}`);
    if (ip === networkAddr(net.cidr)) throw bad('To adres sieci — nie można go przydzielić urządzeniu');
    if (ip === broadcastAddr(net.cidr)) throw bad('To adres rozgłoszeniowy (broadcast) — nie można go przydzielić urządzeniu');
    const mac = normalizeMac(b.mac);
    if (mac === null) throw bad('Nieprawidłowy adres MAC');
    const fqdn = str(b.fqdn, 253).toLowerCase();
    if (fqdn && !/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(fqdn)) throw bad('Nieprawidłowy FQDN');
    const type = TYPES.includes(b.type) ? b.type : 'other';
    const status = STATUSES.includes(b.status) ? b.status : 'used';
    const tags = str(b.tags, 200).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).join(',');
    const dup = one('SELECT id FROM entries WHERE network_id=? AND ip=?', net.id, ip);
    if (dup && dup.id !== existingId) throw new HttpError(409, `Adres ${ip} jest już wpisany w tej sieci`);
    const expires_at = str(b.expires_at, 10);
    if (expires_at && !(/^\d{4}-\d{2}-\d{2}$/.test(expires_at) && !Number.isNaN(Date.parse(expires_at)))) throw bad('Nieprawidłowa data ważności (RRRR-MM-DD)');
    return { ip, ip_num: n, fqdn, alias: str(b.alias, 100), mac, type, status, tags, description: str(b.description), expires_at };
  }

  // ---------- entry history ----------
  const FIELDS = ['ip', 'fqdn', 'alias', 'mac', 'type', 'status', 'tags', 'description', 'expires_at'];
  const hist = (netId, entryId, ip, action, changes, who = actor) => {
    if (!Object.keys(changes).length) return;
    run('INSERT INTO entry_history (network_id, entry_id, ip, action, changes, actor) VALUES (?,?,?,?,?,?)', netId, entryId, ip, action, JSON.stringify(changes), who);
  };
  const diff = (a, b) => Object.fromEntries(FIELDS.filter((f) => String(a[f] ?? '') !== String(b[f] ?? '')).map((f) => [f, [a[f] ?? '', b[f] ?? '']]));
  const snapshot = (e, side) => Object.fromEntries(FIELDS.filter((f) => String(e[f] ?? '') !== '').map((f) => [f, side === 'new' ? ['', e[f]] : [e[f], '']]));
  const macAlert = (e) => !!(e.mac && e.seen_mac && e.seen_mac !== e.mac && e.seen_mac !== e.mac_ack);
  const withFlags = (e) => ({ ...e, mac_alert: macAlert(e), mac_suggest: !e.mac && !!e.seen_mac });

  // A source (scan, UniFi) saw `mac` at this entry's address. A different MAC than the recorded one leaves a trail
  // (once per distinct MAC) and, until accepted or ignored, shows up as a warning on the entry.
  function observeMac(e, mac, who) {
    if (!mac || mac === e.seen_mac) return;
    run('UPDATE entries SET seen_mac=? WHERE id=?', mac, e.id);
    if (e.mac && mac !== e.mac && mac !== e.mac_ack) {
      hist(e.network_id, e.id, e.ip, 'mac_seen', { mac: [e.mac, mac] }, who);
      queueNotify('mac_change', one('SELECT name FROM networks WHERE id=?', e.network_id)?.name ?? '', `${e.ip} (${e.alias || e.fqdn || 'bez nazwy'}): widziany MAC ${mac}, wpis ma ${e.mac}`);
    }
  }

  // ---------- notifications ----------
  const notifyCfg = () => {
    let c = {};
    try { c = JSON.parse(one("SELECT value FROM settings WHERE key='notify'")?.value ?? '{}'); } catch { /* unset */ }
    return { enabled: false, kind: 'ntfy', url: '', ...c, events: { new_host: true, moved: true, mac_change: true, ...(c.events ?? {}) } };
  };
  let notifyQueue = [];
  let notifyTimer = null;
  // Findings are collected for a few seconds and sent as one message, so a scan that finds ten devices makes one notification.
  const queueNotify = (event, network, text) => {
    const c = notifyCfg();
    if (!c.enabled || !c.url || !c.events[event]) return;
    notifyQueue.push({ event, network, text });
    if (!notifyTimer) { notifyTimer = setTimeout(() => { notifyTimer = null; flushNotify(); }, opts.notifyDelayMs ?? 5000); notifyTimer.unref?.(); }
  };
  async function flushNotify() {
    const items = notifyQueue; notifyQueue = [];
    if (!items.length) return null;
    const res = { ts: new Date().toISOString(), count: items.length, ok: true, error: '' };
    try { await notify.send(notifyCfg(), notify.compose(items), { fetch: opts.fetch }); }
    catch (e) { res.ok = false; res.error = String(e.cause?.code ?? e.message).slice(0, 200); }
    saveSetting('notify_last', res);
    return res;
  }
  // A host seen for the first time: a "moved" notice when its MAC belongs to a known entry at another address, otherwise a plain "new host".
  const noteNewHost = (net, ip, mac, name = '') => {
    if (one('SELECT 1 AS x FROM discovered WHERE network_id=? AND ip=?', net.id, ip)) return;
    const known = mac && one('SELECT ip, fqdn, alias FROM entries WHERE network_id=? AND lower(mac)=lower(?) AND ip!=?', net.id, mac, ip);
    if (known) queueNotify('moved', net.name, `${ip} (${mac}) to prawdopodobnie ${known.alias || known.fqdn || 'znane urządzenie'} z adresu ${known.ip}`);
    else queueNotify('new_host', net.name, `${ip}${name ? ` ${name}` : ''}${mac ? ` (${mac})` : ''}`);
  };

  function nextFree(net, from = null) {
    const [lo, hi] = usableRange(net.cidr);
    const taken = new Set(all('SELECT ip_num FROM entries WHERE network_id=?', net.id).map((r) => r.ip_num));
    if (net.gateway) taken.add(ipToInt(net.gateway));
    const ds = net.dhcp_start ? ipToInt(net.dhcp_start) : -1;
    const de = net.dhcp_end ? ipToInt(net.dhcp_end) : -2;
    for (let i = Math.max(lo, from ?? lo); i <= hi; i++) {
      if (!taken.has(i) && !(i >= ds && i <= de)) return intToIp(i);
    }
    return null;
  }

  // Forward DNS lookup (IPv4 only, honours /etc/hosts and search domains); tests inject a fake.
  const resolveA = opts.resolve ?? (async (name) => (await lookup(name, { all: true, family: 4 })).map((a) => a.address));
  const ping = opts.ping ?? ((ip) => new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '1', ip], { timeout: 3000 }, (err) => resolve(!err));
  }));

  // Pings every usable address; known hosts get last_seen, unknown ones land in `discovered`.
  async function scan(net) {
    const [lo, hi] = usableRange(net.cidr);
    if (hi - lo > 1024) throw bad('Skan jest ograniczony do sieci /22 i mniejszych');
    const ips = [];
    for (let i = lo; i <= hi; i++) ips.push(i);
    const alive = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: 64 }, async () => {
      while (cursor < ips.length) {
        const i = ips[cursor++];
        if (await ping(intToIp(i))) alive.push(i);
      }
    }));
    alive.sort((a, b) => a - b);
    const arp = await (opts.neighbors ?? readNeighbors)().catch(() => new Map());
    const entries = new Map(all('SELECT * FROM entries WHERE network_id=?', net.id).map((e) => [e.ip_num, e]));
    let macs = 0;
    const gw = net.gateway ? ipToInt(net.gateway) : -1;
    for (const i of alive) {
      const ip = intToIp(i);
      const mac = arp.get(ip) ?? '';
      if (mac) macs++;
      const e = entries.get(i);
      if (!e && i === gw) {      // the gateway is part of the network, not a new host
        run("UPDATE networks SET gateway_seen=datetime('now'), gateway_mac=CASE WHEN ?!='' THEN ? ELSE gateway_mac END WHERE id=?", mac, mac, net.id);
        continue;
      }
      if (e) {
        run("UPDATE entries SET last_seen=datetime('now') WHERE id=?", e.id);
        observeMac(e, mac, 'skan');
      } else {
        noteNewHost(net, ip, mac);
        run(`INSERT INTO discovered (network_id, ip, mac) VALUES (?,?,?)
          ON CONFLICT(network_id, ip) DO UPDATE SET last_seen=datetime('now'), mac=CASE WHEN excluded.mac!='' THEN excluded.mac ELSE mac END`, net.id, ip, mac);
      }
    }
    return { hosts: alive.map((i) => ({ ip: intToIp(i), known: entries.has(i) || i === gw, ...(i === gw && { gateway: true }), mac: arp.get(intToIp(i)) ?? '' })), macs };
  }

  // ---------- csv ----------
  const CSV_COLS = ['ip', 'fqdn', 'mac', 'type', 'status', 'tags', 'description', 'alias'];
  const csvCell = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  function parseCsv(text) {
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((c) => c !== '')) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some((c) => c !== '')) rows.push(row);
    return rows;
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, pattern, re, keys, handler, public: !!opts.public });
  };

  route('GET', '/api/overview', ({ user }) => {
    const roles = auth.rolesOf(user.id);
    const nets = all('SELECT * FROM networks ORDER BY vlan, cidr');
    const sites = all('SELECT * FROM sites ORDER BY name COLLATE NOCASE').map((s) => ({
      ...s,
      role: auth.effective(roles, s.id, s.tenant_id),
      networks: nets.filter((n) => n.site_id === s.id).map((n) => ({ ...n, stats: netStats(n) })),
    })).filter((s) => RANK[s.role] >= RANK.reader);
    return all('SELECT * FROM tenants ORDER BY name COLLATE NOCASE').map((t) => ({
      ...t, role: auth.effectiveTenant(roles, t.id), sites: sites.filter((s) => s.tenant_id === t.id),
    })).filter((t) => t.sites.length || RANK[t.role] >= RANK.reader);
  });

  function tenantInput(b) {
    const name = str(b.name, 80);
    if (!name) throw bad('Nazwa tenanta jest wymagana');
    return { name, description: str(b.description) };
  }
  route('POST', '/api/tenants', ({ body, user }) => unique(() => {
    needGlobalAdmin(user);
    const t = tenantInput(body);
    const r = run('INSERT INTO tenants (name, description) VALUES (?,?)', t.name, t.description);
    log('create', 'tenant', t.name);
    return { id: Number(r.lastInsertRowid), ...t };
  }));
  route('PUT', '/api/tenants/:id', ({ params, body, user }) => unique(() => {
    must(one('SELECT id FROM tenants WHERE id=?', params.id), 'Tenant');
    needTenant(user, Number(params.id), 'admin');
    const t = tenantInput(body);
    run('UPDATE tenants SET name=?, description=? WHERE id=?', t.name, t.description, params.id);
    log('update', 'tenant', t.name);
    return { id: Number(params.id), ...t };
  }));
  route('DELETE', '/api/tenants/:id', ({ params, user }) => {
    const t = must(one('SELECT * FROM tenants WHERE id=?', params.id), 'Tenant');
    needGlobalAdmin(user);
    run('DELETE FROM tenants WHERE id=?', params.id);
    log('delete', 'tenant', t.name);
    return { ok: true };
  });

  route('POST', '/api/tenants/:id/sites', ({ params, body, user }) => unique(() => {
    must(one('SELECT id FROM tenants WHERE id=?', params.id), 'Tenant');
    needTenant(user, Number(params.id), 'admin');
    const s = siteInput(body);
    const r = run('INSERT INTO sites (tenant_id, name, description, icon) VALUES (?,?,?,?)', params.id, s.name, s.description, s.icon);
    log('create', 'site', s.name);
    return { id: Number(r.lastInsertRowid), tenant_id: Number(params.id), ...s };
  }));
  route('PUT', '/api/sites/:id', ({ params, body, user }) => unique(() => {
    const old = must(one('SELECT * FROM sites WHERE id=?', params.id), 'Lokalizacja');
    need(user, old.id, 'admin');
    const s = siteInput(body);
    run('UPDATE sites SET name=?, description=?, icon=? WHERE id=?', s.name, s.description, s.icon, old.id);
    log('update', 'site', s.name);
    return { id: old.id, tenant_id: old.tenant_id, ...s };
  }));
  route('DELETE', '/api/sites/:id', ({ params, user }) => {
    const s = must(one('SELECT * FROM sites WHERE id=?', params.id), 'Lokalizacja');
    needTenant(user, s.tenant_id, 'admin');
    run('DELETE FROM sites WHERE id=?', params.id);
    log('delete', 'site', s.name);
    return { ok: true };
  });

  route('POST', '/api/sites/:id/networks', ({ params, body, user }) => unique(() => {
    must(one('SELECT id FROM sites WHERE id=?', params.id), 'Lokalizacja');
    need(user, Number(params.id), 'admin');
    const n = netInput(body);
    const r = run(`INSERT INTO networks (site_id, name, cidr, vlan, gateway, dhcp_start, dhcp_end, dns, description, auto_scan)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, params.id, n.name, n.cidr, n.vlan, n.gateway, n.dhcp_start, n.dhcp_end, n.dns, n.description, n.auto_scan);
    log('create', 'network', `${n.name} (${n.cidr})`);
    return { id: Number(r.lastInsertRowid), site_id: Number(params.id), ...n };
  }));
  route('PUT', '/api/networks/:id', ({ params, body, user }) => unique(() => {
    const old = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, old.site_id, 'admin');
    const n = netInput(body);
    if (n.cidr !== old.cidr) {
      const out = all('SELECT ip FROM entries WHERE network_id=?', old.id).filter((e) => !inCidr(e.ip, n.cidr));
      if (out.length) throw bad(`Nowy CIDR nie obejmuje ${out.length} istniejących wpisów (np. ${out[0].ip})`);
    }
    run(`UPDATE networks SET name=?, cidr=?, vlan=?, gateway=?, dhcp_start=?, dhcp_end=?, dns=?, description=?, auto_scan=? WHERE id=?`,
      n.name, n.cidr, n.vlan, n.gateway, n.dhcp_start, n.dhcp_end, n.dns, n.description, n.auto_scan, params.id);
    if (n.gateway !== old.gateway) {
      run("UPDATE networks SET gateway_mac='', gateway_seen=NULL WHERE id=?", old.id);
      if (n.gateway) run('DELETE FROM discovered WHERE network_id=? AND ip=?', old.id, n.gateway);
    }
    log('update', 'network', `${n.name} (${n.cidr})`);
    return { id: old.id, site_id: old.site_id, ...n };
  }));
  route('DELETE', '/api/networks/:id', ({ params, user }) => {
    const n = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, n.site_id, 'admin');
    run('DELETE FROM networks WHERE id=?', params.id);
    log('delete', 'network', `${n.name} (${n.cidr})`);
    return { ok: true };
  });
  route('GET', '/api/networks/:id', ({ params, user }) => {
    const n = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, n.site_id, 'reader');
    const site = one('SELECT * FROM sites WHERE id=?', n.site_id);
    const tenant = one('SELECT * FROM tenants WHERE id=?', site.tenant_id);
    return { ...n, network_addr: networkAddr(n.cidr), broadcast_addr: broadcastAddr(n.cidr), site, tenant, role: roleAt(user, n.site_id), stats: netStats(n), entries: all('SELECT * FROM entries WHERE network_id=? ORDER BY ip_num', n.id).map(withFlags) };
  });
  route('GET', '/api/networks/:id/next-free', ({ params, query, user }) => {
    const n = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, n.site_id, 'reader');
    return { ip: nextFree(n, query.from ? ipToInt(query.from) : null) };
  });
  // Compares each entry's FQDN with what DNS actually answers; a lookup is a read, so Reader is enough.
  route('POST', '/api/networks/:id/dns-check', async ({ params, user }) => {
    const net = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, net.site_id, 'reader');
    const rows = all("SELECT ip, fqdn FROM entries WHERE network_id=? AND fqdn!='' AND status!='free' ORDER BY ip_num LIMIT 500", net.id);
    const results = [];
    for (let i = 0; i < rows.length; i += 10) {
      results.push(...await Promise.all(rows.slice(i, i + 10).map(async (e) => {
        let resolved = [];
        try { resolved = (await resolveA(e.fqdn)).slice(0, 8); } catch { /* NXDOMAIN and friends = no record */ }
        return { ip: e.ip, fqdn: e.fqdn, resolved, result: !resolved.length ? 'missing' : resolved.includes(e.ip) ? 'ok' : 'mismatch' };
      })));
    }
    return { checked: results.length, problems: results.filter((r) => r.result !== 'ok').length, results };
  });

  route('POST', '/api/networks/:id/scan', async ({ params, user }) => {
    const n = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, n.site_id, 'contributor');
    const r = await scan(n);
    return { alive: r.hosts, macs: r.macs };
  });

  route('POST', '/api/networks/:id/entries', ({ params, body, user }) => unique(() => {
    const net = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, net.site_id, 'contributor');
    const e = entryInput(body, net);
    const r = run(`INSERT INTO entries (network_id, ip, ip_num, fqdn, alias, mac, type, status, tags, description, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, net.id, e.ip, e.ip_num, e.fqdn, e.alias, e.mac, e.type, e.status, e.tags, e.description, e.expires_at);
    const seen = one('SELECT mac FROM discovered WHERE network_id=? AND ip=?', net.id, e.ip)?.mac ?? '';
    run('DELETE FROM discovered WHERE network_id=? AND ip=?', net.id, e.ip);
    if (seen) run('UPDATE entries SET seen_mac=? WHERE id=?', seen, r.lastInsertRowid);
    hist(net.id, Number(r.lastInsertRowid), e.ip, 'create', snapshot(e, 'new'));
    log('create', 'entry', `${e.ip} ${e.fqdn}`.trim());
    return { id: Number(r.lastInsertRowid), network_id: net.id, ...e };
  }));
  route('PUT', '/api/entries/:id', ({ params, body, user }) => unique(() => {
    const old = must(one('SELECT * FROM entries WHERE id=?', params.id), 'Wpis');
    const net = one('SELECT * FROM networks WHERE id=?', old.network_id);
    need(user, net.site_id, 'contributor');
    const e = entryInput(body, net, old.id);
    if (body.alias === undefined) e.alias = old.alias;                      // API clients that do not know the field keep it
    if (body.expires_at === undefined) e.expires_at = old.expires_at;
    run(`UPDATE entries SET ip=?, ip_num=?, fqdn=?, alias=?, mac=?, type=?, status=?, tags=?, description=?, expires_at=?,
      updated_at=datetime('now') WHERE id=?`, e.ip, e.ip_num, e.fqdn, e.alias, e.mac, e.type, e.status, e.tags, e.description, e.expires_at, old.id);
    hist(old.network_id, old.id, e.ip, 'update', diff(old, e));
    log('update', 'entry', `${e.ip} ${e.fqdn}`.trim());
    if (e.alias !== old.alias) pushAliasSoon(old.id);
    return { id: old.id, network_id: old.network_id, ...e };
  }));
  route('DELETE', '/api/entries/:id', ({ params, user }) => {
    const e = must(one('SELECT * FROM entries WHERE id=?', params.id), 'Wpis');
    need(user, one('SELECT site_id FROM networks WHERE id=?', e.network_id).site_id, 'contributor');
    hist(e.network_id, e.id, e.ip, 'delete', snapshot(e, 'old'));
    run('DELETE FROM entries WHERE id=?', params.id);
    log('delete', 'entry', `${e.ip} ${e.fqdn}`.trim());
    return { ok: true };
  });

  // Resolve a MAC alert: take the observed MAC as the entry's own, or ignore that particular observed MAC.
  route('POST', '/api/entries/:id/mac', ({ params, body, user }) => {
    const e = must(one('SELECT * FROM entries WHERE id=?', params.id), 'Wpis');
    need(user, one('SELECT site_id FROM networks WHERE id=?', e.network_id).site_id, 'contributor');
    if (!e.seen_mac) throw bad('Brak wykrytego adresu MAC dla tego wpisu');
    if (body.action === 'accept') {
      run("UPDATE entries SET mac=?, mac_ack='', updated_at=datetime('now') WHERE id=?", e.seen_mac, e.id);
      hist(e.network_id, e.id, e.ip, 'update', { mac: [e.mac, e.seen_mac] });
      log('update', 'entry', `${e.ip}: zatwierdzono MAC ${e.seen_mac}`);
    } else if (body.action === 'ignore') {
      run('UPDATE entries SET mac_ack=? WHERE id=?', e.seen_mac, e.id);
      hist(e.network_id, e.id, e.ip, 'mac_ignored', { mac: [e.mac, e.seen_mac] });
    } else throw bad('Nieznana operacja (accept | ignore)');
    return withFlags(one('SELECT * FROM entries WHERE id=?', e.id));
  });

  const histRows = (where, ...p) => all(`SELECT id, entry_id, ip, action, changes, actor, ts FROM entry_history WHERE ${where} ORDER BY id DESC LIMIT 200`, ...p)
    .map((r) => ({ ...r, changes: JSON.parse(r.changes) }));
  route('GET', '/api/entries/:id/history', ({ params, user }) => {
    const e = must(one('SELECT * FROM entries WHERE id=?', params.id), 'Wpis');
    need(user, one('SELECT site_id FROM networks WHERE id=?', e.network_id).site_id, 'reader');
    return histRows('entry_id=? OR (network_id=? AND ip=?)', e.id, e.network_id, e.ip);
  });
  route('GET', '/api/networks/:id/history', ({ params, query, user }) => {
    const n = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, n.site_id, 'reader');
    return query.ip ? histRows('network_id=? AND ip=?', n.id, str(query.ip, 15)) : histRows('network_id=?', n.id);
  });

  route('GET', '/api/search', ({ query, user }) => {
    const q = str(query.q, 100).toLowerCase();
    const sites = visibleSiteIds(user);
    if (!q || !sites.length) return [];
    const like = `%${q.replace(/[%_]/g, '')}%`;
    return all(`SELECT e.*, n.name AS network_name, n.cidr, n.vlan, s.name AS site_name, s.id AS site_id, (SELECT name FROM tenants WHERE id=s.tenant_id) AS tenant_name
      FROM entries e JOIN networks n ON n.id=e.network_id JOIN sites s ON s.id=n.site_id
      WHERE s.id IN (${sites.join(',')})
        AND (e.ip LIKE ? OR e.fqdn LIKE ? OR e.alias LIKE ? OR e.mac LIKE ? OR e.tags LIKE ? OR e.description LIKE ?)
      ORDER BY s.name, e.ip_num LIMIT 50`, like, like, like, like, like, like);
  });

  route('GET', '/api/audit', ({ user }) => (needGlobalAdmin(user), all('SELECT * FROM audit ORDER BY id DESC LIMIT 200')));

  // Excel export. Headers and labels follow ?lang= (the browser's download link cannot carry the app's language otherwise).
  const XL = {
    pl: { head: ['IP', 'FQDN', 'Alias', 'MAC', 'Typ', 'Status', 'Tagi', 'Opis', 'Ważny do', 'Widziany', 'Podłączony do'], kind: { static: 'Statyczny', dynamic: 'Dynamiczny (DHCP)', reserved: 'Rezerwacja DHCP', free: 'Wolny' },
      types: { server: 'Serwer', vm: 'VM', container: 'Kontener', router: 'Router', switch: 'Switch', ap: 'Access Point', iot: 'IoT', printer: 'Drukarka', pc: 'Komputer', phone: 'Telefon', nas: 'NAS', other: 'Inne' } },
    en: { head: ['IP', 'FQDN', 'Alias', 'MAC', 'Type', 'Status', 'Tags', 'Description', 'Valid until', 'Last seen', 'Connected to'], kind: { static: 'Static', dynamic: 'Dynamic (DHCP)', reserved: 'DHCP reservation', free: 'Free' },
      types: { server: 'Server', vm: 'VM', container: 'Container', router: 'Router', switch: 'Switch', ap: 'Access Point', iot: 'IoT', printer: 'Printer', pc: 'Computer', phone: 'Phone', nas: 'NAS', other: 'Other' } },
    de: { head: ['IP', 'FQDN', 'Alias', 'MAC', 'Typ', 'Status', 'Tags', 'Beschreibung', 'Gültig bis', 'Zuletzt gesehen', 'Verbunden mit'], kind: { static: 'Statisch', dynamic: 'Dynamisch (DHCP)', reserved: 'DHCP-Reservierung', free: 'Frei' },
      types: { server: 'Server', vm: 'VM', container: 'Container', router: 'Router', switch: 'Switch', ap: 'Access Point', iot: 'IoT', printer: 'Drucker', pc: 'Computer', phone: 'Telefon', nas: 'NAS', other: 'Sonstige' } },
  };
  const xlSheet = (net, lang) => {
    const L = XL[lang] ?? XL.pl;
    const [ps, pe] = net.dhcp_start ? [ipToInt(net.dhcp_start), ipToInt(net.dhcp_end)] : [1, 0];
    const kind = (e) => (e.status === 'free' ? 'free' : e.ip_num >= ps && e.ip_num <= pe ? (e.status === 'reserved' ? 'reserved' : 'dynamic') : 'static');
    const rows = all('SELECT * FROM entries WHERE network_id=? ORDER BY ip_num', net.id)
      .map((e) => [e.ip, e.fqdn, e.alias, e.mac, L.types[e.type] ?? e.type, L.kind[kind(e)], e.tags, e.description, e.expires_at, e.last_seen ?? '', e.uplink]);
    return { rows: [L.head, ...rows], widths: [16, 30, 24, 19, 14, 20, 20, 36, 12, 19, 22] };
  };
  const xlsxOut = (buf, name) => ({ raw: buf, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: name });
  route('GET', '/api/networks/:id/export.xlsx', ({ params, query, user }) => {
    const n = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, n.site_id, 'reader');
    return xlsxOut(buildXlsx([{ name: n.name, ...xlSheet(n, query.lang) }]), `${n.name.replace(/\W+/g, '_')}.xlsx`);
  });
  route('GET', '/api/export.xlsx', ({ query, user }) => {
    const roles = auth.rolesOf(user.id);
    const sheets = all('SELECT n.*, s.name AS site_name, s.tenant_id FROM networks n JOIN sites s ON s.id=n.site_id ORDER BY s.name, n.vlan, n.cidr')
      .filter((n) => RANK[auth.effective(roles, n.site_id, n.tenant_id)] >= RANK.reader)
      .map((n) => ({ name: `${n.site_name} ${n.name}`, ...xlSheet(n, query.lang) }));
    if (!sheets.length) throw new HttpError(404, 'Nie znaleziono');
    return xlsxOut(buildXlsx(sheets), 'simpleipam.xlsx');
  });
  route('GET', '/api/networks/:id/export.csv', ({ params, user }) => {
    const n = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, n.site_id, 'reader');
    const rows = all('SELECT * FROM entries WHERE network_id=? ORDER BY ip_num', n.id);
    const text = [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
    return { raw: text, contentType: 'text/csv; charset=utf-8', filename: `${n.name.replace(/\W+/g, '_')}.csv` };
  });
  route('POST', '/api/networks/:id/import', ({ params, body, user }) => {
    const net = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, net.site_id, 'contributor');
    const rows = parseCsv(String(body.csv ?? ''));
    if (rows.length < 2) throw bad('Plik CSV jest pusty');
    const head = rows[0].map((h) => h.trim().toLowerCase());
    if (!head.includes('ip')) throw bad('Brak kolumny "ip" w nagłówku CSV');
    let added = 0, updated = 0; const errors = [];
    db.exec('BEGIN');
    try {
      rows.slice(1).forEach((r, i) => {
        const obj = Object.fromEntries(head.map((h, j) => [h, r[j] ?? '']));
        try {
          const existing = one('SELECT * FROM entries WHERE network_id=? AND ip=?', net.id, str(obj.ip, 15));
          const e = entryInput(obj, net, existing?.id);
          if (existing) {
            if (!head.includes('alias')) e.alias = existing.alias;                 // partial CSVs do not wipe it
            run(`UPDATE entries SET fqdn=?, alias=?, mac=?, type=?, status=?, tags=?, description=?, updated_at=datetime('now') WHERE id=?`,
              e.fqdn, e.alias, e.mac, e.type, e.status, e.tags, e.description, existing.id);
            hist(net.id, existing.id, e.ip, 'update', diff(existing, e));
            updated++;
          } else {
            const ins = run(`INSERT INTO entries (network_id, ip, ip_num, fqdn, alias, mac, type, status, tags, description) VALUES (?,?,?,?,?,?,?,?,?,?)`,
              net.id, e.ip, e.ip_num, e.fqdn, e.alias, e.mac, e.type, e.status, e.tags, e.description);
            hist(net.id, Number(ins.lastInsertRowid), e.ip, 'create', snapshot(e, 'new'));
            added++;
          }
        } catch (err) { errors.push(`Wiersz ${i + 2}: ${err.message}`); }
      });
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    log('import', 'network', `${net.name}: +${added} ~${updated}`);
    return { added, updated, errors: errors.slice(0, 20) };
  });

  // ---------- discovery ----------
  route('GET', '/api/networks/:id/discovered', ({ params, user }) => {
    const net = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, net.site_id, 'reader');
    return all('SELECT * FROM discovered WHERE network_id=? AND dismissed=0 AND ip!=? ORDER BY id', net.id, net.gateway)
      .sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
  });
  // What changed in the last N days: devices that appeared (first seen), devices not seen since (were alive before, silent now), entries added/removed.
  route('GET', '/api/networks/:id/changes', ({ params, query, user }) => {
    const net = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, net.site_id, 'reader');
    const days = Math.min(90, Math.max(1, Number(query.days) || 1));
    const since = `-${days} days`;
    const appeared = all("SELECT ip, mac, first_seen FROM discovered WHERE network_id=? AND dismissed=0 AND ip!=? AND first_seen >= datetime('now', ?) ORDER BY first_seen DESC", net.id, net.gateway ?? '', since)
      .sort((x, y) => ipToInt(x.ip) - ipToInt(y.ip));
    // "Silent" only means something when scans are running: require at least one host seen within the window.
    const scanned = one("SELECT COUNT(*) AS n FROM entries WHERE network_id=? AND last_seen >= datetime('now', ?)", net.id, since).n
      + one("SELECT COUNT(*) AS n FROM discovered WHERE network_id=? AND last_seen >= datetime('now', ?)", net.id, since).n > 0;
    const silent = !scanned ? [] : all("SELECT ip, fqdn, alias, last_seen FROM entries WHERE network_id=? AND status!='free' AND last_seen IS NOT NULL AND last_seen < datetime('now', ?) ORDER BY ip_num", net.id, since);
    const added = all("SELECT ip, ts FROM entry_history WHERE network_id=? AND action='create' AND ts >= datetime('now', ?) ORDER BY ts DESC", net.id, since);
    const removed = all("SELECT ip, ts FROM entry_history WHERE network_id=? AND action='delete' AND ts >= datetime('now', ?) ORDER BY ts DESC", net.id, since);
    return { days, scanned, appeared, silent, added, removed };
  });
  route('POST', '/api/discovered/:id/dismiss', ({ params, user }) => {
    const d = must(one('SELECT * FROM discovered WHERE id=?', params.id), 'Wpis');
    need(user, one('SELECT site_id FROM networks WHERE id=?', d.network_id).site_id, 'contributor');
    run('UPDATE discovered SET dismissed=1 WHERE id=?', d.id);
    return { ok: true };
  });

  // ---------- bulk edit ----------
  route('POST', '/api/networks/:id/entries/bulk', ({ params, body, user }) => {
    const net = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, net.site_id, 'contributor');
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length || ids.length > 1000) throw bad('Zaznacz od 1 do 1000 wpisów');
    const rows = all(`SELECT * FROM entries WHERE network_id=? AND id IN (${ids.map(() => '?').join(',')})`, net.id, ...ids);
    if (body.action === 'delete') {
      db.exec('BEGIN');
      try { for (const r of rows) { hist(net.id, r.id, r.ip, 'delete', snapshot(r, 'old')); run('DELETE FROM entries WHERE id=?', r.id); } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      log('delete', 'entry', `${net.name}: ${rows.length} wpisów (zbiorczo)`);
      return { affected: rows.length };
    }
    if (body.action !== 'update') throw bad('Nieznana operacja');
    const c = body.changes ?? {};
    if (c.type !== undefined && !TYPES.includes(c.type)) throw bad('Nieprawidłowy typ');
    if (c.status !== undefined && !STATUSES.includes(c.status)) throw bad('Nieprawidłowy status');
    const addTags = str(c.add_tags, 200).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        const tags = [...new Set([...r.tags.split(',').filter(Boolean), ...addTags])].join(',');
        hist(net.id, r.id, r.ip, 'update', diff(r, { ...r, type: c.type ?? r.type, status: c.status ?? r.status, tags }));
        run("UPDATE entries SET type=?, status=?, tags=?, updated_at=datetime('now') WHERE id=?", c.type ?? r.type, c.status ?? r.status, tags, r.id);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    log('update', 'entry', `${net.name}: ${rows.length} wpisów (zbiorczo)`);
    return { affected: rows.length };
  });

  // ---------- subnet planning ----------
  // First aligned blocks of the requested size inside `within` that overlap no network of the site.
  route('GET', '/api/sites/:id/free-blocks', ({ params, query, user }) => {
    must(one('SELECT id FROM sites WHERE id=?', params.id), 'Lokalizacja');
    need(user, Number(params.id), 'reader');
    const within = parseCidr(query.within);
    const prefix = Number(query.prefix);
    if (!within) throw bad('Nieprawidłowy zakres nadrzędny (np. 10.0.0.0/16)');
    if (!Number.isInteger(prefix) || prefix < Math.max(16, within.prefix) || prefix > 30) throw bad('Nieprawidłowa długość prefiksu (16–30, nie mniej niż zakres nadrzędny)');
    const size = 2 ** (32 - prefix);
    const used = all('SELECT cidr FROM networks WHERE site_id=?', params.id).map((n) => parseCidr(n.cidr));
    const out = [];
    for (let b = within.first, steps = 0; b + size - 1 <= within.last && out.length < 5 && steps < 1_000_000; b += size, steps++) {
      if (!used.some((u) => b <= u.last && u.first <= b + size - 1)) out.push(`${intToIp(b)}/${prefix}`);
    }
    return out;
  });

  // ---------- address planning: pools and VLANs per tenant ----------
  function poolInput(b, tenantId, selfId = null) {
    const cidr = normalizeCidr(b.cidr);
    if (!cidr) throw bad('Nieprawidłowy CIDR puli (np. 10.0.0.0/8)');
    const c = parseCidr(cidr);
    for (const o of all('SELECT * FROM pools WHERE tenant_id=? AND id!=?', tenantId, selfId ?? 0)) {
      const oc = parseCidr(o.cidr);
      if (c.first <= oc.last && oc.first <= c.last) throw new HttpError(409, `Pula nakłada się z pulą ${o.cidr}${o.name ? ` („${o.name}”)` : ''}`);
    }
    return { cidr, name: str(b.name, 80), description: str(b.description) };
  }
  const tenantNets = (tenantId) => all(`SELECT n.*, s.name AS site_name FROM networks n JOIN sites s ON s.id=n.site_id WHERE s.tenant_id=? ORDER BY n.id`, tenantId)
    .map((n) => ({ ...n, c: parseCidr(n.cidr) }));

  route('GET', '/api/tenants/:id/plan', ({ params, user }) => {
    const tenant = must(one('SELECT * FROM tenants WHERE id=?', params.id), 'Tenant');
    needTenant(user, tenant.id, 'reader');
    const nets = tenantNets(tenant.id).map((n) => {
      const [lo, hi] = usableRange(n.cidr);
      const used = one("SELECT COUNT(*) AS n FROM entries WHERE network_id=? AND status!='free'", n.id).n;
      return { id: n.id, name: n.name, cidr: n.cidr, vlan: n.vlan, site_id: n.site_id, site: n.site_name, used, total: hi - lo + 1, c: n.c };
    });
    const pub = ({ c, ...n }) => n;
    const pools = all('SELECT * FROM pools WHERE tenant_id=? ORDER BY id', tenant.id).map((p) => ({ ...p, c: parseCidr(p.cidr) }));
    const inside = (n, p) => n.c.first >= p.c.first && n.c.last <= p.c.last;
    const out = pools.map((p) => {
      const mine = nets.filter((n) => n.c.first <= p.c.last && p.c.first <= n.c.last);
      const taken = mergeRanges(mine.map((n) => ({ first: Math.max(n.c.first, p.c.first), last: Math.min(n.c.last, p.c.last) })));
      const allocated = taken.reduce((s, r) => s + r.last - r.first + 1, 0);
      const free = freeBlocks(p.c, mine.map((n) => n.c));
      return {
        id: p.id, name: p.name, cidr: p.cidr, description: p.description, size: p.c.size, allocated, free: p.c.size - allocated,
        allocations: mine.filter((n) => inside(n, p)).sort((a, b) => a.c.first - b.c.first).map(pub),
        free_blocks: free.slice(0, 64).map(({ cidr, size }) => ({ cidr, size })), free_block_count: free.length,
        largest_free: free.length ? Math.max(...free.map((f) => f.size)) : 0,
      };
    });
    const conflicts = [];
    for (const p of pools) for (const n of nets) {
      if (n.c.first <= p.c.last && p.c.first <= n.c.last && !inside(n, p)) conflicts.push({ kind: 'straddle', text: `Sieć ${n.cidr} („${n.name}”, ${n.site}) wystaje poza pulę ${p.cidr}` });
    }
    const inAnyPool = (n) => pools.some((p) => inside(n, p));
    for (let i = 0; i < nets.length; i++) for (let j = i + 1; j < nets.length; j++) {
      const [a, b] = [nets[i], nets[j]];
      if (a.site_id !== b.site_id && a.c.first <= b.c.last && b.c.first <= a.c.last && (inAnyPool(a) || inAnyPool(b))) {
        conflicts.push({ kind: 'overlap', text: `Sieci ${a.cidr} („${a.name}”, ${a.site}) i ${b.cidr} („${b.name}”, ${b.site}) nakładają się` });
      }
    }
    const vlans = all('SELECT v.*, s.name AS site FROM vlans v LEFT JOIN sites s ON s.id=v.site_id WHERE v.tenant_id=? ORDER BY v.vid, v.site_id', tenant.id);
    const uses = (v, n) => n.vlan === v.vid && (v.site_id == null || v.site_id === n.site_id);
    const unregistered = [...new Set(nets.filter((n) => n.vlan && !vlans.some((v) => uses(v, n))).map((n) => n.vlan))].sort((a, b) => a - b)
      .map((vid) => ({ vid, networks: nets.filter((n) => n.vlan === vid).map(pub) }));
    return {
      tenant: { id: tenant.id, name: tenant.name }, role: auth.effectiveTenant(auth.rolesOf(user.id), tenant.id),
      sites: all('SELECT id, name FROM sites WHERE tenant_id=? ORDER BY name COLLATE NOCASE', tenant.id),
      pools: out, unpooled: nets.filter((n) => !inAnyPool(n)).map(pub), conflicts,
      vlans: vlans.map((v) => ({ ...v, networks: nets.filter((n) => uses(v, n)).map(pub) })), unregistered,
    };
  });

  route('POST', '/api/tenants/:id/pools', ({ params, body, user }) => unique(() => {
    must(one('SELECT id FROM tenants WHERE id=?', params.id), 'Tenant');
    needTenant(user, Number(params.id), 'admin');
    const p = poolInput(body, Number(params.id));
    const r = run('INSERT INTO pools (tenant_id, name, cidr, description) VALUES (?,?,?,?)', params.id, p.name, p.cidr, p.description);
    log('create', 'pool', `${p.cidr}${p.name ? ` (${p.name})` : ''}`);
    return { id: Number(r.lastInsertRowid), tenant_id: Number(params.id), ...p };
  }));
  route('PUT', '/api/pools/:id', ({ params, body, user }) => unique(() => {
    const old = must(one('SELECT * FROM pools WHERE id=?', params.id), 'Pula');
    needTenant(user, old.tenant_id, 'admin');
    const p = poolInput(body, old.tenant_id, old.id);
    run('UPDATE pools SET name=?, cidr=?, description=? WHERE id=?', p.name, p.cidr, p.description, old.id);
    log('update', 'pool', `${p.cidr}${p.name ? ` (${p.name})` : ''}`);
    return { id: old.id, tenant_id: old.tenant_id, ...p };
  }));
  route('DELETE', '/api/pools/:id', ({ params, user }) => {
    const p = must(one('SELECT * FROM pools WHERE id=?', params.id), 'Pula');
    needTenant(user, p.tenant_id, 'admin');
    run('DELETE FROM pools WHERE id=?', p.id);     // the networks carved out of it stay untouched
    log('delete', 'pool', p.cidr);
    return { ok: true };
  });
  route('GET', '/api/pools/:id/suggest', ({ params, query, user }) => {
    const p = must(one('SELECT * FROM pools WHERE id=?', params.id), 'Pula');
    needTenant(user, p.tenant_id, 'reader');
    const prefix = Number(query.prefix);
    const pc = parseCidr(p.cidr);
    if (!Number.isInteger(prefix) || prefix < Math.max(16, pc.prefix) || prefix > 30) throw bad('Nieprawidłowa długość prefiksu (16–30, nie mniej niż pula)');
    const cidr = findFree(pc, tenantNets(p.tenant_id).map((n) => n.c), prefix);
    if (!cidr) throw new HttpError(404, `W puli ${p.cidr} nie ma wolnego bloku /${prefix}`);
    return { cidr };
  });
  // Carves a subnet out of a pool and creates it as a network of the chosen location.
  route('POST', '/api/pools/:id/allocate', ({ params, body, user }) => unique(() => {
    const p = must(one('SELECT * FROM pools WHERE id=?', params.id), 'Pula');
    const site = must(one('SELECT * FROM sites WHERE id=? AND tenant_id=?', body.site_id, p.tenant_id), 'Lokalizacja');
    need(user, site.id, 'admin');
    const pc = parseCidr(p.cidr);
    let cidr = body.cidr ? normalizeCidr(body.cidr) : null;
    if (!cidr) {
      const prefix = Number(body.prefix);
      if (!Number.isInteger(prefix) || prefix < Math.max(16, pc.prefix) || prefix > 30) throw bad('Podaj CIDR albo prefiks 16–30');
      cidr = findFree(pc, tenantNets(p.tenant_id).map((n) => n.c), prefix);
      if (!cidr) throw new HttpError(404, `W puli ${p.cidr} nie ma wolnego bloku /${prefix}`);
    }
    const c = parseCidr(cidr);
    if (c.first < pc.first || c.last > pc.last) throw bad(`Blok ${cidr} leży poza pulą ${p.cidr}`);
    const clash = tenantNets(p.tenant_id).find((o) => c.first <= o.c.last && o.c.first <= c.last);
    if (clash) throw new HttpError(409, `Blok ${cidr} nakłada się z siecią „${clash.name}” (${clash.cidr}, ${clash.site_name})`);
    const n = netInput({ gateway: 'first', ...body, cidr });
    const r = run(`INSERT INTO networks (site_id, name, cidr, vlan, gateway, dhcp_start, dhcp_end, dns, description, auto_scan)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, site.id, n.name, n.cidr, n.vlan, n.gateway, n.dhcp_start, n.dhcp_end, n.dns, n.description, n.auto_scan);
    log('create', 'network', `${n.name} (${n.cidr}) z puli ${p.cidr}`);
    return { id: Number(r.lastInsertRowid), site_id: site.id, ...n };
  }));

  function vlanInput(b, tenantId, selfId = null) {
    const vid = Number(b.vid);
    if (!Number.isInteger(vid) || vid < 1 || vid > 4094) throw bad('VLAN musi być w zakresie 1–4094');
    const name = str(b.name, 80);
    if (!name) throw bad('Nazwa VLAN-u jest wymagana');
    let site_id = null;
    if (b.site_id !== '' && b.site_id != null) {
      site_id = Number(b.site_id);
      must(one('SELECT id FROM sites WHERE id=? AND tenant_id=?', site_id, tenantId), 'Lokalizacja');
    }
    // A VLAN id is either global for the tenant or defined per location, never both.
    const clash = all('SELECT * FROM vlans WHERE tenant_id=? AND vid=? AND id!=?', tenantId, vid, selfId ?? 0)
      .find((o) => o.site_id == null || site_id == null || o.site_id === site_id);
    if (clash) throw new HttpError(409, `VLAN ${vid} jest już zdefiniowany („${clash.name}”)${clash.site_id == null ? ' dla całego tenanta' : ' dla tej lokalizacji'}`);
    return { vid, name, site_id, description: str(b.description) };
  }
  route('POST', '/api/tenants/:id/vlans', ({ params, body, user }) => unique(() => {
    must(one('SELECT id FROM tenants WHERE id=?', params.id), 'Tenant');
    needTenant(user, Number(params.id), 'admin');
    const v = vlanInput(body, Number(params.id));
    const r = run('INSERT INTO vlans (tenant_id, site_id, vid, name, description) VALUES (?,?,?,?,?)', params.id, v.site_id, v.vid, v.name, v.description);
    log('create', 'vlan', `${v.vid} ${v.name}`);
    return { id: Number(r.lastInsertRowid), tenant_id: Number(params.id), ...v };
  }));
  route('PUT', '/api/vlans/:id', ({ params, body, user }) => unique(() => {
    const old = must(one('SELECT * FROM vlans WHERE id=?', params.id), 'VLAN');
    needTenant(user, old.tenant_id, 'admin');
    const v = vlanInput(body, old.tenant_id, old.id);
    run('UPDATE vlans SET vid=?, name=?, site_id=?, description=? WHERE id=?', v.vid, v.name, v.site_id, v.description, old.id);
    log('update', 'vlan', `${v.vid} ${v.name}`);
    return { id: old.id, tenant_id: old.tenant_id, ...v };
  }));
  route('DELETE', '/api/vlans/:id', ({ params, user }) => {
    const v = must(one('SELECT * FROM vlans WHERE id=?', params.id), 'VLAN');
    needTenant(user, v.tenant_id, 'admin');
    run('DELETE FROM vlans WHERE id=?', v.id);
    log('delete', 'vlan', `${v.vid} ${v.name}`);
    return { ok: true };
  });

  // ---------- consistency checks ----------
  route('GET', '/api/networks/:id/issues', ({ params, user }) => {
    const net = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, net.site_id, 'reader');
    return issuesOf(net);
  });
  // Everything that needs attention, across all networks the user can read.
  route('GET', '/api/issues', ({ user }) => {
    const roles = auth.rolesOf(user.id);
    const items = [];
    for (const n of all('SELECT n.*, s.name AS site_name, s.tenant_id, t.name AS tenant_name FROM networks n JOIN sites s ON s.id=n.site_id JOIN tenants t ON t.id=s.tenant_id ORDER BY t.name, s.name, n.vlan, n.cidr')) {
      if (RANK[auth.effective(roles, n.site_id, n.tenant_id)] < RANK.reader) continue;
      for (const i of issuesOf(n)) items.push({ network_id: n.id, network: n.name, cidr: n.cidr, site: n.site_name, tenant: n.tenant_name, ...i });
    }
    const order = { error: 0, warn: 1, info: 2 };
    items.sort((x, y) => order[x.level] - order[y.level]);
    return { total: items.length, items };
  });

  // ---------- DNS / DHCP export ----------
  const shortName = (f) => f.split('.')[0];
  const EXPORTS = {
    hosts: (rows) => ['# generated by simpleIPAM', ...rows.filter((e) => e.fqdn)
      .map((e) => `${e.ip}\t${e.fqdn}${e.fqdn.includes('.') ? ` ${shortName(e.fqdn)}` : ''}`)],
    dnsmasq: (rows) => ['# generated by simpleIPAM', ...rows.filter((e) => e.fqdn).map((e) => `host-record=${e.fqdn},${e.ip}`),
      ...rows.filter((e) => e.mac).map((e) => `dhcp-host=${e.mac},${e.ip}${e.fqdn ? `,${shortName(e.fqdn)}` : ''}`)],
    bind: (rows) => ['; generated by simpleIPAM — A records with absolute names', ...rows.filter((e) => e.fqdn).map((e) => `${e.fqdn}.\tIN\tA\t${e.ip}`)],
  };
  route('GET', '/api/networks/:id/export/:format', ({ params, user }) => {
    const net = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, net.site_id, 'reader');
    const fn = EXPORTS[params.format];
    if (!fn) throw bad('Nieznany format (hosts, dnsmasq, bind)');
    const rows = all("SELECT * FROM entries WHERE network_id=? AND status!='free' ORDER BY ip_num", net.id);
    return { raw: fn(rows).join('\n') + '\n', contentType: 'text/plain; charset=utf-8', filename: `${net.name.replace(/\W+/g, '_')}.${params.format}` };
  });

  // ---------- auth & IAM ----------
  const meOf = (user) => {
    const roles = auth.rolesOf(user.id);
    return { id: user.id, username: user.username, global_role: roles.global, tenant_roles: roles.tenants, site_roles: roles.sites };
  };

  const registrationOpen = () => one("SELECT value FROM settings WHERE key='registration_open'")?.value !== '0'
    || one('SELECT COUNT(*) AS n FROM users').n === 0;

  // Users with no role assignment at all (new sign-ups waiting for an admin, or deliberately reset to None).
  const NO_ROLES = 'NOT EXISTS (SELECT 1 FROM role_assignments r WHERE r.user_id = u.id)';
  const noRoleCount = () => one(`SELECT COUNT(*) AS n FROM users u WHERE ${NO_ROLES}`).n;

  // setup_required: nobody has registered yet, so the UI shows the "create the administrator" screen
  // (the first account is always made global Admin, see auth.register).
  route('GET', '/api/me', ({ user }) => {
    const me = user ? meOf(user) : null;
    if (me?.global_role === 'admin') me.pending_users = noRoleCount();
    if (me) { me.google_email = auth.identityOf(user.id, 'google'); me.has_password = auth.hasPassword(user.id); }
    return { user: me, setup_required: count('users') === 0, registration_open: registrationOpen(), google_login: googleLogin().ready, version: opts.version ?? 'dev' };
  }, { public: true });
  route('GET', '/api/health', () => ({ ok: true }), { public: true });
  // ---------- notifications ----------
  const notifyPublic = () => {
    const { url, ...c } = notifyCfg();
    let last = null;
    try { last = JSON.parse(one("SELECT value FROM settings WHERE key='notify_last'")?.value ?? 'null'); } catch { /* none */ }
    return { ...c, url_set: !!url, url_host: notify.parseUrl(url)?.host ?? '', last };
  };
  route('GET', '/api/admin/notify', ({ user }) => (needGlobalAdmin(user), notifyPublic()));
  route('PUT', '/api/admin/notify', ({ body, user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    const c = notifyCfg();
    if (body.kind !== undefined) { if (!['ntfy', 'webhook'].includes(body.kind)) throw bad('Nieznany rodzaj powiadomień (ntfy, webhook)'); c.kind = body.kind; }
    const url = str(body.url, 500);
    if (url) { if (!notify.parseUrl(url)) throw bad('Adres musi zaczynać się od http:// lub https://'); c.url = url; }
    for (const k of Object.keys(notify.EVENTS)) if (body.events && k in body.events) c.events[k] = !!body.events[k];
    if (body.enabled !== undefined) c.enabled = !!body.enabled;
    if (c.enabled && !c.url) throw bad('Podaj adres, na który mają trafiać powiadomienia');
    saveSetting('notify', c);
    log('update', 'settings', 'powiadomienia');
    return notifyPublic();
  });
  route('POST', '/api/admin/notify/test', async ({ user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    const c = notifyCfg();
    if (!c.url) throw bad('Najpierw zapisz adres powiadomień');
    try { await notify.send(c, { title: 'simpleIPAM: test powiadomień', text: 'Jeśli to widzisz, powiadomienia działają.' }, { fetch: opts.fetch }); }
    catch (e) { throw bad(`Nie udało się wysłać: ${String(e.cause?.code ?? e.message)}`); }
    return { ok: true };
  });

  // ---------- sign in with Google ----------
  // Separate OAuth client from the Drive one: login needs a "Web application" client with a redirect URI.
  const googleLogin = () => {
    let c = {};
    try { c = JSON.parse(one("SELECT value FROM settings WHERE key='google_login'")?.value ?? '{}'); } catch { /* unset */ }
    const cfg = { client_id: '', client_secret: '', enabled: false, ...c };
    return { ...cfg, ready: !!(cfg.enabled && cfg.client_id && cfg.client_secret) };
  };
  const glPublic = () => { const { client_secret, ready, ...c } = googleLogin(); return { ...c, secret_set: !!client_secret, ready }; };
  route('GET', '/api/admin/google-login', ({ user }) => (needGlobalAdmin(user), glPublic()));
  route('POST', '/api/me/google/unlink', ({ user, ctx }) => {
    sessionOnly(ctx);
    auth.unlinkIdentity(user.id, 'google');
    log('update', 'user', `${user.username}: odłączono konto Google`);
    return { ok: true };
  });
  route('PUT', '/api/admin/google-login', ({ body, user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    const c = googleLogin();
    if (body.client_id !== undefined) {
      c.client_id = str(body.client_id, 300);
    }
    if (str(body.client_secret, 300)) c.client_secret = str(body.client_secret, 300);
    if (body.enabled !== undefined) c.enabled = !!body.enabled;
    if (c.enabled && !(c.client_id && c.client_secret)) throw bad('Podaj Client ID i Client Secret, zanim włączysz logowanie przez Google');
    const { ready, ...store } = c;
    run("INSERT INTO settings (key, value) VALUES ('google_login', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(store));
    log('update', 'settings', `logowanie przez Google: ${c.enabled ? 'włączone' : 'wyłączone'}`);
    return glPublic();
  });
  const glPending = new Map();   // state -> { verifier, redirectUri, linkUser, expires }
  route('POST', '/api/auth/google/start', ({ body, user }) => {
    const cfg = googleLogin();
    if (!cfg.ready) throw bad('Logowanie przez Google jest wyłączone');
    let origin;
    try { origin = new URL(String(body.origin)); } catch { throw bad('Nieprawidłowy adres aplikacji'); }
    if (!/^https?:$/.test(origin.protocol)) throw bad('Nieprawidłowy adres aplikacji');
    if (body.link && !user) throw new HttpError(401, 'Wymagane logowanie');
    for (const [k, v] of glPending) if (v.expires < Date.now()) glPending.delete(k);
    const state = randomBytes(24).toString('base64url');
    const { verifier, challenge } = gl.newPkce();
    const redirectUri = `${origin.origin}/api/auth/google/callback`;
    glPending.set(state, { verifier, redirectUri, linkUser: body.link ? user.id : null, expires: Date.now() + 10 * 60_000 });
    return { url: gl.loginUrl({ clientId: cfg.client_id, redirectUri, state, challenge }), redirect_uri: redirectUri };
  }, { public: true });
  route('GET', '/api/auth/google/callback', async ({ query, ctx, user }) => {
    const back = (r) => ({ redirect: `/?google=${encodeURIComponent(r)}#/` });
    const p = glPending.get(query.state);
    glPending.delete(query.state);
    const cfg = googleLogin();
    if (!p || p.expires < Date.now() || !cfg.ready) return back('state');
    if (query.error || !query.code) return back('denied');
    try {
      const id = await gl.exchangeIdentity(cfg, { code: query.code, redirectUri: p.redirectUri, verifier: p.verifier }, { fetch: opts.fetch });
      if (p.linkUser) {
        if (!user || user.id !== p.linkUser) return back('state');
        auth.linkIdentity(user.id, 'google', id.subject, id.email);
        actor = user.username;
        log('update', 'user', `${user.username}: połączono konto Google`);
        return back('linked');
      }
      const r = auth.loginWithIdentity('google', id.subject, id);
      actor = r.user.username;
      if (r.created) log('create', 'user', `${r.user.username} (Google)`);
      ctx.newToken = r.token;
      return back(r.created ? 'new' : 'ok');
    } catch (e) { return back(e instanceof HttpError ? `msg:${e.message}` : 'error'); }
  }, { public: true });
  route('PUT', '/api/settings', ({ body, user }) => {
    needGlobalAdmin(user);
    run("INSERT INTO settings (key, value) VALUES ('registration_open', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", body.registration_open ? '1' : '0');
    log('update', 'settings', `rejestracja: ${body.registration_open ? 'otwarta' : 'wyłączona'}`);
    return { registration_open: !!body.registration_open };
  });
  // ---------- admin: system & backups ----------
  const bdeps = () => ({ dir: opts.backupDir, fetch: opts.fetch, gcsBase: opts.gcsBase });
  const count = (t) => one(`SELECT COUNT(*) AS n FROM ${t}`).n;

  route('GET', '/api/admin/system', ({ user }) => {
    needGlobalAdmin(user);
    return {
      db_bytes: one('PRAGMA page_count').page_count * one('PRAGMA page_size').page_size,
      counts: { tenants: count('tenants'), sites: count('sites'), networks: count('networks'), entries: count('entries'), users: count('users') },
      version: opts.version ?? 'dev',
      commit: opts.commit ?? 'unknown',
      node: process.version,
      scan_interval_min: Number(process.env.SCAN_INTERVAL_MIN ?? 15),
      backup_dir: opts.backupDir || null,
    };
  });

  // Fresh snapshot streamed to the browser; nothing is stored.
  route('GET', '/api/admin/backup', ({ user }) => {
    needGlobalAdmin(user);
    return { raw: snapshotBuffer(db), contentType: 'application/vnd.sqlite3', filename: `simpleipam-${new Date().toISOString().slice(0, 10)}.db` };
  });
  route('GET', '/api/admin/backups', ({ user }) => {
    needGlobalAdmin(user);
    return { dir_enabled: !!opts.backupDir, files: listLocal(opts.backupDir), last: lastBackup(db), config: publicConfig(loadConfig(db)) };
  });
  route('PUT', '/api/admin/backups/config', ({ body, user }) => {
    needGlobalAdmin(user);
    const cfg = saveConfig(db, body);
    log('update', 'settings', `kopie zapasowe: ${cfg.remote_enabled ? `zdalne (${cfg.provider})` : 'tylko lokalne'}, lokalnie ${cfg.local_keep}`);
    return publicConfig(cfg);
  });
  route('POST', '/api/admin/backups/run', async ({ user }) => {
    needGlobalAdmin(user);
    const r = await runBackup(db, { ...bdeps(), trigger: 'manual' });
    log('create', 'backup', `${r.name}${r.ok ? '' : ' (z błędem)'}`);
    return r;
  });
  route('POST', '/api/admin/backups/test-remote', async ({ user }) => {
    needGlobalAdmin(user);
    try { await testRemote(loadConfig(db), bdeps()); return { ok: true }; }
    catch (e) { return { ok: false, message: String(e.message).slice(0, 300) }; }
  });
  // ---------- Google Drive: one-time OAuth consent ----------
  // Redirect flow: the browser goes to Google and returns to /callback. Device flow: the user types a short code at
  // google.com/device; needed when the app is reached over plain http on a LAN address, which Google refuses as a redirect URI.
  const gdPending = new Map();   // state -> { verifier, redirectUri, expires }
  let gdDevice = null;           // { device_code, expires }
  const gdCfg = () => {
    const c = loadConfig(db).gdrive;
    if (!c.client_id || !c.client_secret) throw bad('Najpierw zapisz Client ID i Client Secret z Google Cloud');
    return c;
  };
  const gdCfgConnected = () => {
    const c = gdCfg();
    if (!c.refresh_token) throw bad('Konto Google nie jest połączone');
    return c;
  };
  const gdFetch = () => ({ fetch: opts.fetch });
  const gdFail = (e) => { if (e instanceof gd.GoogleError) throw bad(e.message); throw e; };

  route('POST', '/api/admin/backups/gdrive/connect', ({ body, user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    const cfg = gdCfg();
    let origin;
    try { origin = new URL(String(body.origin)); } catch { throw bad('Nieprawidłowy adres aplikacji'); }
    if (!/^https?:$/.test(origin.protocol)) throw bad('Nieprawidłowy adres aplikacji');
    const redirectUri = `${origin.origin}/api/admin/backups/gdrive/callback`;
    for (const [k, v] of gdPending) if (v.expires < Date.now()) gdPending.delete(k);
    const state = randomBytes(24).toString('base64url');
    const { verifier, challenge } = gd.newPkce();
    gdPending.set(state, { verifier, redirectUri, expires: Date.now() + 10 * 60_000 });
    return { url: gd.authUrl({ clientId: cfg.client_id, redirectUri, state, challenge }), redirect_uri: redirectUri };
  });
  route('GET', '/api/admin/backups/gdrive/callback', async ({ user, ctx, query }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    const back = (r) => ({ redirect: `/#/admin/backups?gdrive=${encodeURIComponent(r)}` });
    const p = gdPending.get(query.state);
    gdPending.delete(query.state);
    if (!p || p.expires < Date.now()) return back('state');
    if (query.error || !query.code) return back('denied');
    try {
      const t = await gd.exchangeCode(gdCfg(), { code: query.code, redirectUri: p.redirectUri, verifier: p.verifier }, gdFetch());
      setGdriveAuth(db, t);
      log('update', 'settings', `Dysk Google połączony (${t.email || 'konto'})`);
      return back('ok');
    } catch { return back('error'); }
  });
  route('POST', '/api/admin/backups/gdrive/device/start', async ({ user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    try {
      const d = await gd.startDevice(gdCfg(), gdFetch());
      gdDevice = { device_code: d.device_code, expires: Date.now() + d.expires_in * 1000 };
      return { user_code: d.user_code, verification_url: d.verification_url, interval: d.interval, expires_in: d.expires_in };
    } catch (e) { gdFail(e); }
  });
  route('POST', '/api/admin/backups/gdrive/device/poll', async ({ user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    if (!gdDevice || gdDevice.expires < Date.now()) { gdDevice = null; return { status: 'expired' }; }
    try {
      const r = await gd.pollDevice(gdCfg(), gdDevice.device_code, gdFetch());
      if (r.status === 'connected') {
        gdDevice = null;
        setGdriveAuth(db, r);
        log('update', 'settings', `Dysk Google połączony (${r.email || 'konto'})`);
        return { status: 'connected', email: r.email };
      }
      if (r.status === 'denied' || r.status === 'expired') gdDevice = null;
      return { status: r.status };
    } catch (e) { gdDevice = null; gdFail(e); }
  });
  route('GET', '/api/admin/backups/gdrive/files', async ({ user }) => {
    needGlobalAdmin(user);
    try { return { files: await gd.listDrive(gdCfgConnected(), gdFetch()) }; } catch (e) { gdFail(e); }
  });
  route('POST', '/api/admin/backups/gdrive/disconnect', async ({ user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    const { refresh_token } = loadConfig(db).gdrive;
    if (refresh_token) await gd.revoke(refresh_token, gdFetch());
    setGdriveAuth(db, {});
    log('update', 'settings', 'Dysk Google odłączony');
    return publicConfig(loadConfig(db));
  });

  // ---------- restore ----------
  // Step 1 (inspect) validates a file and stages it next to the database; step 2 (apply) swaps it in.
  const STAGE_TTL_MS = 15 * 60_000;
  const staged = new Map();   // token -> { path, label, summary, migrated, expires }
  if (db.path !== ':memory:') {   // previews abandoned before a restart leave staged files behind
    const prefix = `${basename(db.path)}.restore-`;
    for (const f of readdirSync(dirname(db.path))) if (f.startsWith(prefix) && f.endsWith('.tmp')) rmSync(join(dirname(db.path), f), { force: true });
  }
  const dropStaged = (t) => { const e = staged.get(t); if (e) { rmSync(e.path, { force: true }); staged.delete(t); } };
  const sweepStaged = () => { for (const [t, e] of staged) if (e.expires < Date.now()) dropStaged(t); };

  route('POST', '/api/admin/restore/inspect', async ({ body, user, ctx }) => {
    needGlobalAdmin(user);
    sessionOnly(ctx);
    if (db.path === ':memory:') throw bad('Przywracanie jest niedostępne dla bazy w pamięci');
    sweepStaged();
    if (staged.size >= 3) dropStaged(staged.keys().next().value);
    const token = randomBytes(16).toString('hex');
    const path = `${db.path}.restore-${token}.tmp`;
    let label;
    if (Buffer.isBuffer(body.file)) {
      if (!body.file.length) throw bad('Plik jest pusty');
      writeFileSync(path, body.file);
      label = 'przesłany plik';
    } else if (body.drive_id) {
      try {
        const d = await gd.downloadDrive(gdCfgConnected(), String(body.drive_id), gdFetch());
        writeFileSync(path, d.data);
        label = `Dysk Google: ${d.name}`;
      } catch (e) { gdFail(e); }
    } else {
      copyFileSync(localFile(String(body.name ?? '')), path);
      label = body.name;
    }
    try {
      const bytes = readFileSync(path);
      if (isEncrypted(bytes)) {      // typed passphrase first, then the one stored for scheduled backups
        const pass = String(body.passphrase ?? ctx.passphrase ?? '') || loadConfig(db).encrypt.passphrase;
        if (!pass) throw bad('Kopia jest zaszyfrowana — podaj hasło szyfrowania');
        writeFileSync(path, decrypt(bytes, pass));
      }
      const { summary, migrated } = validateAndPrepare(path);
      staged.set(token, { path, label, summary, migrated, expires: Date.now() + STAGE_TTL_MS });
      return { token, label, migrated, current: summarize(db), backup: summary, you_in_backup: summary.usernames.includes(user.username) };
    } catch (e) {
      rmSync(path, { force: true });
      throw e;
    }
  });

  route('POST', '/api/admin/restore/apply', ({ body, user, ctx }) => {
    needGlobalAdmin(user);
    sessionOnly(ctx);
    sweepStaged();
    const entry = staged.get(String(body.token ?? ''));
    if (!entry) throw new HttpError(404, 'Sesja przywracania wygasła — wybierz plik ponownie');
    // Safety copy of what is about to be replaced; it is a normal backup file, so restoring it undoes this.
    const stamp = backupName();
    const safety = opts.backupDir ? join(opts.backupDir, stamp) : `${db.path}.pre-restore-${stamp}`;
    mkdirSync(opts.backupDir || join(db.path, '..'), { recursive: true });
    writeFileSync(safety, snapshotBuffer(db));
    db.swapFile(entry.path);
    staged.delete(String(body.token));
    db.exec('DELETE FROM sessions');            // everyone logs in again against the restored accounts
    log('update', 'backup', `przywrócono z: ${entry.label} (kopia bezpieczeństwa: ${stamp})`);
    return { ok: true, safety: opts.backupDir ? stamp : safety, summary: entry.summary };
  });

  const localFile = (name) => {
    if (!opts.backupDir) throw bad('Kopie lokalne są wyłączone (BACKUP_DIR)');
    if (!isBackupName(name)) throw new HttpError(404, 'Nie znaleziono');
    const file = join(opts.backupDir, name);
    if (!existsSync(file)) throw new HttpError(404, 'Kopia nie istnieje');
    return file;
  };
  route('GET', '/api/admin/backups/:name', ({ params, user }) => {
    needGlobalAdmin(user);
    return { raw: readFileSync(localFile(params.name)), contentType: 'application/vnd.sqlite3', filename: params.name };
  });
  route('DELETE', '/api/admin/backups/:name', ({ params, user }) => {
    needGlobalAdmin(user);
    rmSync(localFile(params.name));
    log('delete', 'backup', params.name);
    return { ok: true };
  });


  route('POST', '/api/auth/register', ({ body, ctx }) => {
    const u = auth.register(body.username, body.password);
    log('create', 'user', u.username);
    ctx.newToken = auth.login(u.username, body.password, ctx.ip).token;
    return { user: meOf(u), first: u.first };
  }, { public: true });
  route('POST', '/api/auth/login', ({ body, ctx }) => {
    const { user, token } = auth.login(body.username, body.password, ctx.ip);
    ctx.newToken = token;
    return { user: meOf(user) };
  }, { public: true });
  route('POST', '/api/auth/logout', ({ ctx }) => { auth.logout(ctx.token); ctx.clearToken = true; return { ok: true }; }, { public: true });
  route('GET', '/api/me/tokens', ({ user, ctx }) => (sessionOnly(ctx), auth.listTokens(user.id)));
  route('POST', '/api/me/tokens', ({ body, user, ctx }) => {
    sessionOnly(ctx);
    const t = auth.createToken(user.id, body.name);
    log('create', 'token', `${user.username}: ${t.name}`);
    return t;
  });
  route('DELETE', '/api/me/tokens/:id', ({ params, user, ctx }) => {
    sessionOnly(ctx);
    if (!auth.deleteToken(user.id, Number(params.id))) throw new HttpError(404, 'Token nie istnieje');
    return { ok: true };
  });
  route('POST', '/api/me/password', ({ body, user, ctx }) => {
    sessionOnly(ctx);
    if (auth.hasPassword(user.id) && !auth.checkPassword(user.id, body.current)) throw new HttpError(403, 'Aktualne hasło jest nieprawidłowe');
    auth.setPassword(user.id, body.password);
    auth.dropSessions(user.id);
    ctx.newToken = auth.login(user.username, body.password, ctx.ip).token;
    return { ok: true };
  });

  route('GET', '/api/users', ({ user }) => {
    needGlobalAdmin(user);
    return all(`SELECT u.id, u.username, u.created_at, ${NO_ROLES} AS no_roles FROM users u ORDER BY u.username COLLATE NOCASE`).map((u) => {
      const r = auth.rolesOf(u.id);
      return { ...u, no_roles: !!u.no_roles, global_role: r.global, tenant_roles: r.tenants, site_roles: r.sites };
    });
  });
  // Scope is global (no ids), tenant (tenant_id) or site (site_id). A global role of "none" just removes the assignment.
  route('PUT', '/api/users/:id/roles', ({ params, body, user }) => {
    needGlobalAdmin(user);
    const target = must(one('SELECT id, username FROM users WHERE id=?', params.id), 'Użytkownik');
    if (!ROLES.includes(body.role)) throw bad('Nieprawidłowa rola');
    const blank = (v) => v == null || v === '';
    const tenantId = blank(body.tenant_id) ? null : Number(body.tenant_id);
    const siteId = blank(body.site_id) ? null : Number(body.site_id);
    if (tenantId !== null && siteId !== null) throw bad('Wybierz tenanta albo lokalizację, nie oba');
    let scope = 'global';
    if (siteId !== null) scope = must(one('SELECT name FROM sites WHERE id=?', siteId), 'Lokalizacja').name;
    else if (tenantId !== null) scope = `tenant ${must(one('SELECT name FROM tenants WHERE id=?', tenantId), 'Tenant').name}`;
    else if (body.role !== 'admin' && auth.rolesOf(target.id).global === 'admin' && auth.globalAdminCount() <= 1) {
      throw bad('Musi zostać co najmniej jeden globalny administrator');
    }
    run('DELETE FROM role_assignments WHERE user_id=? AND COALESCE(tenant_id,0)=? AND COALESCE(site_id,0)=?', target.id, tenantId ?? 0, siteId ?? 0);
    if (scope !== 'global' || body.role !== 'none') {
      run('INSERT INTO role_assignments (user_id, tenant_id, site_id, role) VALUES (?,?,?,?)', target.id, tenantId, siteId, body.role);
    }
    log('update', 'role', `${target.username}: ${body.role} (${scope})`);
    return { ok: true };
  });
  // Removing a site/tenant assignment makes the user fall back to the next level up.
  route('DELETE', '/api/users/:id/roles/:scope/:scopeId', ({ params, user }) => {
    needGlobalAdmin(user);
    const target = must(one('SELECT id, username FROM users WHERE id=?', params.id), 'Użytkownik');
    if (!['site', 'tenant'].includes(params.scope)) throw bad('Nieprawidłowy zakres');
    run(`DELETE FROM role_assignments WHERE user_id=? AND ${params.scope}_id=?`, target.id, Number(params.scopeId));
    log('update', 'role', `${target.username}: reset (${params.scope} ${params.scopeId})`);
    return { ok: true };
  });
  route('PUT', '/api/users/:id/password', ({ params, body, user }) => {
    needGlobalAdmin(user);
    const target = must(one('SELECT id, username FROM users WHERE id=?', params.id), 'Użytkownik');
    auth.setPassword(target.id, body.password);
    auth.dropSessions(target.id);
    log('update', 'user', `${target.username}: reset hasła`);
    return { ok: true };
  });
  route('DELETE', '/api/users/:id', ({ params, user }) => {
    needGlobalAdmin(user);
    const target = must(one('SELECT id, username FROM users WHERE id=?', params.id), 'Użytkownik');
    if (target.id === user.id) throw bad('Nie możesz usunąć własnego konta');
    if (auth.rolesOf(target.id).global === 'admin' && auth.globalAdminCount() <= 1) throw bad('Musi zostać co najmniej jeden globalny administrator');
    run('DELETE FROM users WHERE id=?', target.id);
    log('delete', 'user', target.username);
    return { ok: true };
  });

  // Called by server.js on a timer. Scans every network with auto_scan on; one failing network does not stop the rest.
  async function runScheduledScans() {
    for (const net of all('SELECT * FROM networks WHERE auto_scan=1')) {
      try { await scan(net); } catch (e) { console.error(`scheduled scan of ${net.cidr} failed:`, e.message); }
    }
  }

  // ctx: { token, bearer, ip } in; { newToken, clearToken } out (server.js turns these into the cookie).
  async function handle(method, path, query, body, ctx = {}) {
    ctx.viaToken = false;
    ctx.user = auth.sessionUser(ctx.token);
    if (!ctx.user && ctx.bearer) { ctx.user = auth.tokenUser(ctx.bearer); ctx.viaToken = !!ctx.user; }
    actor = ctx.user ? `${ctx.user.username}${ctx.viaToken ? ' (API)' : ''}` : '';
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      if (!r.public && !ctx.user) throw new HttpError(401, 'Wymagane logowanie');
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return r.handler({ params, query, body, user: ctx.user, ctx });
    }
    throw new HttpError(404, 'Nie znaleziono');
  }


  // ---------- UniFi (Site Manager) import ----------
  // One-way: UniFi -> simpleIPAM. Networks are created (or have blanks filled) per console/site, static clients become entries,
  // clients inside the DHCP pool land in "discovered" (or become entries when import_dhcp is on), and the MACs UniFi reports
  // feed the same MAC-change detection as scans.
  const UNIFI_DEFAULTS = { api_key: '', consoles: [], tenant_id: null, import_dhcp: false, auto_sync: false, push_aliases: false, write_verified: false };
  const unifiCfg = () => {
    let c = {};
    try { c = JSON.parse(one("SELECT value FROM settings WHERE key='unifi'")?.value ?? '{}'); } catch { /* unset */ }
    return { ...UNIFI_DEFAULTS, ...c };
  };
  const saveSetting = (key, v) => run('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(v));
  const unifiLast = () => { try { return JSON.parse(one("SELECT value FROM settings WHERE key='unifi_last'")?.value ?? 'null'); } catch { return null; } };
  const unifiPublic = (c = unifiCfg()) => ({ ...c, api_key: undefined, key_set: !!c.api_key, last: unifiLast() });
  const uDeps = () => ({ fetch: opts.fetch });
  const uFail = (e) => { if (e instanceof unifi.UnifiError) throw bad(e.message); throw e; };
  const inPool = (n, ip) => !!n.dhcp_start && ipToInt(ip) >= ipToInt(n.dhcp_start) && ipToInt(ip) <= ipToInt(n.dhcp_end);

  route('GET', '/api/admin/unifi', ({ user }) => (needGlobalAdmin(user), unifiPublic()));
  route('PUT', '/api/admin/unifi', ({ body, user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    const c = unifiCfg();
    if (str(body.api_key, 300)) { c.api_key = str(body.api_key, 300); c.consoles = []; }       // a new key means a new account: rediscover
    if (body.tenant_id !== undefined) {
      if (body.tenant_id !== null) must(one('SELECT id FROM tenants WHERE id=?', body.tenant_id), 'Tenant');
      c.tenant_id = body.tenant_id === null ? null : Number(body.tenant_id);
    }
    if (body.import_dhcp !== undefined) c.import_dhcp = !!body.import_dhcp;
    if (body.auto_sync !== undefined) c.auto_sync = !!body.auto_sync;
    if (body.push_aliases !== undefined) {
      if (body.push_aliases && !c.write_verified) throw bad('Najpierw wyślij aliasy ręcznie („Wyślij aliasy do UniFi”) — automat włączysz po pierwszym udanym zapisie');
      c.push_aliases = !!body.push_aliases;
    }
    if (Array.isArray(body.consoles)) {
      const on = new Set(body.consoles.filter((x) => x.enabled).map((x) => String(x.id)));
      c.consoles = c.consoles.map((x) => ({ ...x, enabled: on.has(x.id) }));
    }
    saveSetting('unifi', c);
    log('update', 'settings', 'integracja UniFi');
    return unifiPublic(c);
  });
  route('POST', '/api/admin/unifi/discover', async ({ user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    const c = unifiCfg();
    if (!c.api_key) throw bad('Najpierw zapisz klucz API');
    try {
      const hosts = await unifi.listHosts(c, uDeps());
      const was = new Map(c.consoles.map((x) => [x.id, x]));
      c.consoles = hosts.map((h) => ({ id: h.id, name: h.name, ip: h.ip, enabled: was.get(h.id)?.enabled ?? false }));
      saveSetting('unifi', c);
      return unifiPublic(c);
    } catch (e) { uFail(e); }
  });


  // ---------- aliases: simpleIPAM -> UniFi ----------
  // Client aliases can only be written through the classic Network API (`rest/user`), addressed by MAC. Only clients UniFi already
  // knows are renamed (none are created), an emptied alias never clears the name in UniFi, and writes are capped per run
  // (the connector allows 100 requests/min per console).
  const PUSH_CAP = 40;
  async function unifiPushSite(c, siteRow, { dry = false, entryId = null } = {}) {
    const out = { site: siteRow.name, planned: [], pushed: 0, skipped: [], errors: [] };
    const where = entryId ? 'AND e.id=?' : '';
    const cands = all(`SELECT e.* FROM entries e JOIN networks n ON n.id=e.network_id
      WHERE n.site_id=? AND e.alias!='' AND e.mac!='' AND e.alias!=e.unifi_name ${where} ORDER BY e.ip_num`, ...(entryId ? [siteRow.id, entryId] : [siteRow.id]));
    if (!cands.length) return out;
    try {
      const siteName = await unifi.classicSiteName(c, siteRow.unifi_host, { internalReference: siteRow.unifi_site, name: siteRow.unifi_site_name }, uDeps());
      const known = await unifi.knownClients(c, siteRow.unifi_host, siteName, uDeps());
      for (const e of cands) {
        const k = known.get(e.mac.toLowerCase());
        if (!k) { out.skipped.push({ ip: e.ip, reason: 'UniFi nie zna tego klienta (brak go na liście znanych urządzeń)' }); continue; }
        if (k.name === e.alias) { if (!dry) run('UPDATE entries SET unifi_name=? WHERE id=?', e.alias, e.id); continue; }   // already the same
        out.planned.push({ ip: e.ip, mac: e.mac, from: k.name, to: e.alias });
        if (dry) continue;
        if (out.pushed >= PUSH_CAP) { out.skipped.push({ ip: e.ip, reason: 'limit zapisów na jedno uruchomienie — reszta przy następnej synchronizacji' }); continue; }
        await unifi.setClientName(c, siteRow.unifi_host, siteName, k.id, e.alias, uDeps());
        run('UPDATE entries SET unifi_name=? WHERE id=?', e.alias, e.id);
        hist(e.network_id, e.id, e.ip, 'pushed', { alias: [k.name, e.alias] }, 'unifi');
        out.pushed++;
      }
    } catch (err) { out.errors.push(err.message); }
    return out;
  }

  // DHCP reservations: entries marked "reserved" with a MAC become fixed IPs of the matching known UniFi client. Same safety
  // rules as the alias push: known clients only, nothing is created, capped per run, previewable.
  async function unifiReserveSite(c, siteRow, { dry = false } = {}) {
    const out = { site: siteRow.name, planned: [], pushed: 0, skipped: [], errors: [] };
    const cands = all(`SELECT e.*, n.cidr AS net_cidr, n.dhcp_start, n.dhcp_end FROM entries e JOIN networks n ON n.id=e.network_id
      WHERE n.site_id=? AND e.status='reserved' AND e.mac!='' ORDER BY e.ip_num`, siteRow.id);
    if (!cands.length) return out;
    try {
      const siteName = await unifi.classicSiteName(c, siteRow.unifi_host, { internalReference: siteRow.unifi_site, name: siteRow.unifi_site_name }, uDeps());
      const known = await unifi.knownClients(c, siteRow.unifi_host, siteName, uDeps());
      const nets = await unifi.classicNetworks(c, siteRow.unifi_host, siteName, uDeps());
      for (const e of cands) {
        if (!(e.dhcp_start && e.ip_num >= ipToInt(e.dhcp_start) && e.ip_num <= ipToInt(e.dhcp_end))) { out.skipped.push({ ip: e.ip, reason: 'adres poza pulą DHCP jest statyczny — nie ma czego rezerwować' }); continue; }
        const k = known.get(e.mac.toLowerCase());
        if (!k) { out.skipped.push({ ip: e.ip, reason: 'UniFi nie zna tego klienta (brak go na liście znanych urządzeń)' }); continue; }
        const net = nets.find((n) => n.cidr === normalizeCidr(e.net_cidr));
        if (!net) { out.skipped.push({ ip: e.ip, reason: 'UniFi nie ma sieci o tym CIDR' }); continue; }
        if (k.fixed && k.fixed_ip === e.ip) continue;                        // already reserved
        out.planned.push({ ip: e.ip, mac: e.mac, from: k.fixed ? k.fixed_ip : '', to: e.ip });
        if (dry) continue;
        if (out.pushed >= PUSH_CAP) { out.skipped.push({ ip: e.ip, reason: 'limit zapisów na jedno uruchomienie — reszta przy następnej synchronizacji' }); continue; }
        await unifi.setFixedIp(c, siteRow.unifi_host, siteName, k.id, e.ip, net.id, uDeps());
        hist(e.network_id, e.id, e.ip, 'pushed', { reservation: [k.fixed ? k.fixed_ip : '', e.ip] }, 'unifi');
        out.pushed++;
      }
    } catch (err) { out.errors.push(err.message); }
    return out;
  }
  async function unifiReserve({ dry = false } = {}) {
    const c = unifiCfg();
    if (!c.api_key) throw bad('Najpierw zapisz klucz API');
    const hosts = new Set(c.consoles.filter((x) => x.enabled).map((x) => x.id));
    const sites = all("SELECT * FROM sites WHERE unifi_host!=''").filter((s) => hosts.has(s.unifi_host));
    if (!sites.length) throw bad('Brak lokalizacji zaimportowanych z UniFi — najpierw wykonaj synchronizację');
    const results = [];
    for (const s of sites) results.push(await unifiReserveSite(c, s, { dry }));
    const pushed = results.reduce((n, r) => n + r.pushed, 0);
    if (!dry && pushed > 0 && !c.write_verified) { c.write_verified = true; saveSetting('unifi', c); }
    return { at: new Date().toISOString(), dry, ok: results.every((r) => !r.errors.length), pushed, results };
  }
  async function unifiPush({ dry = false } = {}) {
    const c = unifiCfg();
    if (!c.api_key) throw bad('Najpierw zapisz klucz API');
    const hosts = new Set(c.consoles.filter((x) => x.enabled).map((x) => x.id));
    const sites = all("SELECT * FROM sites WHERE unifi_host!=''").filter((s) => hosts.has(s.unifi_host));
    if (!sites.length) throw bad('Brak lokalizacji zaimportowanych z UniFi — najpierw wykonaj synchronizację');
    const results = [];
    for (const s of sites) results.push(await unifiPushSite(c, s, { dry }));
    const pushed = results.reduce((n, r) => n + r.pushed, 0);
    if (!dry && pushed > 0 && !c.write_verified) { c.write_verified = true; saveSetting('unifi', c); }
    return { at: new Date().toISOString(), dry, ok: results.every((r) => !r.errors.length), pushed, results };
  }
  route('POST', '/api/admin/unifi/push', async ({ body, user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    actor = user.username;
    try {
      const r = await unifiPush({ dry: !!body.dry_run });
      if (!r.dry && r.pushed) { actor = user.username; log('update', 'settings', `aliasy wysłane do UniFi: ${r.pushed}`); }
      return r;
    } catch (e) { uFail(e); }
  });
  route('POST', '/api/admin/unifi/reserve', async ({ body, user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    actor = user.username;
    try {
      const r = await unifiReserve({ dry: !!body.dry_run });
      if (!r.dry && r.pushed) log('update', 'settings', `rezerwacje DHCP wysłane do UniFi: ${r.pushed}`);
      return r;
    } catch (e) { uFail(e); }
  });
  // An alias saved in simpleIPAM reaches UniFi right away when automatic push is on (failures are retried by the hourly sync).
  const pushAliasSoon = (entryId) => {
    const c = unifiCfg();
    if (!c.push_aliases || !c.write_verified || !c.api_key) return;
    const e = one('SELECT e.id, n.site_id FROM entries e JOIN networks n ON n.id=e.network_id WHERE e.id=?', entryId);
    const site = e && one("SELECT * FROM sites WHERE id=? AND unifi_host!=''", e.site_id);
    if (site) setImmediate(() => unifiPushSite(c, site, { entryId }).catch(() => {}));
  };

  // Before any write-back is built: can this API key even reach the classic Network API (where client aliases live)?
  route('POST', '/api/admin/unifi/diagnose', async ({ user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    const c = unifiCfg();
    if (!c.api_key) throw bad('Najpierw zapisz klucz API');
    const cons = c.consoles.filter((x) => x.enabled);
    if (!cons.length) throw bad('Zaznacz co najmniej jedną konsolę');
    const results = [];
    for (const con of cons) {
      const integration = await unifi.probe(c, con.id, '/integration/v1/sites', uDeps());
      const legacy = await unifi.probe(c, con.id, '/api/self/sites', uDeps());
      results.push({ console: con.name, integration, legacy });
    }
    return { results };
  });

  // Reads everything for one console (awaits happen here), then applies it in a single synchronous transaction.
  async function unifiFetchConsole(c, con) {
    const sites = await unifi.listSites(c, con.id, uDeps());
    const out = [];
    for (const site of sites) {
      const nets = [];
      for (const raw of await unifi.listNetworks(c, con.id, site.id, uDeps())) {
        let n = unifi.toNetwork(raw);
        if (!n && raw?.id) n = unifi.toNetwork(await unifi.networkDetails(c, con.id, site.id, raw.id, uDeps()).catch(() => null));
        nets.push({ raw, n });
      }
      const clients = (await unifi.listClients(c, con.id, site.id, uDeps())).map(unifi.toClient).filter(Boolean);
      // network devices are optional: an older console without the endpoint must not break the import
      const rawDevices = await unifi.listDevices(c, con.id, site.id, uDeps()).catch(() => []);
      out.push({ site, nets, clients, devices: rawDevices.map(unifi.toDevice).filter(Boolean), deviceNames: new Map(rawDevices.filter((d) => d?.id).map((d) => [String(d.id), String(d.name ?? d.model ?? '')])) });
    }
    return { con, sites: out };
  }

  function unifiApply(c, fetched, dry) {
    const who = 'unifi';
    const sum = { console: fetched.con.name, sites: 0, networks: { created: 0, updated: 0, skipped: 0 }, entries: { created: 0, updated: 0, pooled: 0, skipped: 0 }, aliases: { updated: 0, conflicts: 0 }, errors: [] };
    for (const { site, nets, clients: rawClients, devices, deviceNames } of fetched.sites) {
      sum.sites++;
      const siteName = (fetched.sites.length > 1 ? `${fetched.con.name} / ${site.name}` : fetched.con.name).slice(0, 80);
      let ipamSite = one('SELECT * FROM sites WHERE tenant_id=? AND name=?', c.tenant_id, siteName);
      if (!ipamSite && !dry) {
        const r = run('INSERT INTO sites (tenant_id, name, description, icon) VALUES (?,?,?,?)', c.tenant_id, siteName, 'Zaimportowano z UniFi', 'building');
        ipamSite = { id: Number(r.lastInsertRowid) };
        log('create', 'site', `${siteName} (UniFi)`);
      }
      if (ipamSite && !dry) run('UPDATE sites SET unifi_host=?, unifi_site=?, unifi_site_name=? WHERE id=?', fetched.con.id, String(site.internalReference ?? ''), String(site.name ?? ''), ipamSite.id);
      const known = ipamSite ? all('SELECT * FROM networks WHERE site_id=?', ipamSite.id) : [];
      for (const { raw, n } of nets) {
        if (!n) { sum.networks.skipped++; continue; }                          // no gateway-managed IPv4 subnet
        if (parseCidr(n.cidr).prefix < 16) { sum.networks.skipped++; sum.errors.push(`${n.name}: sieć większa niż /16 pominięta`); continue; }
        const have = known.find((k) => k.cidr === n.cidr);
        if (have) {
          const fill = { vlan: have.vlan ?? n.vlan, gateway: have.gateway || n.gateway, dhcp_start: have.dhcp_start || n.dhcp_start, dhcp_end: have.dhcp_end || n.dhcp_end, dns: have.dns || n.dns };
          const changed = Object.keys(fill).some((k) => (fill[k] ?? '') !== (have[k] ?? ''));
          if (changed && !dry) { run('UPDATE networks SET vlan=?, gateway=?, dhcp_start=?, dhcp_end=?, dns=? WHERE id=?', fill.vlan, fill.gateway, fill.dhcp_start, fill.dhcp_end, fill.dns, have.id); Object.assign(have, fill); }
          if (changed) sum.networks.updated++;
        } else {
          sum.networks.created++;
          if (dry) { known.push({ id: null, cidr: n.cidr, dhcp_start: n.dhcp_start, dhcp_end: n.dhcp_end }); continue; }
          const r = run(`INSERT INTO networks (site_id, name, cidr, vlan, gateway, dhcp_start, dhcp_end, dns, description, auto_scan) VALUES (?,?,?,?,?,?,?,?,?,0)`,
            ipamSite.id, n.name, n.cidr, n.vlan, n.gateway, n.dhcp_start, n.dhcp_end, n.dns, 'Zaimportowano z UniFi');
          known.push({ id: Number(r.lastInsertRowid), site_id: ipamSite.id, cidr: n.cidr, dhcp_start: n.dhcp_start, dhcp_end: n.dhcp_end });
          log('create', 'network', `${n.name} (${n.cidr}) z UniFi`);
        }
      }
      // devices first so a gateway/switch/AP is never mistaken for a pool client
      const clients = [...devices.map((d) => ({ ...d, device: true, wifi: false })), ...rawClients.map((cl) => ({ ...cl, uplinkName: deviceNames.get(cl.uplink) ?? '' }))];
      for (const cl of clients) {
        const net = known.find((k) => inCidr(cl.ip, k.cidr));
        if (!net) { sum.entries.skipped++; continue; }
        const mac = normalizeMac(cl.mac) || '';
        const e = net.id ? one('SELECT * FROM entries WHERE network_id=? AND ip=?', net.id, cl.ip) : null;
        if (e) {
          sum.entries.updated++;
          const name = cl.name.slice(0, 100);
          // Three-way alias merge against the name UniFi had at the last sync (unifi_name):
          // only UniFi changed -> take it; only simpleIPAM changed -> keep it; both changed -> simpleIPAM wins.
          const unifiChanged = name !== e.unifi_name;
          const ipamUntouched = e.alias === e.unifi_name || e.alias === '';
          const takes = unifiChanged && ipamUntouched && name !== e.alias;
          if (unifiChanged && !ipamUntouched && name !== e.alias) sum.aliases.conflicts++;
          if (takes) sum.aliases.updated++;
          if (!dry) {
            run("UPDATE entries SET last_seen=datetime('now') WHERE id=?", e.id);
            observeMac(e, mac, who);
            if ((cl.uplinkName ?? '') !== e.uplink && !cl.device) run('UPDATE entries SET uplink=? WHERE id=?', cl.uplinkName ?? '', e.id);
            if (unifiChanged) run('UPDATE entries SET unifi_name=? WHERE id=?', name, e.id);
            if (takes) { run("UPDATE entries SET alias=?, updated_at=datetime('now') WHERE id=?", name, e.id); hist(net.id, e.id, e.ip, 'update', { alias: [e.alias, name] }, who); }
          }
        } else if (!cl.device && inPool(net, cl.ip) && !c.import_dhcp) {
          sum.entries.pooled++;
          if (!dry && net.id) noteNewHost({ id: net.id, name: ipamSite?.name ?? '' }, cl.ip, mac, cl.name.slice(0, 100));
          if (!dry && net.id) run(`INSERT INTO discovered (network_id, ip, mac, name) VALUES (?,?,?,?)
            ON CONFLICT(network_id, ip) DO UPDATE SET last_seen=datetime('now'), name=excluded.name, mac=CASE WHEN excluded.mac!='' THEN excluded.mac ELSE mac END`, net.id, cl.ip, mac, cl.name.slice(0, 100));
        } else {
          sum.entries.created++;
          if (dry || !net.id) continue;
          const alias = cl.name.slice(0, 100);
          const fqdn = unifi.hostnameOf(cl.name);
          const dupFqdn = fqdn && one('SELECT 1 FROM entries e JOIN networks n ON n.id=e.network_id WHERE n.site_id=? AND e.fqdn=?', ipamSite.id, fqdn);
          const entry = { ip: cl.ip, fqdn: dupFqdn ? '' : fqdn, alias, mac, type: cl.type ?? 'other', status: 'used', tags: ['unifi', cl.device ? 'device' : cl.wifi ? 'wifi' : 'lan'].join(','), description: cl.description ?? '' };
          const r = run(`INSERT INTO entries (network_id, ip, ip_num, fqdn, alias, unifi_name, mac, type, status, tags, description, uplink, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
            net.id, entry.ip, ipToInt(entry.ip), entry.fqdn, alias, alias, mac, entry.type, entry.status, entry.tags, entry.description, cl.uplinkName ?? '');
          hist(net.id, Number(r.lastInsertRowid), entry.ip, 'create', snapshot({ ...entry, mac }, 'new'), who);
        }
      }
    }
    return sum;
  }

  async function unifiSync({ dry = false } = {}) {
    const c = unifiCfg();
    if (!c.api_key) throw bad('Najpierw zapisz klucz API');
    if (!c.tenant_id || !one('SELECT id FROM tenants WHERE id=?', c.tenant_id)) throw bad('Wybierz tenanta, do którego trafią zaimportowane lokalizacje');
    const cons = c.consoles.filter((x) => x.enabled);
    if (!cons.length) throw bad('Zaznacz co najmniej jedną konsolę');
    const results = [];
    for (const con of cons) {
      let fetched;
      try { fetched = await unifiFetchConsole(c, con); }
      catch (e) { results.push({ console: con.name, sites: 0, networks: {}, entries: {}, errors: [e.message] }); continue; }
      db.exec('BEGIN');
      try { results.push(unifiApply(c, fetched, dry)); db.exec(dry ? 'ROLLBACK' : 'COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); results.push({ console: con.name, sites: 0, networks: {}, entries: {}, errors: [e.message] }); }
    }
    let pushed = null;
    if (!dry && c.push_aliases && c.write_verified) pushed = await unifiPush().catch((e) => ({ ok: false, pushed: 0, results: [{ site: '', errors: [e.message], planned: [], skipped: [], pushed: 0 }] }));
    const last = { at: new Date().toISOString(), dry, ok: results.every((r) => !r.errors.length) && (pushed?.ok ?? true), results, ...(pushed ? { push: pushed } : {}) };
    if (!dry) saveSetting('unifi_last', last);
    return last;
  }
  route('POST', '/api/admin/unifi/sync', async ({ body, user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    actor = user.username;
    try { const r = await unifiSync({ dry: !!body.dry_run }); if (!r.dry) { actor = user.username; log('update', 'settings', `synchronizacja UniFi: ${r.ok ? 'OK' : 'z błędami'}`); } return r; }
    catch (e) { uFail(e); }
  });
  const runUnifiAuto = async () => {
    const c = unifiCfg();
    if (!c.auto_sync || !c.api_key) return null;
    actor = 'unifi';
    return unifiSync().catch((e) => { console.error('UniFi sync failed:', e.message); return null; });
  };

  // ---------- Azure (VNets and their devices) import ----------
  // One-way: Azure -> simpleIPAM, authenticated as a service principal with the Reader role. Every selected subscription becomes a
  // location, every VNet subnet a network, and network interfaces (VMs, private endpoints) and internal load balancer frontends become entries.
  const AZURE_DEFAULTS = { directory_id: '', client_id: '', client_secret: '', tenant_id: null, subscriptions: [], auto_sync: false };
  const azureCfg = () => {
    let c = {};
    try { c = JSON.parse(one("SELECT value FROM settings WHERE key='azure'")?.value ?? '{}'); } catch { /* unset */ }
    return { ...AZURE_DEFAULTS, ...c };
  };
  const azureLast = () => { try { return JSON.parse(one("SELECT value FROM settings WHERE key='azure_last'")?.value ?? 'null'); } catch { return null; } };
  const azurePublic = (c = azureCfg()) => ({ ...c, client_secret: undefined, secret_set: !!c.client_secret, last: azureLast() });
  const azFail = (e) => { if (e instanceof azure.AzureError) throw bad(e.message); throw e; };
  const azClient = (c) => azure.client(c, { fetch: opts.fetch });
  const azReady = (c) => { if (!c.directory_id || !c.client_id || !c.client_secret) throw bad('Najpierw zapisz dane SPN (tenant, client ID, secret)'); };

  route('GET', '/api/admin/azure', ({ user }) => (needGlobalAdmin(user), azurePublic()));
  route('PUT', '/api/admin/azure', ({ body, user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    const c = azureCfg();
    const guid = (v, what) => {
      const x = str(v, 40);
      if (x && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)) throw bad(`${what} musi być identyfikatorem GUID`);
      return x;
    };
    const dir = guid(body.directory_id, 'Directory (tenant) ID'), cid = guid(body.client_id, 'Client (application) ID');
    if ((dir && dir !== c.directory_id) || (cid && cid !== c.client_id)) c.subscriptions = [];       // another identity: rediscover
    if (dir) c.directory_id = dir;
    if (cid) c.client_id = cid;
    if (str(body.client_secret, 300)) c.client_secret = str(body.client_secret, 300);
    if (body.tenant_id !== undefined) {
      if (body.tenant_id !== null) must(one('SELECT id FROM tenants WHERE id=?', body.tenant_id), 'Tenant');
      c.tenant_id = body.tenant_id === null ? null : Number(body.tenant_id);
    }
    if (body.auto_sync !== undefined) c.auto_sync = !!body.auto_sync;
    if (Array.isArray(body.subscriptions)) {
      const on = new Set(body.subscriptions.filter((x) => x.enabled).map((x) => String(x.id)));
      c.subscriptions = c.subscriptions.map((x) => ({ ...x, enabled: on.has(x.id) }));
    }
    saveSetting('azure', c);
    log('update', 'settings', 'integracja Azure');
    return azurePublic(c);
  });
  // Signs in and lists the subscriptions the service principal can read; doubles as the credentials test.
  route('POST', '/api/admin/azure/discover', async ({ user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    const c = azureCfg(); azReady(c);
    try {
      const subs = await azure.listSubscriptions(azClient(c));
      const was = new Map(c.subscriptions.map((x) => [x.id, x]));
      c.subscriptions = subs.map((s) => ({ id: s.id, name: s.name, enabled: was.get(s.id)?.enabled ?? false }));
      saveSetting('azure', c);
      return azurePublic(c);
    } catch (e) { azFail(e); }
  });
  // Read-only probe per selected subscription: how many of each resource the SPN can see, or why not.
  route('POST', '/api/admin/azure/diagnose', async ({ user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    const c = azureCfg(); azReady(c);
    const subs = c.subscriptions.filter((x) => x.enabled);
    if (!subs.length) throw bad('Zaznacz co najmniej jedną subskrypcję');
    const cl = azClient(c), results = [];
    for (const s of subs) {
      const row = { subscription: s.name };
      for (const [k, fn] of [['vnets', azure.listVnets], ['interfaces', azure.listNics], ['load_balancers', azure.listLoadBalancers]]) {
        try { row[k] = (await fn(cl, s.id)).length; } catch (e) { row[k] = null; (row.errors ??= []).push(`${k}: ${e.message}`); }
      }
      results.push(row);
    }
    return { results };
  });

  async function azureFetchSub(cl, sub) {
    const [vnets, nics, lbs] = await Promise.all([azure.listVnets(cl, sub.id), azure.listNics(cl, sub.id), azure.listLoadBalancers(cl, sub.id).catch(() => [])]);
    return { vnets, items: [...nics.flatMap(azure.toInterfaces), ...lbs.flatMap(azure.toFrontends)] };
  }
  function azureApply(c, sub, f, dry) {
    const who = 'azure';
    const sum = { console: sub.name, sites: 1, networks: { created: 0, updated: 0, skipped: 0 }, entries: { created: 0, updated: 0, pooled: 0, skipped: 0 }, errors: [] };
    const siteName = sub.name.slice(0, 80);
    let site = one('SELECT * FROM sites WHERE tenant_id=? AND azure_sub=?', c.tenant_id, sub.id) ?? one('SELECT * FROM sites WHERE tenant_id=? AND name=?', c.tenant_id, siteName);
    if (!site && !dry) {
      const r = run('INSERT INTO sites (tenant_id, name, description, icon, azure_sub) VALUES (?,?,?,?,?)', c.tenant_id, siteName, 'Zaimportowano z Azure', 'cloud', sub.id);
      site = { id: Number(r.lastInsertRowid) };
      log('create', 'site', `${siteName} (Azure)`);
    } else if (site && !dry) run('UPDATE sites SET azure_sub=? WHERE id=?', sub.id, site.id);
    const known = site ? all('SELECT * FROM networks WHERE site_id=?', site.id) : [];
    const claimed = new Set(), bySubnet = new Map();
    for (const vnet of f.vnets) {
      for (const s of azure.toSubnets(vnet)) {
        const label = `${vnet.name} / ${s.name}`;
        if (parseCidr(s.cidr).prefix < 16) { sum.networks.skipped++; sum.errors.push(`${label}: sieć większa niż /16 pominięta`); continue; }
        if (claimed.has(s.cidr)) { sum.networks.skipped++; sum.errors.push(`${label}: ${s.cidr} już zaimportowano z innego VNetu`); continue; }
        claimed.add(s.cidr);
        const gateway = intToIp(usableRange(s.cidr)[0]);        // Azure: .1 is the default gateway of every subnet
        let net = known.find((k) => k.cidr === s.cidr);
        if (net) {
          if (!net.gateway) {
            if (!dry) run('UPDATE networks SET gateway=? WHERE id=?', gateway, net.id);
            net.gateway = gateway; sum.networks.updated++;
          }
        } else {
          sum.networks.created++;
          if (dry) net = { id: null, cidr: s.cidr, gateway };
          else {
            const r = run(`INSERT INTO networks (site_id, name, cidr, vlan, gateway, dhcp_start, dhcp_end, dns, description, auto_scan) VALUES (?,?,?,?,?,?,?,?,?,0)`,
              site.id, label.slice(0, 80), s.cidr, null, gateway, '', '', '', `Azure VNet ${vnet.name} (${vnet.location ?? ''}), ${azure.resourceGroup(vnet.id)}`);
            net = { id: Number(r.lastInsertRowid), site_id: site.id, cidr: s.cidr, gateway };
            log('create', 'network', `${label} (${s.cidr}) z Azure`);
          }
          known.push(net);
        }
        bySubnet.set(s.id, net);
      }
    }
    for (const it of f.items) {
      const net = bySubnet.get(it.subnetId) ?? known.find((k) => inCidr(it.ip, k.cidr));
      if (!net || it.ip === networkAddr(net.cidr) || it.ip === broadcastAddr(net.cidr)) { sum.entries.skipped++; continue; }
      const mac = normalizeMac(it.mac) || '';
      const e = net.id ? one('SELECT * FROM entries WHERE network_id=? AND ip=?', net.id, it.ip) : null;
      const fqdn = it.primary ? azure.hostnameOf(it.name) : '';
      if (e) {
        const fill = {};
        if (!e.mac && mac) fill.mac = mac;
        if (!e.fqdn && fqdn && !one('SELECT 1 FROM entries x JOIN networks n ON n.id=x.network_id WHERE n.site_id=? AND x.fqdn=?', site.id, fqdn)) fill.fqdn = fqdn;
        if (Object.keys(fill).length) {
          sum.entries.updated++;
          if (!dry) { run(`UPDATE entries SET mac=?, fqdn=?, updated_at=datetime('now') WHERE id=?`, fill.mac ?? e.mac, fill.fqdn ?? e.fqdn, e.id); hist(net.id, e.id, e.ip, 'update', diff(e, { ...e, ...fill }), who); }
        }
        if (!dry && mac) observeMac(e, mac, who);
        continue;
      }
      sum.entries.created++;
      if (dry || !net.id) continue;
      const dup = fqdn && one('SELECT 1 FROM entries x JOIN networks n ON n.id=x.network_id WHERE n.site_id=? AND x.fqdn=?', site.id, fqdn);
      const entry = { ip: it.ip, fqdn: dup ? '' : fqdn, alias: it.name.slice(0, 100), mac, type: it.kind === 'vm' ? 'vm' : 'other', status: 'used', tags: `azure,${it.kind}`, description: `${it.description}${it.method ? ` (${it.method})` : ''}`.slice(0, 500) };
      const r = run(`INSERT INTO entries (network_id, ip, ip_num, fqdn, alias, mac, type, status, tags, description) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        net.id, entry.ip, ipToInt(entry.ip), entry.fqdn, entry.alias, mac, entry.type, entry.status, entry.tags, entry.description);
      hist(net.id, Number(r.lastInsertRowid), entry.ip, 'create', snapshot(entry, 'new'), who);
    }
    return sum;
  }
  async function azureSync({ dry = false } = {}) {
    const c = azureCfg(); azReady(c);
    if (!c.tenant_id || !one('SELECT id FROM tenants WHERE id=?', c.tenant_id)) throw bad('Wybierz tenanta, do którego trafią zaimportowane lokalizacje');
    const subs = c.subscriptions.filter((x) => x.enabled);
    if (!subs.length) throw bad('Zaznacz co najmniej jedną subskrypcję');
    const cl = azClient(c), results = [];
    for (const sub of subs) {
      let fetched;
      try { fetched = await azureFetchSub(cl, sub); }
      catch (e) { results.push({ console: sub.name, sites: 0, networks: {}, entries: {}, errors: [e.message] }); continue; }
      db.exec('BEGIN');
      try { results.push(azureApply(c, sub, fetched, dry)); db.exec(dry ? 'ROLLBACK' : 'COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); results.push({ console: sub.name, sites: 0, networks: {}, entries: {}, errors: [e.message] }); }
    }
    const last = { at: new Date().toISOString(), dry, ok: results.every((r) => !r.errors.length), results };
    if (!dry) saveSetting('azure_last', last);
    return last;
  }
  route('POST', '/api/admin/azure/sync', async ({ body, user, ctx }) => {
    needGlobalAdmin(user); sessionOnly(ctx);
    actor = user.username;
    try { const r = await azureSync({ dry: !!body.dry_run }); if (!r.dry) log('update', 'settings', `synchronizacja Azure: ${r.ok ? 'OK' : 'z błędami'}`); return r; }
    catch (e) { azFail(e); }
  });
  const runAzureAuto = async () => {
    const c = azureCfg();
    if (!c.auto_sync || !c.client_secret) return null;
    actor = 'azure';
    return azureSync().catch((e) => { console.error('Azure sync failed:', e.message); return null; });
  };

  route('GET', '/api/openapi.json', () => buildOpenApi(routes, { version: opts.version }), { public: true });
  route('GET', '/api/docs', () => ({ raw: DOCS_HTML, contentType: 'text/html; charset=utf-8', inline: true }), { public: true });

  return Object.assign(handle, { routes, flushNotify, runUnifiAuto, runAzureAuto, runScheduledScans, runDailyBackup: () => runDailyIfDue(db, bdeps()) });
}
