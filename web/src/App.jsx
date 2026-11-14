import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from './api.js';
import { Icon, Modal, Field, Logo, Toasts, SITE_ICONS, ROLE_LABELS } from './ui.jsx';
import { Network } from './Network.jsx';
import { Admin } from './Admin.jsx';
import { AuthScreen } from './Auth.jsx';

const useHash = () => {
  const [h, setH] = useState(location.hash || '#/');
  useEffect(() => {
    const f = () => setH(location.hash || '#/');
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return h;
};

function SiteForm({ site, tenantId, onClose, onSaved, notify }) {
  const [f, setF] = useState(site ?? { tenant_id: tenantId, name: '', description: '', icon: 'home' });
  const submit = async (e) => {
    e.preventDefault();
    try { await api.saveSite(f); onSaved(); } catch (err) { notify(err.message, 'error'); }
  };
  return (
    <Modal title={site ? 'Edytuj lokalizację' : 'Nowa lokalizacja'} onClose={onClose}>
      <form class="form-grid" onSubmit={submit}>
        <Field label="Nazwa" span><input value={f.name} onInput={(e) => setF({ ...f, name: e.target.value })} placeholder="dom1, lab2, cloud-aws…" required /></Field>
        <Field label="Opis" span><input value={f.description} onInput={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Ikona" span>
          <div class="icon-picker">
            {SITE_ICONS.map((i) => (
              <button type="button" class={f.icon === i ? 'on' : ''} onClick={() => setF({ ...f, icon: i })} aria-label={i}><Icon name={i} /></button>
            ))}
          </div>
        </Field>
        <footer>
          <button type="button" class="btn ghost" onClick={onClose}>Anuluj</button>
          <button class="btn primary">Zapisz</button>
        </footer>
      </form>
    </Modal>
  );
}

function TenantForm({ tenant, onClose, onSaved, notify }) {
  const [f, setF] = useState(tenant ?? { name: '', description: '' });
  const submit = async (e) => {
    e.preventDefault();
    try { await api.saveTenant(f); onSaved(); } catch (err) { notify(err.message, 'error'); }
  };
  return (
    <Modal title={tenant ? 'Edytuj tenanta' : 'Nowy tenant'} onClose={onClose}>
      <form class="form-grid" onSubmit={submit}>
        <Field label="Nazwa" span><input value={f.name} onInput={(e) => setF({ ...f, name: e.target.value })} placeholder="rodzina, firma, klient-x…" required /></Field>
        <Field label="Opis" span><input value={f.description} onInput={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <footer>
          <button type="button" class="btn ghost" onClick={onClose}>Anuluj</button>
          <button class="btn primary">Zapisz</button>
        </footer>
      </form>
    </Modal>
  );
}

function NetworkForm({ net, siteId, onClose, onSaved, notify }) {
  const [f, setF] = useState(net ?? { site_id: siteId, name: '', cidr: '', vlan: '', gateway: '', dhcp_start: '', dhcp_end: '', dns: '', description: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    try { onSaved(await api.saveNetwork(f)); } catch (err) { notify(err.message, 'error'); }
  };
  return (
    <Modal title={net?.id ? 'Edytuj sieć' : 'Nowa sieć'} onClose={onClose}>
      <form class="form-grid" onSubmit={submit}>
        <Field label="Nazwa"><input value={f.name} onInput={set('name')} placeholder="LAN, IoT, Goście…" required /></Field>
        <Field label="CIDR"><input class="mono" value={f.cidr} onInput={set('cidr')} placeholder="192.168.10.0/24" required /></Field>
        <Field label="VLAN"><input type="number" min="1" max="4094" value={f.vlan ?? ''} onInput={set('vlan')} /></Field>
        <Field label="Brama"><input class="mono" value={f.gateway} onInput={set('gateway')} placeholder="192.168.10.1" /></Field>
        <Field label="DHCP od"><input class="mono" value={f.dhcp_start} onInput={set('dhcp_start')} /></Field>
        <Field label="DHCP do"><input class="mono" value={f.dhcp_end} onInput={set('dhcp_end')} /></Field>
        <Field label="DNS" span><input class="mono" value={f.dns} onInput={set('dns')} placeholder="1.1.1.1, 192.168.10.2" /></Field>
        <Field label="Opis" span><input value={f.description} onInput={set('description')} /></Field>
        <label class="toggle span"><input type="checkbox" checked={!!f.auto_scan} onChange={(e) => setF({ ...f, auto_scan: e.target.checked ? 1 : 0 })} />
          Skanuj automatycznie (ping) i wykrywaj nowe urządzenia</label>
        {!net?.id && <FreeBlock siteId={siteId} onPick={(cidr) => setF({ ...f, cidr })} notify={notify} />}
        <footer>
          <button type="button" class="btn ghost" onClick={onClose}>Anuluj</button>
          <button class="btn primary">Zapisz</button>
        </footer>
      </form>
    </Modal>
  );
}

// Suggests unused aligned subnets inside a parent range, so a new network never overlaps an existing one.
function FreeBlock({ siteId, onPick, notify }) {
  const [within, setWithin] = useState('192.168.0.0/16');
  const [prefix, setPrefix] = useState('24');
  const [found, setFound] = useState(null);
  const search = async () => {
    try { setFound(await api.freeBlocks(siteId, within, prefix)); } catch (err) { notify(err.message, 'error'); }
  };
  return (
    <div class="free-block span">
      <span class="muted small-text">Znajdź wolną podsieć w zakresie</span>
      <div class="with-btn">
        <input class="mono" value={within} onInput={(e) => setWithin(e.target.value)} aria-label="Zakres nadrzędny" />
        <select value={prefix} onChange={(e) => setPrefix(e.target.value)} aria-label="Prefiks">
          {[30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20].map((p) => <option value={p}>/{p}</option>)}
        </select>
        <button type="button" class="btn ghost" onClick={search}><Icon name="wand" />Szukaj</button>
      </div>
      {found && (found.length
        ? <div class="role-chips">{found.map((c) => <button type="button" class="chip pick" onClick={() => onPick(c)}>{c}</button>)}</div>
        : <span class="muted small-text">Brak wolnych bloków w tym zakresie.</span>)}
    </div>
  );
}

function PasswordForm({ onClose, notify, me, googleReady }) {
  const [f, setF] = useState({ current: '', password: '' });
  const submit = async (e) => {
    e.preventDefault();
    try { await api.changePassword(f.current, f.password); notify('Hasło zostało zmienione'); onClose(); if (!me.has_password) setTimeout(() => location.reload(), 600); }
    catch (err) { notify(err.message, 'error'); }
  };
  return (
    <Modal title={me.has_password ? 'Zmiana hasła' : 'Ustaw hasło'} onClose={onClose}>
      <form class="form-grid" onSubmit={submit}>
        {me.has_password && <Field label="Aktualne hasło" span><input type="password" autocomplete="current-password" value={f.current} onInput={(e) => setF({ ...f, current: e.target.value })} required /></Field>}
        <Field label="Nowe hasło" hint="min. 8 znaków" span><input type="password" autocomplete="new-password" minLength={8} value={f.password} onInput={(e) => setF({ ...f, password: e.target.value })} required /></Field>
        <footer><button type="button" class="btn ghost" onClick={onClose}>Anuluj</button><button class="btn primary">Zmień</button></footer>
      </form>
      {googleReady && (
        <div class="google-link">
          {me.google_email
            ? <p class="muted small-text">Połączone konto Google: <b>{me.google_email}</b> — możesz się nim logować.{' '}
                {me.has_password ? <button type="button" class="link-btn" onClick={() => api.googleUnlink().then(() => { notify('Konto Google odłączone'); onClose(); setTimeout(() => location.reload(), 600); }).catch((e) => notify(e.message, 'error'))}>Odłącz</button>
                  : <span>Ustaw hasło powyżej, aby móc odłączyć Google.</span>}</p>
            : <button type="button" class="btn ghost block" onClick={() => api.googleStart(true).then((r) => { location.href = r.url; }).catch((e) => notify(e.message, 'error'))}>Połącz z kontem Google</button>}
        </div>
      )}
    </Modal>
  );
}

function Tokens({ onClose, notify }) {
  const [list, setList] = useState([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState(null);
  const load = () => api.tokens().then(setList).catch((e) => notify(e.message, 'error'));
  useEffect(() => { load(); }, []);
  const create = async (e) => {
    e.preventDefault();
    try { setFresh(await api.createToken(name)); setName(''); load(); } catch (err) { notify(err.message, 'error'); }
  };
  return (
    <Modal title="Tokeny API" onClose={onClose} wide>
      <p class="muted small-text">Token działa jak Ty (te same role). Użyj go w nagłówku <span class="mono">Authorization: Bearer …</span>. Opis wszystkich endpointów: <a href="/api/docs" target="_blank" rel="noreferrer">dokumentacja API</a> (<a href="/api/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a>).</p>
      {fresh && (
        <div class="token-new">
          <span>Skopiuj teraz — nie zobaczysz go ponownie:</span>
          <code class="mono">{fresh.token}</code>
          <button class="btn small" onClick={() => navigator.clipboard?.writeText(fresh.token).then(() => notify('Skopiowano'))}><Icon name="copy" size={14} />Kopiuj</button>
        </div>
      )}
      <form class="with-btn" onSubmit={create}>
        <input class="token-name" placeholder="nazwa, np. skrypt backupu" value={name} onInput={(e) => setName(e.target.value)} required />
        <button class="btn primary">Utwórz token</button>
      </form>
      <ul class="scan-list">
        {list.map((t) => (
          <li><span><b>{t.name}</b><div class="muted small-text">utworzony {t.created_at.slice(0, 10)} · {t.last_used ? `użyty ${t.last_used}` : 'nieużywany'}</div></span>
            <button class="btn small ghost danger" onClick={async () => { await api.delToken(t.id); load(); }}>Odwołaj</button></li>
        ))}
        {!list.length && <li class="muted">Brak tokenów.</li>}
      </ul>
    </Modal>
  );
}

function Palette({ sites, onClose, go }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [sel, setSel] = useState(0);
  const nav = useMemo(() => [
    { label: 'Dziennik zmian', sub: 'Historia', to: '#/audit' },
    ...sites.flatMap((s) => s.networks.map((n) => ({ label: `${s.name} / ${n.name}`, sub: n.cidr, to: `#/n/${n.id}` }))),
  ], [sites]);
  useEffect(() => {
    if (!q.trim()) return setHits([]);
    const t = setTimeout(() => api.search(q).then(setHits).catch(() => {}), 120);
    return () => clearTimeout(t);
  }, [q]);
  const s = q.toLowerCase();
  const items = [
    ...nav.filter((i) => !s || i.label.toLowerCase().includes(s) || i.sub.includes(s)).slice(0, 8),
    ...hits.map((h) => ({ label: `${h.ip}  ${h.fqdn}`, sub: `${h.site_name} / ${h.network_name}`, to: `#/n/${h.network_id}` })),
  ];
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((sel + 1) % Math.max(1, items.length)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((sel - 1 + items.length) % Math.max(1, items.length)); }
    if (e.key === 'Enter' && items[sel]) { go(items[sel].to); onClose(); }
    if (e.key === 'Escape') onClose();
  };
  return (
    <div class="overlay top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="palette">
        <div class="palette-input"><Icon name="search" />
          <input autofocus placeholder="Szukaj IP, FQDN, MAC, sieci…" value={q} onInput={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={key} /></div>
        <ul>
          {items.map((i, idx) => (
            <li class={idx === sel ? 'on' : ''} onMouseEnter={() => setSel(idx)} onClick={() => { go(i.to); onClose(); }}>
              <span class="mono">{i.label}</span><small>{i.sub}</small>
            </li>
          ))}
          {!items.length && <li class="muted">Brak wyników</li>}
        </ul>
      </div>
    </div>
  );
}

export function App() {
  const hash = useHash();
  const [me, setMe] = useState(undefined);
  const [tenants, setTenants] = useState([]);
  const sites = useMemo(() => tenants.flatMap((t) => t.sites), [tenants]);
  const [regOpen, setRegOpen] = useState(true);
  const [version, setVersion] = useState('');
  const [setupRequired, setSetupRequired] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState({});
  const [modal, setModal] = useState(null);
  const [palette, setPalette] = useState(false);
  const [nav, setNav] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [rev, setRev] = useState(0);
  const [theme, setTheme] = useState(() => { try { return localStorage.theme; } catch { return null; } });
  const tid = useRef(0);

  const notify = (text, kind = 'ok') => {
    const id = ++tid.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  };
  const reload = () => api.overview().then((t) => { setTenants(t); setLoaded(true); }).catch((e) => notify(e.message, 'error'));
  const go = (to) => { location.hash = to; };

  useEffect(() => {
    const g = /[?&]google=(ok|new|linked)\b/.exec(location.search)?.[1];      // returned from a successful Google sign-in / link
    if (g) {
      history.replaceState(null, '', `${location.pathname}${location.hash}`);
      notify(g === 'linked' ? 'Konto Google połączone' : g === 'new' ? 'Konto utworzone — poproś administratora o nadanie uprawnień' : 'Zalogowano przez Google');
    }
    api.me().then((r) => { setMe(r.user); setRegOpen(r.registration_open); setVersion(r.version ?? ''); setSetupRequired(!!r.setup_required); setGoogleReady(!!r.google_login); }).catch(() => setMe(null));
    const f = () => { setMe(null); setTenants([]); setLoaded(false); };
    addEventListener('ipam:unauth', f);
    return () => removeEventListener('ipam:unauth', f);
  }, []);
  useEffect(() => { if (me) reload(); }, [me?.id]);
  useEffect(() => {
    const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [theme]);
  useEffect(() => {
    const f = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); } };
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, []);
  useEffect(() => setNav(false), [hash]);

  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.theme = next; } catch {}
  };

  const netId = (/^#\/n\/(\d+)/.exec(hash) ?? [])[1];
  const isAdmin = me?.global_role === 'admin';
  // legacy #/users and #/audit still work
  const adminTab = isAdmin ? (/^#\/admin(?:\/(\w+))?/.exec(hash)?.[1] ?? (hash === '#/users' ? 'users' : hash === '#/audit' ? 'audit' : hash.startsWith('#/admin') ? 'users' : null)) : null;
  const refreshMe = () => api.me().then((r) => setMe(r.user)).catch(() => {});   // e.g. the pending-users badge
  const logout = async () => { await api.logout(); setMe(null); setTenants([]); setLoaded(false); go('#/'); };

  const delTenant = async (t) => {
    if (!confirm(`Usunąć tenanta „${t.name}” razem z ${t.sites.length} lokalizacjami i wszystkimi danymi?`)) return;
    await api.delTenant(t.id); notify('Usunięto tenanta'); go('#/'); reload();
  };
  const delSite = async (s) => {
    if (!confirm(`Usunąć lokalizację „${s.name}” razem ze wszystkimi sieciami i wpisami?`)) return;
    await api.delSite(s.id); notify('Usunięto lokalizację'); go('#/'); reload();
  };
  const delNet = async (n) => {
    if (!confirm(`Usunąć sieć „${n.name}” (${n.cidr}) razem ze wszystkimi wpisami?`)) return;
    await api.delNetwork(n.id); notify('Usunięto sieć'); go('#/'); reload();
  };

  if (me === undefined) return null;
  if (!me) return <AuthScreen google={googleReady} version={version} setup={setupRequired} registrationOpen={regOpen} onAuth={(u) => { setSetupRequired(false); setMe(u); go('#/'); }} />;

  return (
    <div class="shell">
      <aside class={`sidebar ${nav ? 'open' : ''}`}>
        <a class="brand" href="#/" aria-label="Strona główna"><Logo size={28} />simpleIPAM</a>
        <button class="search-trigger" onClick={() => setPalette(true)}>
          <Icon name="search" size={16} /><span>Szukaj…</span><kbd>⌘K</kbd>
        </button>
        <nav>
          {tenants.map((t) => (
            <div class="tenant">
              <div class="tenant-head">
                <button class="tenant-btn" onClick={() => setOpen({ ...open, [`t${t.id}`]: open[`t${t.id}`] === false })}
                  aria-expanded={open[`t${t.id}`] !== false}>
                  <Icon name="tenant" size={15} /><span>{t.name}</span>
                </button>
                {t.role === 'admin' && <>
                  <button class="icon-btn" aria-label="Dodaj lokalizację" title="Dodaj lokalizację" onClick={() => setModal({ kind: 'site', tenantId: t.id })}><Icon name="plus" size={14} /></button>
                  <button class="icon-btn" aria-label="Edytuj tenanta" onClick={() => setModal({ kind: 'tenant', tenant: t })}><Icon name="edit" size={14} /></button>
                </>}
              </div>
              {open[`t${t.id}`] !== false && t.sites.map((s) => (
                <div class="site">
                  <div class="site-head">
                    <button class="site-btn" onClick={() => setOpen({ ...open, [s.id]: open[s.id] === false })}>
                      <Icon name={s.icon} size={16} /><span>{s.name}</span><small>{s.networks.length}</small>
                    </button>
                    {s.role === 'admin' && <button class="icon-btn" aria-label="Edytuj lokalizację" onClick={() => setModal({ kind: 'site', site: s })}><Icon name="edit" size={14} /></button>}
                  </div>
                  {open[s.id] !== false && (
                    <div class="nets">
                      {s.networks.map((n) => {
                        const pct = Math.round((n.stats.used / Math.max(1, n.stats.total)) * 100);
                        return (
                          <a href={`#/n/${n.id}`} class={String(n.id) === netId ? 'on' : ''} title={`${n.name} · ${n.cidr}${n.vlan ? ` · VLAN ${n.vlan}` : ''}`}>
                            <span class="net-top">
                              <span class="net-name">{n.name}</span>
                              {n.stats.new_hosts > 0 && <b class="badge" title="Nowe urządzenia">{n.stats.new_hosts}</b>}
                              {n.vlan && <span class="vlan-pill">VLAN {n.vlan}</span>}
                            </span>
                            <span class="net-bottom"><span class="mono">{n.cidr}</span><span>{pct}%</span></span>
                            <span class="mini-bar"><i style={{ width: `${pct}%` }} /></span>
                          </a>
                        );
                      })}
                      {s.role === 'admin' && <button class="add-net" onClick={() => setModal({ kind: 'net', siteId: s.id })}><Icon name="plus" size={14} />Dodaj sieć</button>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </nav>
        <div class="side-foot">
          {isAdmin && <button class="btn ghost block" onClick={() => setModal({ kind: 'tenant' })}><Icon name="plus" />Tenant</button>}
          {isAdmin && (
            <a class={`btn ghost block ${adminTab ? 'on' : ''}`} href="#/admin"><Icon name="settings" />Administracja{me.pending_users > 0 && <b class="badge" title="Użytkownicy bez uprawnień">{me.pending_users}</b>}</a>
          )}
          <div class="user-box">
            <span class="name" title={me.username}>{me.username}</span>
            <span class={`role-badge ${me.global_role}`}>{ROLE_LABELS[me.global_role]}</span>
            <div class="user-actions">
            <button class="icon-btn" onClick={() => setModal({ kind: 'tokens' })} aria-label="Tokeny API" title="Tokeny API"><Icon name="code" size={16} /></button>
            <button class="icon-btn" onClick={() => setModal({ kind: 'pw' })} aria-label="Zmień hasło" title="Zmień hasło"><Icon name="key" size={16} /></button>
            <button class="icon-btn" onClick={toggleTheme} aria-label="Zmień motyw"><Icon name={document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'} size={16} /></button>
            <button class="icon-btn" onClick={logout} aria-label="Wyloguj" title="Wyloguj"><Icon name="logout" size={16} /></button>
            </div>
          </div>
          {version && <a class="version" href="https://github.com/lukaszsedek/simpleIPAM/releases" target="_blank" rel="noopener" title="Historia wersji">simpleIPAM v{version.replace(/^v/, '')}</a>}
        </div>
      </aside>

      <main>
        <button class="menu-btn icon-btn" onClick={() => setNav(!nav)} aria-label="Menu"><Icon name="menu" /></button>
        {adminTab ? <Admin tab={adminTab} tenants={tenants} me={me} notify={notify} onUsersChanged={refreshMe} />
          : netId ? <Network key={`${netId}-${rev}`} id={netId} notify={notify} reload={reload}
              onEditNet={(n) => setModal({ kind: 'net', net: n })} onDeleteNet={delNet} />
          : loaded && (
            <div class="page welcome">
              <h1>Witaj w simpleIPAM</h1>
              {!tenants.length ? (
                <>
                  {isAdmin ? <>
                    <p class="muted">Zacznij od utworzenia tenanta (np. <b>rodzina</b>), potem dodaj w nim lokalizacje: <b>dom1</b>, <b>lab2</b>, <b>cloud-aws</b>. W lokalizacji utworzysz sieci z VLAN-em i DHCP.</p>
                    <button class="btn primary" onClick={() => setModal({ kind: 'tenant' })}><Icon name="plus" />Dodaj tenanta</button>
                  </> : <p class="muted">Nie masz jeszcze dostępu do żadnej lokalizacji. Poproś administratora o nadanie uprawnień.</p>}
                </>
              ) : tenants.map((t) => (
                <div class="tenant-block">
                  <div class="tenant-title">
                    <h2><Icon name="tenant" /> {t.name}</h2>
                    {t.description && <span class="muted">{t.description}</span>}
                    <span class="spacer" />
                    {t.role === 'admin' && <button class="btn small ghost" onClick={() => setModal({ kind: 'site', tenantId: t.id })}><Icon name="plus" size={14} />Lokalizacja</button>}
                    {isAdmin && <button class="btn small ghost danger" onClick={() => delTenant(t)} aria-label="Usuń tenanta"><Icon name="trash" size={14} /></button>}
                  </div>
                  {!t.sites.length && <p class="muted">Brak lokalizacji.</p>}
                  <div class="grid">
                    {t.sites.map((s) => (
                      <section class="card">
                        <h3><Icon name={s.icon} /> {s.name} <span class={`role-badge ${s.role}`}>{ROLE_LABELS[s.role]}</span></h3>
                        <p class="muted">{s.description || `${s.networks.length} sieci`}</p>
                        {s.networks.map((n) => (
                          <a class="net-row" href={`#/n/${n.id}`}><span>{n.name}</span><span class="mono muted">{n.cidr}</span>
                            <span class="muted">{n.stats.used}/{n.stats.total}</span></a>
                        ))}
                        <div class="card-actions">
                          {s.role === 'admin' ? <button class="btn small ghost" onClick={() => setModal({ kind: 'net', siteId: s.id })}><Icon name="plus" size={14} />Sieć</button> : <span />}
                          {t.role === 'admin' && <button class="btn small ghost danger" onClick={() => delSite(s)} aria-label="Usuń lokalizację"><Icon name="trash" size={14} /></button>}
                        </div>
                      </section>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
      </main>

      {modal?.kind === 'tenant' && <TenantForm tenant={modal.tenant} notify={notify} onClose={() => setModal(null)}
        onSaved={() => { setModal(null); reload(); notify('Zapisano'); }} />}
      {modal?.kind === 'site' && <SiteForm site={modal.site} tenantId={modal.tenantId} notify={notify} onClose={() => setModal(null)}
        onSaved={() => { setModal(null); reload(); notify('Zapisano'); }} />}
      {modal?.kind === 'net' && <NetworkForm net={modal.net} siteId={modal.siteId} notify={notify} onClose={() => setModal(null)}
        onSaved={(n) => { setModal(null); setRev(rev + 1); reload(); notify('Zapisano'); go(`#/n/${n.id}`); }} />}
      {modal?.kind === 'tokens' && <Tokens notify={notify} onClose={() => setModal(null)} />}
      {modal?.kind === 'pw' && <PasswordForm me={me} googleReady={googleReady} notify={notify} onClose={() => setModal(null)} />}
      {palette && <Palette sites={sites} go={go} onClose={() => setPalette(false)} />}
      <Toasts items={toasts} />
    </div>
  );
}
