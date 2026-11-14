async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth/') && url !== '/api/me') window.dispatchEvent(new Event('ipam:unauth'));
  if (!res.ok) throw new Error(data.error || `Błąd ${res.status}`);
  return data;
}

// Database files are uploaded as raw bytes (the JSON helper above is for everything else).
async function upload(url, file, passphrase) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(passphrase ? { 'x-backup-passphrase': passphrase } : {}) }, body: file });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) window.dispatchEvent(new Event('ipam:unauth'));
  if (!res.ok) throw new Error(data.error || `Błąd ${res.status}`);
  return data;
}

export const api = {
  inspectRestore: (name, passphrase) => req('POST', '/api/admin/restore/inspect', { name, passphrase }),
  inspectUpload: (file, passphrase) => upload('/api/admin/restore/inspect', file, passphrase),
  applyRestore: (token) => req('POST', '/api/admin/restore/apply', { token }),
  me: () => req('GET', '/api/me'),
  login: (username, password) => req('POST', '/api/auth/login', { username, password }),
  register: (username, password) => req('POST', '/api/auth/register', { username, password }),
  logout: () => req('POST', '/api/auth/logout', {}),
  changePassword: (current, password) => req('POST', '/api/me/password', { current, password }),
  users: () => req('GET', '/api/users'),
  // scope: {} = global, { tenant_id } or { site_id }
  setRole: (id, scope, role) => req('PUT', `/api/users/${id}/roles`, { ...scope, role }),
  resetRole: (id, kind, scopeId) => req('DELETE', `/api/users/${id}/roles/${kind}/${scopeId}`),
  setUserPassword: (id, password) => req('PUT', `/api/users/${id}/password`, { password }),
  delUser: (id) => req('DELETE', `/api/users/${id}`),
  overview: () => req('GET', '/api/overview'),
  network: (id) => req('GET', `/api/networks/${id}`),
  nextFree: (id, from) => req('GET', `/api/networks/${id}/next-free${from ? `?from=${from}` : ''}`),
  scan: (id) => req('POST', `/api/networks/${id}/scan`, {}),
  search: (q) => req('GET', `/api/search?q=${encodeURIComponent(q)}`),
  audit: () => req('GET', '/api/audit'),
  importCsv: (id, csv) => req('POST', `/api/networks/${id}/import`, { csv }),
  tokens: () => req('GET', '/api/me/tokens'),
  createToken: (name) => req('POST', '/api/me/tokens', { name }),
  delToken: (id) => req('DELETE', `/api/me/tokens/${id}`),
  discovered: (id) => req('GET', `/api/networks/${id}/discovered`),
  dismiss: (id) => req('POST', `/api/discovered/${id}/dismiss`, {}),
  bulk: (netId, body) => req('POST', `/api/networks/${netId}/entries/bulk`, body),
  freeBlocks: (siteId, within, prefix) => req('GET', `/api/sites/${siteId}/free-blocks?within=${encodeURIComponent(within)}&prefix=${prefix}`),
  system: () => req('GET', '/api/admin/system'),
  backups: () => req('GET', '/api/admin/backups'),
  saveBackupConfig: (c) => req('PUT', '/api/admin/backups/config', c),
  runBackup: () => req('POST', '/api/admin/backups/run', {}),
  gdriveConnect: () => req('POST', '/api/admin/backups/gdrive/connect', { origin: location.origin }),
  gdriveDeviceStart: () => req('POST', '/api/admin/backups/gdrive/device/start', {}),
  gdriveDevicePoll: () => req('POST', '/api/admin/backups/gdrive/device/poll', {}),
  gdriveFiles: () => req('GET', '/api/admin/backups/gdrive/files'),
  inspectDrive: (id, passphrase) => req('POST', '/api/admin/restore/inspect', { drive_id: id, passphrase }),
  gdriveDisconnect: () => req('POST', '/api/admin/backups/gdrive/disconnect', {}),
  googleStart: (link) => req('POST', '/api/auth/google/start', { origin: location.origin, link }),
  googleUnlink: () => req('POST', '/api/me/google/unlink', {}),
  googleLoginConfig: () => req('GET', '/api/admin/google-login'),
  saveGoogleLogin: (c) => req('PUT', '/api/admin/google-login', c),
  entryHistory: (id) => req('GET', `/api/entries/${id}/history`),
  networkHistory: (id) => req('GET', `/api/networks/${id}/history`),
  macAction: (id, action) => req('POST', `/api/entries/${id}/mac`, { action }),
  unifi: () => req('GET', '/api/admin/unifi'),
  saveUnifi: (c) => req('PUT', '/api/admin/unifi', c),
  unifiDiscover: () => req('POST', '/api/admin/unifi/discover', {}),
  unifiSync: (dry_run) => req('POST', '/api/admin/unifi/sync', { dry_run }),
  testRemote: () => req('POST', '/api/admin/backups/test-remote', {}),
  delBackup: (name) => req('DELETE', `/api/admin/backups/${encodeURIComponent(name)}`),
  saveTenant: (t) => (t.id ? req('PUT', `/api/tenants/${t.id}`, t) : req('POST', '/api/tenants', t)),
  delTenant: (id) => req('DELETE', `/api/tenants/${id}`),
  saveSite: (s) => (s.id ? req('PUT', `/api/sites/${s.id}`, s) : req('POST', `/api/tenants/${s.tenant_id}/sites`, s)),
  issues: (id) => req('GET', `/api/networks/${id}/issues`),
  setSettings: (s) => req('PUT', '/api/settings', s),
  delSite: (id) => req('DELETE', `/api/sites/${id}`),
  saveNetwork: (n) => (n.id ? req('PUT', `/api/networks/${n.id}`, n) : req('POST', `/api/sites/${n.site_id}/networks`, n)),
  delNetwork: (id) => req('DELETE', `/api/networks/${id}`),
  saveEntry: (e) => (e.id ? req('PUT', `/api/entries/${e.id}`, e) : req('POST', `/api/networks/${e.network_id}/entries`, e)),
  delEntry: (id) => req('DELETE', `/api/entries/${id}`),
};
