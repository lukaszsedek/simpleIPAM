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

function Settings({ notify }) {
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
      {tab === 'settings' && <Settings notify={notify} />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}
