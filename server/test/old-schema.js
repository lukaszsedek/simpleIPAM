// Schema as shipped before tenants (sites.name globally unique, role_assignments without tenant_id).
export const OLD = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT 'home');
  CREATE TABLE networks (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, name TEXT NOT NULL, cidr TEXT NOT NULL,
    vlan INTEGER, gateway TEXT NOT NULL DEFAULT '', dhcp_start TEXT NOT NULL DEFAULT '', dhcp_end TEXT NOT NULL DEFAULT '', dns TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', UNIQUE (site_id, cidr));
  CREATE TABLE entries (id INTEGER PRIMARY KEY, network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE, ip TEXT NOT NULL, ip_num INTEGER NOT NULL,
    fqdn TEXT NOT NULL DEFAULT '', mac TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'other', status TEXT NOT NULL DEFAULT 'used',
    tags TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (network_id, ip));
  CREATE TABLE audit (id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')), action TEXT NOT NULL, entity TEXT NOT NULL, label TEXT NOT NULL DEFAULT '');
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE role_assignments (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('admin','contributor','reader','none')));
  CREATE UNIQUE INDEX idx_roles_unique ON role_assignments(user_id, COALESCE(site_id, 0));
  INSERT INTO sites (id, name) VALUES (1, 'dom1'), (2, 'lab2');
  INSERT INTO networks (id, site_id, name, cidr) VALUES (1, 1, 'LAN', '192.168.1.0/24');
  INSERT INTO entries (network_id, ip, ip_num, fqdn) VALUES (1, '192.168.1.5', 3232235781, 'nas.lan');
  INSERT INTO users (id, username, password_hash) VALUES (1, 'root', 'x'), (2, 'bob', 'x');
  INSERT INTO role_assignments (user_id, site_id, role) VALUES (1, NULL, 'admin'), (2, 2, 'reader');
`;
