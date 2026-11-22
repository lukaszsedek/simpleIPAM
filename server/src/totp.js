// RFC 6238 time-based one-time passwords (HMAC-SHA1, 30 s, 6 digits) with no dependencies.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(s).toUpperCase().replace(/[\s=]/g, '')) {
    const i = ALPHA.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32(randomBytes(20));

export function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

// Returns the matched time step (accepting ±1 step of clock drift) or null. Callers remember the step to refuse a replay.
export function verify(secret, code, now = Date.now()) {
  const given = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const step = Math.floor(now / 30_000);
  for (const s of [step, step - 1, step + 1]) {
    const want = codeAt(secret, s);
    if (timingSafeEqual(Buffer.from(want), Buffer.from(given))) return s;
  }
  return null;
}

export const uri = (secret, account, issuer = 'simpleIPAM') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
