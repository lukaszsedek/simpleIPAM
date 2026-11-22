import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';

import { OLD } from './old-schema.js';

test('pre-tenant database is migrated in place, keeping data and roles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ipam-mig-'));
  const file = join(dir, 'ipam.db');
  const old = new DatabaseSync(file);
  old.exec(OLD);
  old.close();

  const db = openDb(file);
  assert.ok(existsSync(`${file}.pre-tenants.bak`));
  const tenants = db.prepare('SELECT * FROM tenants').all();
  assert.deepEqual(tenants.map((t) => t.name), ['Domyślny']);
  assert.deepEqual(db.prepare('SELECT id, name, tenant_id FROM sites ORDER BY id').all().map((s) => [s.id, s.name, s.tenant_id]), [[1, 'dom1', tenants[0].id], [2, 'lab2', tenants[0].id]]);
  assert.equal(db.prepare('SELECT fqdn FROM entries').get().fqdn, 'nas.lan');       // network/entry data survives
  assert.deepEqual(db.prepare('SELECT user_id, tenant_id, site_id, role FROM role_assignments ORDER BY id').all().map((r) => ({ ...r })),
    [{ user_id: 1, tenant_id: null, site_id: null, role: 'admin' }, { user_id: 2, tenant_id: null, site_id: 2, role: 'reader' }]);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // new columns from later features are added too
  assert.ok(db.prepare('PRAGMA table_info(entries)').all().some((c) => c.name === 'last_seen'));
  db.close();

  const again = openDb(file);                                                          // idempotent
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM tenants').get().n, 1);
});

test('empty pre-tenant database gets no default tenant', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ipam-mig-'));
  const file = join(dir, 'ipam.db');
  const old = new DatabaseSync(file);
  old.exec(OLD.split('INSERT INTO sites')[0]);
  old.close();
  assert.equal(openDb(file).prepare('SELECT COUNT(*) AS n FROM tenants').get().n, 0);
});

test('pools without a site are handed to the site that holds most of their networks (else the first site)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ipam-mig-')), 'ipam.db');
  const db = openDb(file);
  const t = Number(db.prepare("INSERT INTO tenants (name) VALUES ('T')").run().lastInsertRowid);
  const s1 = Number(db.prepare("INSERT INTO sites (tenant_id, name) VALUES (?, 'a')").run(t).lastInsertRowid);
  const s2 = Number(db.prepare("INSERT INTO sites (tenant_id, name) VALUES (?, 'b')").run(t).lastInsertRowid);
  db.prepare("INSERT INTO networks (site_id, name, cidr, vlan) VALUES (?, 'n', '10.1.0.0/24', 10)").run(s2);
  db.prepare("INSERT INTO pools (tenant_id, cidr) VALUES (?, '10.0.0.0/8')").run(t);
  db.prepare("INSERT INTO pools (tenant_id, cidr) VALUES (?, '172.16.0.0/12')").run(t);
  db.close();
  const again = openDb(file);
  assert.deepEqual(again.prepare('SELECT cidr, site_id FROM pools ORDER BY id').all().map((p) => [p.cidr, p.site_id]), [['10.0.0.0/8', s2], ['172.16.0.0/12', s1]]);
  again.close();
});
