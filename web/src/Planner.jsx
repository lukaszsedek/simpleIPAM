import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from './api.js';
import { Icon, Modal, Field, ask } from './ui.jsx';
import { t, locale } from './i18n.js';
import { calc4, calc6, split4, split6, summarize4, prefixForHosts, usableOf, bigFmt } from './cidr.js';

const num = (n) => Number(n).toLocaleString(locale());
const ipNum = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const span = (cidr) => { const [ip, p] = cidr.split('/'); const size = 2 ** (32 - Number(p)); const first = Math.floor(ipNum(ip) / size) * size; return { first, size }; };
// Fixed, well separated colours per location (same hue family as the app palette) instead of a computed hue.
const SITE_COLORS = ['#0b7f8a', '#d99a1c', '#6f4fe0', '#c2543d', '#3f8f4a', '#2e6bd1', '#b04a8f', '#8a7a2c'];
const siteColor = (siteId) => SITE_COLORS[(Number(siteId) - 1 + SITE_COLORS.length * 1000) % SITE_COLORS.length];
const pctText = (a, s) => { const p = (a / s) * 100; return p < 0.1 && a ? '<0,1' : p.toFixed(p < 10 ? 1 : 0); };
const vlanOf = (n) => n.vlan ?? 1;

function PoolForm({ tenantId, plan, pool, onClose, onSaved, notify }) {
  const [f, setF] = useState(pool ?? { cidr: '', name: '', description: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    try { await api.savePool(tenantId, f); onSaved(); } catch (err) { notify(err.message, 'error'); }
  };
  const c = f.cidr.includes(':') ? calc6(f.cidr) : calc4(f.cidr);
  return (
    <Modal title={pool ? 'Edytuj pulę' : 'Nowa pula adresowa'} onClose={onClose}>
      <form class="form-grid" onSubmit={submit}>
        <Field label="CIDR" span hint={plan.ipv6 ? 'np. 10.0.0.0/8, 172.16.0.0/12 albo fd00::/48' : 'np. 10.0.0.0/8 lub 172.16.0.0/12'}>
          <input class="mono" value={f.cidr} onInput={set('cidr')} placeholder="10.0.0.0/8" required /></Field>
        {c && <p class="span muted small-text calc-line">{c.family === 4
          ? `${c.cidr} · ${t('{n} adresów', { n: num(c.total) })} · ${c.first} – ${c.last}`
          : `${c.cidr} · ${t('{n} podsieci /64', { n: bigFmt(c.subnets64) })}`}</p>}
        <Field label="Nazwa"><input value={f.name} onInput={set('name')} placeholder={t('np. Sieć firmowa')} /></Field>
        <Field label="Opis"><input value={f.description} onInput={set('description')} /></Field>
        <footer><button type="button" class="btn ghost" onClick={onClose}>{t('Anuluj')}</button><button class="btn primary">{t('Zapisz')}</button></footer>
      </form>
    </Modal>
  );
}

// Hands a subnet of a pool to a location. Size is chosen as a prefix or as a number of hosts; the first free aligned block is suggested.
function AllocateForm({ plan, pool, cidr: preset, onClose, onSaved, notify }) {
  const six = pool.family === 6;
  const poolPrefix = Number(pool.cidr.split('/')[1]);
  const prefixes = six ? [48, 52, 56, 60, 64].filter((p) => p >= poolPrefix) : Array.from({ length: 30 - Math.max(16, poolPrefix) + 1 }, (_, i) => Math.max(16, poolPrefix) + i);
  const [f, setF] = useState({ site_id: plan.sites[0]?.id ?? '', name: '', by: 'prefix', prefix: six ? (prefixes.includes(64) ? 64 : prefixes[0]) : Math.max(24, poolPrefix), hosts: '', cidr: preset ?? '', vlan: '', gateway: 'first' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const suggest = async (next) => {
    const x = { ...f, ...next };
    setF({ ...x, cidr: '' });
    try {
      const q = x.by === 'hosts' ? { hosts: x.hosts } : { prefix: x.prefix };
      if (x.by === 'hosts' && !(Number(x.hosts) >= 1)) return;
      const r = await api.suggestBlock(pool.id, q);
      setF({ ...x, cidr: r.cidr, prefix: r.prefix ?? x.prefix });
    } catch (err) { notify(err.message, 'error'); }
  };
  useEffect(() => { if (!preset) suggest({}); }, []);
  const c = f.cidr ? (six ? calc6(f.cidr) : calc4(f.cidr)) : null;
  const submit = async (e) => {
    e.preventDefault();
    try { onSaved(await api.allocate(pool.id, { ...f, vlan: f.vlan === '' ? '' : Number(f.vlan), site_id: Number(f.site_id), hosts: undefined, prefix: undefined })); }
    catch (err) { notify(err.message, 'error'); }
  };
  return (
    <Modal title={`${t('Przydziel podsieć')} — ${pool.cidr}`} onClose={onClose}>
      <form class="form-grid" onSubmit={submit}>
        <Field label="Lokalizacja"><select value={f.site_id} onChange={set('site_id')} required>
          {plan.sites.map((s) => <option value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Nazwa"><input value={f.name} onInput={set('name')} placeholder={t('LAN, IoT, Goście…')} required /></Field>
        {!six && <div class="field span"><label>{t('Rozmiar')}</label>
          <div class="segmented small"><button type="button" class={f.by === 'prefix' ? 'on' : ''} onClick={() => suggest({ by: 'prefix' })}>{t('wg prefiksu')}</button>
            <button type="button" class={f.by === 'hosts' ? 'on' : ''} onClick={() => suggest({ by: 'hosts' })}>{t('wg liczby hostów')}</button></div></div>}
        {f.by === 'hosts' && !six
          ? <Field label="Potrzebnych hostów" hint={f.hosts ? `→ /${prefixForHosts(Number(f.hosts)) ?? '?'}` : ''}>
              <input type="number" min="1" max="65534" value={f.hosts} onInput={(e) => suggest({ hosts: e.target.value })} required /></Field>
          : <Field label="Prefiks"><select value={f.prefix} onChange={(e) => suggest({ prefix: Number(e.target.value) })}>
              {prefixes.map((p) => <option value={p}>/{p}{six ? '' : ` (${num(usableOf(p))} ${t('adresów')})`}</option>)}</select></Field>}
        <Field label="CIDR" hint="pierwszy wolny blok — możesz wpisać inny"><input class="mono" value={f.cidr} onInput={set('cidr')} required /></Field>
        {c && <p class="span muted small-text calc-line">{c.family === 4 ? `${c.mask} · ${c.first} – ${c.last} · ${t('{n} hostów', { n: num(c.hosts) })}` : `${c.first} – ${c.last}`}</p>}
        <Field label="VLAN" hint="puste = sieć domyślna (VLAN 1)"><input type="number" min="1" max="4094" value={f.vlan} onInput={set('vlan')} placeholder="1" /></Field>
        {!six && <Field label="Brama"><select value={f.gateway} onChange={set('gateway')}>
          <option value="first">{t('pierwszy adres')}</option><option value="last">{t('ostatni adres')}</option><option value="">{t('brak')}</option></select></Field>}
        <footer><button type="button" class="btn ghost" onClick={onClose}>{t('Anuluj')}</button><button class="btn primary" disabled={!f.cidr}>{t('Przydziel')}</button></footer>
      </form>
    </Modal>
  );
}

function PrefixForm({ plan, prefix, onClose, onSaved, notify }) {
  const [f, setF] = useState({ ...prefix, vlan: prefix.vlan ?? '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    try { await api.savePrefix6({ ...f, vlan: f.vlan === '' ? '' : Number(f.vlan), site_id: Number(f.site_id) }); onSaved(); } catch (err) { notify(err.message, 'error'); }
  };
  return (
    <Modal title="Edytuj prefiks" onClose={onClose}>
      <form class="form-grid" onSubmit={submit}>
        <Field label="Prefiks" span><input class="mono" value={prefix.cidr} readOnly /></Field>
        <Field label="Nazwa"><input value={f.name} onInput={set('name')} required /></Field>
        <Field label="Lokalizacja"><select value={f.site_id} onChange={set('site_id')}>{plan.sites.map((s) => <option value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="VLAN" hint="puste = sieć domyślna (VLAN 1)"><input type="number" min="1" max="4094" value={f.vlan} onInput={set('vlan')} placeholder="1" /></Field>
        <footer><button type="button" class="btn ghost" onClick={onClose}>{t('Anuluj')}</button><button class="btn primary">{t('Zapisz')}</button></footer>
      </form>
    </Modal>
  );
}

// The whole pool as one bar: every allocated network sits at its real position, coloured by location.
function PoolBar({ pool }) {
  const p = span(pool.cidr);
  return (
    <div class="pool-bar" role="img" aria-label={`${pool.cidr}: ${num(pool.allocated)} / ${num(pool.size)}`}>
      {pool.allocations.map((n) => {
        const s = span(n.cidr);
        return <a key={n.id} href={`#/n/${n.id}`} class="pool-seg" title={`${n.cidr} · ${n.name} · ${n.site}`}
          style={{ left: `${((s.first - p.first) / p.size) * 100}%`, width: `${Math.max(0.35, (s.size / p.size) * 100)}%`, background: siteColor(n.site_id) }} />;
      })}
    </div>
  );
}

function Stat({ label, value, hint, tone }) {
  return <div class={`stat-tile ${tone ?? ''}`}><b>{value}</b><span>{t(label)}</span>{hint && <small class="muted">{hint}</small>}</div>;
}

// The dashboard: totals, a map of every pool, usage per location, then each pool in detail.
function Pools({ plan, canEdit, reload, notify, setModal }) {
  const T = plan.totals;
  const siteIds = [...new Set(plan.pools.flatMap((p) => p.allocations.map((n) => n.site_id)))];
  const delPool = async (p) => {
    if (!await ask(t('Usunąć pulę {cidr}? Sieci z niej wydzielone zostaną.', { cidr: p.cidr }), { title: 'Usuń pulę' })) return;
    try { await api.delPool(p.id); reload(); } catch (err) { notify(err.message, 'error'); }
  };
  return (
    <>
      {!plan.pools.length && !plan.pools6.length ? (
        <section class="card">
          <p class="muted">{t('Pula to duży blok adresów (np. 10.0.0.0/8 albo 192.168.0.0/16) należący do tenanta. Z puli wydzielasz podsieci i przypisujesz je lokalizacjom — każda podsieć ma swój VLAN (brak VLAN-u = sieć domyślna, VLAN 1).')}</p>
        </section>
      ) : (
        <>
          <section class="stat-row">
            <Stat label="Puli IPv4" value={T.pools} />
            <Stat label="Adresów w pulach" value={num(T.addresses)} />
            <Stat label="Przydzielone" value={`${pctText(T.allocated, T.addresses)}%`} hint={`${num(T.allocated)} / ${num(T.addresses)}`} />
            <Stat label="Największy wolny blok" value={T.largest_free ? `/${32 - Math.log2(T.largest_free)}` : '—'} hint={T.largest_free ? `${num(T.largest_free)} ${t('adresów')}` : ''} />
            <Stat label="Sieci" value={T.networks} hint={`${T.sites} ${t('lokalizacji')}`} />
            <Stat label="Konflikty" value={T.conflicts} tone={T.conflicts ? 'bad' : ''} />
          </section>
          {plan.pools.length > 0 && (
            <section class="card">
              <h3>{t('Mapa wszystkich pul')}</h3>
              <div class="pool-map">
                {plan.pools.map((p) => (
                  <div class="pool-map-row"><span class="mono pool-map-label">{p.cidr}{p.name && <small class="muted"> {p.name}</small>}</span>
                    <PoolBar pool={p} /><span class="muted pool-map-pct">{pctText(p.allocated, p.size)}%</span></div>
                ))}
              </div>
              {siteIds.length > 0 && <div class="legend">{siteIds.map((id) => <span><i class="site-dot" style={{ background: siteColor(id) }} />{plan.sites.find((s) => s.id === id)?.name}</span>)}</div>}
            </section>
          )}
          {plan.site_stats.some((s) => s.networks) && (
            <section class="card">
              <h3>{t('Lokalizacje')}</h3>
              <div class="table-wrap"><table>
                <thead><tr><th>{t('Lokalizacja')}</th><th>{t('Sieci')}</th><th>{t('Adresów')}</th><th>VLAN</th></tr></thead>
                <tbody>{plan.site_stats.filter((s) => s.networks).map((s) => (
                  <tr><td><i class="site-dot" style={{ background: siteColor(s.id) }} />{s.name}</td><td>{s.networks}</td><td class="mono">{num(s.addresses)}</td>
                    <td>{s.vlans.map((v) => <span class="chip">{v}{v === 1 && ` ${t('(domyślny)')}`}</span>)}</td></tr>
                ))}</tbody>
              </table></div>
            </section>
          )}
        </>
      )}
      {plan.pools.map((p) => (
        <section class="card pool">
          <div class="pool-head">
            <h3><span class="mono">{p.cidr}</span>{p.name && <span class="muted"> · {p.name}</span>}</h3>
            <span class="spacer" />
            {canEdit && <>
              <button class="btn small primary" onClick={() => setModal({ kind: 'alloc', pool: p })} disabled={!plan.sites.length}><Icon name="plus" size={14} />{t('Przydziel podsieć')}</button>
              <button class="icon-btn" aria-label={t('Edytuj')} onClick={() => setModal({ kind: 'pool', pool: p })}><Icon name="edit" size={16} /></button>
              <button class="icon-btn danger" aria-label={t('Usuń pulę')} onClick={() => delPool(p)}><Icon name="trash" size={16} /></button>
            </>}
          </div>
          {p.description && <p class="muted small-text">{p.description}</p>}
          <PoolBar pool={p} />
          <p class="muted small-text">{t('Przydzielono {a} z {s} adresów ({pct}%), wolne: {f}', { a: num(p.allocated), s: num(p.size), pct: pctText(p.allocated, p.size), f: num(p.free) })}
            {p.largest_free > 0 && <> · {t('największy wolny blok: /{n}', { n: 32 - Math.log2(p.largest_free) })}</>}</p>
          {p.by_site.length > 1 && <div class="legend">{p.by_site.map((b) => <span><i class="site-dot" style={{ background: siteColor(b.site_id) }} />{plan.sites.find((s) => s.id === b.site_id)?.name} · {num(b.addresses)}</span>)}</div>}
          {p.allocations.length > 0 && (
            <div class="table-wrap"><table>
              <thead><tr><th>{t('Sieć')}</th><th>CIDR</th><th>{t('Lokalizacja')}</th><th>VLAN</th><th>{t('Użycie')}</th></tr></thead>
              <tbody>{p.allocations.map((n) => (
                <tr><td><a href={`#/n/${n.id}`}><i class="site-dot" style={{ background: siteColor(n.site_id) }} />{n.name}</a></td>
                  <td class="mono">{n.cidr}</td><td>{n.site}</td><td>{vlanOf(n)}{!n.vlan && <small class="muted"> {t('(domyślny)')}</small>}</td><td class="muted">{n.used}/{n.total}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {p.free_blocks.length > 0 && (
            <div>
              <div class="muted small-text">{t('Wolne bloki')}{p.free_block_count > p.free_blocks.length && ` (${p.free_blocks.length} / ${p.free_block_count})`}</div>
              <div class="free-blocks">
                {p.free_blocks.map((b) => canEdit
                  ? <button class="chip block" title={`${num(b.size)} ${t('adresów')}`} onClick={() => setModal({ kind: 'alloc', pool: p, cidr: b.cidr })}>{b.cidr}</button>
                  : <span class="chip">{b.cidr}</span>)}
              </div>
            </div>
          )}
        </section>
      ))}
      {plan.ipv6 && (
        <>
          <h2 class="section-title">IPv6</h2>
          {!plan.pools6.length && <section class="card"><p class="muted">{t('Dodaj pulę IPv6 (np. fd00::/48 albo prefiks od dostawcy), a potem przydzielaj z niej prefiksy /64 lokalizacjom. Ewidencja pojedynczych adresów IPv6 nie jest jeszcze obsługiwana — to planowanie prefiksów.')}</p></section>}
          {plan.pools6.map((p) => (
            <section class="card pool">
              <div class="pool-head">
                <h3><span class="mono">{p.cidr}</span>{p.name && <span class="muted"> · {p.name}</span>}</h3>
                <span class="spacer" />
                {canEdit && <>
                  <button class="btn small primary" onClick={() => setModal({ kind: 'alloc', pool: p })} disabled={!plan.sites.length}><Icon name="plus" size={14} />{t('Przydziel prefiks')}</button>
                  <button class="icon-btn" aria-label={t('Edytuj')} onClick={() => setModal({ kind: 'pool', pool: p })}><Icon name="edit" size={16} /></button>
                  <button class="icon-btn danger" aria-label={t('Usuń pulę')} onClick={() => delPool(p)}><Icon name="trash" size={16} /></button>
                </>}
              </div>
              <div class="pool-bar"><div class="pool-seg v6" style={{ left: 0, width: `${Math.max(p.pct > 0 ? 0.6 : 0, Math.min(100, p.pct))}%` }} /></div>
              <p class="muted small-text">{t('Przydzielono {a} z {s} podsieci /64', { a: p.allocated_64, s: p.total_64 === '0' ? '—' : num(p.total_64) })} ({p.pct.toFixed(p.pct < 10 ? 2 : 0)}%)</p>
              {p.allocations.length > 0 && (
                <div class="table-wrap"><table>
                  <thead><tr><th>{t('Nazwa')}</th><th>{t('Prefiks')}</th><th>{t('Lokalizacja')}</th><th>VLAN</th><th /></tr></thead>
                  <tbody>{p.allocations.map((x) => (
                    <tr><td>{x.name}</td><td class="mono">{x.cidr}</td><td>{x.site_name}</td><td>{x.vlan ?? 1}{!x.vlan && <small class="muted"> {t('(domyślny)')}</small>}</td>
                      <td class="row-actions always">{canEdit && <>
                        <button class="icon-btn" aria-label={t('Edytuj')} onClick={() => setModal({ kind: 'prefix', prefix: x })}><Icon name="edit" size={16} /></button>
                        <button class="icon-btn danger" aria-label={t('Usuń')} onClick={async () => { if (await ask(t('Usunąć {name}?', { name: x.cidr }), { title: 'Usuń prefiks' })) { try { await api.delPrefix6(x.id); reload(); } catch (err) { notify(err.message, 'error'); } } }}><Icon name="trash" size={16} /></button></>}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
              {Object.keys(p.next).length > 0 && <div><div class="muted small-text">{t('Następne wolne')}</div>
                <div class="free-blocks">{Object.entries(p.next).filter(([, c]) => c).map(([bits, c]) => canEdit
                  ? <button class="chip block" onClick={() => setModal({ kind: 'alloc', pool: p, cidr: c })}>{c}</button> : <span class="chip">{c}</span>)}</div></div>}
            </section>
          ))}
        </>
      )}
      {plan.unpooled.length > 0 && (
        <section class="card">
          <h3>{t('Sieci poza pulami')} ({plan.unpooled.length})</h3>
          <p class="muted small-text">{t('Nie mieszczą się w żadnej puli tenanta — to normalne dla sieci 192.168.x.x, jeśli ich nie planujesz centralnie.')}</p>
          <div class="table-wrap"><table>
            <thead><tr><th>{t('Sieć')}</th><th>CIDR</th><th>{t('Lokalizacja')}</th><th>VLAN</th></tr></thead>
            <tbody>{plan.unpooled.map((n) => <tr><td><a href={`#/n/${n.id}`}>{n.name}</a></td><td class="mono">{n.cidr}</td><td>{n.site}</td><td>{vlanOf(n)}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}

// VLSM: describe the subnets by host count, see them fitted into a pool (biggest first), then create them in one go.
function Vlsm({ plan, canEdit, reload, notify }) {
  const pools = plan.pools;
  const [poolId, setPoolId] = useState(pools[0]?.id ?? '');
  const [site, setSite] = useState(plan.sites[0]?.id ?? '');
  const [rows, setRows] = useState([{ name: '', hosts: '', vlan: '' }, { name: '', hosts: '', vlan: '' }]);
  const [res, setRes] = useState(null);
  const upd = (i, k) => (e) => { const v = e.target.value; setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r))); setRes(null); };
  const body = () => ({ site_id: Number(site), requests: rows.filter((r) => r.name || r.hosts).map((r) => ({ name: r.name, hosts: r.hosts === '' ? '' : Number(r.hosts), vlan: r.vlan === '' ? '' : Number(r.vlan) })) });
  if (!pools.length) return <section class="card"><p class="muted">{t('Dodaj najpierw pulę IPv4 — planer rozmieści w niej podsieci.')}</p></section>;
  const run = async (apply) => {
    try {
      const r = await api.vlsm(poolId, { ...body(), apply });
      setRes(r);
      if (apply) { notify('Utworzono sieci'); reload(); setRows([{ name: '', hosts: '', vlan: '' }]); }
    } catch (err) { notify(err.message, 'error'); }
  };
  const need = rows.reduce((a, r) => a + (Number(r.hosts) > 0 ? 2 ** (32 - (prefixForHosts(Number(r.hosts)) ?? 32)) : 0), 0);
  return (
    <>
      <section class="card">
        <h3>{t('Planer VLSM')}</h3>
        <p class="muted small-text">{t('Podaj, ile hostów potrzebuje każda sieć. Planer dobierze najmniejszy pasujący prefiks, ułoży podsieci od największej i znajdzie dla nich wolne, wyrównane bloki w puli.')}</p>
        <div class="form-grid">
          <Field label="Pula"><select value={poolId} onChange={(e) => { setPoolId(e.target.value); setRes(null); }}>{pools.map((p) => <option value={p.id}>{p.cidr}{p.name ? ` · ${p.name}` : ''}</option>)}</select></Field>
          <Field label="Lokalizacja"><select value={site} onChange={(e) => { setSite(e.target.value); setRes(null); }}>{plan.sites.map((s) => <option value={s.id}>{s.name}</option>)}</select></Field>
        </div>
        <div class="vlsm-rows">
          {rows.map((r, i) => (
            <div class="vlsm-row">
              <input placeholder={t('Nazwa (np. Serwery)')} value={r.name} onInput={upd(i, 'name')} aria-label={t('Nazwa')} />
              <input type="number" min="1" max="65534" placeholder={t('Hostów')} value={r.hosts} onInput={upd(i, 'hosts')} aria-label={t('Hostów')} />
              <span class="mono muted vlsm-prefix">{r.hosts ? `/${prefixForHosts(Number(r.hosts)) ?? '?'}` : ''}</span>
              <input type="number" min="1" max="4094" placeholder="VLAN" value={r.vlan} onInput={upd(i, 'vlan')} aria-label="VLAN" />
              <button class="icon-btn danger" aria-label={t('Usuń')} onClick={() => { setRows(rows.filter((_, j) => j !== i)); setRes(null); }}><Icon name="trash" size={16} /></button>
            </div>
          ))}
        </div>
        <div class="row-btns">
          <button class="btn ghost" onClick={() => setRows([...rows, { name: '', hosts: '', vlan: '' }])}><Icon name="plus" />{t('Dodaj wiersz')}</button>
          <span class="spacer" />
          {need > 0 && <span class="muted small-text">{t('Razem potrzeba {n} adresów', { n: num(need) })}</span>}
          <button class="btn primary" onClick={() => run(false)}>{t('Oblicz')}</button>
        </div>
      </section>
      {res && (
        <section class="card">
          <h3>{res.ok ? t('Propozycja rozmieszczenia') : t('Nie wszystko się mieści')}</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>{t('Nazwa')}</th><th>{t('Hostów')}</th><th>CIDR</th><th>{t('Maska')}</th><th>{t('Zakres')}</th><th>VLAN</th></tr></thead>
            <tbody>{res.items.map((it) => {
              const c = it.cidr ? calc4(it.cidr) : null;
              return <tr><td>{it.name}</td><td>{it.hosts ?? '—'}</td>
                <td class="mono">{it.cidr ?? <span class="error-text">{t(it.error)}</span>}</td><td class="mono">{c ? c.mask : ''}</td>
                <td class="mono small-text">{c ? `${c.first} – ${c.last}` : ''}</td><td>{it.vlan ?? 1}</td></tr>;
            })}</tbody>
          </table></div>
          {res.free_after.length > 0 && <p class="muted small-text">{t('Wolne po przydziale')}: {res.free_after.slice(0, 8).map((b) => b.cidr).join(', ')}{res.free_after.length > 8 ? ' …' : ''}</p>}
          {canEdit && res.ok && <div class="row-btns"><span class="spacer" /><button class="btn primary" onClick={async () => { if (await ask(t('Utworzyć {n} sieci w lokalizacji?', { n: res.items.length }), { title: 'Zastosować plan?', confirm: 'Utwórz', danger: false })) run(true); }}>{t('Utwórz sieci')}</button></div>}
        </section>
      )}
    </>
  );
}

// Pure client-side tools: block calculator, splitter, aggregator and a hosts -> prefix table.
function Calculator({ plan }) {
  const [q, setQ] = useState('192.168.10.37/24');
  const [to, setTo] = useState('26');
  const [list, setList] = useState('10.0.0.0/24\n10.0.1.0/24\n10.0.2.0/23');
  const [hosts, setHosts] = useState('50');
  const six = q.includes(':');
  const c = useMemo(() => (six ? (plan.ipv6 ? calc6(q) : null) : calc4(q)), [q, plan.ipv6]);
  const sp = useMemo(() => {
    const n = Number(to);
    if (!c || !Number.isInteger(n)) return null;
    return c.family === 4 ? split4(c.cidr, n) : split6(c.cidr, n);
  }, [c, to]);
  const sum = useMemo(() => summarize4(list.split('\n')), [list]);
  const h = Number(hosts);
  const row = (k, v, mono = true) => <><dt>{t(k)}</dt><dd class={mono ? 'mono' : ''}>{v}</dd></>;
  return (
    <>
      <section class="card">
        <h3>{t('Kalkulator CIDR')}</h3>
        <Field label="Adres z maską" span hint={plan.ipv6 ? '10.0.0.5/24, 10.0.0.5 255.255.255.0, 2001:db8::/48' : '10.0.0.5/24, 10.0.0.5 255.255.255.0'}>
          <input class="mono" value={q} onInput={(e) => setQ(e.target.value)} spellcheck={false} /></Field>
        {!c && q.trim() && <p class="error-text">{six && !plan.ipv6 ? t('IPv6 jest wyłączone dla tego tenanta') : t('Nieprawidłowy adres lub maska')}</p>}
        {c && c.family === 4 && (
          <dl class="calc-grid">
            {row('Sieć', c.cidr)}{row('Maska', c.mask)}{row('Wildcard', c.wildcard)}{row('Broadcast', c.broadcast)}
            {row('Pierwszy host', c.first)}{row('Ostatni host', c.last)}{row('Hostów', num(c.hosts))}{row('Adresów razem', num(c.total))}
            {row('Maska (bin)', c.maskBin)}{row('Adres (bin)', c.ipBin)}{c.private && row('Typ', t('prywatny (RFC 1918)'), false)}
          </dl>
        )}
        {c && c.family === 6 && (
          <dl class="calc-grid">
            {row('Prefiks', c.cidr)}{row('Rozwinięty', c.expanded)}{row('Pierwszy adres', c.first)}{row('Ostatni adres', c.last)}
            {row('Adresów razem', bigFmt(c.total))}{row('Podsieci /64', bigFmt(c.subnets64))}
          </dl>
        )}
      </section>
      {c && (
        <section class="card">
          <h3>{t('Podział na mniejsze bloki')}</h3>
          <div class="form-grid">
            <Field label="Nowy prefiks"><input type="number" min={c.prefix + 1} max={c.family === 4 ? 32 : 128} value={to} onInput={(e) => setTo(e.target.value)} /></Field>
            {sp && <p class="muted small-text calc-line">{t('{n} bloków po {s} adresów', { n: c.family === 4 ? num(sp.count) : bigFmt(sp.count), s: c.family === 4 ? num(sp.size) : bigFmt(sp.size) })}</p>}
          </div>
          {sp ? <div class="free-blocks">{sp.list.map((b) => <span class="chip mono">{b}</span>)}{(c.family === 4 ? sp.count > sp.list.length : sp.count > BigInt(sp.list.length)) && <span class="muted">…</span>}</div>
            : <p class="muted small-text">{t('Podaj prefiks dłuższy niż /{n}', { n: c.prefix })}</p>}
        </section>
      )}
      <section class="card">
        <h3>{t('Agregacja (supernet)')}</h3>
        <p class="muted small-text">{t('Wklej listę sieci IPv4 (po jednej w linii) — dostaniesz najmniejszy zestaw bloków, który je obejmuje.')}</p>
        <textarea class="mono" rows="4" value={list} onInput={(e) => setList(e.target.value)} spellcheck={false} />
        <div class="free-blocks">{sum.blocks.map((b) => <span class="chip mono">{b}</span>)}</div>
        {sum.bad.length > 0 && <p class="error-text small-text">{t('Nie rozpoznano')}: {sum.bad.join(', ')}</p>}
      </section>
      <section class="card">
        <h3>{t('Ile hostów → jaki prefiks')}</h3>
        <div class="form-grid"><Field label="Potrzebnych hostów"><input type="number" min="1" max="65534" value={hosts} onInput={(e) => setHosts(e.target.value)} /></Field>
          {h >= 1 && h <= 65534 && <p class="calc-line">/{prefixForHosts(h)} · {t('{n} hostów', { n: num(usableOf(prefixForHosts(h))) })} · {calc4(`0.0.0.0/${prefixForHosts(h)}`).mask}</p>}</div>
        <div class="table-wrap"><table>
          <thead><tr><th>{t('Prefiks')}</th><th>{t('Maska')}</th><th>{t('Hostów')}</th></tr></thead>
          <tbody>{Array.from({ length: 15 }, (_, i) => 16 + i).map((p) => (
            <tr class={h >= 1 && prefixForHosts(h) === p ? 'hit' : ''}><td class="mono">/{p}</td><td class="mono">{calc4(`0.0.0.0/${p}`).mask}</td><td>{num(usableOf(p))}</td></tr>
          ))}</tbody>
        </table></div>
      </section>
    </>
  );
}

// General tenant settings (name, description, IPv6 opt-in).
function TenantSettings({ plan, canEdit, notify, onChanged, reload }) {
  const [f, setF] = useState({ id: plan.tenant.id, name: plan.tenant.name, description: plan.tenant.description ?? '', ipv6: plan.tenant.ipv6 });
  const submit = async (e) => {
    e.preventDefault();
    try { await api.saveTenant(f); notify('Zapisano'); onChanged?.(); reload(); } catch (err) { notify(err.message, 'error'); }
  };
  return (
    <section class="card">
      <h3>{t('Ogólne')}</h3>
      <form class="form-grid" onSubmit={submit}>
        <Field label="Nazwa" span><input value={f.name} onInput={(e) => setF({ ...f, name: e.target.value })} required disabled={!canEdit} /></Field>
        <Field label="Opis" span><input value={f.description} onInput={(e) => setF({ ...f, description: e.target.value })} disabled={!canEdit} /></Field>
        {plan.ipv6_enabled
          ? <label class="check span"><input type="checkbox" checked={f.ipv6} onChange={(e) => setF({ ...f, ipv6: e.target.checked })} disabled={!canEdit} />
              <span>{t('Ten tenant używa IPv6')}<small class="muted"> — {t('pokaże pule i prefiksy IPv6 w planowaniu')}</small></span></label>
          : <p class="muted small-text span">{t('IPv6 jest wyłączone globalnie (Administracja → Ustawienia).')}</p>}
        {canEdit && <footer><button class="btn primary">{t('Zapisz')}</button></footer>}
      </form>
    </section>
  );
}

const TABS = [['', 'Pule adresowe', 'map'], ['vlsm', 'Planer VLSM', 'wand'], ['calc', 'Kalkulator', 'code'], ['settings', 'Ogólne', 'settings']];

// Tenant settings: address planning dashboard (pools -> networks for locations), VLSM planner, CIDR calculator, general options.
export function Planner({ tenantId, tab = '', notify, onChanged }) {
  const [plan, setPlan] = useState(null);
  const [modal, setModal] = useState(null);
  const load = () => api.plan(tenantId).then(setPlan).catch((e) => notify(e.message, 'error'));
  useEffect(() => { setPlan(null); load(); }, [tenantId]);
  if (!plan) return <div class="skeleton" />;
  const canEdit = plan.role === 'admin';
  const reload = () => { load(); onChanged?.(); };
  const done = (msg) => () => { setModal(null); reload(); notify(msg); };
  const cur = TABS.some(([k]) => k === tab) ? tab : '';
  return (
    <div class="page">
      <header class="page-head"><div><div class="crumb">{t('Ustawienia tenanta')}</div><h1>{plan.tenant.name}</h1></div>
        {canEdit && cur === '' && <div class="head-actions"><button class="btn primary" onClick={() => setModal({ kind: 'pool' })}><Icon name="plus" />{t('Dodaj pulę')}</button></div>}
      </header>
      <div class="tabs" role="tablist">
        {TABS.map(([k, label, icon]) => <a role="tab" aria-selected={cur === k} class={cur === k ? 'on' : ''} href={`#/plan/${tenantId}${k ? `/${k}` : ''}`}><Icon name={icon} size={16} />{t(label)}</a>)}
      </div>
      {cur === '' && plan.conflicts.length > 0 && (
        <section class="card"><h3>{t('Konflikty')} ({plan.conflicts.length})</h3>
          <div class="issues">{plan.conflicts.map((c) => <div class="issue error">{t(c.text)}</div>)}</div></section>
      )}
      {cur === '' && <Pools plan={plan} canEdit={canEdit} reload={reload} notify={notify} setModal={setModal} />}
      {cur === 'vlsm' && <Vlsm plan={plan} canEdit={canEdit} reload={reload} notify={notify} />}
      {cur === 'calc' && <Calculator plan={plan} />}
      {cur === 'settings' && <TenantSettings plan={plan} canEdit={canEdit} notify={notify} onChanged={onChanged} reload={reload} />}
      {modal?.kind === 'pool' && <PoolForm tenantId={tenantId} plan={plan} pool={modal.pool} notify={notify} onClose={() => setModal(null)} onSaved={done('Zapisano')} />}
      {modal?.kind === 'prefix' && <PrefixForm plan={plan} prefix={modal.prefix} notify={notify} onClose={() => setModal(null)} onSaved={done('Zapisano')} />}
      {modal?.kind === 'alloc' && <AllocateForm plan={plan} pool={modal.pool} cidr={modal.cidr} notify={notify} onClose={() => setModal(null)}
        onSaved={(n) => { setModal(null); reload(); notify(modal.pool.family === 6 ? 'Prefiks został przydzielony' : 'Sieć została utworzona'); if (modal.pool.family !== 6) location.hash = `#/n/${n.id}`; }} />}
    </div>
  );
}
