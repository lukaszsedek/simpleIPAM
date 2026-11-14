import { useEffect, useState } from 'preact/hooks';
import { api } from './api.js';
import { Icon, Field } from './ui.jsx';
import { Users } from './Users.jsx';
import { Backups } from './Backups.jsx';

const TABS = [['users', 'Użytkownicy', 'users'], ['backups', 'Kopie zapasowe', 'download'], ['settings', 'Ustawienia', 'settings'], ['audit', 'Dziennik zmian', 'history']];

function Audit() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.audit().then(setRows); }, []);
  const A = { create: 'dodano', update: 'zmieniono', delete: 'usunięto', import: 'import' };
  const E = { site: 'lokalizację', network: 'sieć', entry: 'wpis', user: 'użytkownika', role: 'rolę', tenant: 'tenanta', settings: 'ustawienia', token: 'token', backup: 'kopię' };
  return (
    <section class="card">
      <ul class="timeline">
        {rows.map((r) => (
          <li><i class={`dot ${r.action}`} /><span>{r.actor && <b>{r.actor} </b>}{A[r.action]} {E[r.entity] ?? r.entity} <b>{r.label}</b></span><time>{r.ts}</time></li>
        ))}
        {!rows.length && <li class="muted">Brak zdarzeń.</li>}
      </ul>
    </section>
  );
}

const bytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

function GoogleLogin({ notify }) {
  const [c, setC] = useState(null);
  const [f, setF] = useState({ client_id: '', client_secret: '' });
  useEffect(() => { api.googleLoginConfig().then((r) => { setC(r); setF({ client_id: r.client_id, client_secret: '' }); }).catch((e) => notify(e.message, 'error')); }, []);
  if (!c) return null;
  const save = async (enabled) => {
    try { const r = await api.saveGoogleLogin({ ...f, enabled }); setC(r); setF({ client_id: r.client_id, client_secret: '' }); notify(enabled ? 'Logowanie przez Google włączone' : 'Zapisano'); }
    catch (e) { notify(e.message, 'error'); }
  };
  return (
    <section class="card">
      <h3>Logowanie przez Google</h3>
      <p class="muted small-text">Użytkownicy mogą się logować kontem Google. Nowe konta powstają bez uprawnień (rola None), tak jak przy zwykłej rejestracji, i podlegają przełącznikowi „Otwarta rejestracja”.</p>
      <div class="form-grid">
        <Field label="Client ID" span><input value={f.client_id} onInput={(e) => setF({ ...f, client_id: e.target.value })} placeholder="123…apps.googleusercontent.com" /></Field>
        <Field label="Client Secret" span hint={c.secret_set ? 'zapisany — wpisz nowy, by go zmienić' : ''}><input type="password" autocomplete="off" value={f.client_secret} placeholder={c.secret_set ? '(zapisany)' : ''} onInput={(e) => setF({ ...f, client_secret: e.target.value })} /></Field>
      </div>
      <div class="form-actions">
        <button class="btn primary" onClick={() => save(true)}>{c.enabled ? 'Zapisz' : 'Zapisz i włącz'}</button>
        {c.enabled && <button class="btn ghost" onClick={() => save(false)}>Wyłącz</button>}
      </div>
      <details class="setup-help">
        <summary>Jak skonfigurować?</summary>
        <ol class="small-text muted">
          <li>W Google Cloud Console utwórz <b>Identyfikator klienta OAuth</b> typu „Aplikacja internetowa” (może być ten sam projekt co dla Dysku, ale to inny klient).</li>
          <li>Adres przekierowania: <span class="mono">{location.origin}/api/auth/google/callback</span> (Google przyjmuje tylko https lub localhost).</li>
          <li>Wpisz Client ID i Secret powyżej. Konto, którym już się logujesz hasłem, połączysz z Google w oknie „Zmiana hasła”.</li>
        </ol>
      </details>
    </section>
  );
}

const when = (iso) => new Date(iso).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });

function SyncResult({ r }) {
  return (
    <div class={`last-run ${r.ok ? 'ok' : 'bad'}`}>
      <div><b>{r.dry ? 'Podgląd (nic nie zapisano)' : r.ok ? 'Ostatnia synchronizacja' : 'Synchronizacja z błędami'}</b> · {when(r.at)}</div>
      {r.results.map((c) => (
        <div class="small-text">
          <b>{c.console}</b>: {c.errors.length && !c.sites ? '' : `sieci +${c.networks.created} ~${c.networks.updated}, wpisy +${c.entries.created} ~${c.entries.updated}, z puli DHCP ${c.entries.pooled}, pominięte ${c.entries.skipped}`}
          {c.errors.map((e) => <div class="error-text">{e}</div>)}
        </div>
      ))}
    </div>
  );
}

function Unifi({ tenants, notify }) {
  const [c, setC] = useState(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [res, setRes] = useState(null);
  useEffect(() => { api.unifi().then((r) => { setC(r); setRes(r.last); }).catch((e) => notify(e.message, 'error')); }, []);
  if (!c) return null;
  const act = async (name, fn, done) => {
    setBusy(name);
    try { done(await fn()); } catch (e) { notify(e.message, 'error'); }
    setBusy('');
  };
  const saveKey = () => act('key', () => api.saveUnifi({ api_key: key }), (r) => { setC(r); setKey(''); notify('Klucz zapisany'); });
  const discover = () => act('discover', api.unifiDiscover, (r) => { setC(r); notify(`Znaleziono konsol: ${r.consoles.length}`); });
  const patch = (changes, msg) => act('save', () => api.saveUnifi(changes), (r) => { setC(r); if (msg) notify(msg); });
  const toggle = (id, on) => patch({ consoles: c.consoles.map((x) => ({ id: x.id, enabled: x.id === id ? on : x.enabled })) });
  const sync = (dry) => act(dry ? 'dry' : 'sync', () => api.unifiSync(dry), (r) => { setRes(r); notify(dry ? 'Podgląd gotowy' : r.ok ? 'Synchronizacja zakończona' : 'Synchronizacja z błędami', r.ok ? 'ok' : 'error'); });
  const ready = c.key_set && c.tenant_id && c.consoles.some((x) => x.enabled);
  return (
    <section class="card span-2">
      <h3>UniFi (Site Manager)</h3>
      <p class="muted small-text">Jednokierunkowy import z Twoich konsol UniFi (Cloud Gateway, UDM…) przez konto Ubiquiti: sieci z VLAN-ami i zakresem DHCP, urządzenia o stałych adresach jako wpisy, klienci z puli DHCP jako „nowe urządzenia”. Adresy MAC z UniFi zasilają wykrywanie zmian MAC.</p>
      <div class="form-grid">
        <Field label="Klucz API Site Managera" span hint={c.key_set ? 'zapisany — wpisz nowy, by go zmienić (lista konsol zostanie wczytana ponownie)' : 'unifi.ui.com → API → Create API Key (klucz musi należeć do właściciela konsol)'}>
          <input type="password" autocomplete="off" value={key} placeholder={c.key_set ? '(zapisany)' : ''} onInput={(e) => setKey(e.target.value)} /></Field>
      </div>
      <div class="form-actions">
        <button class="btn primary" disabled={!key || busy === 'key'} onClick={saveKey}>Zapisz klucz</button>
        <button class="btn ghost" disabled={!c.key_set || busy === 'discover'} onClick={discover}>{busy === 'discover' ? 'Szukam…' : 'Pobierz listę konsol'}</button>
      </div>
      {c.consoles.length > 0 && (
        <div class="unifi-consoles">
          <h4>Konsole do synchronizacji</h4>
          {c.consoles.map((x) => (
            <label class="toggle"><input type="checkbox" checked={x.enabled} onChange={(e) => toggle(x.id, e.target.checked)} /> <b>{x.name}</b> <span class="muted small-text mono">{x.ip}</span></label>
          ))}
          <div class="form-grid">
            <Field label="Tenant dla zaimportowanych lokalizacji" hint="Każda konsola trafi do osobnej lokalizacji o jej nazwie">
              <select value={c.tenant_id ?? ''} onChange={(e) => patch({ tenant_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— wybierz —</option>
                {tenants.map((t) => <option value={t.id}>{t.name}</option>)}
              </select></Field>
          </div>
          <label class="toggle"><input type="checkbox" checked={c.import_dhcp} onChange={(e) => patch({ import_dhcp: e.target.checked })} /> Klienci z puli DHCP też jako wpisy (domyślnie trafiają do „nowych urządzeń”)</label>
          <label class="toggle"><input type="checkbox" checked={c.auto_sync} onChange={(e) => patch({ auto_sync: e.target.checked })} /> Synchronizuj automatycznie co godzinę</label>
          <div class="form-actions">
            <button class="btn ghost" disabled={!ready || !!busy} onClick={() => sync(true)}>{busy === 'dry' ? 'Liczę…' : 'Podgląd'}</button>
            <button class="btn primary" disabled={!ready || !!busy} onClick={() => sync(false)}>{busy === 'sync' ? 'Synchronizuję…' : 'Synchronizuj teraz'}</button>
          </div>
        </div>
      )}
      {res && <SyncResult r={res} />}
      <p class="muted small-text">Wymaga konsoli z UniFi OS ≥ 5.0.3 online w chmurze Ubiquiti (limit: 100 zapytań/min na konsolę). Istniejące wpisy i sieci nie są nadpisywane — uzupełniane są tylko puste pola, a rozbieżne MAC-i są zgłaszane jako ostrzeżenia.</p>
    </section>
  );
}

function Settings({ notify, tenants }) {
  const [reg, setReg] = useState(true);
  const [sys, setSys] = useState(null);
  useEffect(() => { api.me().then((r) => setReg(r.registration_open)); api.system().then(setSys).catch((e) => notify(e.message, 'error')); }, []);
  const toggle = async () => {
    try { setReg((await api.setSettings({ registration_open: !reg })).registration_open); } catch (e) { notify(e.message, 'error'); }
  };
  return (
    <div class="admin-grid">
      <section class="card">
        <h3>Dostęp</h3>
        <label class="toggle"><input type="checkbox" checked={reg} onChange={toggle} /> Otwarta rejestracja nowych użytkowników</label>
        <p class="muted small-text">Nowe konta nie mają dostępu do żadnych danych, dopóki nie nadasz im roli. Pierwsze konto w systemie zawsze może się zarejestrować.</p>
      </section>
      <GoogleLogin notify={notify} />
      <Unifi tenants={tenants} notify={notify} />
      <section class="card">
        <h3>System</h3>
        {sys ? (
          <dl class="kv">
            <dt>Wersja</dt><dd class="mono" title={`commit ${sys.commit}`}>{sys.version}{sys.commit !== 'unknown' && ` (${sys.commit.slice(0, 7)})`}</dd>
            <dt>Rozmiar bazy</dt><dd>{bytes(sys.db_bytes)}</dd>
            <dt>Tenanty / lokalizacje</dt><dd>{sys.counts.tenants} / {sys.counts.sites}</dd>
            <dt>Sieci / wpisy</dt><dd>{sys.counts.networks} / {sys.counts.entries}</dd>
            <dt>Użytkownicy</dt><dd>{sys.counts.users}</dd>
            <dt>Skan okresowy</dt><dd>{sys.scan_interval_min > 0 ? `co ${sys.scan_interval_min} min` : 'wyłączony'}</dd>
            <dt>Kopie lokalne</dt><dd class="mono">{sys.backup_dir ?? 'wyłączone'}</dd>
            <dt>Node.js</dt><dd class="mono">{sys.node}</dd>
          </dl>
        ) : <p class="muted">Ładowanie…</p>}
      </section>
    </div>
  );
}

export function Admin({ tab, tenants, me, notify, onUsersChanged }) {
  return (
    <div class="page">
      <header class="page-head">
        <div>
          <div class="crumb">Administracja</div>
          <h1>Panel administratora</h1>
        </div>
      </header>
      <div class="tabs" role="tablist">
        {TABS.map(([k, label, icon]) => (
          <a role="tab" aria-selected={tab === k} class={tab === k ? 'on' : ''} href={`#/admin/${k}`}><Icon name={icon} size={16} />{label}</a>
        ))}
      </div>
      {tab === 'users' && <Users tenants={tenants} me={me} notify={notify} onChanged={onUsersChanged} />}
      {tab === 'backups' && <Backups notify={notify} />}
      {tab === 'settings' && <Settings notify={notify} tenants={tenants} />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}
