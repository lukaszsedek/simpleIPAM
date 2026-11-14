import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApi } from '../src/app.js';

const idToken = (c) => `h.${Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'cid', exp: Math.floor(Date.now() / 1000) + 600, ...c })).toString('base64url')}.s`;
function setup(claims = {}) {
  let current = { sub: '111', email: 'jan.kowalski@gmail.com', email_verified: true, ...claims };
  const fetch = async (url, init) => {
    assert.match(String(url), /oauth2\.googleapis\.com\/token/);
    assert.ok(init.body.get('code_verifier'));
    return { ok: true, status: 200, json: async () => ({ id_token: idToken(current) }) };
  };
  const api = createApi(openDb(':memory:'), { fetch });
  const browser = () => { const ctx = {}; return async (m, p, body = {}, q = {}) => { const o = await api(m, p, q, body, ctx); if (ctx.newToken) { ctx.token = ctx.newToken; ctx.newToken = undefined; } return o; }; };
  return { browser, claims: (c) => { current = { ...current, ...c }; } };
}
const google = async (b, extra = {}) => {
  const { url } = await b('POST', '/api/auth/google/start', { origin: 'http://localhost:8080', ...extra });
  const q = new URL(url).searchParams;
  assert.equal(q.get('scope'), 'openid email profile');          // identity only, never Drive
  assert.equal(q.get('access_type'), null);
  return (code = 'c', state = q.get('state')) => b('GET', '/api/auth/google/callback', {}, { code, state });
};

test('Google sign-in: disabled by default, admin configures, new users get no role', async () => {
  const { browser } = setup();
  const admin = browser();
  await assert.rejects(admin('POST', '/api/auth/google/start', { origin: 'http://localhost:8080' }), /wyłączone/);
  assert.equal((await admin('GET', '/api/me')).google_login, false);
  await admin('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  await assert.rejects(admin('PUT', '/api/admin/google-login', { enabled: true }), /Client ID/);
  const pub = await admin('PUT', '/api/admin/google-login', { client_id: 'cid', client_secret: 'sec', enabled: true });
  assert.deepEqual([pub.ready, pub.secret_set, 'client_secret' in pub], [true, true, false]);

  const jan = browser();
  assert.equal((await jan('GET', '/api/me')).google_login, true);
  const cb = await google(jan);
  assert.equal((await cb()).redirect, '/?google=new#/');
  const me = (await jan('GET', '/api/me')).user;
  assert.equal(me.username, 'jan.kowalski');
  assert.equal(me.global_role, 'none');
  assert.equal(me.google_email, 'jan.kowalski@gmail.com');
  assert.equal((await admin("GET", "/api/me")).user.pending_users, 1);

  // same identity logs into the same account; forged/reused state is refused
  const again = browser();
  const cb2 = await google(again);
  assert.equal((await cb2()).redirect, '/?google=ok#/');
  assert.equal((await again('GET', '/api/me')).user.username, 'jan.kowalski');
  assert.equal((await cb2()).redirect, '/?google=state#/');
  assert.equal((await (await google(browser()))('c', 'forged')).redirect, '/?google=state#/');
});

test('Google sign-in respects closed registration, unverified e-mail and first-run setup', async () => {
  const { browser, claims } = setup();
  const admin = browser();
  // nobody exists yet: the administrator must be created locally
  await admin('PUT', '/api/admin/google-login', {}).catch(() => {});
  await admin('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  await admin('PUT', '/api/admin/google-login', { client_id: 'cid', client_secret: 'sec', enabled: true });
  await admin('PUT', '/api/settings', { registration_open: false });
  assert.match((await (await google(browser()))()).redirect, /msg%3ARejestracja/);
  await admin('PUT', '/api/settings', { registration_open: true });
  claims({ email_verified: false });
  assert.match((await (await google(browser()))()).redirect, /google=error/);
  claims({ email_verified: true, aud: 'someone-else' });
  assert.match((await (await google(browser()))()).redirect, /google=error/);
});

test('linking Google to an existing account; identity cannot be shared', async () => {
  const { browser, claims } = setup();
  const admin = browser();
  await admin('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  await admin('PUT', '/api/admin/google-login', { client_id: 'cid', client_secret: 'sec', enabled: true });
  await assert.rejects(browser()('POST', '/api/auth/google/start', { origin: 'http://localhost:8080', link: true }), /Wymagane logowanie/);
  assert.equal((await (await google(admin, { link: true }))()).redirect, '/?google=linked#/');
  assert.equal((await admin('GET', '/api/me')).user.google_email, 'jan.kowalski@gmail.com');
  const viaGoogle = browser();
  await (await google(viaGoogle))();
  assert.equal((await viaGoogle('GET', '/api/me')).user.username, 'admin');   // lands in the linked admin account
  // another user cannot claim the same Google account
  const bob = browser(); await bob('POST', '/api/auth/register', { username: 'bob', password: 'password123' });
  assert.match((await (await google(bob, { link: true }))()).redirect, /msg%3A/);
});

test('unlinking Google: refused while the account has no password, allowed after one is set', async () => {
  const { browser } = setup();
  const admin = browser();
  await admin('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  await admin('PUT', '/api/admin/google-login', { client_id: 'cid', client_secret: 'sec', enabled: true });
  const jan = browser();
  await (await google(jan))();
  assert.equal((await jan('GET', '/api/me')).user.has_password, false);
  await assert.rejects(jan('POST', '/api/me/google/unlink'), /ustaw hasło/);
  await jan('POST', '/api/me/password', { password: 'brand-new-pass' });      // no current password needed the first time
  assert.equal((await jan('GET', '/api/me')).user.has_password, true);
  await jan('POST', '/api/me/google/unlink');
  assert.equal((await jan('GET', '/api/me')).user.google_email, null);
  await assert.rejects(jan('POST', '/api/me/password', { current: 'wrong-one', password: 'another-pass1' }), /nieprawidłowe/);
  // the identity is free again: signing in with Google now creates a fresh account
  const again = browser();
  await (await google(again))();
  assert.equal((await again('GET', '/api/me')).user.username, 'jan.kowalski2');
});
