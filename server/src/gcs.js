// Google Cloud Storage upload using a service-account key (JWT bearer flow), no SDK.
import { createSign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const tokens = new Map();   // client_email -> { token, exp }

export function parseServiceAccount(json) {
  let sa;
  try { sa = JSON.parse(json); } catch { throw new Error('Klucz konta usługi nie jest poprawnym JSON-em'); }
  if (!sa.client_email || !sa.private_key) throw new Error('W kluczu brakuje client_email lub private_key');
  try { createSign('RSA-SHA256').update('x').sign(sa.private_key); } catch { throw new Error('private_key jest nieprawidłowy'); }
  return sa;
}

export function signJwt(sa, now = new Date()) {
  const iat = Math.floor(now.getTime() / 1000);
  const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(sa.private_key).toString('base64url')}`;
}

async function accessToken(sa, fetch, now) {
  const cached = tokens.get(sa.client_email);
  if (cached && cached.exp > now.getTime() + 60_000) return cached.token;
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(sa, now) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GCS token ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
  const j = await res.json();
  tokens.set(sa.client_email, { token: j.access_token, exp: now.getTime() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

export async function putGcs(cfg, key, body, { fetch = globalThis.fetch, now = new Date(), base = 'https://storage.googleapis.com' } = {}) {
  const sa = parseServiceAccount(cfg.service_account_json);
  const token = await accessToken(sa, fetch, now);
  const url = `${base}/upload/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`GCS ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
}
