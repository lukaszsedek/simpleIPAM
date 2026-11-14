import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from './api.js';
import { Icon, Modal, Field, Logo, Toasts, SITE_ICONS, ROLE_LABELS } from './ui.jsx';
import { Network } from './Network.jsx';
import { Admin } from './Admin.jsx';
import { AuthScreen } from './Auth.jsx';
// `tx`, not `t`: tenants are called `t` all over this file.
import { t as tx, useLang, setLang, getLang, LANGS } from './i18n.js';

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
        <Field label="Nazwa" span><input value={f.name} onInput={(e) => setF({ ...f, name: e.target.value })} placeholder={tx('dom1, lab2, cloud-aws…')} required /></Field>
        <Field label="Opis" span><input value={f.description} onInput={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Ikona" span>
          <div class="icon-picker">
            {SITE_ICONS.map((i) => (
              <button type="button" class={f.icon === i ? 'on' : ''} onClick={() => setF({ ...f, icon: i })} aria-label={i}><Icon name={i} /></button>
            ))}
          </div>
        </Field>
        <footer>
          <button type="button" class="btn ghost" onClick={onClose}>{tx('Anuluj')}</button>
          <button class="btn primary">{tx('Zapisz')}</button>
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
        <Field label="Nazwa" span><input value={f.name} onInput={(e) => setF({ ...f, name: e.target.value })} placeholder={tx('rodzina, firma, klient-x…')} required /></Field>
        <Field label="Opis" span><input value={f.description} onInput={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <footer>
          <button type="button" class="btn ghost" onClick={onClose}>{tx('Anuluj')}</button>
          <button class="btn primary">{tx('Zapisz')}</button>
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
        <Field label="Nazwa"><input value={f.name} onInput={set('name')} placeholder={tx('LAN, IoT, Goście…')} required /></Field>
        <Field label="CIDR"><input class="mono" value={f.cidr} onInput={set('cidr')} placeholder="192.168.10.0/24" required /></Field>
        <Field label="VLAN"><input type="number" min="1" max="4094" value={f.vlan ?? ''} onInput={set('vlan')} /></Field>
        <Field label="Brama"><input class="mono" value={f.gateway} onInput={set('gateway')} placeholder="192.168.10.1" /></Field>
        <Field label="DHCP od"><input class="mono" value={f.dhcp_start} onInput={set('dhcp_start')} /></Field>
        <Field label="DHCP do"><input class="mono" value={f.dhcp_end} onInput={set('dhcp_end')} /></Field>
        <Field label="DNS" span><input class="mono" value={f.dns} onInput={set('dns')} placeholder="1.1.1.1, 192.168.10.2" /></Field>
        <Field label="Opis" span><input value={f.description} onInput={set('description')} /></Field>
        <label class="toggle span"><input type="checkbox" checked={!!f.auto_scan} onChange={(e) => setF({ ...f, auto_scan: e.target.checked ? 1 : 0 })} />
          {tx('Skanuj automatycznie (ping) i wykrywaj nowe urządzenia')}</label>
        {!net?.id && <FreeBlock siteId={siteId} onPick={(cidr) => setF({ ...f, cidr })} notify={notify} />}
        <footer>
          <button type="button" class="btn ghost" onClick={onClose}>{tx('Anuluj')}</button>
          <button class="btn primary">{tx('Zapisz')}</button>
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
      <span class="muted small-text">{tx('Znajdź wolną podsieć w zakresie')}</span>
      <div class="with-btn">
        <input class="mono" value={within} onInput={(e) => setWithin(e.target.value)} aria-label={tx('Zakres nadrzędny')} />
        <select value={prefix} onChange={(e) => setPrefix(e.target.value)} aria-label={tx('Prefiks')}>
          {[30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20].map((p) => <option value={p}>/{p}</option>)}
        </select>
        <button type="button" class="btn ghost" onClick={search}><Icon name="wand" />{tx('Szukaj')}</button>
      </div>
      {found && (found.length
        ? <div class="role-chips">{found.map((c) => <button type="button" class="chip pick" onClick={() => onPick(c)}>{c}</button>)}</div>
        : <span class="muted small-text">{tx('Brak wolnych bloków w tym zakresie.')}</span>)}
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
        <footer><button type="button" class="btn ghost" onClick={onClose}>{tx('Anuluj')}</button><button class="btn primary">{tx('Zmień')}</button></footer>
      </form>
      {googleReady && (
        <div class="google-link">
          {me.google_email
            ? <p class="muted small-text">{tx('Połączone konto Google:')} <b>{me.google_email}</b> — {tx('możesz się nim logować.')}{' '}
                {me.has_password ? <button type="button" class="link-btn" onClick={() => api.googleUnlink().then(() => { notify('Konto Google odłączone'); onClose(); setTimeout(() => location.reload(), 600); }).catch((e) => notify(e.message, 'error'))}>{tx('Odłącz')}</button>
                  : <span>{tx('Ustaw hasło powyżej, aby móc odłączyć Google.')}</span>}</p>
            : <button type="button" class="btn ghost block" onClick={() => api.googleStart(true).then((r) => { location.href = r.url; }).catch((e) => notify(e.message, 'error'))}>{tx('Połącz z kontem Google')}</button>}
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
      <p class="muted small-text">{tx('Token działa jak Ty (te same role). Użyj go w nagłówku')} <span class="mono">Authorization: Bearer …</span>. {tx('Opis wszystkich endpointów:')} <a href="/api/docs" target="_blank" rel="noreferrer">{tx('dokumentacja API')}</a> (<a href="/api/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a>).</p>
      {fresh && (
        <div class="token-new">
          <span>{tx('Skopiuj teraz — nie zobaczysz go ponownie:')}</span>
          <code class="mono">{fresh.token}</code>
          <button class="btn small" onClick={() => navigator.clipboard?.writeText(fresh.token).then(() => notify('Skopiowano'))}><Icon name="copy" size={14} />{tx('Kopiuj')}</button>
        </div>
      )}
      <form class="with-btn" onSubmit={create}>
        <input class="token-name" placeholder={tx('nazwa, np. skrypt backupu')} value={name} onInput={(e) => setName(e.target.value)} required />
        <button class="btn primary">{tx('Utwórz token')}</button>
      </form>
      <ul class="scan-list">
        {list.map((k) => (
          <li><span><b>{k.name}</b><div class="muted small-text">{tx('utworzony {d}', { d: k.created_at.slice(0, 10) })} · {k.last_used ? tx('użyty {d}', { d: k.last_used }) : tx('nieużywany')}</div></span>
            <button class="btn small ghost danger" onClick={async () => { await api.delToken(k.id); load(); }}>{tx('Odwołaj')}</button></li>
        ))}
        {!list.length && <li class="muted">{tx('Brak tokenów.')}</li>}
      </ul>
    </Modal>
  );
}

function Palette({ sites, onClose, go }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [sel, setSel] = useState(0);
  const nav = useMemo(() => [
    { label: tx('Dziennik zmian'), sub: tx('Historia'), to: '#/audit' },
    ...sites.flatMap((s) => s.networks.map((n) => ({ label: `${s.name} / ${n.name}`, sub: n.cidr, to: `#/n/${n.id}` }))),
  ], [sites, getLang()]);
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
          <input autofocus placeholder={tx('Szukaj IP, FQDN, MAC, sieci…')} value={q} onInput={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={key} /></div>
        <ul>
          {items.map((i, idx) => (
            <li class={idx === sel ? 'on' : ''} onMouseEnter={() => setSel(idx)} onClick={() => { go(i.to); onClose(); }}>
              <span class="mono">{i.label}</span><small>{i.sub}</small>
            </li>
          ))}
          {!items.length && <li class="muted">{tx('Brak wyników')}</li>}
        </ul>
      </div>
    </div>
  );
}

export function App() {
  useLang();      // re-render everything on a language switch
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
  const [menu, setMenu] = useState(false);   // profile dropdown
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menu) return undefined;
    const off = (e) => { if (!menuRef.current?.contains(e.target)) setMenu(false); };
    const esc = (e) => { if (e.key === 'Escape') setMenu(false); };
    addEventListener('mousedown', off); addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', off); removeEventListener('keydown', esc); };
  }, [menu]);
  const [toasts, setToasts] = useState([]);
  const [rev, setRev] = useState(0);
  const [theme, setTheme] = useState(() => { try { return localStorage.theme || 'system'; } catch { return 'system'; } });   // light | dark | system
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
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = (theme === 'system' ? mq.matches : theme === 'dark') ? 'dark' : 'light'; };
    apply();
    if (theme !== 'system') return undefined;
    mq.addEventListener('change', apply);      // follow the OS while in "system" mode
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    const f = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); } };
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, []);
  useEffect(() => setNav(false), [hash]);

  const toggleTheme = () => {
    const next = { light: 'dark', dark: 'system', system: 'light' }[theme];
    setTheme(next);
    try { localStorage.theme = next; } catch {}
  };

  const netId = (/^#\/n\/(\d+)/.exec(hash) ?? [])[1];
  // Locations start collapsed (just the list); the one holding the open network is shown expanded so you can see where you are.
  const siteOpen = (s) => open[s.id] ?? s.networks.some((n) => String(n.id) === netId);
  const isAdmin = me?.global_role === 'admin';
  // legacy #/users and #/audit still work
  const adminTab = isAdmin ? (/^#\/admin(?:\/(\w+))?/.exec(hash)?.[1] ?? (hash === '#/users' ? 'users' : hash === '#/audit' ? 'audit' : hash.startsWith('#/admin') ? 'users' : null)) : null;
  const refreshMe = () => api.me().then((r) => setMe(r.user)).catch(() => {});   // e.g. the pending-users badge
  const logout = async () => { await api.logout(); setOpen({}); setMe(null); setTenants([]); setLoaded(false); go('#/'); };

  const delTenant = async (t) => {
    if (!confirm(tx('Usunąć tenanta „{name}” razem z {n} lokalizacjami i wszystkimi danymi?', { name: t.name, n: t.sites.length }))) return;
    await api.delTenant(t.id); notify('Usunięto tenanta'); go('#/'); reload();
  };
  const delSite = async (s) => {
    if (!confirm(tx('Usunąć lokalizację „{name}” razem ze wszystkimi sieciami i wpisami?', { name: s.name }))) return;
    await api.delSite(s.id); notify('Usunięto lokalizację'); go('#/'); reload();
  };
  const delNet = async (n) => {
    if (!confirm(tx('Usunąć sieć „{name}” ({cidr}) razem ze wszystkimi wpisami?', { name: n.name, cidr: n.cidr }))) return;
    await api.delNetwork(n.id); notify('Usunięto sieć'); go('#/'); reload();
  };

  if (me === undefined) return null;
  if (!me) return <AuthScreen google={googleReady} version={version} setup={setupRequired} registrationOpen={regOpen} onAuth={(u) => { setSetupRequired(false); setMe(u); go('#/'); }} />;

  return (
    <div class="shell">
      <aside class={`sidebar ${nav ? 'open' : ''}`}>
        <a class="brand" href="#/" aria-label={tx('Strona główna')}><Logo size={28} />simpleIPAM</a>
        <button class="search-trigger" onClick={() => setPalette(true)}>
          <Icon name="search" size={16} /><span>{tx('Szukaj…')}</span><kbd>⌘K</kbd>
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
                  <button class="icon-btn" aria-label={tx('Dodaj lokalizację')} title={tx('Dodaj lokalizację')} onClick={() => setModal({ kind: 'site', tenantId: t.id })}><Icon name="plus" size={14} /></button>
                  <button class="icon-btn" aria-label={tx('Edytuj tenanta')} onClick={() => setModal({ kind: 'tenant', tenant: t })}><Icon name="edit" size={14} /></button>
                </>}
              </div>
              {open[`t${t.id}`] !== false && t.sites.map((s) => (
                <div class="site">
                  <div class="site-head">
                    <button class="site-btn" aria-expanded={siteOpen(s)} onClick={() => setOpen({ ...open, [s.id]: !siteOpen(s) })}>
                      <Icon name={s.icon} size={16} /><span>{s.name}</span><small>{s.networks.length}</small>
                      <span class={`chev ${siteOpen(s) ? 'open' : ''}`}><Icon name="chevron" size={14} /></span>
                    </button>
                    {s.role === 'admin' && <button class="icon-btn" aria-label={tx('Edytuj lokalizację')} onClick={() => setModal({ kind: 'site', site: s })}><Icon name="edit" size={14} /></button>}
                  </div>
                  {siteOpen(s) && (
                    <div class="nets">
                      {s.networks.map((n) => {
                        const pct = Math.round((n.stats.used / Math.max(1, n.stats.total)) * 100);
                        return (
                          <a href={`#/n/${n.id}`} class={String(n.id) === netId ? 'on' : ''} title={`${n.name} · ${n.cidr}${n.vlan ? ` · VLAN ${n.vlan}` : ''}`}>
                            <span class="net-top">
                              <span class="net-name">{n.name}</span>
                              {n.stats.new_hosts > 0 && <b class="badge" title={tx('Nowe urządzenia')}>{n.stats.new_hosts}</b>}
                              {n.vlan && <span class="vlan-pill">VLAN {n.vlan}</span>}
                            </span>
                            <span class="net-bottom"><span class="mono">{n.cidr}</span><span>{pct}%</span></span>
                            <span class="mini-bar"><i style={{ width: `${pct}%` }} /></span>
                          </a>
                        );
                      })}
                      {s.role === 'admin' && <button class="add-net" onClick={() => setModal({ kind: 'net', siteId: s.id })}><Icon name="plus" size={14} />{tx('Dodaj sieć')}</button>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </nav>
        <div class="side-foot">
          {isAdmin && <button class="btn ghost block" onClick={() => setModal({ kind: 'tenant' })}><Icon name="plus" />{tx('Tenant')}</button>}
          {version && <a class="version" href="https://github.com/lukaszsedek/simpleIPAM/releases" target="_blank" rel="noopener" title={tx('Historia wersji')}>simpleIPAM v{version.replace(/^v/, '')}</a>}
        </div>
      </aside>

      <a class="skip-link" href="#content" onClick={(e) => { e.preventDefault(); document.getElementById('content')?.focus(); }}>{tx('Przejdź do treści')}</a>
      <main id="content" tabIndex={-1}>
        <header class="topbar">
          {isAdmin && (
            <a class={`btn ghost small admin-link ${adminTab ? 'on' : ''}`} href="#/admin" title={tx('Administracja')}>
              <Icon name="settings" size={16} /><span>{tx('Administracja')}</span>{me.pending_users > 0 && <b class="badge" title={tx('Użytkownicy bez uprawnień')}>{me.pending_users}</b>}
            </a>
          )}
          <div class="profile" ref={menuRef}>
            <button class="profile-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <span class="avatar" aria-hidden="true">{me.username.slice(0, 1).toUpperCase()}</span>
              <span class="who"><b>{me.username}</b><small>{ROLE_LABELS[me.global_role]}</small></span>
              <Icon name="chevron" size={14} />
            </button>
            {menu && (
              <div class="menu" role="menu">
                <div class="menu-head"><b>{me.username}</b><span class={`role-badge ${me.global_role}`}>{ROLE_LABELS[me.global_role]}</span></div>
                <button role="menuitem" onClick={() => { setMenu(false); setModal({ kind: 'tokens' }); }}><Icon name="code" size={16} />{tx('Tokeny API')}</button>
                <button role="menuitem" onClick={() => { setMenu(false); setModal({ kind: 'pw' }); }}><Icon name="key" size={16} />{me.has_password ? tx('Zmień hasło') : tx('Hasło i konto Google')}</button>
                <button role="menuitem" onClick={toggleTheme}><Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'settings'} size={16} />{tx('Motyw')}: {tx({ light: 'jasny', dark: 'ciemny', system: 'systemowy' }[theme])}</button>
                <div class="menu-lang" role="group" aria-label={tx('Język')}>
                  {Object.entries(LANGS).map(([k, l]) => <button type="button" class={getLang() === k ? 'on' : ''} onClick={() => setLang(k)}>{k.toUpperCase()}<span class="sr-only"> {l}</span></button>)}
                </div>
                <hr />
                <button role="menuitem" class="danger" onClick={() => { setMenu(false); logout(); }}><Icon name="logout" size={16} />{tx('Wyloguj')}</button>
              </div>
            )}
          </div>
        </header>
        <button class="menu-btn icon-btn" onClick={() => setNav(!nav)} aria-label="Menu"><Icon name="menu" /></button>
        {adminTab ? <Admin tab={adminTab} tenants={tenants} me={me} notify={notify} onUsersChanged={refreshMe} />
          : netId ? <Network key={`${netId}-${rev}`} id={netId} notify={notify} reload={reload}
              onEditNet={(n) => setModal({ kind: 'net', net: n })} onDeleteNet={delNet} />
          : loaded && (
            <div class="page welcome">
              <h1>{tx('Witaj w simpleIPAM')}</h1>
              {!tenants.length ? (
                <>
                  {isAdmin ? <>
                    <p class="muted">{tx('Zacznij od utworzenia tenanta (np. rodzina), potem dodaj w nim lokalizacje: dom1, lab2, cloud-aws. W lokalizacji utworzysz sieci z VLAN-em i DHCP.')}</p>
                    <button class="btn primary" onClick={() => setModal({ kind: 'tenant' })}><Icon name="plus" />{tx('Dodaj tenanta')}</button>
                  </> : <p class="muted">{tx('Nie masz jeszcze dostępu do żadnej lokalizacji. Poproś administratora o nadanie uprawnień.')}</p>}
                </>
              ) : tenants.map((t) => (
                <div class="tenant-block">
                  <div class="tenant-title">
                    <h2><Icon name="tenant" /> {t.name}</h2>
                    {t.description && <span class="muted">{t.description}</span>}
                    <span class="spacer" />
                    {t.role === 'admin' && <button class="btn small ghost" onClick={() => setModal({ kind: 'site', tenantId: t.id })}><Icon name="plus" size={14} />{tx('Lokalizacja')}</button>}
                    {isAdmin && <button class="btn small ghost danger" onClick={() => delTenant(t)} aria-label={tx('Usuń tenanta')}><Icon name="trash" size={14} /></button>}
                  </div>
                  {!t.sites.length && <p class="muted">{tx('Brak lokalizacji.')}</p>}
                  <div class="grid">
                    {t.sites.map((s) => (
                      <section class="card">
                        <h3><Icon name={s.icon} /> {s.name} <span class={`role-badge ${s.role}`}>{ROLE_LABELS[s.role]}</span></h3>
                        <p class="muted">{s.description || tx('{n} sieci', { n: s.networks.length })}</p>
                        {s.networks.map((n) => (
                          <a class="net-row" href={`#/n/${n.id}`}><span>{n.name}</span><span class="mono muted">{n.cidr}</span>
                            <span class="muted">{n.stats.used}/{n.stats.total}</span></a>
                        ))}
                        <div class="card-actions">
                          {s.role === 'admin' ? <button class="btn small ghost" onClick={() => setModal({ kind: 'net', siteId: s.id })}><Icon name="plus" size={14} />{tx('Sieć')}</button> : <span />}
                          {t.role === 'admin' && <button class="btn small ghost danger" onClick={() => delSite(s)} aria-label={tx('Usuń lokalizację')}><Icon name="trash" size={14} /></button>}
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
