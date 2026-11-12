import { ipToInt, intToIp, parseCidr, normalizeCidr, inCidr, usableRange, normalizeMac } from './ip.js';
import { execFile } from 'node:child_process';

import { HttpError } from './errors.js';
import { createAuth, RANK, ROLES } from './auth.js';
import { snapshotBuffer, backupName, listLocal, isBackupName, loadConfig, saveConfig, publicConfig, runBackup, runDailyIfDue, lastBackup, testRemote } from './backup.js';
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
    const gateway = ipField('gateway', 'Brama');
    const dhcp_start = ipField('dhcp_start', 'Początek DHCP');
    const dhcp_end = ipField('dhcp_end', 'Koniec DHCP');
    if (!!dhcp_start !== !!dhcp_end) throw bad('Podaj oba końce zakresu DHCP');
    if (dhcp_start && ipToInt(dhcp_start) > ipToInt(dhcp_end)) throw bad('Początek DHCP jest większy niż koniec');
    return { name, cidr, vlan, gateway, dhcp_start, dhcp_end, dns: str(b.dns, 200), description: str(b.description), auto_scan: b.auto_scan ? 1 : 0 };
  }

  function netStats(n) {
    const c = parseCidr(n.cidr);
    const [lo, hi] = usableRange(n.cidr);
    const total = hi - lo + 1;
    const dhcp = n.dhcp_start ? ipToInt(n.dhcp_end) - ipToInt(n.dhcp_start) + 1 : 0;
    const row = one(`SELECT COUNT(*) AS used,
        SUM(status='reserved') AS reserved FROM entries WHERE network_id=? AND status!='free'`, n.id);
    const fresh = one('SELECT COUNT(*) AS n FROM discovered WHERE network_id=? AND dismissed=0', n.id).n;
    return { total, dhcp, used: row.used, reserved: row.reserved ?? 0, prefix: c.prefix, new_hosts: fresh };
  }

  // ---------- entries ----------
  function entryInput(b, net, existingId = null) {
    const ip = str(b.ip, 15);
    const n = ipToInt(ip);
    if (n === null || !inCidr(ip, net.cidr)) throw bad(`Adres IP musi należeć do ${net.cidr}`);
    const mac = normalizeMac(b.mac);
    if (mac === null) throw bad('Nieprawidłowy adres MAC');
    const fqdn = str(b.fqdn, 253).toLowerCase();
    if (fqdn && !/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(fqdn)) throw bad('Nieprawidłowy FQDN');
    const type = TYPES.includes(b.type) ? b.type : 'other';
    const status = STATUSES.includes(b.status) ? b.status : 'used';
    const tags = str(b.tags, 200).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).join(',');
    const dup = one('SELECT id FROM entries WHERE network_id=? AND ip=?', net.id, ip);
    if (dup && dup.id !== existingId) throw new HttpError(409, `Adres ${ip} jest już wpisany w tej sieci`);
    return { ip, ip_num: n, fqdn, mac, type, status, tags, description: str(b.description) };
  }

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
    const known = new Set(all('SELECT ip_num FROM entries WHERE network_id=?', net.id).map((r) => r.ip_num));
    for (const i of alive) {
      const ip = intToIp(i);
      if (known.has(i)) run("UPDATE entries SET last_seen=datetime('now') WHERE network_id=? AND ip=?", net.id, ip);
      else run(`INSERT INTO discovered (network_id, ip) VALUES (?,?)
        ON CONFLICT(network_id, ip) DO UPDATE SET last_seen=datetime('now')`, net.id, ip);
    }
    return alive.map((i) => ({ ip: intToIp(i), known: known.has(i) }));
  }

  // ---------- csv ----------
  const CSV_COLS = ['ip', 'fqdn', 'mac', 'type', 'status', 'tags', 'description'];
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
    routes.push({ method, re, keys, handler, public: !!opts.public });
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
    return { ...n, site, tenant, role: roleAt(user, n.site_id), stats: netStats(n), entries: all('SELECT * FROM entries WHERE network_id=? ORDER BY ip_num', n.id) };
  });
  route('GET', '/api/networks/:id/next-free', ({ params, query, user }) => {
    const n = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, n.site_id, 'reader');
    return { ip: nextFree(n, query.from ? ipToInt(query.from) : null) };
  });
  route('POST', '/api/networks/:id/scan', async ({ params, user }) => {
    const n = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, n.site_id, 'contributor');
    return { alive: await scan(n) };
  });

  route('POST', '/api/networks/:id/entries', ({ params, body, user }) => unique(() => {
    const net = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, net.site_id, 'contributor');
    const e = entryInput(body, net);
    const r = run(`INSERT INTO entries (network_id, ip, ip_num, fqdn, mac, type, status, tags, description)
      VALUES (?,?,?,?,?,?,?,?,?)`, net.id, e.ip, e.ip_num, e.fqdn, e.mac, e.type, e.status, e.tags, e.description);
    run('DELETE FROM discovered WHERE network_id=? AND ip=?', net.id, e.ip);
    log('create', 'entry', `${e.ip} ${e.fqdn}`.trim());
    return { id: Number(r.lastInsertRowid), network_id: net.id, ...e };
  }));
  route('PUT', '/api/entries/:id', ({ params, body, user }) => unique(() => {
    const old = must(one('SELECT * FROM entries WHERE id=?', params.id), 'Wpis');
    const net = one('SELECT * FROM networks WHERE id=?', old.network_id);
    need(user, net.site_id, 'contributor');
    const e = entryInput(body, net, old.id);
    run(`UPDATE entries SET ip=?, ip_num=?, fqdn=?, mac=?, type=?, status=?, tags=?, description=?,
      updated_at=datetime('now') WHERE id=?`, e.ip, e.ip_num, e.fqdn, e.mac, e.type, e.status, e.tags, e.description, old.id);
    log('update', 'entry', `${e.ip} ${e.fqdn}`.trim());
    return { id: old.id, network_id: old.network_id, ...e };
  }));
  route('DELETE', '/api/entries/:id', ({ params, user }) => {
    const e = must(one('SELECT * FROM entries WHERE id=?', params.id), 'Wpis');
    need(user, one('SELECT site_id FROM networks WHERE id=?', e.network_id).site_id, 'contributor');
    run('DELETE FROM entries WHERE id=?', params.id);
    log('delete', 'entry', `${e.ip} ${e.fqdn}`.trim());
    return { ok: true };
  });

  route('GET', '/api/search', ({ query, user }) => {
    const q = str(query.q, 100).toLowerCase();
    const sites = visibleSiteIds(user);
    if (!q || !sites.length) return [];
    const like = `%${q.replace(/[%_]/g, '')}%`;
    return all(`SELECT e.*, n.name AS network_name, n.cidr, n.vlan, s.name AS site_name, s.id AS site_id, (SELECT name FROM tenants WHERE id=s.tenant_id) AS tenant_name
      FROM entries e JOIN networks n ON n.id=e.network_id JOIN sites s ON s.id=n.site_id
      WHERE s.id IN (${sites.join(',')})
        AND (e.ip LIKE ? OR e.fqdn LIKE ? OR e.mac LIKE ? OR e.tags LIKE ? OR e.description LIKE ?)
      ORDER BY s.name, e.ip_num LIMIT 50`, like, like, like, like, like);
  });

  route('GET', '/api/audit', ({ user }) => (needGlobalAdmin(user), all('SELECT * FROM audit ORDER BY id DESC LIMIT 200')));

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
          const existing = one('SELECT id FROM entries WHERE network_id=? AND ip=?', net.id, str(obj.ip, 15));
          const e = entryInput(obj, net, existing?.id);
          if (existing) {
            run(`UPDATE entries SET fqdn=?, mac=?, type=?, status=?, tags=?, description=?, updated_at=datetime('now') WHERE id=?`,
              e.fqdn, e.mac, e.type, e.status, e.tags, e.description, existing.id);
            updated++;
          } else {
            run(`INSERT INTO entries (network_id, ip, ip_num, fqdn, mac, type, status, tags, description) VALUES (?,?,?,?,?,?,?,?,?)`,
              net.id, e.ip, e.ip_num, e.fqdn, e.mac, e.type, e.status, e.tags, e.description);
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
    return all('SELECT * FROM discovered WHERE network_id=? AND dismissed=0 ORDER BY id', net.id)
      .sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
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
      try { for (const r of rows) run('DELETE FROM entries WHERE id=?', r.id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
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

  // ---------- consistency checks ----------
  route('GET', '/api/networks/:id/issues', ({ params, user }) => {
    const net = must(one('SELECT * FROM networks WHERE id=?', params.id), 'Sieć');
    need(user, net.site_id, 'reader');
    const issues = [];
    const entries = all('SELECT * FROM entries WHERE network_id=? ORDER BY ip_num', net.id);
    const group = (rows, key) => {
      const m = new Map();
      for (const r of rows) if (r[key]) m.set(r[key], [...(m.get(r[key]) ?? []), r]);
      return [...m].filter(([, v]) => v.length > 1);
    };
    for (const [mac, rows] of group(entries, 'mac')) {
      issues.push({ level: 'error', text: `Duplikat MAC ${mac}: ${rows.map((r) => r.ip).join(', ')}` });
    }
    const siteEntries = all(`SELECT e.* FROM entries e JOIN networks n ON n.id=e.network_id WHERE n.site_id=? AND e.status!='free'`, net.site_id);
    for (const [fqdn, rows] of group(siteEntries, 'fqdn')) {
      if (rows.some((r) => r.network_id === net.id)) issues.push({ level: 'warn', text: `FQDN ${fqdn} występuje ${rows.length}× w lokalizacji: ${rows.map((r) => r.ip).join(', ')}` });
    }
    if (net.dhcp_start) {
      const [a, b] = [ipToInt(net.dhcp_start), ipToInt(net.dhcp_end)];
      for (const e of entries) if (e.ip_num >= a && e.ip_num <= b && e.status !== 'free') {
        issues.push({ level: 'info', text: `${e.ip} (${e.fqdn || 'bez nazwy'}) leży w puli DHCP — rozważ rezerwację DHCP lub zawężenie puli` });
      }
    }
    const me = parseCidr(net.cidr);
    for (const o of all('SELECT * FROM networks WHERE site_id=? AND id!=?', net.site_id, net.id)) {
      const c = parseCidr(o.cidr);
      if (me.first <= c.last && c.first <= me.last) issues.push({ level: 'error', text: `Nakłada się z siecią „${o.name}” (${o.cidr}) w tej samej lokalizacji` });
    }
    return issues;
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
    return { user: me, setup_required: count('users') === 0, registration_open: registrationOpen(), version: opts.version ?? 'dev' };
  }, { public: true });
  route('GET', '/api/health', () => ({ ok: true }), { public: true });
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

  route('POST', '/api/admin/restore/inspect', ({ body, user, ctx }) => {
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
    } else {
      copyFileSync(localFile(String(body.name ?? '')), path);
      label = body.name;
    }
    try {
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
    if (!auth.checkPassword(user.id, body.current)) throw new HttpError(403, 'Aktualne hasło jest nieprawidłowe');
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

  return Object.assign(handle, { runScheduledScans, runDailyBackup: () => runDailyIfDue(db, bdeps()) });
}
