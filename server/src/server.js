import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApi, HttpError } from './app.js';
import { dirname } from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? '/data/ipam.db';
const STATIC_DIR = process.env.STATIC_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const db = openDb(DB_PATH);
// Local backup folder (empty value disables local copies). Cloud upload is configured in the admin panel.
const BACKUP_DIR = process.env.BACKUP_DIR ?? join(dirname(DB_PATH), 'backups');
// APP_VERSION / APP_COMMIT are baked in by the Docker build; plain `npm start` falls back to package.json.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const VERSION = process.env.APP_VERSION && process.env.APP_VERSION !== 'dev' ? process.env.APP_VERSION : `${pkg.version}-dev`;
const COMMIT = process.env.APP_COMMIT ?? 'unknown';
const api = createApi(db, { backupDir: DB_PATH === ':memory:' ? '' : BACKUP_DIR, version: VERSION, commit: COMMIT });

// Networks with auto-scan enabled are pinged every SCAN_INTERVAL_MIN minutes (0 disables). Needs LAN reachability from the container.
const SCAN_MIN = Number(process.env.SCAN_INTERVAL_MIN ?? 15);
if (SCAN_MIN > 0) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await api.runScheduledScans(); } finally { busy = false; }
  }, SCAN_MIN * 60_000).unref();
}

// One automatic backup per day (local + the cloud destination, if enabled in the admin panel); checked hourly.
{
  const tick = () => api.runDailyBackup().catch((e) => console.error('backup failed', e));
  setTimeout(tick, 5000).unref();
  setInterval(tick, 3600_000).unref();
}

const parseCookies = (h = '') =>
  Object.fromEntries(h.split(';').map((c) => c.trim().split(/=(.*)/s)).filter((p) => p[0]).map((p) => [p[0], p[1] ?? '']));

function sessionCookie(req, token) {
  const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
  const base = `sid=${token ?? ''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? 30 * 24 * 3600 : 0}`;
  return secure ? `${base}; Secure` : base;
}

// Raw uploads (database files for restore) bypass the JSON body limit but are capped separately.
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB ?? 512) * 1024 * 1024;
const RAW_PATHS = new Set(['/api/admin/restore/inspect']);
async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_UPLOAD) throw new HttpError(413, `Plik jest zbyt duży (limit ${MAX_UPLOAD / 1048576} MB)`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw new HttpError(413, 'Zbyt duże żądanie');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Nieprawidłowy JSON'); }
}

async function serveStatic(res, pathname) {
  let file = join(STATIC_DIR, normalize(pathname));
  if (!file.startsWith(STATIC_DIR)) file = join(STATIC_DIR, 'index.html');
  try { if (!(await stat(file)).isFile()) throw 0; } catch { file = join(STATIC_DIR, 'index.html'); }
  try {
    const data = await readFile(file);
    const ext = extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

console.log(`simpleIPAM ${VERSION} (${COMMIT.slice(0, 7)})`);

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const hasBody = req.method !== 'GET' && req.method !== 'DELETE';
      const type = String(req.headers['content-type']);
      const raw = hasBody && RAW_PATHS.has(url.pathname) && type.startsWith('application/octet-stream');
      if (hasBody && !raw && !type.startsWith('application/json')) throw new HttpError(415, 'Wymagany Content-Type: application/json');
      const body = raw ? { file: await readRaw(req) } : hasBody ? await readBody(req) : {};
      const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const ctx = { token: parseCookies(req.headers.cookie).sid, bearer, ip: req.socket.remoteAddress };
      const out = await api(req.method, url.pathname, Object.fromEntries(url.searchParams), body, ctx);
      const headers = {};
      if (ctx.newToken || ctx.clearToken) headers['set-cookie'] = sessionCookie(req, ctx.newToken);
      if (out?.raw !== undefined) {
        res.writeHead(200, { ...headers, 'content-type': out.contentType, 'content-disposition': `attachment; filename="${out.filename}"` });
        res.end(out.raw);
      } else {
        res.writeHead(200, { ...headers, 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      }
    } else {
      await serveStatic(res, url.pathname);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: status === 500 ? 'Błąd serwera' : e.message }));
  }
}).listen(PORT, () => console.log(`simpleIPAM listening on :${PORT} (db: ${DB_PATH})`));
