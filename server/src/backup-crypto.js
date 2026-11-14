// Optional passphrase encryption of backup files (AES-256-GCM, key from scrypt).
// Layout: "SIPAMENC1\n" | salt(16) | iv(12) | ciphertext | tag(16)
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { HttpError } from './errors.js';

const MAGIC = Buffer.from('SIPAMENC1\n');
const key = (pass, salt) => scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export const isEncrypted = (buf) => buf.length > MAGIC.length + 44 && buf.subarray(0, MAGIC.length).equals(MAGIC);

export function encrypt(plain, pass) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(pass, salt), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, body, c.getAuthTag()]);
}

export function decrypt(buf, pass) {
  const o = MAGIC.length;
  const salt = buf.subarray(o, o + 16), iv = buf.subarray(o + 16, o + 28), tag = buf.subarray(buf.length - 16);
  try {
    const d = createDecipheriv('aes-256-gcm', key(pass, salt), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(buf.subarray(o + 28, buf.length - 16)), d.final()]);
  } catch { throw new HttpError(400, 'Nieprawidłowe hasło szyfrowania lub uszkodzony plik'); }
}
