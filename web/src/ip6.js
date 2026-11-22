// IPv6 helpers on BigInt. Only used for planning (pools and prefixes); address bookkeeping stays IPv4.
// Keep web/src/ip6.js identical: the browser calculator uses the same file.
export function parse6(str) {
  let s = String(str).trim().toLowerCase();
  if (!/^[0-9a-f:]+$/.test(s) || (s.match(/::/g) ?? []).length > 1 || s.includes(':::')) return null;
  let head = s, tail = '';
  if (s.includes('::')) [head, tail] = s.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  if (fill < (s.includes('::') ? 1 : 0)) return null;
  const parts = [...h, ...Array(fill).fill('0'), ...t];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.reduce((a, p) => (a << 16n) | BigInt(parseInt(p, 16)), 0n);
}

export function fmt6(n) {
  const g = Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(16 * (7 - i))) & 0xffffn));
  let best = [-1, 0];
  for (let i = 0; i < 8;) {          // longest run of zero groups (>= 2) gets "::"
    if (g[i] !== 0) { i++; continue; }
    let j = i; while (j < 8 && g[j] === 0) j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best[1] < 2) return hex.join(':');
  return `${hex.slice(0, best[0]).join(':')}::${hex.slice(best[0] + best[1]).join(':')}`;
}

export const isV6 = (cidr) => String(cidr).includes(':');

// { base, prefix, first, last, size } (BigInt) or null. Prefixes /16–/128 are accepted.
export function parseCidr6(cidr) {
  const m = /^([0-9a-fA-F:]+)\/(\d{1,3})$/.exec(String(cidr).trim());
  if (!m) return null;
  const ip = parse6(m[1]);
  const prefix = Number(m[2]);
  if (ip === null || prefix < 16 || prefix > 128) return null;
  const size = 1n << BigInt(128 - prefix);
  const base = (ip / size) * size;
  return { base, prefix, first: base, last: base + size - 1n, size };
}
export const normalizeCidr6 = (cidr) => { const c = parseCidr6(cidr); return c ? `${fmt6(c.base)}/${c.prefix}` : null; };

// First free aligned block of `prefix` bits inside pool `pc` that overlaps none of `used` (parsed cidrs).
export function findFree6(pc, used, prefix) {
  const size = 1n << BigInt(128 - prefix);
  const sorted = [...used].filter((u) => u.first <= pc.last && pc.first <= u.last).sort((a, b) => (a.first < b.first ? -1 : 1));
  let b = (pc.first / size) * size;
  if (b < pc.first) b += size;
  for (let guard = 0; b + size - 1n <= pc.last && guard < 100_000; guard++) {
    const hit = sorted.find((u) => b <= u.last && u.first <= b + size - 1n);
    if (!hit) return `${fmt6(b)}/${prefix}`;
    b = ((hit.last + 1n + size - 1n) / size) * size;
  }
  return null;
}
