// Azure through Azure Resource Manager (management.azure.com), authenticated as a service principal (SPN):
//   POST login.microsoftonline.com/{directory}/oauth2/v2.0/token   client credentials, scope https://management.azure.com/.default
//   GET  /subscriptions                                            subscriptions the SPN can see
//   GET  /subscriptions/{id}/providers/Microsoft.Network/{virtualNetworks|networkInterfaces|loadBalancers}
// The SPN only needs the Reader role. Read-only; parsing is tolerant because it has not been run against a real tenant yet.
import { normalizeCidr } from './ip.js';

const LOGIN = 'https://login.microsoftonline.com';
const ARM = 'https://management.azure.com';
const NET_API = '2024-05-01';
export class AzureError extends Error {}
const short = (s) => String(s).replace(/\s+/g, ' ').slice(0, 220);
const last = (id) => String(id ?? '').split('/').filter(Boolean).pop() ?? '';

export const resourceGroup = (id) => /\/resourceGroups\/([^/]+)/i.exec(String(id ?? ''))?.[1] ?? '';
export const hostnameOf = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').slice(0, 63);

// One client per sync: the token is requested lazily and reused.
export function client(cfg, { fetch = globalThis.fetch } = {}) {
  let token = null;
  const call = async (url, init = {}) => {
    try { return await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }); }
    catch (e) { throw new AzureError(`Brak połączenia z ${new URL(url).host}: ${short(e.message)}`); }
  };
  async function auth() {
    if (token) return token;
    const res = await call(`${LOGIN}/${encodeURIComponent(cfg.directory_id)}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.client_id, client_secret: cfg.client_secret, scope: `${ARM}/.default` }).toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new AzureError(`Logowanie do Azure AD nie powiodło się: ${short(String(j.error_description ?? j.error ?? res.status).split('Trace ID')[0])}`);
    return (token = j.access_token);
  }
  async function get(url) {
    const res = await call(url.startsWith('http') ? url : `${ARM}${url}`, { headers: { authorization: `Bearer ${await auth()}`, accept: 'application/json' } });
    if (res.status === 401) throw new AzureError('Azure odrzucił token (401) — sprawdź tenant (directory) i dane SPN');
    if (res.status === 403) throw new AzureError('Brak uprawnień (403) — nadaj SPN rolę Reader na subskrypcji');
    if (res.status === 429) throw new AzureError('Limit zapytań Azure — spróbuj za chwilę');
    if (!res.ok) throw new AzureError(`Azure ${res.status}: ${short(await res.text().catch(() => ''))}`);
    return res.json();
  }
  // Follows nextLink, but only on management.azure.com so the bearer token never goes anywhere else.
  async function list(path) {
    const out = [];
    for (let url = path, i = 0; url && i < 200; i++) {
      const j = await get(url);
      out.push(...(Array.isArray(j.value) ? j.value : []));
      url = typeof j.nextLink === 'string' && j.nextLink.startsWith(`${ARM}/`) ? j.nextLink : null;
    }
    return out;
  }
  return { auth, get, list };
}

export async function listSubscriptions(c) {
  const subs = await c.list('/subscriptions?api-version=2022-12-01');
  return subs.filter((s) => s?.subscriptionId && !/^(disabled|deleted)$/i.test(s.state ?? '')).map((s) => ({ id: s.subscriptionId, name: s.displayName || s.subscriptionId }));
}
const inSub = (sub, type) => `/subscriptions/${sub}/providers/Microsoft.Network/${type}?api-version=${NET_API}`;
export const listVnets = (c, sub) => c.list(inSub(sub, 'virtualNetworks'));
export const listNics = (c, sub) => c.list(inSub(sub, 'networkInterfaces'));
export const listLoadBalancers = (c, sub) => c.list(inSub(sub, 'loadBalancers'));

// IPv4 subnets of a VNet: { id, name, cidr }.
export function toSubnets(vnet) {
  const out = [];
  for (const s of vnet?.properties?.subnets ?? []) {
    const p = s.properties ?? {};
    for (const raw of p.addressPrefixes ?? (p.addressPrefix ? [p.addressPrefix] : [])) {
      const cidr = String(raw).includes(':') ? null : normalizeCidr(raw);
      if (cidr) out.push({ id: String(s.id ?? '').toLowerCase(), name: String(s.name ?? ''), cidr });
    }
  }
  return out;
}

// Private addresses of a network interface (VM, private endpoint…): one row per IP configuration.
export function toInterfaces(nic) {
  const p = nic?.properties ?? {};
  const vm = p.virtualMachine?.id, pe = p.privateEndpoint?.id;
  const name = last(vm) || last(pe) || String(nic?.name ?? '');
  const kind = vm ? 'vm' : pe ? 'private-endpoint' : 'nic';
  const rg = resourceGroup(nic?.id);
  return (p.ipConfigurations ?? []).map((ic, i) => ({
    ip: ic.properties?.privateIPAddress ?? '', mac: p.macAddress ?? '', subnetId: String(ic.properties?.subnet?.id ?? '').toLowerCase(),
    name, kind, primary: ic.properties?.primary ?? i === 0, method: ic.properties?.privateIPAllocationMethod ?? '',
    description: `Azure: ${rg}/${nic?.name ?? ''}`,
  })).filter((x) => x.ip && !x.ip.includes(':'));
}

// Private frontends of a load balancer.
export function toFrontends(lb) {
  const rg = resourceGroup(lb?.id);
  return (lb?.properties?.frontendIPConfigurations ?? []).map((fe) => ({
    ip: fe.properties?.privateIPAddress ?? '', mac: '', subnetId: String(fe.properties?.subnet?.id ?? '').toLowerCase(),
    name: `${lb.name}/${fe.name}`, kind: 'load-balancer', primary: false, method: fe.properties?.privateIPAllocationMethod ?? '',
    description: `Azure: ${rg}/${lb?.name ?? ''}`,
  })).filter((x) => x.ip && !x.ip.includes(':'));
}
