// "Sign in with Google" (OpenID Connect, authorization-code flow + PKCE). Identity only: no Drive access.
// The id_token comes straight from Google's token endpoint over TLS, so its claims are trusted after the aud/iss/exp checks.
import { authUrl, newPkce, postForm, TOKEN_URL, GoogleError } from './gdrive.js';

const SCOPE = 'openid email profile';
export { newPkce };
export const loginUrl = (a) => authUrl({ ...a, scope: SCOPE, offline: false });

export async function exchangeIdentity(cfg, { code, redirectUri, verifier }, { fetch = globalThis.fetch, now = new Date() } = {}) {
  const r = await postForm(fetch, TOKEN_URL, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
    client_id: cfg.client_id, client_secret: cfg.client_secret,
  });
  if (!r.ok) throw new GoogleError(String(r.data.error_description || r.data.error || `Google ${r.status}`).slice(0, 200));
  let c;
  try { c = JSON.parse(Buffer.from(String(r.data.id_token).split('.')[1], 'base64url')); } catch { throw new GoogleError('Nieprawidłowa odpowiedź Google'); }
  if (c.aud !== cfg.client_id || !/^(https:\/\/)?accounts\.google\.com$/.test(c.iss) || c.exp * 1000 < now.getTime()) throw new GoogleError('Nieprawidłowy token Google');
  if (!c.sub) throw new GoogleError('Brak identyfikatora konta Google');
  if (c.email && c.email_verified === false) throw new GoogleError('Adres e-mail konta Google nie jest zweryfikowany');
  return { subject: String(c.sub), email: c.email ?? '', name: c.name ?? '' };
}
