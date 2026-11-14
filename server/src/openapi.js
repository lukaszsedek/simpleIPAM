// OpenAPI 3.0 description of the HTTP API, built from the live route table so a route can never be undocumented:
// test/openapi.test.js fails when a registered route has no entry in DOCS (and when an entry has no route).
//
// DOCS value: [tag, summary, access, { body, query, returns }]
//   access: 'public' | 'reader' | 'contributor' | 'admin' (site/tenant admin) | 'global-admin' | 'session' (session only, no API token)
//   body/query: { field: 'type' } — suffix "*" marks a required field; type may be "a|b|c" for enums.
const D = {
  // --- structure ---
  'GET /api/overview': ['Struktura', 'Drzewo tenant → lokalizacja → sieci ze statystykami (tylko to, do czego masz dostęp)', 'reader'],
  'POST /api/tenants': ['Struktura', 'Utwórz tenanta', 'global-admin', { body: { name: 'string*', description: 'string' } }],
  'PUT /api/tenants/:id': ['Struktura', 'Zmień tenanta', 'admin', { body: { name: 'string*', description: 'string' } }],
  'DELETE /api/tenants/:id': ['Struktura', 'Usuń tenanta wraz z zawartością', 'global-admin'],
  'POST /api/tenants/:id/sites': ['Struktura', 'Dodaj lokalizację (site) do tenanta', 'admin', { body: { name: 'string*', description: 'string', icon: 'string' } }],
  'PUT /api/sites/:id': ['Struktura', 'Zmień lokalizację', 'admin', { body: { name: 'string*', description: 'string', icon: 'string' } }],
  'DELETE /api/sites/:id': ['Struktura', 'Usuń lokalizację wraz z sieciami', 'admin'],
  'POST /api/sites/:id/networks': ['Sieci', 'Dodaj sieć do lokalizacji', 'admin', { body: { name: 'string*', cidr: 'string* (np. 192.168.1.0/24, max /16)', vlan: 'integer 1–4094', gateway: 'string (IP)', dhcp_start: 'string (IP)', dhcp_end: 'string (IP)', dns: 'string', description: 'string', auto_scan: 'boolean' } }],
  'PUT /api/networks/:id': ['Sieci', 'Zmień sieć', 'admin', { body: { name: 'string*', cidr: 'string*', vlan: 'integer', gateway: 'string', dhcp_start: 'string', dhcp_end: 'string', dns: 'string', description: 'string', auto_scan: 'boolean' } }],
  'DELETE /api/networks/:id': ['Sieci', 'Usuń sieć wraz z wpisami', 'admin'],
  'GET /api/networks/:id': ['Sieci', 'Szczegóły sieci: wpisy, statystyki, ostatnio zauważone hosty', 'reader'],
  'GET /api/networks/:id/next-free': ['Sieci', 'Pierwszy wolny adres (pomija bramę, zakres DHCP i wpisy)', 'reader', { query: { from: 'string (IP) — szukaj od tego adresu' }, returns: '{ ip: string|null }' }],
  'POST /api/networks/:id/scan': ['Sieci', 'Przeskanuj sieć pingiem (sieci do /22) i odczytaj MAC z tablicy ARP (gdy serwer jest w tym samym segmencie L2). Zwraca { alive: [{ ip, known, mac }], macs }', 'contributor'],
  'GET /api/networks/:id/issues': ['Sieci', 'Ostrzeżenia spójności: duplikaty, kolizje z DHCP, nakładające się sieci', 'reader'],
  'GET /api/networks/:id/discovered': ['Sieci', 'Hosty znalezione skanem, a niewpisane do sieci', 'reader'],
  'POST /api/discovered/:id/dismiss': ['Sieci', 'Ukryj znaleziony host', 'contributor'],
  'GET /api/sites/:id/free-blocks': ['Sieci', 'Wolne bloki CIDR w lokalizacji', 'reader', { query: { within: 'string* (CIDR nadrzędny)', prefix: 'integer* (żądana długość prefiksu)' } }],
  // --- entries ---
  'POST /api/networks/:id/entries': ['Wpisy', 'Dodaj wpis (adres IP)', 'contributor', { body: { ip: 'string* (w CIDR sieci)', fqdn: 'string', alias: 'string (przyjazna nazwa urządzenia; zgodna z aliasem w UniFi)', mac: 'string', type: 'server|vm|container|router|switch|ap|iot|printer|pc|phone|nas|other', status: 'used|reserved|free', tags: 'string (po przecinku)', description: 'string' } }],
  'PUT /api/entries/:id': ['Wpisy', 'Zmień wpis', 'contributor', { body: { ip: 'string*', fqdn: 'string', alias: 'string (pominięte = bez zmian)', mac: 'string', type: 'string', status: 'used|reserved|free', tags: 'string', description: 'string' } }],
  'DELETE /api/entries/:id': ['Wpisy', 'Usuń wpis', 'contributor'],
  'POST /api/networks/:id/entries/bulk': ['Wpisy', 'Zbiorcza zmiana lub usunięcie wpisów (do 1000)', 'contributor', { body: { ids: 'integer[]*', action: 'delete|update*', changes: 'object ({ type, status, add_tags } — dla action=update)' } }],
  'GET /api/search': ['Wpisy', 'Szukaj wpisów po IP, FQDN, MAC, tagach', 'reader', { query: { q: 'string*' } }],
  'GET /api/networks/:id/export.csv': ['Wymiana danych', 'Eksport wpisów do CSV', 'reader', { returns: 'text/csv' }],
  'POST /api/networks/:id/import': ['Wymiana danych', 'Import wpisów z CSV (wymagana kolumna ip)', 'contributor', { body: { csv: 'string*' } }],
  'GET /api/networks/:id/export/:format': ['Wymiana danych', 'Eksport do DNS/DHCP: format = hosts | dnsmasq | bind', 'reader', { returns: 'text/plain' }],
  'GET /api/audit': ['Dziennik', 'Dziennik zmian (ostatnie wpisy)', 'reader'],
  'GET /api/entries/:id/history': ['Wpisy', 'Historia zmian wpisu (do 200 zdarzeń): pola [stara, nowa], autor, czas', 'reader'],
  'GET /api/networks/:id/history': ['Wpisy', 'Historia zmian w sieci albo jednego adresu', 'reader', { query: { ip: 'string — tylko ten adres' } }],
  'POST /api/entries/:id/mac': ['Wpisy', 'Rozstrzygnij zmianę MAC wykrytą skanem: accept = zapisz wykryty MAC we wpisie, ignore = nie ostrzegaj o tym MAC', 'contributor', { body: { action: 'accept|ignore*' } }],
  // --- session & users ---
  'GET /api/me': ['Sesja', 'Zalogowany użytkownik, wersja i flagi (setup_required, registration_open, google_login)', 'public'],
  'GET /api/health': ['Sesja', 'Test żywotności (Docker healthcheck)', 'public'],
  'POST /api/auth/register': ['Sesja', 'Rejestracja; pierwsze konto zostaje administratorem, kolejne mają rolę None', 'public', { body: { username: 'string* (3–32)', password: 'string* (min. 8)' } }],
  'POST /api/auth/login': ['Sesja', 'Logowanie (ustawia ciasteczko sid); po 5 błędach blokada na minutę', 'public', { body: { username: 'string*', password: 'string*' } }],
  'POST /api/auth/logout': ['Sesja', 'Wylogowanie', 'public'],
  'GET /api/me/tokens': ['Tokeny API', 'Lista Twoich tokenów', 'session'],
  'POST /api/me/tokens': ['Tokeny API', 'Utwórz token (wartość widoczna tylko raz; używaj jako Authorization: Bearer)', 'session', { body: { name: 'string*' } }],
  'DELETE /api/me/tokens/:id': ['Tokeny API', 'Usuń token', 'session'],
  'POST /api/me/password': ['Sesja', 'Zmień swoje hasło (current pomijane, gdy konto powstało przez Google)', 'session', { body: { current: 'string', password: 'string* (min. 8)' } }],
  'POST /api/me/google/unlink': ['Sesja', 'Odłącz konto Google (wymaga ustawionego hasła)', 'session'],
  'GET /api/users': ['Użytkownicy', 'Lista użytkowników z rolami', 'global-admin'],
  'PUT /api/users/:id/roles': ['Użytkownicy', 'Nadaj rolę (global, na tenancie albo lokalizacji)', 'global-admin', { body: { role: 'admin|contributor|reader|none*', tenant_id: 'integer', site_id: 'integer' } }],
  'DELETE /api/users/:id/roles/:scope/:scopeId': ['Użytkownicy', 'Cofnij przypisanie roli (scope = global | tenant | site)', 'global-admin'],
  'PUT /api/users/:id/password': ['Użytkownicy', 'Ustaw użytkownikowi nowe hasło', 'global-admin', { body: { password: 'string*' } }],
  'DELETE /api/users/:id': ['Użytkownicy', 'Usuń użytkownika', 'global-admin'],
  'PUT /api/settings': ['Ustawienia', 'Otwarta rejestracja nowych użytkowników', 'global-admin', { body: { registration_open: 'boolean*' } }],
  // --- google sign-in ---
  'GET /api/admin/google-login': ['Logowanie Google', 'Konfiguracja logowania przez Google (bez sekretu)', 'global-admin'],
  'PUT /api/admin/google-login': ['Logowanie Google', 'Zapisz Client ID/Secret i włącz/wyłącz logowanie', 'session', { body: { client_id: 'string', client_secret: 'string (puste = bez zmian)', enabled: 'boolean' } }],
  'POST /api/auth/google/start': ['Logowanie Google', 'Rozpocznij logowanie; zwraca adres Google do przekierowania', 'public', { body: { origin: 'string* (adres aplikacji)', link: 'boolean (połącz z zalogowanym kontem)' }, returns: '{ url, redirect_uri }' }],
  'GET /api/auth/google/callback': ['Logowanie Google', 'Adres powrotny z Google (przeglądarka; 302 do aplikacji)', 'public', { query: { code: 'string', state: 'string' } }],
  // --- admin: system & backups ---
  'GET /api/admin/system': ['Administracja', 'Wersja, rozmiar bazy, liczniki, ustawienia środowiska', 'global-admin'],
  'GET /api/admin/backup': ['Kopie zapasowe', 'Pobierz świeżą migawkę bazy (SQLite)', 'global-admin', { returns: 'application/vnd.sqlite3' }],
  'GET /api/admin/backups': ['Kopie zapasowe', 'Lista kopii lokalnych, ostatni przebieg i konfiguracja (bez sekretów)', 'global-admin'],
  'PUT /api/admin/backups/config': ['Kopie zapasowe', 'Zapisz konfigurację kopii (puste sekrety = bez zmian)', 'global-admin', { body: { provider: 'none|s3|gcs|gdrive', remote_enabled: 'boolean', local_keep: 'integer 1–365', s3: 'object', gcs: 'object', gdrive: 'object', encrypt: '{ enabled: boolean, passphrase: string }' } }],
  'POST /api/admin/backups/run': ['Kopie zapasowe', 'Wykonaj kopię teraz (lokalnie i do chmury)', 'global-admin'],
  'POST /api/admin/backups/test-remote': ['Kopie zapasowe', 'Wyślij plik testowy do skonfigurowanej chmury', 'global-admin'],
  'GET /api/admin/backups/:name': ['Kopie zapasowe', 'Pobierz kopię lokalną', 'global-admin', { returns: 'application/vnd.sqlite3' }],
  'DELETE /api/admin/backups/:name': ['Kopie zapasowe', 'Usuń kopię lokalną', 'global-admin'],
  'POST /api/admin/backups/gdrive/connect': ['Dysk Google', 'Rozpocznij logowanie do Dysku (zwraca adres Google)', 'session', { body: { origin: 'string*' }, returns: '{ url, redirect_uri }' }],
  'GET /api/admin/backups/gdrive/callback': ['Dysk Google', 'Adres powrotny z Google (302 do aplikacji)', 'session', { query: { code: 'string', state: 'string' } }],
  'POST /api/admin/backups/gdrive/device/start': ['Dysk Google', 'Rozpocznij logowanie kodem urządzenia', 'session'],
  'POST /api/admin/backups/gdrive/device/poll': ['Dysk Google', 'Sprawdź, czy kod urządzenia został potwierdzony', 'session', { returns: '{ status: pending|connected|denied|expired }' }],
  'GET /api/admin/backups/gdrive/files': ['Dysk Google', 'Lista kopii w folderze na Dysku', 'global-admin'],
  'POST /api/admin/backups/gdrive/disconnect': ['Dysk Google', 'Odłącz konto Google i unieważnij token', 'session'],
  'POST /api/admin/restore/inspect': ['Przywracanie', 'Krok 1: zweryfikuj kopię i pokaż podgląd. Źródło: { name } (lokalna), { drive_id } (Dysk) albo surowy plik (Content-Type: application/octet-stream). Hasło szyfrowania: pole passphrase lub nagłówek X-Backup-Passphrase', 'session', { body: { name: 'string', drive_id: 'string', passphrase: 'string' }, returns: '{ token, current, backup, migrated, you_in_backup }' }],
  'POST /api/admin/restore/apply': ['Przywracanie', 'Krok 2: zapisz kopię bezpieczeństwa i podmień bazę; unieważnia sesje', 'session', { body: { token: 'string*' } }],
  'GET /api/admin/unifi': ['UniFi', 'Konfiguracja integracji UniFi (bez klucza), lista konsol i ostatnia synchronizacja', 'global-admin'],
  'PUT /api/admin/unifi': ['UniFi', 'Zapisz klucz API Site Managera, tenanta docelowego i wybór konsol', 'session', { body: { api_key: 'string (nowy klucz z unifi.ui.com)', tenant_id: 'integer', consoles: 'object[] ([{ id, enabled }])', import_dhcp: 'boolean (klienci z puli DHCP jako wpisy)', auto_sync: 'boolean (co godzinę)' } }],
  'POST /api/admin/unifi/discover': ['UniFi', 'Pobierz listę konsol (hostów) z konta Ubiquiti', 'session'],
  'POST /api/admin/unifi/sync': ['UniFi', 'Synchronizuj UniFi → simpleIPAM (jednokierunkowo). dry_run=true tylko pokazuje, co by się stało', 'session', { body: { dry_run: 'boolean' } }],
  'POST /api/admin/unifi/diagnose': ['UniFi', 'Tylko odczyt: sprawdź, do jakich API konsoli (Integration i klasyczne) ma dostęp klucz — warunek ewentualnego zapisu aliasów do UniFi', 'session'],
  // --- meta ---
  'GET /api/openapi.json': ['Dokumentacja', 'Ten opis API w formacie OpenAPI 3', 'public'],
  'GET /api/docs': ['Dokumentacja', 'Czytelna dokumentacja API (HTML)', 'public'],
};
export const DOCS = D;

const ACCESS = {
  public: 'Bez logowania.',
  reader: 'Rola co najmniej **Reader** w danym zakresie.',
  contributor: 'Rola co najmniej **Contributor** w danej lokalizacji.',
  admin: 'Rola **Admin** w danym zakresie (lokalizacja/tenant) albo globalnie.',
  'global-admin': 'Tylko **globalny Admin**.',
  session: 'Tylko globalny Admin lub właściciel konta, **zalogowany w przeglądarce** (tokeny API są odrzucane).',
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
        400: { description: 'Nieprawidłowe dane (`{ "error": "…" }`)' },
        ...(access === 'public' ? {} : { 401: { description: 'Wymagane logowanie' }, 403: { description: 'Brak uprawnień' } }),
        ...(r.keys.length ? { 404: { description: 'Nie znaleziono' } } : {}),
      },
      ...(access === 'public' ? { security: [] } : access === 'session' ? { security: [{ cookieAuth: [] }] } : {}),
    };
    (paths[path] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'simpleIPAM API', version,
      description: 'Lekki IPAM do użytku domowego. Uwierzytelnianie: ciasteczko sesji `sid` (po logowaniu) albo token API w nagłówku `Authorization: Bearer ipam_…` (tokeny tworzysz w aplikacji; operacje oznaczone „zalogowany w przeglądarce” ich nie przyjmują). Ciało żądań to JSON (`Content-Type: application/json`), błędy mają postać `{ "error": "…" }`. Uprawnienia: rola obowiązuje w zakresie global → tenant → lokalizacja, najbardziej szczegółowe przypisanie wygrywa.',
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
</style></head><body><main><h1>simpleIPAM API</h1><p class="d" id="info">Ładowanie…</p>
<p><a href="/api/openapi.json">openapi.json</a></p><input id="q" placeholder="Szukaj endpointu…" type="search"><div id="root"></div></main>
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
