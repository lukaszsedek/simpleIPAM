// Client-side CIDR maths for the planner's calculator and VLSM helper (IPv4 on numbers, IPv6 on BigInt via ip6.js).
import { parse6, fmt6, parseCidr6 } from './ip6.js';

export const ip4 = (s) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s).trim());
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return null;
  return m.slice(1).reduce((a, o) => a * 256 + Number(o), 0);
};
export const str4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const maskOf = (p) => (p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
const bin = (n) => [24, 16, 8, 0].map((s) => ((n >>> s) & 255).toString(2).padStart(8, '0')).join('.');

// "10.1.2.3/24", "10.1.2.3 255.255.255.0" or "10.1.2.3 0.0.0.255" (wildcard) -> parsed block or null
export function parse4(input) {
  const t = String(input).trim();
  let ip, prefix;
  let m = /^(\S+?)\s*\/\s*(\d{1,2})$/.exec(t);
  if (m) { ip = ip4(m[1]); prefix = Number(m[2]); } else if ((m = /^(\S+)\s+(\S+)$/.exec(t))) {
    ip = ip4(m[1]);
    const mk = ip4(m[2]);
    if (mk === null) return null;
    const bits = mk.toString(2).padStart(32, '0');
    if (/^1*0*$/.test(bits)) prefix = bits.split('1').length - 1;                       // netmask 255.255.255.0
    else if (/^0*1*$/.test(bits)) prefix = 32 - (bits.split('1').length - 1);          // wildcard 0.0.0.255
    else return null;
  } else if (ip4(t) !== null) { ip = ip4(t); prefix = 32; }
  if (ip == null || prefix == null || prefix < 0 || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const base = Math.floor(ip / size) * size;
  return { ip, prefix, size, base, last: base + size - 1 };
}

export function calc4(input) {
  const b = parse4(input);
  if (!b) return null;
  const mask = maskOf(b.prefix);
  const hosts = b.prefix >= 31 ? b.size : b.size - 2;
  const [first, last] = b.prefix >= 31 ? [b.base, b.last] : [b.base + 1, b.last - 1];
  const ipn = b.ip;
  const priv = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]].some(([a, p]) => ipn >= ip4(a) && ipn <= ip4(a) + 2 ** (32 - p) - 1);
  return {
    family: 4, cidr: `${str4(b.base)}/${b.prefix}`, network: str4(b.base), broadcast: b.prefix >= 31 ? '—' : str4(b.last), mask: str4(mask), wildcard: str4((~mask) >>> 0),
    prefix: b.prefix, first: str4(first), last: str4(last), hosts, total: b.size, maskBin: bin(mask), ipBin: bin(b.ip), private: priv, base: b.base, size: b.size,
  };
}

export function calc6(input) {
  const t = String(input).trim();
  const m = /^([0-9a-fA-F:]+)(?:\/(\d{1,3}))?$/.exec(t);
  if (!m) return null;
  const c = parseCidr6(`${m[1]}/${m[2] ?? 128}`);
  if (!c) return null;
  const hex = c.base.toString(16).padStart(32, '0').match(/.{4}/g).join(':');
  return {
    family: 6, cidr: `${fmt6(c.base)}/${c.prefix}`, network: fmt6(c.base), expanded: hex, prefix: c.prefix, first: fmt6(c.first), last: fmt6(c.last),
    total: c.size, subnets64: c.prefix <= 64 ? c.size >> 64n : 0n, base: c.base, size: c.size,
  };
}
export const bigFmt = (n) => (n < 10n ** 15n ? Number(n).toLocaleString() : `2^${n.toString(2).length - 1}`);

// Split a block into /newPrefix blocks (at most `cap` are listed; `count` is the real number).
export function split4(cidr, newPrefix, cap = 256) {
  const b = parse4(cidr);
  if (!b || newPrefix <= b.prefix || newPrefix > 32) return null;
  const size = 2 ** (32 - newPrefix), count = b.size / size;
  const list = [];
  for (let i = 0; i < Math.min(count, cap); i++) list.push(`${str4(b.base + i * size)}/${newPrefix}`);
  return { list, count, size };
}
export function split6(cidr, newPrefix, cap = 64) {
  const c = parseCidr6(cidr);
  if (!c || newPrefix <= c.prefix || newPrefix > 128) return null;
  const size = 1n << BigInt(128 - newPrefix), count = c.size / size;
  const list = [];
  for (let i = 0n; i < count && i < BigInt(cap); i++) list.push(`${fmt6(c.base + i * size)}/${newPrefix}`);
  return { list, count, size };
}

// Aggregate any list of IPv4 CIDRs/addresses into the smallest set of covering blocks.
export function summarize4(lines) {
  const ranges = [];
  const bad = [];
  for (const l of lines.map((x) => x.trim()).filter(Boolean)) {
    const b = parse4(l);
    if (b) ranges.push([b.base, b.last]); else bad.push(l);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  const out = [];
  for (let [from, to] of merged) {
    while (from <= to) {
      let size = from === 0 ? 2 ** 32 : Math.min(from & -from, 2 ** 32);
      while (from + size - 1 > to) size /= 2;
      out.push(`${str4(from)}/${32 - Math.log2(size)}`);
      from += size;
    }
  }
  return { blocks: out, bad };
}

export const prefixForHosts = (hosts) => (hosts >= 1 && hosts <= 65534 ? 32 - Math.ceil(Math.log2(hosts + 2)) : null);
export const usableOf = (prefix) => (prefix >= 31 ? 2 ** (32 - prefix) : 2 ** (32 - prefix) - 2);
export { parse6 };
