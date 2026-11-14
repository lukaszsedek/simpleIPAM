// UniFi through Ubiquiti's Site Manager (api.ui.com): one API key from unifi.ui.com reaches every console on the account.
//   GET  /v1/hosts                                              -> consoles (Cloud Gateway, UDM…)
//   GET  /v1/connector/consoles/{id}/proxy/network/integration/v1/...  -> that console's Network Integration API
// Docs: developer.ui.com (connector needs console firmware >= 5.0.3, 100 requests/min per console).
// Read-only. Parsing is deliberately tolerant: field names that Ubiquiti has not pinned down in the public spec
// are searched for rather than assumed.
import { normalizeCidr, inCidr, ipToInt } from './ip.js';

const BASE = 'https://api.ui.com';
export class UnifiError extends Error {}
const short = (s) => String(s).replace(/\s+/g, ' ').slice(0, 200);

async function get(cfg, path, { fetch = globalThis.fetch } = {}) {
  let res;
  try { res = await fetch(`${BASE}${path}`, { headers: { 'x-api-key': cfg.api_key, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }); }
  catch (e) { throw new UnifiError(`Brak połączenia z api.ui.com: ${short(e.message)}`); }
  if (res.status === 401 || res.status === 403) throw new UnifiError('Klucz API odrzucony (401/403). Klucz musi pochodzić z unifi.ui.com i należeć do właściciela konsoli');
  if (res.status === 429) throw new UnifiError('Limit zapytań Ubiquiti (100/min na konsolę) — spróbuj za chwilę');
  if (res.status === 404) throw new UnifiError('Nie znaleziono (404) — konsola offline albo firmware starszy niż 5.0.3?');
  if (!res.ok) throw new UnifiError(`Ubiquiti ${res.status}: ${short(await res.text().catch(() => ''))}`);
  return res.json();
}

const rows = (j) => (Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : []);

// Walks every page of a paginated Integration API list.
async function listAll(cfg, path, deps) {
  const out = [];
  for (let offset = 0; offset < 5000;) {
    const j = await get(cfg, `${path}${path.includes('?') ? '&' : '?'}limit=200&offset=${offset}`, deps);
    const page = rows(j);
    out.push(...page);
    offset += page.length;
    if (!page.length || offset >= (j.totalCount ?? offset)) break;
  }
  return out;
}

export async function listHosts(cfg, deps) {
  const hosts = [];
  for (let token = '', i = 0; i < 20; i++) {
    const j = await get(cfg, `/v1/hosts?pageSize=100${token ? `&nextToken=${encodeURIComponent(token)}` : ''}`, deps);
    hosts.push(...rows(j));
    token = j.nextToken;
    if (!token) break;
  }
  return hosts.filter((h) => h?.id).map((h) => ({
    id: h.id,
    name: h.reportedState?.name || h.reportedState?.hostname || h.userData?.name || h.hostname || h.id.slice(0, 8),
    ip: h.ipAddress ?? h.reportedState?.ip ?? '',
    type: h.type ?? '',
  }));
}

const proxy = (host, p) => `/v1/connector/consoles/${encodeURIComponent(host)}/proxy/network/integration/v1${p}`;
export const listSites = async (cfg, host, deps) => (await listAll(cfg, proxy(host, '/sites'), deps)).filter((s) => s?.id);
export const listClients = (cfg, host, site, deps) => listAll(cfg, proxy(host, `/sites/${site}/clients`), deps);
export const listNetworks = (cfg, host, site, deps) => listAll(cfg, proxy(host, `/sites/${site}/networks`), deps);
export const networkDetails = (cfg, host, site, id, deps) => get(cfg, proxy(host, `/sites/${site}/networks/${id}`), deps);

// First value found under `key` anywhere in a JSON tree.
export function findKey(o, key, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return undefined;
  if (key in o && o[key] != null) return o[key];
  for (const v of Object.values(o)) { const r = findKey(v, key, depth + 1); if (r !== undefined) return r; }
  return undefined;
}

// A UniFi network -> what simpleIPAM stores, or null when it has no gateway-managed IPv4 subnet.
export function toNetwork(n) {
  const host = findKey(n, 'hostIpAddress');
  const prefix = findKey(n, 'prefixLength');
  if (!host || prefix == null) return null;
  const cidr = normalizeCidr(`${host}/${prefix}`);
  if (!cidr) return null;
  const range = findKey(n, 'ipAddressRange');
  const ok = (ip) => (ip && inCidr(ip, cidr) ? ip : '');
  const dns = findKey(n, 'dnsServerIpAddressesOverride');
  const [start, stop] = [ok(range?.start), ok(range?.stop)];
  return {
    uid: n.id, name: String(n.name ?? '').trim() || `VLAN ${n.vlanId ?? ''}`.trim(), cidr,
    vlan: Number.isInteger(n.vlanId) && n.vlanId >= 1 && n.vlanId <= 4094 ? n.vlanId : null,
    gateway: ok(findKey(n, 'gatewayIpAddressOverride')) || ok(host),
    dhcp_start: start && stop ? start : '', dhcp_end: start && stop ? stop : '',
    dns: Array.isArray(dns) ? dns.join(', ') : '',
    enabled: n.enabled !== false,
  };
}

// A UniFi client -> { ip, mac, name, wifi } or null without a usable IPv4 address.
export function toClient(c) {
  const ip = String(c?.ipAddress ?? '');
  if (ipToInt(ip) === null) return null;
  return { ip, mac: String(c.macAddress ?? ''), name: String(c.name ?? c.hostname ?? '').trim(), wifi: /wireless|wifi/i.test(String(c.type ?? '')) };
}

// Hostname-like names become the FQDN; anything else ("Łukasz's iPhone") stays a description.
export const hostnameOf = (name) => (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(name) ? name.toLowerCase() : '');
