import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from './api.js';
import { Icon, Modal, Field, TYPE_LABELS, STATUS_LABELS, RANK } from './ui.jsx';
import { t } from './i18n.js';

const ipNum = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const intIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const ipOf = (n) => intIp(n);

function EditableCell({ value, placeholder, onSave, mono, readOnly }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input class={`cell-input ${mono ? 'mono' : ''}`} value={v} placeholder={placeholder}
      readOnly={readOnly} onInput={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setV(value); e.target.blur(); } }} />
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
            {Object.entries(STATUS_LABELS).map(([k, l]) => <option value={k}>{l}</option>)}
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
  for (let n = lo; n <= hi; n++) {
    const e = byNum.get(n);
    let cls = 'free';
    if (e) cls = e.status === 'reserved' ? 'reserved' : e.status === 'free' ? 'free' : 'used';
    else if (n === gw) cls = 'gw';
    else if (n >= ds && n <= de) cls = 'dhcp';
    const title = `${ipOf(n)}${e?.fqdn ? ` · ${e.fqdn}` : ''}${n === gw ? ` · ${t('brama')}` : ''}${!e && n >= ds && n <= de ? ' · DHCP' : ''}`;
    cells.push(<button key={n} class={`ipcell ${cls}`} title={title} aria-label={title} onClick={() => onPick(n, e)} />);
  }
  return (
    <>
      <div class="ipmap">{cells}</div>
      <div class="legend">
        {[['used', 'Zajęty'], ['reserved', 'Zarezerwowany'], ['dhcp', 'DHCP'], ['gw', 'Brama'], ['free', 'Wolny']].map(([c, l]) => (
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
  const [sel, setSel] = useState(new Set());
  const [sort, setSort] = useState({ key: 'ip', dir: 1 });

  const load = () => {
    api.network(id).then(setNet).catch((e) => notify(e.message, 'error'));
    api.issues(id).then(setIssues).catch(() => setIssues([]));
    api.discovered(id).then(setFound).catch(() => setFound([]));
    setSel(new Set());
  };
  useEffect(() => { setNet(null); setQ(''); load(); }, [id]);
  const refresh = () => { load(); reload(); };

  const byNum = useMemo(() => new Map((net?.entries ?? []).map((e) => [ipNum(e.ip), e])), [net]);
  const rows = useMemo(() => {
    const s = q.toLowerCase();
    const list = (net?.entries ?? []).filter((e) =>
      (status === 'all' || e.status === status) &&
      (!s || [e.ip, e.fqdn, e.alias, e.mac, e.tags, e.description, TYPE_LABELS[e.type]].some((v) => v?.toLowerCase().includes(s))));
    const val = (e) => (sort.key === 'ip' ? ipNum(e.ip) : (e[sort.key] ?? '').toString().toLowerCase());
    return list.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
  }, [net, q, status, sort]);

  if (!net) return <div class="skeleton" />;
  const canEdit = RANK[net.role] >= RANK.contributor;
  const isAdmin = net.role === 'admin';
  const st = net.stats;
  const pct = Math.round((st.used / Math.max(1, st.total)) * 100);

  const patch = async (e, changes) => {
    try { await api.saveEntry({ ...e, ...changes }); load(); reload(); }
    catch (err) { notify(err.message, 'error'); load(); }
  };
  const macAct = async (e, action) => {
    try { await api.macAction(e.id, action); notify(action === 'accept' ? t('MAC {ip} zaktualizowany', { ip: e.ip }) : 'Zignorowano ten adres MAC'); refresh(); }
    catch (err) { notify(err.message, 'error'); }
  };
  const remove = async (e) => {
    if (!confirm(t('Usunąć {name}?', { name: `${e.ip}${e.fqdn ? ` (${e.fqdn})` : ''}` }))) return;
    await api.delEntry(e.id); notify('Usunięto wpis'); refresh();
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

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <div class="crumb">{net.tenant.name} / {net.site.name}</div>
          <h1>{net.name} <span class="mono cidr">{net.cidr}</span></h1>
          <div class="chips">
            {net.vlan && <span class="chip accent">VLAN {net.vlan}</span>}
            {net.gateway && <span class="chip">{t('Brama')} <b class="mono">{net.gateway}</b></span>}
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
        <div class="card stat"><span>{t('Wykorzystanie')}</span><b>{pct}%</b>
          <div class="bar"><i style={{ width: `${pct}%` }} /></div></div>
        <div class="card stat"><span>{t('Zajęte')}</span><b>{st.used - st.reserved}</b></div>
        <div class="card stat"><span>{t('Zarezerwowane')}</span><b>{st.reserved}</b></div>
        <div class="card stat"><span>{t('Pula DHCP')}</span><b>{st.dhcp}</b></div>
        <div class="card stat"><span>{t('Dostępne łącznie')}</span><b>{st.total}</b></div>
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

      <section class="card">
        <h3>{t('Mapa adresów')}</h3>
        <IpMap net={net} byNum={byNum} onPick={pick} />
      </section>

      <section class="card">
        <div class="toolbar">
          <div class="search-box"><Icon name="search" size={16} />
            <input placeholder={t('Filtruj wpisy…')} value={q} onInput={(e) => setQ(e.target.value)} /></div>
          <div class="segmented" role="tablist">
            {[['all', 'Wszystkie'], ['used', 'Zajęte'], ['reserved', 'Rezerwacje']].map(([k, l]) => (
              <button class={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{t(l)}</button>
            ))}
          </div>
          <div class="spacer" />
          <button class="btn ghost" onClick={() => setHist(true)}><Icon name="history" />{t('Historia')}</button>
          {canEdit && <button class="btn ghost" onClick={() => setScan(true)}><Icon name="radar" />{t('Skanuj')}</button>}
          <button class="btn ghost" onClick={() => setDns(true)} title={t('Porównuje FQDN wpisów z tym, co odpowiada DNS')}><Icon name="search" />DNS</button>
          <details class="menu">
            <summary class="btn ghost"><Icon name="download" />{t('Eksport')}</summary>
            <div class="menu-list">
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
          onDelete={() => confirm(t('Usunąć {n} wpisów?', { n: sel.size })) && bulk({ action: 'delete' }, 'Usunięto')} />}
        <div class="table-wrap">
          <table>
            <thead><tr>
              {canEdit && <th class="check"><input type="checkbox" checked={allOn} aria-label={t('Zaznacz wszystkie')}
                onChange={() => setSel(allOn ? new Set() : new Set(rows.map((e) => e.id)))} /></th>}
              {th('ip', 'IP')}{th('fqdn', 'FQDN')}{th('alias', 'Alias')}{th('mac', 'MAC')}{th('type', 'Typ')}{th('status', 'Status')}{th('description', 'Opis')}{th('last_seen', 'Widziany')}<th />
            </tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} class={sel.has(e.id) ? 'selected' : ''}>
                  {canEdit && <td class="check"><input type="checkbox" checked={sel.has(e.id)} onChange={() => toggle(e.id)} aria-label={t('Zaznacz {ip}', { ip: e.ip })} /></td>}
                  <td class="mono ip">{e.ip}</td>
                  <td><EditableCell readOnly={!canEdit} value={e.fqdn} placeholder="—" onSave={(v) => patch(e, { fqdn: v })} />
                    {e.uplink && <div class="uplink muted small-text" title={t('Podłączony do (UniFi)')}>↳ {e.uplink}</div>}</td>
                  <td><EditableCell readOnly={!canEdit} value={e.alias} placeholder="—" onSave={(v) => patch(e, { alias: v })} /></td>
                  <td class="mono muted">{e.mac || '—'}
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
                  </td>
                  <td><span class="chip">{TYPE_LABELS[e.type]}</span></td>
                  <td>
                    <select class={`status-select ${e.status}`} disabled={!canEdit} value={e.status} onChange={(ev) => patch(e, { status: ev.target.value })}>
                      {Object.entries(STATUS_LABELS).map(([k, l]) => <option value={k}>{l}</option>)}
                    </select>
                  </td>
                  <td><EditableCell readOnly={!canEdit} value={e.description} placeholder="—" onSave={(v) => patch(e, { description: v })} />
                    {e.tags && <div class="tags">{e.tags.split(',').map((tg) => <span class="tag">#{tg}</span>)}</div>}</td>
                  <td class="muted small-text nowrap" title={e.last_seen ?? ''}>{ago(e.last_seen)}</td>
                  <td class="row-actions">
                    <button class="icon-btn" onClick={() => setHist(e)} aria-label={t('Historia {ip}', { ip: e.ip })} title={t('Historia zmian')}><Icon name="history" size={16} /></button>
                    {canEdit && <><button class="icon-btn" onClick={() => setForm(e)} aria-label={t('Edytuj')}><Icon name="edit" size={16} /></button>
                    <button class="icon-btn danger" onClick={() => remove(e)} aria-label={t('Usuń')}><Icon name="trash" size={16} /></button></>}
                  </td>
                </tr>
              ))}
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
