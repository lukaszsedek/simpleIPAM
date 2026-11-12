// Usage: node src/cli.js reset-admin <username> [new-password]
// Creates the user if missing, sets the password and makes them global Admin.
import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createAuth } from './auth.js';

const [cmd, username, given] = process.argv.slice(2);
if (cmd !== 'reset-admin' || !username) {
  console.error('Usage: node src/cli.js reset-admin <username> [new-password]');
  process.exit(2);
}
const db = openDb(process.env.DB_PATH ?? '/data/ipam.db');
const auth = createAuth(db);
const password = given ?? randomBytes(9).toString('base64url');

let user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (user) auth.setPassword(user.id, password);
else user = { id: auth.register(username, password).id };
auth.dropSessions(user.id);
db.prepare('DELETE FROM role_assignments WHERE user_id = ? AND tenant_id IS NULL AND site_id IS NULL').run(user.id);
db.prepare("INSERT INTO role_assignments (user_id, role) VALUES (?, 'admin')").run(user.id);
console.log(`OK: ${username} is global Admin. ${given ? '' : `Password: ${password}`}`);
