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

// Network and broadcast addresses of a block; /31 and /32 have neither (RFC 3021).
export function networkAddr(cidr) {
  const c = parseCidr(cidr);
  return c && c.prefix <= 30 ? intToIp(c.first) : null;
}
export function broadcastAddr(cidr) {
  const c = parseCidr(cidr);
  return c && c.prefix <= 30 ? intToIp(c.last) : null;
}

// Merges [first, last] intervals that overlap or touch.
export function mergeRanges(ranges) {
  const out = [];
  for (const r of [...ranges].sort((a, b) => a.first - b.first)) {
    const last = out[out.length - 1];
    if (last && r.first <= last.last + 1) last.last = Math.max(last.last, r.last);
    else out.push({ first: r.first, last: r.last });
  }
  return out;
}

// Free space inside `pool` ({first,last}) given the occupied ranges, as the biggest aligned CIDR blocks that fit.
export function freeBlocks(pool, used) {
  const out = [];
  let cur = pool.first;
  const emit = (from, to) => {
    while (from <= to) {
      let size = from === 0 ? 2 ** 32 : Math.min(from & -from, 2 ** 32);
      while (from + size - 1 > to) size /= 2;
      out.push({ cidr: `${intToIp(from)}/${32 - Math.log2(size)}`, size, first: from });
      from += size;
    }
  };
  for (const r of mergeRanges(used.filter((u) => u.last >= pool.first && u.first <= pool.last))) {
    if (r.first > cur) emit(cur, r.first - 1);
    cur = Math.max(cur, r.last + 1);
  }
  if (cur <= pool.last) emit(cur, pool.last);
  return out;
}

// First aligned block of the requested prefix length that is completely free inside the pool, or null.
export function findFree(pool, used, prefix) {
  const size = 2 ** (32 - prefix);
  const merged = mergeRanges(used.filter((u) => u.last >= pool.first && u.first <= pool.last));
  let b = Math.ceil(pool.first / size) * size;
  while (b + size - 1 <= pool.last) {
    const hit = merged.find((r) => r.first <= b + size - 1 && b <= r.last);
    if (!hit) return `${intToIp(b)}/${prefix}`;
    b = Math.floor(hit.last / size) * size + size;   // jump past the occupied range, staying aligned
  }
  return null;
}
