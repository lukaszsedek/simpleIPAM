import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from './api.js';
import { Icon, Modal, Field, TYPE_LABELS, STATUS_LABELS, RANK } from './ui.jsx';

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
    <Modal title={entry?.id ? `Edytuj ${entry.ip}` : 'Nowy wpis'} onClose={onClose}>
      <form class="form-grid" onSubmit={submit}>
        <Field label="Adres IP">
          <div class="with-btn">
            <input class="mono" value={f.ip ?? ''} onInput={set('ip')} required placeholder={net.cidr.replace(/\.0\//, '.x/')} />
            {!entry?.id && <button type="button" class="btn ghost" onClick={suggest} title="Następny wolny"><Icon name="wand" /></button>}
          </div>
        </Field>
        <Field label="FQDN"><input value={f.fqdn ?? ''} onInput={set('fqdn')} placeholder="nas.home.lan" /></Field>
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
        <Field label="Tagi" hint="rozdzielone przecinkami"><input value={f.tags ?? ''} onInput={set('tags')} placeholder="iot, kuchnia" /></Field>
        <Field label="Opis" span><input value={f.description ?? ''} onInput={set('description')} /></Field>
        <footer>
          <button type="button" class="btn ghost" onClick={onClose}>Anuluj</button>
          <button class="btn primary" disabled={busy}>Zapisz</button>
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
    <Modal title={`Skan ${net.cidr}`} onClose={onClose}>
      {state.loading && <div class="scan"><div class="radar" /><p>Skanowanie sieci (ping)…</p></div>}
      {state.error && <p class="error-text">{state.error}</p>}
      {state.alive && (
        <>
          <p class="muted">Aktywne hosty: {state.alive.length}, nieznane w IPAM: {fresh.length}</p>
          <ul class="scan-list">
            {fresh.map((a) => (
              <li><span class="mono">{a.ip}</span>{a.mac && <span class="mono muted small-text">{a.mac}</span>}<button class="btn small" onClick={() => onAdd(a.ip)}>Dodaj</button></li>
            ))}
            {!fresh.length && <li class="muted">Wszystkie aktywne hosty są już w bazie 🎉</li>}
          </ul>
          {state.alive.length > 0 && !state.macs && (
            <p class="muted small-text">Nie odczytano żadnych adresów MAC. Aplikacja widzi je tylko w swoim segmencie sieci — w Dockerze uruchom kontener z <span class="mono">network_mode: host</span> (Linux), aby wykrywać zmiany MAC.</p>
          )}
        </>
      )}
    </Modal>
  );
}

const FIELD_LABELS = { ip: 'IP', fqdn: 'FQDN', mac: 'MAC', type: 'Typ', status: 'Status', tags: 'Tagi', description: 'Opis' };
const show = (k, v) => (v === '' || v == null ? '∅' : k === 'type' ? TYPE_LABELS[v] ?? v : k === 'status' ? STATUS_LABELS[v] ?? v : v);
const ACTIONS = { create: 'dodano', update: 'zmieniono', delete: 'usunięto', mac_seen: 'zauważył inny MAC', mac_ignored: 'zignorowano MAC' };

// Change log of one entry (or, without `entry`, of the whole network).
function HistoryModal({ net, entry, onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { (entry ? api.entryHistory(entry.id) : api.networkHistory(net.id)).then(setRows).catch(() => setRows([])); }, []);
  return (
    <Modal title={entry ? `Historia ${entry.ip}` : `Historia zmian · ${net.name}`} onClose={onClose} wide>
      {!rows && <p class="muted">Ładowanie…</p>}
      {rows && !rows.length && <p class="muted">Brak zapisanych zmian. Historia jest prowadzona od chwili wdrożenia tej funkcji.</p>}
      {rows && <ul class="timeline history">
        {rows.map((r) => (
          <li>
            <i class={`dot ${r.action === 'delete' ? 'delete' : r.action === 'create' ? 'create' : 'update'}`} />
            <span>
              <b>{r.actor || 'system'}</b> {ACTIONS[r.action] ?? r.action}{!entry && <> <span class="mono">{r.ip}</span></>}
              <span class="diffs">
                {Object.entries(r.changes).map(([k, [a, b]]) => (
                  <span class="diff"><em>{FIELD_LABELS[k] ?? k}</em>{r.action === 'create' ? <b>{show(k, b)}</b> : r.action === 'delete' ? <s>{show(k, a)}</s> : <><s>{show(k, a)}</s> → <b>{show(k, b)}</b></>}</span>
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
  if (m < 2) return 'teraz';
  if (m < 60) return `${m} min temu`;
  if (m < 48 * 60) return `${Math.round(m / 60)} godz. temu`;
  return `${Math.round(m / 1440)} dni temu`;
};

function BulkBar({ count, onApply, onDelete, onClear }) {
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [tags, setTags] = useState('');
  const changes = { ...(type && { type }), ...(status && { status }), ...(tags.trim() && { add_tags: tags }) };
  return (
    <div class="bulk">
      <b>{count} zaznaczonych</b>
      <select value={type} onChange={(e) => setType(e.target.value)}>
        <option value="">typ…</option>{Object.entries(TYPE_LABELS).map(([k, l]) => <option value={k}>{l}</option>)}
      </select>
      <select value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">status…</option>{Object.entries(STATUS_LABELS).map(([k, l]) => <option value={k}>{l}</option>)}
      </select>
      <input placeholder="dodaj tagi…" value={tags} onInput={(e) => setTags(e.target.value)} />
      <button class="btn small primary" disabled={!Object.keys(changes).length} onClick={() => onApply(changes)}>Zastosuj</button>
      <span class="spacer" />
      <button class="btn small ghost danger" onClick={onDelete}><Icon name="trash" size={14} />Usuń</button>
      <button class="btn small ghost" onClick={onClear}>Anuluj</button>
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
  if (hi - lo > 1024) return <p class="muted">Mapa adresów jest dostępna dla sieci /22 i mniejszych.</p>;
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
    const title = `${ipOf(n)}${e?.fqdn ? ` · ${e.fqdn}` : ''}${n === gw ? ' · brama' : ''}${!e && n >= ds && n <= de ? ' · DHCP' : ''}`;
    cells.push(<button key={n} class={`ipcell ${cls}`} title={title} aria-label={title} onClick={() => onPick(n, e)} />);
  }
  return (
    <>
      <div class="ipmap">{cells}</div>
      <div class="legend">
        {[['used', 'Zajęty'], ['reserved', 'Zarezerwowany'], ['dhcp', 'DHCP'], ['gw', 'Brama'], ['free', 'Wolny']].map(([c, l]) => (
          <span><i class={`ipcell ${c}`} />{l}</span>
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
      (!s || [e.ip, e.fqdn, e.mac, e.tags, e.description, TYPE_LABELS[e.type]].some((v) => v?.toLowerCase().includes(s))));
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
    try { await api.macAction(e.id, action); notify(action === 'accept' ? `MAC ${e.ip} zaktualizowany` : 'Zignorowano ten adres MAC'); refresh(); }
    catch (err) { notify(err.message, 'error'); }
  };
  const remove = async (e) => {
    if (!confirm(`Usunąć ${e.ip}${e.fqdn ? ` (${e.fqdn})` : ''}?`)) return;
    await api.delEntry(e.id); notify('Usunięto wpis'); refresh();
  };
  const importFile = async (ev) => {
    const file = ev.target.files[0]; ev.target.value = '';
    if (!file) return;
    try {
      const r = await api.importCsv(net.id, await file.text());
      notify(`Import: +${r.added}, zaktualizowano ${r.updated}${r.errors.length ? `, błędy: ${r.errors.length}` : ''}`, r.errors.length ? 'error' : 'ok');
      if (r.errors.length) console.warn(r.errors);
      refresh();
    } catch (err) { notify(err.message, 'error'); }
  };
  const toggle = (id) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = rows.length > 0 && rows.every((e) => sel.has(e.id));
  const bulk = async (body, msg) => {
    try { const r = await api.bulk(net.id, { ids: [...sel], ...body }); notify(`${msg}: ${r.affected}`); refresh(); }
    catch (err) { notify(err.message, 'error'); }
  };
  const th = (key, label) => (
    <th class="sortable" onClick={() => setSort({ key, dir: sort.key === key ? -sort.dir : 1 })} aria-sort={sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
      {label}{sort.key === key && <span class="arrow">{sort.dir > 0 ? '▲' : '▼'}</span>}
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
            {net.gateway && <span class="chip">Brama <b class="mono">{net.gateway}</b></span>}
            {net.dhcp_start && <span class="chip">DHCP <b class="mono">{net.dhcp_start} – {net.dhcp_end}</b></span>}
            {net.dns && <span class="chip">DNS <b class="mono">{net.dns}</b></span>}
          </div>
          {net.description && <p class="muted">{net.description}</p>}
        </div>
        {isAdmin && <div class="head-actions">
          <button class="btn ghost" onClick={() => onEditNet(net)}><Icon name="edit" />Edytuj</button>
          <button class="btn ghost danger" onClick={() => onDeleteNet(net)}><Icon name="trash" /></button>
        </div>}
      </header>

      <section class="stats">
        <div class="card stat"><span>Wykorzystanie</span><b>{pct}%</b>
          <div class="bar"><i style={{ width: `${pct}%` }} /></div></div>
        <div class="card stat"><span>Zajęte</span><b>{st.used - st.reserved}</b></div>
        <div class="card stat"><span>Zarezerwowane</span><b>{st.reserved}</b></div>
        <div class="card stat"><span>Pula DHCP</span><b>{st.dhcp}</b></div>
        <div class="card stat"><span>Dostępne łącznie</span><b>{st.total}</b></div>
      </section>

      {issues.length > 0 && (
        <section class="card">
          <h3>Do sprawdzenia ({issues.length})</h3>
          <div class="issues">
            {issues.map((i) => <div class={`issue ${i.level}`}>{i.text}</div>)}
          </div>
        </section>
      )}

      {found.length > 0 && (
        <section class="card">
          <h3>Nowe urządzenia w sieci ({found.length})</h3>
          <p class="muted small-text">Odpowiadają na ping albo zgłasza je kontroler UniFi, ale nie ma ich w IPAM.</p>
          <ul class="scan-list">
            {found.map((d) => (
              <li><span class="mono">{d.ip}</span>{d.name && <b>{d.name}</b>}{d.mac && <span class="mono muted small-text">{d.mac}</span>}<span class="muted small-text">wykryto {ago(d.first_seen)}</span>
                {canEdit && <span class="row-btns">
                  <button class="btn small" onClick={() => setForm({ ip: d.ip, mac: d.mac, description: d.name })}>Dodaj</button>
                  <button class="btn small ghost" onClick={async () => { await api.dismiss(d.id); load(); reload(); }}>Ignoruj</button>
                </span>}</li>
            ))}
          </ul>
        </section>
      )}

      <section class="card">
        <h3>Mapa adresów</h3>
        <IpMap net={net} byNum={byNum} onPick={pick} />
      </section>

      <section class="card">
        <div class="toolbar">
          <div class="search-box"><Icon name="search" size={16} />
            <input placeholder="Filtruj wpisy…" value={q} onInput={(e) => setQ(e.target.value)} /></div>
          <div class="segmented" role="tablist">
            {[['all', 'Wszystkie'], ['used', 'Zajęte'], ['reserved', 'Rezerwacje']].map(([k, l]) => (
              <button class={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>
            ))}
          </div>
          <div class="spacer" />
          <button class="btn ghost" onClick={() => setHist(true)}><Icon name="history" />Historia</button>
          {canEdit && <button class="btn ghost" onClick={() => setScan(true)}><Icon name="radar" />Skanuj</button>}
          <details class="menu">
            <summary class="btn ghost"><Icon name="download" />Eksport</summary>
            <div class="menu-list">
              <a href={`/api/networks/${net.id}/export.csv`}>CSV<small>wszystkie pola, do importu</small></a>
              <a href={`/api/networks/${net.id}/export/hosts`}>hosts<small>/etc/hosts</small></a>
              <a href={`/api/networks/${net.id}/export/dnsmasq`}>dnsmasq / Pi-hole<small>host-record + dhcp-host</small></a>
              <a href={`/api/networks/${net.id}/export/bind`}>BIND<small>rekordy A</small></a>
            </div>
          </details>
          {canEdit && <label class="btn ghost"><Icon name="upload" />Import<input type="file" accept=".csv,text/csv" hidden onChange={importFile} /></label>}
          {canEdit && <button class="btn primary" onClick={async () => setForm({ ip: (await api.nextFree(net.id)).ip ?? '' })}>
            <Icon name="plus" />Dodaj</button>}
        </div>

        {sel.size > 0 && <BulkBar count={sel.size} onClear={() => setSel(new Set())}
          onApply={(changes) => bulk({ action: 'update', changes }, 'Zmieniono')}
          onDelete={() => confirm(`Usunąć ${sel.size} wpisów?`) && bulk({ action: 'delete' }, 'Usunięto')} />}
        <div class="table-wrap">
          <table>
            <thead><tr>
              {canEdit && <th class="check"><input type="checkbox" checked={allOn} aria-label="Zaznacz wszystkie"
                onChange={() => setSel(allOn ? new Set() : new Set(rows.map((e) => e.id)))} /></th>}
              {th('ip', 'IP')}{th('fqdn', 'FQDN')}{th('mac', 'MAC')}{th('type', 'Typ')}{th('status', 'Status')}{th('description', 'Opis')}{th('last_seen', 'Widziany')}<th />
            </tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} class={sel.has(e.id) ? 'selected' : ''}>
                  {canEdit && <td class="check"><input type="checkbox" checked={sel.has(e.id)} onChange={() => toggle(e.id)} aria-label={`Zaznacz ${e.ip}`} /></td>}
                  <td class="mono ip">{e.ip}</td>
                  <td><EditableCell readOnly={!canEdit} value={e.fqdn} placeholder="—" onSave={(v) => patch(e, { fqdn: v })} /></td>
                  <td class="mono muted">{e.mac || '—'}
                    {e.mac_alert && (
                      <div class="mac-alert" role="alert">
                        <span title="Skan widzi inny adres MAC niż zapisany">⚠ widziany: {e.seen_mac}</span>
                        {canEdit && <div class="mac-actions"><button class="btn small" onClick={() => macAct(e, 'accept')}>Zatwierdź</button>
                        <button class="btn small ghost" onClick={() => macAct(e, 'ignore')}>Ignoruj</button></div>}
                      </div>
                    )}
                    {e.mac_suggest && (
                      <div class="mac-suggest">wykryty: {e.seen_mac}{canEdit && <button class="link-btn" onClick={() => macAct(e, 'accept')}>użyj</button>}</div>
                    )}
                  </td>
                  <td><span class="chip">{TYPE_LABELS[e.type]}</span></td>
                  <td>
                    <select class={`status-select ${e.status}`} disabled={!canEdit} value={e.status} onChange={(ev) => patch(e, { status: ev.target.value })}>
                      {Object.entries(STATUS_LABELS).map(([k, l]) => <option value={k}>{l}</option>)}
                    </select>
                  </td>
                  <td><EditableCell readOnly={!canEdit} value={e.description} placeholder="—" onSave={(v) => patch(e, { description: v })} />
                    {e.tags && <div class="tags">{e.tags.split(',').map((t) => <span class="tag">#{t}</span>)}</div>}</td>
                  <td class="muted small-text nowrap" title={e.last_seen ?? ''}>{ago(e.last_seen)}</td>
                  <td class="row-actions">
                    <button class="icon-btn" onClick={() => setHist(e)} aria-label={`Historia ${e.ip}`} title="Historia zmian"><Icon name="history" size={16} /></button>
                    {canEdit && <><button class="icon-btn" onClick={() => setForm(e)} aria-label="Edytuj"><Icon name="edit" size={16} /></button>
                    <button class="icon-btn danger" onClick={() => remove(e)} aria-label="Usuń"><Icon name="trash" size={16} /></button></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div class="empty">{net.entries.length ? 'Brak wyników.' : canEdit ? 'Ta sieć jest jeszcze pusta — dodaj pierwszy wpis lub zaimportuj CSV.' : 'Ta sieć jest jeszcze pusta.'}</div>}
        </div>
      </section>

      {form && <EntryForm net={net} entry={form} notify={notify} onClose={() => setForm(null)} onSaved={() => { setForm(null); refresh(); }} />}
      {hist && <HistoryModal net={net} entry={hist === true ? null : hist} onClose={() => setHist(null)} />}
      {scan && <ScanModal net={net} onClose={() => setScan(false)} onAdd={(ip) => { setScan(false); setForm({ ip }); }} />}
    </div>
  );
}
