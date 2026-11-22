import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from './api.js';
import { Icon, Modal, Field, TYPE_LABELS, STATUS_LABELS, RANK, ask } from './ui.jsx';
import { t, getLang } from './i18n.js';

const ipNum = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const intIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const ipOf = (n) => intIp(n);

const inPool = (net, ip) => !!net.dhcp_start && ipNum(ip) >= ipNum(net.dhcp_start) && ipNum(ip) <= ipNum(net.dhcp_end);
// Outside the DHCP pool an address is static by definition (nothing to reserve); inside it is a dynamic lease or a DHCP reservation.
const statusChoices = (net, ip, current) => {
  const pool = inPool(net, ip ?? '');
  const base = pool ? [['used', 'Dynamiczny (DHCP)'], ['reserved', 'Rezerwacja DHCP']] : [['used', 'Statyczny']];
  if (!pool && current === 'reserved') base.push(['reserved', 'Zarezerwowany ⚠ (poza pulą)']);      // legacy value, flagged under "To review"
  return [...base, ['free', 'Wolny']];
};

// onSave resolves to true when the value was stored; the cell then flashes a tick so the edit never goes unnoticed.
function EditableCell({ value, placeholder, onSave, mono, readOnly, className = '' }) {
  const [v, setV] = useState(value);
  const [tick, setTick] = useState(false);
  useEffect(() => setV(value), [value]);
  const save = async () => {
    if (v === value) return;
    if (await onSave(v)) { setTick(true); setTimeout(() => setTick(false), 1400); }
  };
  return (
    <span class="cell-wrap">
      <input class={`cell-input ${mono ? 'mono' : ''} ${className}`} value={v} placeholder={placeholder}
        readOnly={readOnly} onInput={(e) => setV(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setV(value); e.target.blur(); } }} />
      {tick && <i class="saved-tick" role="status" aria-label={t('Zapisano')}><Icon name="check" size={12} /></i>}
    </span>
  );
}

function EntryForm({ net, entry, onClose, onSaved, notify }) {
  const [f, setF] = useState({ type: 'other', status: 'used', ...entry });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.saveEntry({ ...f, network_id: net.id });
      notify(entry?.id ? 'Zapisano zmiany' : 'Dodano wpis');
      onSaved();
    } catch (err) { notify(err.message, 'error'); setBusy(false); }
  };
  const suggest = async () => setF({ ...f, ip: (await api.nextFree(net.id)).ip ?? '' });
  return (
    <Modal title={entry?.id ? t('Edytuj {ip}', { ip: entry.ip }) : 'Nowy wpis'} onClose={onClose}>
      <form class="form-grid" onSubmit={submit}>
        <Field label="Adres IP">
          <div class="with-btn">
            <input class="mono" value={f.ip ?? ''} onInput={set('ip')} required placeholder={net.cidr.replace(/\.0\//, '.x/')} />
            {!entry?.id && <button type="button" class="btn ghost" onClick={suggest} title={t('Następny wolny')}><Icon name="wand" /></button>}
          </div>
        </Field>
        <Field label="FQDN"><input value={f.fqdn ?? ''} onInput={set('fqdn')} placeholder="nas.home.lan" /></Field>
        <Field label="Alias" hint="przyjazna nazwa; zgodna z aliasem w UniFi"><input value={f.alias ?? ''} onInput={set('alias')} placeholder={t('NAS w salonie')} /></Field>
        <Field label="MAC"><input class="mono" value={f.mac ?? ''} onInput={set('mac')} placeholder="aa:bb:cc:dd:ee:ff" /></Field>
        <Field label="Typ">
          <select value={f.type} onChange={set('type')}>
            {Object.entries(TYPE_LABELS).map(([k, l]) => <option value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select value={f.status} onChange={set('status')}>
            {statusChoices(net, f.ip, f.status).map(([k, l]) => <option value={k}>{t(l)}</option>)}
          </select>
        </Field>
        <Field label="Tagi" hint="rozdzielone przecinkami"><input value={f.tags ?? ''} onInput={set('tags')} placeholder={t('iot, kuchnia')} /></Field>
        <Field label="Opis" span><input value={f.description ?? ''} onInput={set('description')} /></Field>
        <Field label="Ważny do"><input type="date" value={f.expires_at ?? ''} onInput={set('expires_at')} /></Field>
        <footer>
          <button type="button" class="btn ghost" onClick={onClose}>{t('Anuluj')}</button>
          <button class="btn primary" disabled={busy}>{t('Zapisz')}</button>
        </footer>
      </form>
    </Modal>
  );
}

function ScanModal({ net, onClose, onAdd }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => { api.scan(net.id).then((r) => setState({ alive: r.alive, macs: r.macs })).catch((e) => setState({ error: e.message })); }, []);
  const fresh = state.alive?.filter((a) => !a.known) ?? [];
  return (
    <Modal title={t('Skan {cidr}', { cidr: net.cidr })} onClose={onClose}>
      {state.loading && <div class="scan"><div class="radar" /><p>{t('Skanowanie sieci (ping)…')}</p></div>}
      {state.error && <p class="error-text">{t(state.error)}</p>}
      {state.alive && (
        <>
          <p class="muted">{t('Aktywne hosty: {a}, nieznane w IPAM: {n}', { a: state.alive.length, n: fresh.length })}</p>
          <ul class="scan-list">
            {fresh.map((a) => (
              <li><span class="mono">{a.ip}</span>{a.mac && <span class="mono muted small-text">{a.mac}</span>}<button class="btn small" onClick={() => onAdd(a.ip)}>{t('Dodaj')}</button></li>
            ))}
            {!fresh.length && <li class="muted">{t('Wszystkie aktywne hosty są już w bazie')} 🎉</li>}
          </ul>
          {state.alive.length > 0 && !state.macs && (
            <p class="muted small-text">{t('Nie odczytano żadnych adresów MAC. Aplikacja widzi je tylko w swoim segmencie sieci — w Dockerze uruchom kontener z')} <span class="mono">network_mode: host</span> {t('(Linux), aby wykrywać zmiany MAC.')}</p>
          )}
        </>
      )}
    </Modal>
  );
}

const FIELD_LABELS = { ip: 'IP', fqdn: 'FQDN', alias: 'Alias', mac: 'MAC', type: 'Typ', status: 'Status', tags: 'Tagi', description: 'Opis', expires_at: 'Ważny do', reservation: 'Rezerwacja DHCP' };
const show = (k, v) => (v === '' || v == null ? '∅' : k === 'type' ? TYPE_LABELS[v] ?? v : k === 'status' ? STATUS_LABELS[v] ?? v : v);
const ACTIONS = { create: 'dodano', update: 'zmieniono', delete: 'usunięto', mac_seen: 'zauważył inny MAC', mac_ignored: 'zignorowano MAC', pushed: 'wysłano do UniFi' };

// Change log of one entry (or, without `entry`, of the whole network).
function HistoryModal({ net, entry, onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { (entry ? api.entryHistory(entry.id) : api.networkHistory(net.id)).then(setRows).catch(() => setRows([])); }, []);
  return (
    <Modal title={entry ? t('Historia {ip}', { ip: entry.ip }) : t('Historia zmian · {name}', { name: net.name })} onClose={onClose} wide>
      {!rows && <p class="muted">{t('Ładowanie…')}</p>}
      {rows && !rows.length && <p class="muted">{t('Brak zapisanych zmian. Historia jest prowadzona od chwili wdrożenia tej funkcji.')}</p>}
      {rows && <ul class="timeline history">
        {rows.map((r) => (
          <li>
            <i class={`dot ${r.action === 'delete' ? 'delete' : r.action === 'create' ? 'create' : 'update'}`} />
            <span>
              <b>{r.actor || t('system')}</b> {t(ACTIONS[r.action] ?? r.action)}{!entry && <> <span class="mono">{r.ip}</span></>}
              <span class="diffs">
                {Object.entries(r.changes).map(([k, [a, b]]) => (
                  <span class="diff"><em>{t(FIELD_LABELS[k] ?? k)}</em>{r.action === 'create' ? <b>{show(k, b)}</b> : r.action === 'delete' ? <s>{show(k, a)}</s> : <><s>{show(k, a)}</s> → <b>{show(k, b)}</b></>}</span>
                ))}
              </span>
            </span>
            <time>{r.ts}</time>
          </li>
        ))}
      </ul>}
    </Modal>
  );
}

// Hovering or focusing a map cell lights the matching table row and vice versa (both carry data-n = numeric address).
// A toolbar dropdown opens towards the right and flips to the left only when it would leave the window.
const placeMenu = (e) => {
  const d = e.currentTarget;
  const list = d.querySelector('.menu-list');
  if (!d.open || !list) return;
  list.classList.remove('flip');
  if (list.getBoundingClientRect().right > innerWidth - 8) list.classList.add('flip');
};
let lit = [];
const light = (n) => {
  lit.forEach((x) => x.classList.remove('hot'));
  lit = n == null ? [] : [...document.querySelectorAll(`[data-n="${n}"]`)];
  lit.forEach((x) => x.classList.add('hot'));
};
const hotOf = (ev) => { const el = ev.target.closest?.('[data-n]'); light(el ? el.dataset.n : null); };

const ago = (ts) => {
  if (!ts) return '—';
  const m = Math.round((Date.now() - new Date(ts.replace(' ', 'T') + 'Z')) / 60000);
  if (m < 2) return t('teraz');
  if (m < 60) return t('{n} min temu', { n: m });
  if (m < 48 * 60) return t('{n} godz. temu', { n: Math.round(m / 60) });
  return t('{n} dni temu', { n: Math.round(m / 1440) });
};

// Resolves every FQDN of the network from the server and lists the entries whose DNS record is missing or points elsewhere.
function DnsModal({ net, onClose }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => { api.dnsCheck(net.id).then(setState).catch((e) => setState({ error: e.message })); }, []);
  const bad = state.results?.filter((r) => r.result !== 'ok') ?? [];
  return (
    <Modal title="Spójność DNS" onClose={onClose} wide>
      {state.loading && <div class="scan"><div class="radar" /><p>{t('Sprawdzam DNS…')}</p></div>}
      {state.error && <p class="error-text">{t(state.error)}</p>}
      {state.results && (
        <>
          <p class="muted">{t('Sprawdzono nazw: {n}, rozbieżności: {p}', { n: state.checked, p: state.problems })}</p>
          <ul class="scan-list">
            {bad.map((r) => (
              <li><span class="mono">{r.ip}</span><b>{r.fqdn}</b>
                <span class={r.result === 'missing' ? 'muted small-text' : 'error-text small-text'}>
                  {r.result === 'missing' ? t('brak rekordu A w DNS') : t('DNS wskazuje {ips}', { ips: r.resolved.join(', ') })}</span></li>
            ))}
            {!bad.length && <li class="muted">{state.checked ? t('Wszystkie nazwy wskazują na właściwe adresy') : t('Brak wpisów z FQDN do sprawdzenia')} 🎉</li>}
          </ul>
        </>
      )}
    </Modal>
  );
}

function BulkBar({ count, onApply, onDelete, onClear }) {
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [tags, setTags] = useState('');
  const changes = { ...(type && { type }), ...(status && { status }), ...(tags.trim() && { add_tags: tags }) };
  return (
    <div class="bulk">
      <b>{t('{n} zaznaczonych', { n: count })}</b>
      <select value={type} onChange={(e) => setType(e.target.value)}>
        <option value="">{t('typ…')}</option>{Object.entries(TYPE_LABELS).map(([k, l]) => <option value={k}>{l}</option>)}
      </select>
      <select value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">{t('status…')}</option>{Object.entries(STATUS_LABELS).map(([k, l]) => <option value={k}>{l}</option>)}
      </select>
      <input placeholder={t('dodaj tagi…')} value={tags} onInput={(e) => setTags(e.target.value)} />
      <button class="btn small primary" disabled={!Object.keys(changes).length} onClick={() => onApply(changes)}>{t('Zastosuj')}</button>
      <span class="spacer" />
      <button class="btn small ghost danger" onClick={onDelete}><Icon name="trash" size={14} />{t('Usuń')}</button>
      <button class="btn small ghost" onClick={onClear}>{t('Anuluj')}</button>
    </div>
  );
}

function IpMap({ net, byNum, onPick }) {
  // Phones get rows of 8 (bigger cells) and a first tap that only selects.
  const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 560px)').matches;
  const per = narrow ? 8 : 16;
  const [sel, setSel] = useState(null);
  const [lo, hi] = useMemo(() => {
    const [a, p] = net.cidr.split('/');
    const size = 2 ** (32 - Number(p));
    const base = Math.floor(ipNum(a) / size) * size;
    return Number(p) >= 31 ? [base, base + size - 1] : [base + 1, base + size - 2];
  }, [net.cidr]);
  if (hi - lo > 1024) return <p class="muted">{t('Mapa adresów jest dostępna dla sieci /22 i mniejszych.')}</p>;
  const gw = net.gateway ? ipNum(net.gateway) : -1;
  const ds = net.dhcp_start ? ipNum(net.dhcp_start) : -1;
  const de = net.dhcp_end ? ipNum(net.dhcp_end) : -2;
  const cells = [];
  const sys = (n, label) => <span key={`s${n}`} class="ipcell sys" title={`${ipOf(n)} · ${label}`} aria-label={`${ipOf(n)} · ${label}`} />;
  // Patch-panel layout: rows of 16, each led by the row's first address, each cell carrying its last octet.
  const first = net.network_addr ? lo - 1 : lo;
  const wide = hi - lo > 255;
  const rowLabel = (n) => (wide ? `${(n >>> 8) & 255}.${n & 255}` : `.${n & 255}`);
  const rowPool = (n) => ds >= 0 && n + per - 1 >= ds && n <= de;
  const pad = first % per;
  const put = (n, node) => {
    if (n % per === 0 || cells.length === 0) cells.push(<span key={`r${n}`} class={`rowlab${rowPool(n - (n % per)) ? ' pool' : ''}`} aria-hidden="true" title={rowPool(n - (n % per)) ? 'DHCP' : undefined}>{rowLabel(n - (n % per))}</span>);
    if (cells.length === 1) for (let i = 0; i < pad; i++) cells.push(<span key={`p${i}`} class="ipcell pad" aria-hidden="true" />);
    cells.push(node);
  };
  if (net.network_addr) put(lo - 1, sys(lo - 1, t('adres sieci')));
  for (let n = lo; n <= hi; n++) {
    const e = byNum.get(n);
    const pool = n >= ds && n <= de;
    let cls = 'free';
    if (e && e.status !== 'free') cls = !pool ? 'used' : e.status === 'reserved' ? 'reserved' : 'dynamic';      // outside the pool everything is static
    else if (n === gw) cls = 'gw';
    else if (pool) cls = 'dhcp';
    const title = `${ipOf(n)}${e?.fqdn ? ` · ${e.fqdn}` : ''}${n === gw ? ` · ${t('brama')}` : ''}${!e && n >= ds && n <= de ? ' · DHCP' : ''}`;
    put(n, <button key={n} data-n={n} class={`ipcell ${cls}${sel === n ? ' picked' : ''}`} title={title} aria-label={title} onClick={() => (narrow && sel !== n ? setSel(n) : onPick(n, e))}><span aria-hidden="true">{n & 255}</span></button>);
  }
  if (net.broadcast_addr) put(hi + 1, sys(hi + 1, t('adres rozgłoszeniowy (broadcast)')));
  return (
    <>
      <div class="ipmap" style={{ '--per': per }} role="group" aria-label={t('Mapa adresów')} onMouseOver={hotOf} onMouseLeave={() => light(null)} onFocusIn={hotOf} onFocusOut={() => light(null)}>{cells}</div>
      {narrow && sel != null && (
        <div class="cellbar">
          <span class="mono">{ipOf(sel)}</span><span class="muted">{byNum.get(sel)?.fqdn ?? ''}</span>
          <button class="btn small primary" onClick={() => onPick(sel, byNum.get(sel))}>{t(byNum.get(sel) ? 'Edytuj' : 'Dodaj')}</button>
        </div>
      )}
      <div class="legend">
        {[['used', 'Statyczny'], ['reserved', 'Rezerwacja DHCP'], ['dynamic', 'Dynamiczny'], ['dhcp', 'Pula DHCP'], ['gw', 'Brama'], ['sys', 'Sieć / broadcast'], ['free', 'Wolny']].map(([c, l]) => (
          <span><i class={`ipcell ${c}`} />{t(l)}</span>
        ))}
      </div>
    </>
  );
}

export function Network({ id, notify, reload, onEditNet, onDeleteNet }) {
  const [net, setNet] = useState(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [form, setForm] = useState(null);
  const [scan, setScan] = useState(false);
  const [dns, setDns] = useState(false);
  const [hist, setHist] = useState(null);   // entry, or true for the whole network
  const [issues, setIssues] = useState([]);
  const [found, setFound] = useState([]);
  const [chg, setChg] = useState(null);
  const [chgDays, setChgDays] = useState(() => { try { return Number(localStorage.chgDays) || 1; } catch { return 1; } });
  const [sel, setSel] = useState(new Set());
  const [sort, setSort] = useState({ key: 'ip', dir: 1 });
  const [cols, setCols] = useState(() => { try { return { mac: true, type: true, desc: true, ...JSON.parse(localStorage.cols) }; } catch { return { mac: true, type: true, desc: true }; } });
  const setCol = (k, v) => { const n = { ...cols, [k]: v }; setCols(n); try { localStorage.cols = JSON.stringify(n); } catch { /* not persisted */ } };

  const load = () => {
    api.network(id).then(setNet).catch((e) => notify(e.message, 'error'));
    api.issues(id).then(setIssues).catch(() => setIssues([]));
    api.discovered(id).then(setFound).catch(() => setFound([]));
    api.changes(id, chgDays).then(setChg).catch(() => setChg(null));
    setSel(new Set());
  };
  useEffect(() => { setNet(null); setQ(''); load(); }, [id, chgDays]);
  const refresh = () => { load(); reload(); };

  const byNum = useMemo(() => new Map((net?.entries ?? []).map((e) => [ipNum(e.ip), e])), [net]);
  const rows = useMemo(() => {
    const s = q.toLowerCase();
    const list = (net?.entries ?? []).filter((e) =>
      (status === 'all' || (status === 'static' ? !inPool(net, e.ip) : status === 'pool' ? inPool(net, e.ip) : e.status === status)) &&
      (!s || [e.ip, e.fqdn, e.alias, e.mac, e.tags, e.description, TYPE_LABELS[e.type]].some((v) => v?.toLowerCase().includes(s))));
    const val = (e) => (sort.key === 'ip' ? ipNum(e.ip) : (e[sort.key] ?? '').toString().toLowerCase());
    return list.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
  }, [net, q, status, sort]);

  if (!net) return <div class="skeleton" />;
  const canEdit = RANK[net.role] >= RANK.contributor;
  const isAdmin = net.role === 'admin';
  const st = net.stats;
  const pct = Math.round(((st.used + (st.infra ?? 0)) / Math.max(1, st.total)) * 100);

  // Stores a change and offers to undo it (the old values of just the touched fields are put back on top of the current entry).
  const patch = async (e, changes) => {
    const before = Object.fromEntries(Object.keys(changes).map((k) => [k, e[k] ?? '']));
    try {
      await api.saveEntry({ ...e, ...changes }); load(); reload();
      notify('Zapisano', 'ok', { label: 'Cofnij', fn: async () => {
        try {
          const cur = (await api.network(net.id)).entries.find((x) => x.id === e.id);
          if (cur) await api.saveEntry({ ...cur, ...before });
          notify('Cofnięto'); refresh();
        } catch (err) { notify(err.message, 'error'); }
      } });
      return true;
    } catch (err) { notify(err.message, 'error'); load(); return false; }
  };
  // Deleting can be undone by creating the entries again (their history starts over).
  const restore = async (list) => {
    try { for (const e of list) await api.saveEntry({ ...e, id: undefined, network_id: net.id }); notify('Wpisy przywrócone'); refresh(); }
    catch (err) { notify(err.message, 'error'); refresh(); }
  };
  const macAct = async (e, action) => {
    try { await api.macAction(e.id, action); notify(action === 'accept' ? t('MAC {ip} zaktualizowany', { ip: e.ip }) : 'Zignorowano ten adres MAC'); refresh(); }
    catch (err) { notify(err.message, 'error'); }
  };
  const remove = async (e) => {
    if (!await ask(t('Usunąć {name}?', { name: `${e.ip}${e.fqdn ? ` (${e.fqdn})` : ''}` }), { title: 'Usuń wpis' })) return;
    await api.delEntry(e.id); notify('Usunięto wpis', 'ok', { label: 'Cofnij', fn: () => restore([e]) }); refresh();
  };
  const importFile = async (ev) => {
    const file = ev.target.files[0]; ev.target.value = '';
    if (!file) return;
    try {
      const r = await api.importCsv(net.id, await file.text());
      notify(`${t('Import')}: +${r.added}, ${t('zaktualizowano')} ${r.updated}${r.errors.length ? `, ${t('błędy')}: ${r.errors.length}` : ''}`, r.errors.length ? 'error' : 'ok');
      if (r.errors.length) console.warn(r.errors);
      refresh();
    } catch (err) { notify(err.message, 'error'); }
  };
  const toggle = (id) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = rows.length > 0 && rows.every((e) => sel.has(e.id));
  const bulk = async (body, msg) => {
    try { const r = await api.bulk(net.id, { ids: [...sel], ...body }); notify(`${t(msg)}: ${r.affected}`); refresh(); }
    catch (err) { notify(err.message, 'error'); }
  };
  const th = (key, label) => (
    <th class="sortable" tabIndex={0} onClick={() => setSort({ key, dir: sort.key === key ? -sort.dir : 1 })}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSort({ key, dir: sort.key === key ? -sort.dir : 1 }); } }} aria-sort={sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
      {t(label)}{sort.key === key && <span class="arrow">{sort.dir > 0 ? '▲' : '▼'}</span>}
    </th>
  );
  const pick = (n, e) => canEdit && (e ? setForm(e) : setForm({ ip: ipOf(n) }));

  // Network address, gateway and broadcast are part of every subnet but are not entries; they get pinned, read-only rows.
  const showSys = !q && status === 'all';
  const sysRow = (kind, ip, label, hint, extra = {}) => (
    <tr key={kind} class="sys-row">
      {canEdit && <td class="check" />}
      <td class="mono ip">{ip}<div class="muted small-text nowrap">{extra.seen ?? ''}</div></td>
      <td class="name-cell" title={extra.title ?? ''}><b>{label}</b><div class="muted small-text">{hint}</div></td>
      {cols.mac && <td class={`mono muted c-mac${extra.mac ? '' : ' none'}`}>{extra.mac || '—'}</td>}
      {cols.type && <td class="c-type">{extra.type && <span class="chip">{extra.type}</span>}</td>}
      <td class="c-status"><span class="chip">{t('Systemowy')}</span></td>
      {cols.desc && <td class="c-desc" />}
      <td class="row-actions">{extra.actions}</td>
    </tr>
  );
  const gwHasEntry = !!net.gateway && net.entries.some((e) => e.ip === net.gateway);
  const gwRow = net.gateway && !gwHasEntry && sysRow('gw', net.gateway, t('Brama domyślna'), t('router sieci'), {
    title: t('nie jest nowym urządzeniem — wpisz ją, żeby dodać nazwę i MAC'), mac: net.gateway_mac, type: TYPE_LABELS.router, seen: net.gateway_seen ? ago(net.gateway_seen) : '',
    actions: canEdit && <button class="btn small ghost" onClick={() => setForm({ ip: net.gateway, type: 'router', mac: net.gateway_mac, alias: t('Brama') })}>{t('Zapisz jako wpis')}</button>,
  });

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <div class="crumb">{net.tenant.name} / {net.site.name}</div>
          <h1>{net.name} <span class="mono cidr">{net.cidr}</span></h1>
          <div class="chips">
            {net.vlan && <span class="chip accent">VLAN {net.vlan}</span>}
            {net.gateway && <span class="chip" title={net.gateway_seen ? `${t('widziana')} ${ago(net.gateway_seen)}${net.gateway_mac ? ` · ${net.gateway_mac}` : ''}` : ''}>{t('Brama')} <b class="mono">{net.gateway}</b></span>}
            {net.network_addr && <span class="chip muted-chip">{t('Adres sieci')} <b class="mono">{net.network_addr}</b></span>}
            {net.broadcast_addr && <span class="chip muted-chip">Broadcast <b class="mono">{net.broadcast_addr}</b></span>}
            {net.dhcp_start && <span class="chip">DHCP <b class="mono">{net.dhcp_start} – {net.dhcp_end}</b></span>}
            {net.dns && <span class="chip">DNS <b class="mono">{net.dns}</b></span>}
          </div>
          {net.description && <p class="muted">{net.description}</p>}
        </div>
        {isAdmin && <div class="head-actions">
          <button class="btn ghost" onClick={() => onEditNet(net)}><Icon name="edit" />{t('Edytuj')}</button>
          <button class="btn ghost danger" onClick={() => onDeleteNet(net)}><Icon name="trash" /></button>
        </div>}
      </header>

      <section class="stats">
        <div class="stat"><span>{t('Wykorzystanie')}</span><b>{pct}%</b>
          <div class="bar"><i style={{ width: `${pct}%` }} /></div></div>
        <div class="stat"><span>{t('Statyczne')}</span><b>{st.static}</b></div>
        {st.dhcp > 0 && <>
          <div class="stat"><span>{t('Rezerwacje DHCP')}</span><b>{st.dhcp_reserved}</b></div>
          <div class="stat"><span>{t('Dynamiczne (DHCP)')}</span><b>{st.dynamic}</b></div>
          <div class="stat"><span>{t('Pula DHCP')}</span><b>{st.dhcp}</b></div>
        </>}
        <div class="stat"><span>{t('Dostępne łącznie')}</span><b>{st.total}</b></div>
      </section>

      {issues.length > 0 && (
        <section class="card">
          <h3>{t('Do sprawdzenia')} ({issues.length})</h3>
          <div class="issues">
            {issues.map((i) => <div class={`issue ${i.level}`}>{t(i.text)}</div>)}
          </div>
        </section>
      )}

      {found.length > 0 && (
        <section class="card">
          <h3>{t('Nowe urządzenia w sieci')} ({found.length})</h3>
          <p class="muted small-text">{t('Odpowiadają na ping albo zgłasza je kontroler UniFi, ale nie ma ich w IPAM.')}</p>
          <ul class="scan-list">
            {found.map((d) => (
              <li><span class="mono">{d.ip}</span>{d.name && <b>{d.name}</b>}{d.mac && <span class="mono muted small-text">{d.mac}</span>}<span class="muted small-text">{t('wykryto {when}', { when: ago(d.first_seen) })}</span>
                {canEdit && <span class="row-btns">
                  <button class="btn small" onClick={() => setForm({ ip: d.ip, mac: d.mac, alias: d.name })}>{t('Dodaj')}</button>
                  <button class="btn small ghost" onClick={async () => { await api.dismiss(d.id); load(); reload(); }}>{t('Ignoruj')}</button>
                </span>}</li>
            ))}
          </ul>
        </section>
      )}

      {chg && (chg.appeared.length + chg.silent.length + chg.added.length + chg.removed.length > 0 || chgDays > 1) && (
        <section class="card changes">
          <div class="card-head">
            <h3>{t('Co się zmieniło')}</h3>
            <div class="segmented" role="group" aria-label={t('Co się zmieniło')}>
              {[[1, 'ostatnie 24 h'], [7, 'ostatnie 7 dni'], [30, 'ostatnie 30 dni']].map(([d, l]) => (
                <button class={chgDays === d ? 'on' : ''} aria-pressed={chgDays === d} onClick={() => { setChgDays(d); try { localStorage.chgDays = d; } catch { /* not persisted */ } }}>{t(l)}</button>
              ))}
            </div>
          </div>
          {chg.appeared.length + chg.silent.length + chg.added.length + chg.removed.length === 0 && <p class="muted small-text">{t('Brak zmian w tym okresie.')}</p>}
          <div class="change-groups">
            {chg.appeared.length > 0 && <div><h4>{t('Pojawiły się')} ({chg.appeared.length})</h4>
              <ul>{chg.appeared.map((d) => <li><span class="mono">{d.ip}</span><span class="muted small-text">{d.mac}</span></li>)}</ul></div>}
            {chg.silent.length > 0 && <div><h4>{t('Przestały odpowiadać')} ({chg.silent.length})</h4>
              <ul>{chg.silent.map((e) => <li><span class="mono">{e.ip}</span><span>{e.alias || e.fqdn}</span><span class="muted small-text">{t('ostatnio widziany {when}', { when: ago(e.last_seen) })}</span></li>)}</ul></div>}
            {chg.added.length > 0 && <div><h4>{t('Dodane wpisy')} ({chg.added.length})</h4>
              <ul>{chg.added.map((a) => <li><span class="mono">{a.ip}</span><span class="muted small-text">{ago(a.ts)}</span></li>)}</ul></div>}
            {chg.removed.length > 0 && <div><h4>{t('Usunięte wpisy')} ({chg.removed.length})</h4>
              <ul>{chg.removed.map((a) => <li><span class="mono">{a.ip}</span><span class="muted small-text">{ago(a.ts)}</span></li>)}</ul></div>}
          </div>
        </section>
      )}

      <section class="card">
        <h3>{t('Mapa adresów')}</h3>
        <IpMap net={net} byNum={byNum} onPick={pick} />
      </section>

      <section class="card">
        <div class="toolbar">
          <div class="search-box"><Icon name="search" size={16} />
            <input placeholder={t('Filtruj wpisy…')} value={q} onInput={(e) => setQ(e.target.value)} /></div>
          <div class="segmented" role="tablist">
            {[['all', 'Wszystkie'], ['static', 'Statyczne'], ['pool', 'Pula DHCP'], ['reserved', 'Rezerwacje']].map(([k, l]) => (
              <button class={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{t(l)}</button>
            ))}
          </div>
          <div class="spacer" />
          <button class="btn ghost" onClick={() => setHist(true)}><Icon name="history" />{t('Historia')}</button>
          {canEdit && <button class="btn ghost" onClick={() => setScan(true)}><Icon name="radar" />{t('Skanuj')}</button>}
          <button class="btn ghost" onClick={() => setDns(true)} title={t('Porównuje FQDN wpisów z tym, co odpowiada DNS')}><Icon name="search" />DNS</button>
          <details class="menu" onToggle={placeMenu}>
            <summary class="btn ghost"><Icon name="menu" />{t('Kolumny')}</summary>
            <div class="menu-list cols-menu">
              {[['mac', 'MAC'], ['type', 'Typ'], ['desc', 'Opis']].map(([k, l]) => <label class="toggle"><input type="checkbox" checked={cols[k]} onChange={(e) => setCol(k, e.target.checked)} /> {t(l)}</label>)}
            </div>
          </details>
          <details class="menu" onToggle={placeMenu}>
            <summary class="btn ghost"><Icon name="download" />{t('Eksport')}</summary>
            <div class="menu-list">
              <a href={`/api/networks/${net.id}/export.xlsx?lang=${getLang()}`}>{t('Excel (.xlsx)')}<small>{t('dla tej sieci')}</small></a>
              <a href={`/api/export.xlsx?lang=${getLang()}`}>{t('Eksport do Excela')}<small>{t('wszystkie sieci, arkusz na sieć')}</small></a>
              <a href={`/api/networks/${net.id}/export.csv`}>CSV<small>{t('wszystkie pola, do importu')}</small></a>
              <a href={`/api/networks/${net.id}/export/hosts`}>hosts<small>/etc/hosts</small></a>
              <a href={`/api/networks/${net.id}/export/dnsmasq`}>dnsmasq / Pi-hole<small>host-record + dhcp-host</small></a>
              <a href={`/api/networks/${net.id}/export/bind`}>BIND<small>{t('rekordy A')}</small></a>
            </div>
          </details>
          {canEdit && <label class="btn ghost"><Icon name="upload" />{t('Import')}<input type="file" accept=".csv,text/csv" hidden onChange={importFile} /></label>}
          {canEdit && <button class="btn primary" onClick={async () => setForm({ ip: (await api.nextFree(net.id)).ip ?? '' })}>
            <Icon name="plus" />{t('Dodaj')}</button>}
        </div>

        {sel.size > 0 && <BulkBar count={sel.size} onClear={() => setSel(new Set())}
          onApply={(changes) => bulk({ action: 'update', changes }, 'Zmieniono')}
          onDelete={async () => {
            if (!await ask(t('Usunąć {n} wpisów?', { n: sel.size }), { title: 'Usuń wpisy' })) return;
            const gone = net.entries.filter((e) => sel.has(e.id));
            try { const r = await api.bulk(net.id, { ids: [...sel], action: 'delete' }); notify(t('Usunięto wpisów: {n}', { n: r.affected }), 'ok', { label: 'Cofnij', fn: () => restore(gone) }); refresh(); }
            catch (err) { notify(err.message, 'error'); }
          }} />}
        <div class="table-wrap">
          <table>
            <thead><tr>
              {canEdit && <th class="check"><input type="checkbox" checked={allOn} aria-label={t('Zaznacz wszystkie')}
                onChange={() => setSel(allOn ? new Set() : new Set(rows.map((e) => e.id)))} /></th>}
              {th('ip', 'IP')}{th('fqdn', 'Nazwa / alias')}{cols.mac && th('mac', 'MAC')}{cols.type && th('type', 'Typ')}{th('status', 'Status')}{cols.desc && th('description', 'Opis')}<th />
            </tr></thead>
            <tbody>
              {showSys && net.network_addr && sysRow('net', net.network_addr, t('Adres sieci'), t('zarezerwowany'))}
              {showSys && gwRow}
              {rows.map((e) => (
                <tr key={e.id} data-n={ipNum(e.ip)} class={sel.has(e.id) ? 'selected' : ''} onMouseEnter={() => light(ipNum(e.ip))} onMouseLeave={() => light(null)}>
                  {canEdit && <td class="check"><input type="checkbox" checked={sel.has(e.id)} onChange={() => toggle(e.id)} aria-label={t('Zaznacz {ip}', { ip: e.ip })} /></td>}
                  <td class="mono ip">{e.ip}<div class="muted small-text nowrap" title={e.last_seen ?? ''}>{e.last_seen ? ago(e.last_seen) : ''}</div></td>
                  <td class="name-cell"><EditableCell readOnly={!canEdit} value={e.fqdn} placeholder="FQDN" onSave={(v) => patch(e, { fqdn: v })} />
                    <EditableCell readOnly={!canEdit} className="alias" value={e.alias} placeholder={t('Alias')} onSave={(v) => patch(e, { alias: v })} />
                    {e.uplink && <div class="uplink muted small-text" title={t('Podłączony do (UniFi)')}>↳ {e.uplink}</div>}</td>
                  {cols.mac && <td class={`mono muted c-mac${e.mac || e.mac_alert || e.mac_suggest ? '' : ' none'}`}>{e.mac || '—'}
                    {e.mac_alert && (
                      <div class="mac-alert" role="alert">
                        <span title={t('Skan widzi inny adres MAC niż zapisany')}>⚠ {t('widziany:')} {e.seen_mac}</span>
                        {canEdit && <div class="mac-actions"><button class="btn small" onClick={() => macAct(e, 'accept')}>{t('Zatwierdź')}</button>
                        <button class="btn small ghost" onClick={() => macAct(e, 'ignore')}>{t('Ignoruj')}</button></div>}
                      </div>
                    )}
                    {e.mac_suggest && (
                      <div class="mac-suggest">{t('wykryty:')} {e.seen_mac}{canEdit && <button class="link-btn" onClick={() => macAct(e, 'accept')}>{t('użyj')}</button>}</div>
                    )}
                  </td>}
                  {cols.type && <td class="c-type"><span class="chip">{TYPE_LABELS[e.type]}</span></td>}
                  <td class="c-status">
                    <select class={`status-select ${e.status}`} disabled={!canEdit} value={e.status} onChange={(ev) => patch(e, { status: ev.target.value })}>
                      {statusChoices(net, e.ip, e.status).map(([k, l]) => <option value={k}>{t(l)}</option>)}
                    </select>
                  </td>
                  {cols.desc && <td class={`c-desc${e.description || e.tags ? '' : ' none'}`}><EditableCell readOnly={!canEdit} value={e.description} placeholder="—" onSave={(v) => patch(e, { description: v })} />
                    {e.tags && <div class="tags">{e.tags.split(',').map((tg) => <button class="tag" onClick={() => setQ(tg)} title={t('Filtruj wpisy…')}>#{tg}</button>)}</div>}</td>}
                  <td class="row-actions">
                    <button class="icon-btn" onClick={() => setHist(e)} aria-label={t('Historia {ip}', { ip: e.ip })} title={t('Historia zmian')}><Icon name="history" size={16} /></button>
                    {canEdit && <><button class="icon-btn" onClick={() => setForm(e)} aria-label={t('Edytuj')}><Icon name="edit" size={16} /></button>
                    <button class="icon-btn danger" onClick={() => remove(e)} aria-label={t('Usuń')}><Icon name="trash" size={16} /></button></>}
                  </td>
                </tr>
              ))}
              {showSys && net.broadcast_addr && sysRow('bc', net.broadcast_addr, t('Adres rozgłoszeniowy (broadcast)'), t('zarezerwowany'))}
            </tbody>
          </table>
          {!rows.length && <div class="empty">{t(net.entries.length ? 'Brak wyników.' : canEdit ? 'Ta sieć jest jeszcze pusta — dodaj pierwszy wpis lub zaimportuj CSV.' : 'Ta sieć jest jeszcze pusta.')}</div>}
        </div>
      </section>

      {form && <EntryForm net={net} entry={form} notify={notify} onClose={() => setForm(null)} onSaved={() => { setForm(null); refresh(); }} />}
      {hist && <HistoryModal net={net} entry={hist === true ? null : hist} onClose={() => setHist(null)} />}
      {dns && <DnsModal net={net} onClose={() => setDns(false)} />}
      {scan && <ScanModal net={net} onClose={() => setScan(false)} onAdd={(ip) => { setScan(false); setForm({ ip }); }} />}
    </div>
  );
}
