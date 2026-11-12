// Minimal AWS Signature V4 + S3 PutObject. Works with AWS and S3-compatible stores (MinIO, R2, Backblaze…).
import { createHmac, createHash } from 'node:crypto';

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
// RFC 3986 encoding as required by SigV4 (encodeURIComponent leaves !'()* alone).
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// `headers` are the headers to sign (must include host). Returns them plus x-amz-date and authorization.
export function signV4({ method, url, headers, payloadHash, accessKey, secretKey, region, service = 's3', now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const all = Object.fromEntries(Object.entries({ ...headers, 'x-amz-date': amzDate }).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const names = Object.keys(all).sort();
  const query = [...u.searchParams].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, u.pathname, query, names.map((n) => `${n}:${all[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

export function s3Url(cfg, key) {
  const path = key.split('/').map(enc).join('/');
  if (cfg.endpoint) {
    const e = new URL(cfg.endpoint);
    return `${e.origin}${e.pathname.replace(/\/$/, '')}/${enc(cfg.bucket)}/${path}`;    // path-style: works everywhere
  }
  const region = cfg.region || 'us-east-1';
  return cfg.bucket.includes('.')
    ? `https://s3.${region}.amazonaws.com/${enc(cfg.bucket)}/${path}`                    // dotted names break the TLS wildcard
    : `https://${cfg.bucket}.s3.${region}.amazonaws.com/${path}`;
}

export async function putS3(cfg, key, body, { fetch = globalThis.fetch, now } = {}) {
  const url = s3Url(cfg, key);
  const payloadHash = sha256hex(body);
  const signed = signV4({
    method: 'PUT', url, region: cfg.region || 'us-east-1', accessKey: cfg.access_key, secretKey: cfg.secret_key, payloadHash, now,
    headers: { host: new URL(url).host, 'x-amz-content-sha256': payloadHash, 'content-type': 'application/octet-stream' },
  });
  delete signed.host;                                   // fetch sets Host itself
  const res = await fetch(url, { method: 'PUT', headers: signed, body, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`S3 ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
}
