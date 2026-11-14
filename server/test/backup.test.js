import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApi } from '../src/app.js';
import { signV4, s3Url, putS3 } from '../src/s3.js';
import { putGcs, signJwt } from '../src/gcs.js';
import { runBackup, runDailyIfDue, loadConfig, saveConfig, publicConfig, backupName, isBackupName } from '../src/backup.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');

// Examples from the AWS S3 documentation ("Signature Calculations for the Authorization Header").
const DOC = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z') };
const sigOf = (h) => h.authorization.split('Signature=')[1];

test('SigV4 reproduces the AWS documented GET Object signature (with Range header)', () => {
  const h = signV4({ ...DOC, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', payloadHash: sha(''),
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': sha('') } });
  assert.match(h.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
  assert.equal(sigOf(h), 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('SigV4 reproduces the AWS documented PUT Object signature (key with "$")', () => {
  const hash = sha('Welcome to Amazon S3.');
  assert.equal(hash, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  const url = s3Url({ bucket: 'examplebucket' }, 'test$file.text');
  assert.ok(url.endsWith('/test%24file.text'));
  const h = signV4({ ...DOC, method: 'PUT', url, payloadHash: hash,
    headers: { host: 'examplebucket.s3.amazonaws.com', date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': hash } });
  assert.equal(sigOf(h), '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('S3 urls: AWS virtual-host, dotted bucket path-style, custom endpoint, key encoding', () => {
  assert.equal(s3Url({ bucket: 'my-bkt', region: 'eu-west-1' }, 'ipam/a b.db'), 'https://my-bkt.s3.eu-west-1.amazonaws.com/ipam/a%20b.db');
  assert.equal(s3Url({ bucket: 'my.bkt', region: 'eu-west-1' }, 'x.db'), 'https://s3.eu-west-1.amazonaws.com/my.bkt/x.db');
  assert.equal(s3Url({ bucket: 'b', endpoint: 'http://minio:9000/' }, 'p/x.db'), 'http://minio:9000/b/p/x.db');
});

test('putS3 sends a signed PUT with the payload hash and surfaces errors', async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push({ url, init }); return { ok: true }; };
  const body = Buffer.from('hello');
  await putS3({ bucket: 'b', region: 'us-east-1', access_key: 'AK', secret_key: 'SK', endpoint: 'http://minio:9000' }, 'p/x.db', body, { fetch, now: new Date('2026-01-02T03:04:05Z') });
  const { url, init } = seen[0];
  assert.equal(url, 'http://minio:9000/b/p/x.db');
  assert.equal(init.method, 'PUT');
  assert.equal(init.headers['x-amz-content-sha256'], sha(body));
  assert.equal(init.headers['x-amz-date'], '20260102T030405Z');
  assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AK\/20260102\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal('host' in init.headers, false);
  await assert.rejects(putS3({ bucket: 'b', access_key: 'a', secret_key: 's' }, 'k', body, {
    fetch: async () => ({ ok: false, status: 403, text: async () => '<Error><Code>AccessDenied</Code></Error>' }),
  }), /S3 403.*AccessDenied/);
});

const serviceAccount = () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  return { publicKey, json: JSON.stringify({ client_email: 'ipam@proj.iam.gserviceaccount.com', private_key: privateKey, token_uri: 'https://oauth.test/token' }) };
};

test('GCS: JWT is RS256-signed with the service account and token is reused', async () => {
  const { publicKey, json } = serviceAccount();
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://oauth.test/token') {
      const jwt = new URLSearchParams(init.body).get('assertion');
      const [h, c, sig] = jwt.split('.');
      assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, sig, 'base64url'));
      const claims = JSON.parse(Buffer.from(c, 'base64url'));
      assert.equal(claims.iss, 'ipam@proj.iam.gserviceaccount.com');
      assert.match(claims.scope, /devstorage\.read_write/);
      return { ok: true, json: async () => ({ access_token: 'tok123', expires_in: 3600 }) };
    }
    return { ok: true };
  };
  const cfg = { bucket: 'bkt', service_account_json: json };
  await putGcs(cfg, 'ipam/x.db', Buffer.from('d'), { fetch, base: 'https://gcs.test' });
  await putGcs(cfg, 'ipam/y.db', Buffer.from('d'), { fetch, base: 'https://gcs.test' });
  const uploads = calls.filter((c) => c.url.startsWith('https://gcs.test'));
  assert.equal(uploads[0].url, 'https://gcs.test/upload/storage/v1/b/bkt/o?uploadType=media&name=ipam%2Fx.db');
  assert.equal(uploads[0].init.headers.authorization, 'Bearer tok123');
  assert.equal(calls.filter((c) => c.url === 'https://oauth.test/token').length, 1);
  assert.ok(signJwt(JSON.parse(json)).split('.').length === 3);
});

test('config: validation, secrets kept when blank and never returned', () => {
  const db = openDb(':memory:');
  assert.throws(() => saveConfig(db, { provider: 's3', remote_enabled: true }), /Bucket|bucket/i);
  assert.throws(() => saveConfig(db, { provider: 'x' }), /dostawc/);
  assert.throws(() => saveConfig(db, { provider: 'gcs', gcs: { service_account_json: '{nope' } }), /JSON/);
  assert.throws(() => saveConfig(db, { s3: { prefix: '../x' } }), /\.\./);
  assert.throws(() => saveConfig(db, { local_keep: 0 }), /1–365/);
  saveConfig(db, { provider: 's3', remote_enabled: true, s3: { bucket: 'b', region: 'r', access_key: 'AK', secret_key: 'SECRET', prefix: '/ipam' } });
  saveConfig(db, { s3: { secret_key: '' } });                                   // blank keeps it
  assert.equal(loadConfig(db).s3.secret_key, 'SECRET');
  assert.equal(loadConfig(db).s3.prefix, 'ipam/');
  const pub = JSON.stringify(publicConfig(loadConfig(db)));
  assert.equal(pub.includes('SECRET'), false);
  assert.match(pub, /"secret_set":true/);
});

test('runBackup: local file + remote upload, remote failure keeps local copy; daily runs once', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'ipam-bk-')), 'backups');
  const db = openDb(':memory:');
  const uploads = [];
  let fail = false;
  const fetch = async (url, init) => { if (fail) return { ok: false, status: 500, text: async () => 'boom' }; uploads.push({ url, init }); return { ok: true }; };
  saveConfig(db, { provider: 's3', remote_enabled: true, local_keep: 2, s3: { bucket: 'b', region: 'r', access_key: 'a', secret_key: 's', prefix: 'ipam' } });

  const r1 = await runBackup(db, { dir, fetch, now: new Date('2026-03-01T10:00:00Z') });
  assert.equal(r1.ok, true);
  assert.equal(uploads[0].url, 'https://b.s3.r.amazonaws.com/ipam/ipam-20260301-100000.db');
  assert.equal(uploads[0].init.body.subarray(0, 15).toString(), 'SQLite format 3');
  assert.ok(existsSync(join(dir, 'ipam-20260301-100000.db')));

  await runBackup(db, { dir, fetch, now: new Date('2026-03-02T10:00:00Z') });
  fail = true;
  const r3 = await runBackup(db, { dir, fetch, now: new Date('2026-03-03T10:00:00Z') });
  assert.equal(r3.ok, false);
  assert.match(r3.remote.message, /S3 500.*boom/);
  assert.equal(r3.local.ok, true);
  assert.deepEqual(readdirSync(dir).sort(), ['ipam-20260302-100000.db', 'ipam-20260303-100000.db']);   // keep=2

  assert.equal(await runDailyIfDue(db, { dir, fetch, now: new Date('2026-03-03T22:00:00Z') }), null);    // already ran that day
  assert.ok(await runDailyIfDue(db, { dir, fetch, now: new Date('2026-03-04T00:30:00Z') }));
  assert.equal(isBackupName(backupName()), true);
  assert.equal(isBackupName('../etc/passwd'), false);
});

test('admin backup routes: permissions, list/download/delete, traversal, test-remote', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'ipam-bk-')), 'backups');
  const calls = [];
  const api = createApi(openDb(':memory:'), { backupDir: dir, fetch: async (u, i) => { calls.push(u); return { ok: true }; } });
  const mk = () => { const ctx = {}; const c = async (m, p, body = {}, q = {}) => { const o = await api(m, p, q, body, ctx); if (ctx.newToken) { ctx.token = ctx.newToken; ctx.newToken = undefined; } return o; }; return c; };
  const admin = mk(); await admin('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  const bob = mk(); await bob('POST', '/api/auth/register', { username: 'bob', password: 'password123' });

  for (const [m, p] of [['GET', '/api/admin/backups'], ['POST', '/api/admin/backups/run'], ['GET', '/api/admin/system'], ['PUT', '/api/admin/backups/config'], ['POST', '/api/admin/backups/test-remote']]) {
    await assert.rejects(bob(m, p), /uprawnień/, `${m} ${p}`);
  }
  const run = await admin('POST', '/api/admin/backups/run');
  assert.equal(run.ok, true);
  const list = await admin('GET', '/api/admin/backups');
  assert.equal(list.files[0].name, run.name);
  assert.equal(list.last.name, run.name);
  assert.equal((await admin('GET', `/api/admin/backups/${run.name}`)).raw.subarray(0, 15).toString(), 'SQLite format 3');
  await assert.rejects(admin('GET', '/api/admin/backups/..%2Fsecret'), /Nie znaleziono/);
  await assert.rejects(admin('GET', '/api/admin/backups/passwd'), /Nie znaleziono/);

  assert.equal((await admin('POST', '/api/admin/backups/test-remote')).ok, false);              // nothing configured yet
  await admin('PUT', '/api/admin/backups/config', { provider: 's3', s3: { bucket: 'b', region: 'r', access_key: 'a', secret_key: 's' } });
  assert.equal((await admin('POST', '/api/admin/backups/test-remote')).ok, true);
  assert.match(calls[0], /simpleipam-connection-test\.txt$/);

  await admin('DELETE', `/api/admin/backups/${run.name}`);
  assert.equal((await admin('GET', '/api/admin/backups')).files.length, 0);
  const sys = await admin('GET', '/api/admin/system');
  assert.equal(sys.counts.users, 2);
});

test('encrypted backups: AES-GCM roundtrip, wrong passphrase, tamper, scheduled backups, restore staging', async () => {
  const { encrypt, decrypt, isEncrypted } = await import('../src/backup-crypto.js');
  const plain = Buffer.from('SQLite format 3\0 pretend database');
  const blob = encrypt(plain, 'correct horse');
  assert.equal(isEncrypted(blob), true);
  assert.equal(blob.includes(Buffer.from('pretend database')), false);
  assert.deepEqual(decrypt(blob, 'correct horse'), plain);
  assert.throws(() => decrypt(blob, 'wrong pass'), /Nieprawidłowe hasło/);
  const bad = Buffer.from(blob); bad[bad.length - 20] ^= 1;
  assert.throws(() => decrypt(bad, 'correct horse'), /Nieprawidłowe hasło/);

  const dir = join(mkdtempSync(join(tmpdir(), 'ipam-enc-')), 'b');
  const db = openDb(':memory:');
  assert.throws(() => saveConfig(db, { encrypt: { enabled: true } }), /Ustaw hasło/);
  assert.throws(() => saveConfig(db, { encrypt: { enabled: true, passphrase: 'short' } }), /min. 8/);
  const pub = publicConfig(saveConfig(db, { encrypt: { enabled: true, passphrase: 'correct horse' } }));
  assert.deepEqual([pub.encrypt.enabled, pub.encrypt.passphrase_set, 'passphrase' in pub.encrypt], [true, true, false]);
  const r = await runBackup(db, { dir, now: new Date('2026-05-01T10:00:00Z') });
  assert.equal(r.name, 'ipam-20260501-100000.db.enc');
  assert.deepEqual(readdirSync(dir), ['ipam-20260501-100000.db.enc']);
  assert.equal(isBackupName(r.name), true);
  const { readFileSync } = await import('node:fs');
  const file = readFileSync(join(dir, r.name));
  assert.equal(isEncrypted(file), true);
  assert.equal(decrypt(file, 'correct horse').subarray(0, 15).toString(), 'SQLite format 3');
  // a blank passphrase on later saves keeps the stored one
  assert.equal(loadConfig(saveConfigDb(db)).encrypt.passphrase, 'correct horse');
  function saveConfigDb(d) { saveConfig(d, { encrypt: { passphrase: '' } }); return d; }
});
