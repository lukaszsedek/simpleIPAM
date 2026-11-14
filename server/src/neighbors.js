// MAC addresses of hosts on the local L2 segment, read from the OS neighbour (ARP) table right after a ping sweep.
// Only works where the app shares the segment with the hosts (Docker needs network_mode: host or macvlan).
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { normalizeMac } from './ip.js';

// Linux /proc/net/arp: "IP address  HW type  Flags  HW address  Mask  Device"; flags 0x0 = incomplete entry.
export function parseProcArp(text) {
  const out = new Map();
  for (const line of text.split('\n').slice(1)) {
    const [ip, , flags, mac] = line.trim().split(/\s+/);
    if (ip && mac && flags !== '0x0') { const m = normalizeMac(mac); if (m && m !== '00:00:00:00:00:00') out.set(ip, m); }
  }
  return out;
}

// macOS/BSD `arp -an`: "? (192.168.1.1) at a:b:c:d:e:f on en0 ifscope [ethernet]" (macOS prints octets without zero padding).
export function parseArpAn(text) {
  const out = new Map();
  for (const m of text.matchAll(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/gi)) {
    const mac = normalizeMac(m[2].split(':').map((o) => o.padStart(2, '0')).join(':'));
    if (mac && mac !== 'ff:ff:ff:ff:ff:ff') out.set(m[1], mac);
  }
  return out;
}

export async function readNeighbors() {
  try { return parseProcArp(readFileSync('/proc/net/arp', 'utf8')); } catch { /* not Linux */ }
  return new Promise((resolve) => execFile('arp', ['-an'], { timeout: 5000 }, (err, stdout) => resolve(err ? new Map() : parseArpAn(stdout))));
}
