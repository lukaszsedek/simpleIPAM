export function ipToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip).trim());
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

export function intToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// Returns { base, prefix, first, last, size } or null. first/last cover the whole block.
export function parseCidr(cidr) {
  const m = /^(.+)\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m) return null;
  const ip = ipToInt(m[1]);
  const prefix = Number(m[2]);
  if (ip === null || prefix < 8 || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const base = Math.floor(ip / size) * size;
  return { base, prefix, first: base, last: base + size - 1, size };
}

export function normalizeCidr(cidr) {
  const c = parseCidr(cidr);
  return c ? `${intToIp(c.base)}/${c.prefix}` : null;
}

export function inCidr(ip, cidr) {
  const n = ipToInt(ip);
  const c = parseCidr(cidr);
  return n !== null && c !== null && n >= c.first && n <= c.last;
}

// Number of addresses usable for hosts (excludes network/broadcast for /30 and larger).
export function usableRange(cidr) {
  const c = parseCidr(cidr);
  if (c.prefix >= 31) return [c.first, c.last];
  return [c.first + 1, c.last - 1];
}

export function normalizeMac(mac) {
  if (!mac) return '';
  const hex = String(mac).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return null;
  return hex.match(/../g).join(':');
}
