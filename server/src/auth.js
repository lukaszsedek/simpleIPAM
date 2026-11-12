import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { HttpError } from './errors.js';

export const RANK = { none: 0, reader: 1, contributor: 2, admin: 3 };
export const ROLES = Object.keys(RANK);
const SESSION_TTL_S = 30 * 24 * 3600;
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

const sha = (t) => createHash('sha256').update(t).digest('hex');

function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const got = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(got, Buffer.from(hash, 'hex'));
}
const DUMMY_HASH = hashPassword('dummy-password');

export function createAuth(db) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const fails = new Map();

  function validateCredentials(username, password) {
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, 'Login: 3–32 znaków (litery, cyfry, . _ -)');
    if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Hasło musi mieć min. 8 znaków');
    if (password.length > 200) throw new HttpError(400, 'Hasło jest zbyt długie');
  }

  function startSession(userId) {
    const token = randomBytes(32).toString('base64url');
    run('DELETE FROM sessions WHERE expires_at < ?', Math.floor(Date.now() / 1000));
    run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)',
      sha(token), userId, Math.floor(Date.now() / 1000) + SESSION_TTL_S);
    return token;
  }

  // The very first account becomes global Admin so a fresh install is never locked out.
  function register(username, password) {
    username = String(username ?? '').trim();
    validateCredentials(username, password);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (one('SELECT id FROM users WHERE username = ?', username)) throw new HttpError(409, 'Ten login jest zajęty');
      const first = one('SELECT COUNT(*) AS n FROM users').n === 0;
      if (!first && one("SELECT value FROM settings WHERE key='registration_open'")?.value === '0') {
        throw new HttpError(403, 'Rejestracja jest wyłączona. Poproś administratora o konto.');
      }
      const id = Number(run('INSERT INTO users (username, password_hash) VALUES (?,?)', username, hashPassword(password)).lastInsertRowid);
      if (first) run("INSERT INTO role_assignments (user_id, role) VALUES (?, 'admin')", id);
      db.exec('COMMIT');
      return { id, username, first };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  function login(username, password, ip) {
    username = String(username ?? '').trim();
    const key = `${ip}|${username.toLowerCase()}`;
    const f = fails.get(key);
    if (f && f.n >= MAX_FAILS && f.until > Date.now()) throw new HttpError(429, 'Zbyt wiele prób logowania. Spróbuj za minutę.');
    const u = one('SELECT * FROM users WHERE username = ?', username);
    const ok = verifyPassword(String(password ?? ''), u ? u.password_hash : DUMMY_HASH) && u;
    if (!ok) {
      fails.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + LOCK_MS });
      throw new HttpError(401, 'Nieprawidłowy login lub hasło');
    }
    fails.delete(key);
    return { user: u, token: startSession(u.id) };
  }

  const sessionUser = (token) => token ? one(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`, sha(token), Math.floor(Date.now() / 1000)) ?? null : null;
  const logout = (token) => token && run('DELETE FROM sessions WHERE token_hash = ?', sha(token));

  function setPassword(userId, password) {
    validateCredentials('valid.name', password);
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), userId);
  }
  const checkPassword = (userId, password) => verifyPassword(String(password ?? ''), one('SELECT password_hash FROM users WHERE id=?', userId).password_hash);
  // Personal API tokens: shown once at creation, stored as sha256. They carry the owner's roles.
  function createToken(userId, name) {
    name = String(name ?? '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Nazwa tokenu jest wymagana');
    const token = `ipam_${randomBytes(24).toString('base64url')}`;
    const id = Number(run('INSERT INTO api_tokens (user_id, name, token_hash) VALUES (?,?,?)', userId, name, sha(token)).lastInsertRowid);
    return { id, name, token };
  }
  const listTokens = (userId) => all('SELECT id, name, created_at, last_used FROM api_tokens WHERE user_id=? ORDER BY id DESC', userId);
  const deleteToken = (userId, id) => run('DELETE FROM api_tokens WHERE id=? AND user_id=?', id, userId).changes > 0;
  function tokenUser(token) {
    if (!token) return null;
    const row = one(`SELECT u.id, u.username, t.id AS token_id FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`, sha(token));
    if (row) run("UPDATE api_tokens SET last_used = datetime('now') WHERE id = ?", row.token_id);
    return row ? { id: row.id, username: row.username } : null;
  }
  const dropSessions = (userId) => run('DELETE FROM sessions WHERE user_id = ?', userId);

  // { global: role, tenants: { [tenantId]: role }, sites: { [siteId]: role } }
  function rolesOf(userId) {
    const out = { global: 'none', tenants: {}, sites: {} };
    for (const r of all('SELECT tenant_id, site_id, role FROM role_assignments WHERE user_id = ?', userId)) {
      if (r.site_id !== null) out.sites[r.site_id] = r.role;
      else if (r.tenant_id !== null) out.tenants[r.tenant_id] = r.role;
      else out.global = r.role;
    }
    return out;
  }
  // Most specific assignment wins (that is what makes a site-level "none" a deny).
  const effective = (roles, siteId, tenantId) => roles.sites[siteId] ?? roles.tenants[tenantId] ?? roles.global;
  const effectiveTenant = (roles, tenantId) => roles.tenants[tenantId] ?? roles.global;

  const globalAdminCount = () => one("SELECT COUNT(*) AS n FROM role_assignments WHERE site_id IS NULL AND tenant_id IS NULL AND role='admin'").n;

  return { register, login, logout, sessionUser, setPassword, checkPassword, dropSessions, rolesOf, effective, effectiveTenant, globalAdminCount, createToken, listTokens, deleteToken, tokenUser };
}
