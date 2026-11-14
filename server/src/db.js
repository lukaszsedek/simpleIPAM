import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

// Databases created before tenants existed have no sites.tenant_id / role_assignments.tenant_id.
// Existing sites move into a "Domyślny" tenant and every role assignment is kept. A snapshot is
// written next to the file first, since SQLite cannot add a NOT NULL FK column in place.
function migrateToTenants(db, path) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('sites').length || cols('sites').includes('tenant_id')) return;

  if (path !== ':memory:') db.exec(`VACUUM INTO '${`${path}.pre-tenants.bak`.replace(/'/g, "''")}'`);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL DEFAULT '')`);
    if (db.prepare('SELECT COUNT(*) AS n FROM sites').get().n > 0) {
      db.exec("INSERT INTO tenants (name, description) VALUES ('Domyślny', 'Utworzony podczas aktualizacji')");
    }
    db.exec(`
      CREATE TABLE sites_new (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT 'home',
        UNIQUE (tenant_id, name)
      );
      INSERT INTO sites_new (id, tenant_id, name, description, icon)
        SELECT id, (SELECT id FROM tenants ORDER BY id LIMIT 1), name, description, icon FROM sites;
      DROP TABLE sites;
      ALTER TABLE sites_new RENAME TO sites;
    `);
    if (cols('role_assignments').length && !cols('role_assignments').includes('tenant_id')) {
      db.exec(`
        CREATE TABLE role_assignments_new (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
          site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('admin','contributor','reader','none')),
          CHECK (tenant_id IS NULL OR site_id IS NULL)
        );
        INSERT INTO role_assignments_new (id, user_id, site_id, role) SELECT id, user_id, site_id, role FROM role_assignments;
        DROP TABLE role_assignments;
        ALTER TABLE role_assignments_new RENAME TO role_assignments;
      `);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function openRaw(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  migrateToTenants(db, path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT 'home',
      UNIQUE (tenant_id, name)
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS networks (
      id INTEGER PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cidr TEXT NOT NULL,
      vlan INTEGER,
      gateway TEXT NOT NULL DEFAULT '',
      dhcp_start TEXT NOT NULL DEFAULT '',
      dhcp_end TEXT NOT NULL DEFAULT '',
      dns TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      UNIQUE (site_id, cidr)
    );
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY,
      network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
      ip TEXT NOT NULL,
      ip_num INTEGER NOT NULL,
      fqdn TEXT NOT NULL DEFAULT '',
      mac TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'other',
      status TEXT NOT NULL DEFAULT 'used',
      tags TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (network_id, ip)
    );
    CREATE INDEX IF NOT EXISTS idx_entries_net ON entries(network_id, ip_num);
    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used TEXT
    );
    -- Hosts found alive by a scan that have no entry yet.
    CREATE TABLE IF NOT EXISTS discovered (
      id INTEGER PRIMARY KEY,
      network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
      ip TEXT NOT NULL,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      dismissed INTEGER NOT NULL DEFAULT 0,
      UNIQUE (network_id, ip)
    );
    -- Per-entry change log: changes is JSON { field: [old, new] }; rows outlive the entry (entry_id is not a FK).
    CREATE TABLE IF NOT EXISTS entry_history (
      id INTEGER PRIMARY KEY,
      network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
      entry_id INTEGER,
      ip TEXT NOT NULL,
      action TEXT NOT NULL,
      changes TEXT NOT NULL DEFAULT '{}',
      actor TEXT NOT NULL DEFAULT '',
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hist_entry ON entry_history(entry_id);
    CREATE INDEX IF NOT EXISTS idx_hist_net ON entry_history(network_id, id);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Sign-in with an external identity provider (Google): (provider, subject) is stable, e-mail may change.
    CREATE TABLE IF NOT EXISTS user_identities (
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (provider, subject)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    -- Scope is global (tenant_id and site_id NULL), tenant (tenant_id set) or site (site_id set).
    -- The most specific assignment wins: site > tenant > global.
    CREATE TABLE IF NOT EXISTS role_assignments (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin','contributor','reader','none')),
      CHECK (tenant_id IS NULL OR site_id IS NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_unique ON role_assignments(user_id, COALESCE(tenant_id, 0), COALESCE(site_id, 0));
  `);
  const addColumn = (table, col, ddl) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  };
  addColumn('entries', 'last_seen', 'TEXT');
  addColumn('sites', 'unifi_host', "TEXT NOT NULL DEFAULT ''");   // UniFi console / Integration-API site this site was imported from
  addColumn('sites', 'unifi_site', "TEXT NOT NULL DEFAULT ''");
  addColumn('sites', 'unifi_site_name', "TEXT NOT NULL DEFAULT ''");
  addColumn('entries', 'uplink', "TEXT NOT NULL DEFAULT ''");       // where UniFi says the client is attached (AP / switch name)
  addColumn('entries', 'alias', "TEXT NOT NULL DEFAULT ''");        // friendly device name (mirrors the UniFi client alias)
  addColumn('entries', 'unifi_name', "TEXT NOT NULL DEFAULT ''");    // alias as last seen in UniFi: the base for detecting who changed it
  addColumn('entries', 'seen_mac', "TEXT NOT NULL DEFAULT ''");   // MAC last observed by a scan
  addColumn('entries', 'mac_ack', "TEXT NOT NULL DEFAULT ''");     // observed MAC the user chose to ignore
  addColumn('discovered', 'name', "TEXT NOT NULL DEFAULT ''");   // device name reported by an integration (UniFi)
  addColumn('discovered', 'mac', "TEXT NOT NULL DEFAULT ''");
  addColumn('users', 'has_password', 'INTEGER NOT NULL DEFAULT 1');   // 0 = created through Google, password never chosen
  addColumn('networks', 'auto_scan', 'INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(audit)').all().some((c) => c.name === 'actor')) {
    db.exec("ALTER TABLE audit ADD COLUMN actor TEXT NOT NULL DEFAULT ''");
  }
  return db;
}

// Thin handle around DatabaseSync so the underlying file can be swapped (restore) without
// restarting the process: everything else keeps using `db.prepare` / `db.exec`.
class Database {
  constructor(path) {
    this.path = path;
    this.inner = openRaw(path);
  }
  prepare(sql) { return this.inner.prepare(sql); }
  exec(sql) { return this.inner.exec(sql); }
  close() { this.inner.close(); }

  // Replaces the database file with `stagedPath` (same filesystem, already validated/migrated) and reopens it.
  // The previous file is only deleted once the new one opens; on failure it is put back.
  swapFile(stagedPath) {
    if (this.path === ':memory:') throw new Error('in-memory database cannot be replaced');
    this.inner.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.inner.close();
    const aside = `${this.path}.replaced`;
    try {
      renameSync(this.path, aside);
      for (const ext of ['-wal', '-shm']) rmSync(this.path + ext, { force: true });
      renameSync(stagedPath, this.path);
      this.inner = openRaw(this.path);
    } catch (e) {
      rmSync(this.path, { force: true });
      try { renameSync(aside, this.path); } catch { /* nothing left to restore */ }
      this.inner = openRaw(this.path);
      throw e;
    }
    rmSync(aside, { force: true });
  }
}

export function openDb(path) {
  return new Database(path);
}
