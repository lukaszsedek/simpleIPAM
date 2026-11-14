// OpenAPI 3.0 description of the HTTP API, built from the live route table so a route can never be undocumented:
// test/openapi.test.js fails when a registered route has no entry in DOCS (and when an entry has no route).
//
// DOCS value: [tag, summary, access, { body, query, returns }]
//   access: 'public' | 'reader' | 'contributor' | 'admin' (site/tenant admin) | 'global-admin' | 'session' (session only, no API token)
//   body/query: { field: 'type' } — suffix "*" marks a required field; type may be "a|b|c" for enums.
const D = {
  // --- structure ---
  'GET /api/overview': ['Structure', 'Tree of tenant → location → networks with statistics (only what you have access to)', 'reader'],
  'POST /api/tenants': ['Structure', 'Create a tenant', 'global-admin', { body: { name: 'string*', description: 'string' } }],
  'PUT /api/tenants/:id': ['Structure', 'Update a tenant', 'admin', { body: { name: 'string*', description: 'string' } }],
  'DELETE /api/tenants/:id': ['Structure', 'Delete a tenant with its contents', 'global-admin'],
  'POST /api/tenants/:id/sites': ['Structure', 'Add a location (site) to a tenant', 'admin', { body: { name: 'string*', description: 'string', icon: 'string' } }],
  'PUT /api/sites/:id': ['Structure', 'Update a location', 'admin', { body: { name: 'string*', description: 'string', icon: 'string' } }],
  'DELETE /api/sites/:id': ['Structure', 'Delete a location with its networks', 'admin'],
  'POST /api/sites/:id/networks': ['Networks', 'Add a network to a location', 'admin', { body: { name: 'string*', cidr: 'string* (e.g. 192.168.1.0/24, max /16)', vlan: 'integer 1–4094', gateway: 'string (IP)', dhcp_start: 'string (IP)', dhcp_end: 'string (IP)', dns: 'string', description: 'string', auto_scan: 'boolean' } }],
  'PUT /api/networks/:id': ['Networks', 'Update a network', 'admin', { body: { name: 'string*', cidr: 'string*', vlan: 'integer', gateway: 'string', dhcp_start: 'string', dhcp_end: 'string', dns: 'string', description: 'string', auto_scan: 'boolean' } }],
  'DELETE /api/networks/:id': ['Networks', 'Delete a network with its entries', 'admin'],
  'GET /api/networks/:id': ['Networks', 'Network details: entries, statistics, recently seen hosts', 'reader'],
  'GET /api/networks/:id/next-free': ['Networks', 'First free address (skips the gateway, the DHCP range and existing entries)', 'reader', { query: { from: 'string (IP) — search from this address' }, returns: '{ ip: string|null }' }],
  'POST /api/networks/:id/scan': ['Networks', 'Ping-scan the network (up to /22) and read MACs from the ARP table (when the server is in the same L2 segment). Returns { alive: [{ ip, known, mac }], macs }', 'contributor'],
  'GET /api/networks/:id/issues': ['Networks', 'Consistency warnings: duplicates, clashes with DHCP, overlapping networks, expiring entries, growth forecast', 'reader'],
  'GET /api/networks/:id/discovered': ['Networks', 'Hosts found by a scan but not entered in the network', 'reader'],
  'POST /api/discovered/:id/dismiss': ['Networks', 'Dismiss a discovered host', 'contributor'],
  'GET /api/sites/:id/free-blocks': ['Networks', 'Free CIDR blocks in a location', 'reader', { query: { within: 'string* (parent CIDR)', prefix: 'integer* (requested prefix length)' } }],
  // --- entries ---
  'POST /api/networks/:id/entries': ['Entries', 'Add an entry (IP address)', 'contributor', { body: { ip: 'string* (inside the network CIDR)', fqdn: 'string', alias: 'string (friendly device name; matches the alias in UniFi)', mac: 'string', type: 'server|vm|container|router|switch|ap|iot|printer|pc|phone|nas|other', status: 'used|reserved|free', tags: 'string (comma-separated)', description: 'string' } }],
  'PUT /api/entries/:id': ['Entries', 'Update an entry', 'contributor', { body: { ip: 'string*', fqdn: 'string', alias: 'string (omitted = unchanged)', mac: 'string', type: 'string', status: 'used|reserved|free', tags: 'string', description: 'string' } }],
  'DELETE /api/entries/:id': ['Entries', 'Delete an entry', 'contributor'],
  'POST /api/networks/:id/entries/bulk': ['Entries', 'Bulk update or delete entries (up to 1000)', 'contributor', { body: { ids: 'integer[]*', action: 'delete|update*', changes: 'object ({ type, status, add_tags } — for action=update)' } }],
  'GET /api/search': ['Entries', 'Search entries by IP, FQDN, MAC, tags', 'reader', { query: { q: 'string*' } }],
  'GET /api/networks/:id/export.csv': ['Data exchange', 'Export entries to CSV', 'reader', { returns: 'text/csv' }],
  'POST /api/networks/:id/import': ['Data exchange', 'Import entries from CSV (the ip column is required)', 'contributor', { body: { csv: 'string*' } }],
  'GET /api/networks/:id/export/:format': ['Data exchange', 'Export for DNS/DHCP: format = hosts | dnsmasq | bind', 'reader', { returns: 'text/plain' }],
  'GET /api/audit': ['Audit log', 'Audit log (latest events)', 'reader'],
  'GET /api/entries/:id/history': ['Entries', 'Change history of an entry (up to 200 events): fields [old, new], author, time', 'reader'],
  'GET /api/networks/:id/history': ['Entries', 'Change history of a network or of a single address', 'reader', { query: { ip: 'string — only this address' } }],
  'POST /api/entries/:id/mac': ['Entries', 'Resolve a MAC change found by a scan: accept = store the detected MAC in the entry, ignore = stop warning about this MAC', 'contributor', { body: { action: 'accept|ignore*' } }],
  // --- session & users ---
  'GET /api/me': ['Session', 'The signed-in user, the version and flags (setup_required, registration_open, google_login)', 'public'],
  'GET /api/health': ['Session', 'Liveness check (Docker healthcheck)', 'public'],
  'POST /api/auth/register': ['Session', 'Registration; the first account becomes the administrator, later ones get the None role', 'public', { body: { username: 'string* (3–32)', password: 'string* (min. 8)' } }],
  'POST /api/auth/login': ['Session', 'Sign in (sets the sid cookie); blocked for a minute after 5 failures', 'public', { body: { username: 'string*', password: 'string*' } }],
  'POST /api/auth/logout': ['Session', 'Sign out', 'public'],
  'GET /api/me/tokens': ['API tokens', 'List your tokens', 'session'],
  'POST /api/me/tokens': ['API tokens', 'Create a token (the value is shown only once; use it as Authorization: Bearer)', 'session', { body: { name: 'string*' } }],
  'DELETE /api/me/tokens/:id': ['API tokens', 'Delete a token', 'session'],
  'POST /api/me/password': ['Session', 'Change your password (current is ignored when the account was created through Google)', 'session', { body: { current: 'string', password: 'string* (min. 8)' } }],
  'POST /api/me/google/unlink': ['Session', 'Disconnect the Google account (requires a password to be set)', 'session'],
  'GET /api/users': ['Users', 'List users with their roles', 'global-admin'],
  'PUT /api/users/:id/roles': ['Users', 'Grant a role (globally, on a tenant or on a location)', 'global-admin', { body: { role: 'admin|contributor|reader|none*', tenant_id: 'integer', site_id: 'integer' } }],
  'DELETE /api/users/:id/roles/:scope/:scopeId': ['Users', 'Remove a role assignment (scope = global | tenant | site)', 'global-admin'],
  'PUT /api/users/:id/password': ['Users', 'Set a new password for a user', 'global-admin', { body: { password: 'string*' } }],
  'DELETE /api/users/:id': ['Users', 'Delete a user', 'global-admin'],
  'PUT /api/settings': ['Settings', 'Open registration of new users', 'global-admin', { body: { registration_open: 'boolean*' } }],
  // --- google sign-in ---
  'GET /api/admin/google-login': ['Google sign-in', 'Google sign-in configuration (without the secret)', 'global-admin'],
  'PUT /api/admin/google-login': ['Google sign-in', 'Save the Client ID/Secret and enable/disable sign-in', 'session', { body: { client_id: 'string', client_secret: 'string (empty = unchanged)', enabled: 'boolean' } }],
  'POST /api/auth/google/start': ['Google sign-in', 'Start the sign-in; returns the Google address to redirect to', 'public', { body: { origin: 'string* (app address)', link: 'boolean (link to the signed-in account)' }, returns: '{ url, redirect_uri }' }],
  'GET /api/auth/google/callback': ['Google sign-in', 'Return address from Google (browser; 302 to the app)', 'public', { query: { code: 'string', state: 'string' } }],
  // --- admin: system & backups ---
  'GET /api/admin/system': ['Administration', 'Version, database size, counters, environment settings', 'global-admin'],
  'GET /api/admin/backup': ['Backups', 'Download a fresh snapshot of the database (SQLite)', 'global-admin', { returns: 'application/vnd.sqlite3' }],
  'GET /api/admin/backups': ['Backups', 'List of local backups, the last run and the configuration (without secrets)', 'global-admin'],
  'PUT /api/admin/backups/config': ['Backups', 'Save the backup configuration (empty secrets = unchanged)', 'global-admin', { body: { provider: 'none|s3|gcs|gdrive', remote_enabled: 'boolean', local_keep: 'integer 1–365', s3: 'object', gcs: 'object', gdrive: 'object', encrypt: '{ enabled: boolean, passphrase: string }' } }],
  'POST /api/admin/backups/run': ['Backups', 'Run a backup now (locally and to the cloud)', 'global-admin'],
  'POST /api/admin/backups/test-remote': ['Backups', 'Upload a test file to the configured cloud', 'global-admin'],
  'GET /api/admin/backups/:name': ['Backups', 'Download a local backup', 'global-admin', { returns: 'application/vnd.sqlite3' }],
  'DELETE /api/admin/backups/:name': ['Backups', 'Delete a local backup', 'global-admin'],
  'POST /api/admin/backups/gdrive/connect': ['Google Drive', 'Start the Drive sign-in (returns the Google address)', 'session', { body: { origin: 'string*' }, returns: '{ url, redirect_uri }' }],
  'GET /api/admin/backups/gdrive/callback': ['Google Drive', 'Return address from Google (302 to the app)', 'session', { query: { code: 'string', state: 'string' } }],
  'POST /api/admin/backups/gdrive/device/start': ['Google Drive', 'Start a device-code sign-in', 'session'],
  'POST /api/admin/backups/gdrive/device/poll': ['Google Drive', 'Check whether the device code was confirmed', 'session', { returns: '{ status: pending|connected|denied|expired }' }],
  'GET /api/admin/backups/gdrive/files': ['Google Drive', 'List of backups in the Drive folder', 'global-admin'],
  'POST /api/admin/backups/gdrive/disconnect': ['Google Drive', 'Disconnect the Google account and revoke the token', 'session'],
  'POST /api/admin/restore/inspect': ['Restore', 'Step 1: verify the backup and show a preview. Source: { name } (local), { drive_id } (Drive) or a raw file (Content-Type: application/octet-stream). Encryption passphrase: the passphrase field or the X-Backup-Passphrase header', 'session', { body: { name: 'string', drive_id: 'string', passphrase: 'string' }, returns: '{ token, current, backup, migrated, you_in_backup }' }],
  'POST /api/admin/restore/apply': ['Restore', 'Step 2: save a safety backup and swap the database; invalidates sessions', 'session', { body: { token: 'string*' } }],
  'GET /api/admin/unifi': ['UniFi', 'UniFi integration configuration (without the key), the console list and the last sync', 'global-admin'],
  'PUT /api/admin/unifi': ['UniFi', 'Save the Site Manager API key, the target tenant and the console selection', 'session', { body: { api_key: 'string (a new key from unifi.ui.com)', tenant_id: 'integer', consoles: 'object[] ([{ id, enabled }])', import_dhcp: 'boolean (clients from the DHCP pool as entries)', auto_sync: 'boolean (every hour)', push_aliases: 'boolean (send aliases to UniFi automatically; requires a successful manual write)' } }],
  'POST /api/admin/unifi/discover': ['UniFi', 'Fetch the list of consoles (hosts) from the Ubiquiti account', 'session'],
  'POST /api/admin/unifi/sync': ['UniFi', 'Sync UniFi → simpleIPAM (one-way, plus aliases). dry_run=true only shows what would happen', 'session', { body: { dry_run: 'boolean' } }],
  'POST /api/admin/unifi/diagnose': ['UniFi', 'Read-only: check which console APIs (Integration and classic) the key can reach — a precondition for writing aliases to UniFi', 'session'],
  'POST /api/admin/unifi/push': ['UniFi', 'Send aliases from simpleIPAM to UniFi (classic API, by MAC; only clients UniFi already knows, nothing is created). dry_run=true shows the plan. After the first successful write automation can be enabled (push_aliases)', 'session', { body: { dry_run: 'boolean' } }],
  // --- meta ---
  'GET /api/openapi.json': ['Documentation', 'This API description in OpenAPI 3 format', 'public'],
  'GET /api/docs': ['Documentation', 'Readable API documentation (HTML)', 'public'],
};
export const DOCS = D;

const ACCESS = {
  public: 'No sign-in required.',
  reader: 'At least the **Reader** role in the given scope.',
  contributor: 'At least the **Contributor** role in the given location.',
  admin: 'The **Admin** role in the given scope (location/tenant) or globally.',
  'global-admin': '**Global Admin** only.',
  session: 'Only a global Admin or the account owner, **signed in through the browser** (API tokens are rejected).',
};

function schemaOf(spec) {
  const props = {}, required = [];
  for (const [k, v] of Object.entries(spec)) {
    const req = /^[^ ]*\*/.test(v);
    const clean = v.replace(/^([^ ]*)\*/, '$1');
    const [type, ...rest] = clean.split(' ');
    const desc = rest.join(' ');
    let s;
    if (type.endsWith('[]')) s = { type: 'array', items: { type: type.slice(0, -2) } };
    else if (type.includes('|')) s = { type: 'string', enum: type.split('|') };
    else if (['string', 'integer', 'boolean', 'object'].includes(type)) s = { type };
    else s = { type: 'string', description: clean };
    if (desc) s.description = desc;
    props[k] = s;
    if (req) required.push(k);
  }
  return { type: 'object', properties: props, ...(required.length ? { required } : {}) };
}

export function buildOpenApi(routes, { version = 'dev' } = {}) {
  const paths = {};
  for (const r of routes) {
    const key = `${r.method} ${r.pattern}`;
    const [tag, summary, access, extra = {}] = D[key] ?? ['Inne', key, r.public ? 'public' : 'reader'];
    const path = r.pattern.replace(/:(\w+)/g, '{$1}');
    const parameters = r.keys.map((k) => ({ name: k, in: 'path', required: true, schema: { type: k === 'format' || k === 'name' || k === 'scope' ? 'string' : 'integer' } }));
    for (const [k, v] of Object.entries(extra.query ?? {})) parameters.push({ name: k, in: 'query', required: /^[^ ]*\*/.test(v), description: v.replace(/^([^ ]*)\*/, '$1'), schema: { type: 'string' } });
    const op = {
      tags: [tag], summary, description: ACCESS[access], operationId: `${r.method.toLowerCase()}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      ...(parameters.length ? { parameters } : {}),
      ...(extra.body ? { requestBody: { required: true, content: { 'application/json': { schema: schemaOf(extra.body) } } } } : {}),
      responses: {
        200: { description: extra.returns ?? 'OK', ...(extra.returns?.includes('/') && !extra.returns.startsWith('{') ? { content: { [extra.returns]: { schema: { type: 'string', format: 'binary' } } } } : {}) },
        400: { description: 'Invalid input (`{ "error": "…" }`)' },
        ...(access === 'public' ? {} : { 401: { description: 'Sign-in required' }, 403: { description: 'Forbidden' } }),
        ...(r.keys.length ? { 404: { description: 'Not found' } } : {}),
      },
      ...(access === 'public' ? { security: [] } : access === 'session' ? { security: [{ cookieAuth: [] }] } : {}),
    };
    (paths[path] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'simpleIPAM API', version,
      description: 'A lightweight IPAM for home use. Authentication: the `sid` session cookie (after signing in) or an API token in the `Authorization: Bearer ipam_…` header (create tokens in the app; operations marked "signed in through the browser" do not accept them). Request bodies are JSON (`Content-Type: application/json`), errors look like `{ "error": "…" }`. Permissions: a role applies in the scope global → tenant → location, the most specific assignment wins. Error messages are in Polish.',
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    components: { securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'Token API (ipam_…)' },
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'sid' },
    } },
    paths,
  };
}

export const DOCS_HTML = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>simpleIPAM API</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
:root{--bg:#f6f7fb;--s:#fff;--b:#e3e6ef;--t:#161a2b;--m:#6b7189;--a:#6366f1}
@media(prefers-color-scheme:dark){:root{--bg:#0d0f17;--s:#151824;--b:#262b3d;--t:#e8eaf4;--m:#8b91ab}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:15px/1.5 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 64px}h1{margin:0 0 4px}p.d{color:var(--m)}
h2{margin:32px 0 8px;font-size:18px}details{background:var(--s);border:1px solid var(--b);border-radius:12px;margin:8px 0}
summary{cursor:pointer;padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.m{font:700 11px ui-monospace,monospace;padding:3px 8px;border-radius:6px;color:#fff;min-width:56px;text-align:center}
.GET{background:#2f855a}.POST{background:#3182ce}.PUT{background:#b7791f}.DELETE{background:#c53030}
code,pre{font:13px ui-monospace,monospace}.p{font-weight:600}.s{color:var(--m);flex:1 1 240px}
.body{padding:0 14px 14px;border-top:1px solid var(--b)}table{border-collapse:collapse;width:100%;margin:6px 0}
td,th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--b);vertical-align:top;font-size:13px}
.req{color:#c53030}pre{background:var(--bg);padding:10px;border-radius:8px;overflow:auto}
input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--b);background:var(--s);color:var(--t);margin:12px 0}
</style></head><body><main><h1>simpleIPAM API</h1><p class="d" id="info">Loading…</p>
<p><a href="/api/openapi.json">openapi.json</a></p><input id="q" placeholder="Search endpoints…" type="search"><div id="root"></div></main>
<script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const md=s=>esc(s).replace(/\\*\\*(.+?)\\*\\*/g,'<b>$1</b>').replace(/\`(.+?)\`/g,'<code>$1</code>');
fetch('/api/openapi.json').then(r=>r.json()).then(spec=>{
  document.getElementById('info').innerHTML='v'+esc(spec.info.version)+' — '+md(spec.info.description);
  const groups={};
  for(const[p,ops]of Object.entries(spec.paths))for(const[m,o]of Object.entries(ops))(groups[o.tags[0]]??=[]).push({p,m:m.toUpperCase(),o});
  const root=document.getElementById('root');
  const render=f=>{root.innerHTML=Object.entries(groups).map(([t,list])=>{
    list=list.filter(e=>!f||(e.m+' '+e.p+' '+e.o.summary).toLowerCase().includes(f));
    if(!list.length)return'';
    return'<h2>'+esc(t)+'</h2>'+list.map(({p,m,o})=>{
      const params=(o.parameters||[]).map(x=>'<tr><td><code>'+esc(x.name)+'</code></td><td>'+x.in+'</td><td>'+(x.required?'<span class="req">wymagany</span>':'')+' '+esc(x.description||x.schema.type)+'</td></tr>').join('');
      const sch=o.requestBody?.content['application/json'].schema;
      const body=sch?Object.entries(sch.properties).map(([k,v])=>'<tr><td><code>'+esc(k)+'</code></td><td>'+esc(v.enum?v.enum.join(' | '):v.type==='array'?v.items.type+'[]':v.type)+'</td><td>'+((sch.required||[]).includes(k)?'<span class="req">wymagane</span> ':'')+esc(v.description||'')+'</td></tr>').join(''):'';
      return'<details><summary><span class="m '+m+'">'+m+'</span><span class="p">'+esc(p)+'</span><span class="s">'+esc(o.summary)+'</span></summary><div class="body"><p>'+md(o.description)+'</p>'+
        (params?'<table><tr><th>Parametr</th><th>Gdzie</th><th>Opis</th></tr>'+params+'</table>':'')+
        (body?'<table><tr><th>Pole JSON</th><th>Typ</th><th>Opis</th></tr>'+body+'</table>':'')+
        '<pre>curl -X '+m+' -H "Authorization: Bearer ipam_…"'+(body?' -H "Content-Type: application/json" -d \\'{…}\\'':'')+' '+esc(location.origin+p)+'</pre></div></details>';
    }).join('');}).join('');};
  render('');document.getElementById('q').oninput=e=>render(e.target.value.toLowerCase());
});
</script></body></html>`;
