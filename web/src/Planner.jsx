import { useEffect, useState } from 'preact/hooks';
import { api } from './api.js';
import { Icon, Modal, Field, ask } from './ui.jsx';
import { t, locale } from './i18n.js';

const num = (n) => Number(n).toLocaleString(locale());
const ipNum = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const span = (cidr) => { const [ip, p] = cidr.split('/'); const size = 2 ** (32 - Number(p)); const first = Math.floor(ipNum(ip) / size) * size; return { first, size }; };
// Fixed, well separated colours per location (same hue family as the app palette) instead of a computed hue.
const SITE_COLORS = ['#0b7f8a', '#d99a1c', '#6f4fe0', '#c2543d', '#3f8f4a', '#2e6bd1', '#b04a8f', '#8a7a2c'];
const siteColor = (siteId) => SITE_COLORS[(Number(siteId) - 1 + SITE_COLORS.length * 1000) % SITE_COLORS.length];
const sizeLabel = (size) => (size >= 1024 ? `${num(size)}` : String(size));

function PoolForm({ tenantId, plan, pool, onClose, onSaved, notify }) {
  const [f, setF] = useState(pool ?? { site_id: plan.sites[0]?.id ?? '', cidr: '', name: '', description: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    try { await api.savePool(tenantId, { ...f, site_id: Number(f.site_id) }); onSaved(); } catch (err) { notify(err.message, 'error'); }
  };
  return (
    <Modal title={pool ? 'Edytuj pulę' : 'Nowa pula adresowa'} onClose={onClose}>
      <form class="form-grid" onSubmit={submit}>
        <Field label="Lokalizacja" hint="Pula zawsze należy do lokalizacji — sieci z niej trafiają właśnie tam"><select value={f.site_id} onChange={set('site_id')} required>
          {plan.sites.map((s) => <option value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="CIDR" hint="np. 10.0.0.0/8 lub 172.16.0.0/12"><input class="mono" value={f.cidr} onInput={set('cidr')} placeholder="10.0.0.0/8" required /></Field>
        <Field label="Nazwa"><input value={f.name} onInput={set('name')} placeholder={t('np. Sieć firmowa')} /></Field>
        <Field label="Opis" span><input value={f.description} onInput={set('description')} /></Field>
        <footer><button type="button" class="btn ghost" onClick={onClose}>{t('Anuluj')}</button><button class="btn primary">{t('Zapisz')}</button></footer>
      </form>
    </Modal>
  );
}

// Carves a subnet out of a pool for a location: suggests the first free aligned block of the chosen size.
function AllocateForm({ plan, pool, cidr: preset, onClose, onSaved, notify }) {
  const poolPrefix = Number(pool.cidr.split('/')[1]);
  const [f, setF] = useState({ name: '', prefix: Math.max(24, poolPrefix), cidr: preset ?? '', vlan: '', gateway: 'first' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const suggest = async (prefix) => {
    try { setF((x) => ({ ...x, prefix, cidr: '' })); const r = await api.suggestBlock(pool.id, prefix); setF((x) => ({ ...x, prefix, cidr: r.cidr })); }
    catch (err) { setF((x) => ({ ...x, prefix, cidr: '' })); notify(err.message, 'error'); }
  };
  useEffect(() => { if (!preset) suggest(f.prefix); }, []);
  const submit = async (e) => {
    e.preventDefault();
    try { onSaved(await api.allocate(pool.id, { ...f, vlan: Number(f.vlan) })); }
    catch (err) { notify(err.message, 'error'); }
  };
  return (
    <Modal title={`${t('Przydziel podsieć')} — ${pool.cidr}`} onClose={onClose}>
      <form class="form-grid" onSubmit={submit}>
        <Field label="Nazwa" hint={`${t('Lokalizacja')}: ${pool.site}`}><input value={f.name} onInput={set('name')} placeholder={t('LAN, IoT, Goście…')} required /></Field>
        <Field label="Rozmiar"><select value={f.prefix} onChange={(e) => suggest(Number(e.target.value))}>
          {Array.from({ length: 30 - Math.max(16, poolPrefix) + 1 }, (_, i) => Math.max(16, poolPrefix) + i).map((p) => <option value={p}>/{p} ({num(2 ** (32 - p) - 2)} {t('adresów')})</option>)}</select></Field>
        <Field label="CIDR" hint="pierwszy wolny blok — możesz wpisać inny"><input class="mono" value={f.cidr} onInput={set('cidr')} required /></Field>
        <Field label="VLAN"><input type="number" min="1" max="4094" value={f.vlan} onInput={set('vlan')} required /></Field>
        <Field label="Brama"><select value={f.gateway} onChange={set('gateway')}>
          <option value="first">{t('pierwszy adres')}</option><option value="last">{t('ostatni adres')}</option><option value="">{t('brak')}</option></select></Field>
        <footer><button type="button" class="btn ghost" onClick={onClose}>{t('Anuluj')}</button><button class="btn primary" disabled={!f.cidr}>{t('Przydziel')}</button></footer>
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

function Pools({ plan, canEdit, reload, notify, setModal }) {
  const siteIds = [...new Set(plan.pools.flatMap((p) => p.allocations.map((n) => n.site_id)))];
  return (
    <>
      {!plan.pools.length && (
        <section class="card">
          <p class="muted">{t('Pula to duży blok adresów (np. 10.0.0.0/8) przypisany do lokalizacji. Dodaj pulę, a potem przydzielaj z niej kolejne wolne bloki — każdy to sieć z własnym VLAN-em.')}</p>
        </section>
      )}
      {plan.pools.map((p) => {
        const pct = (p.allocated / p.size) * 100;
        return (
          <section class="card pool">
            <div class="pool-head">
              <h3><span class="mono">{p.cidr}</span>{p.name && <span class="muted"> · {p.name}</span>}</h3>
              {p.site && <span class="chip" style={{ borderColor: siteColor(p.site_id) }}>{p.site}</span>}
              <span class="spacer" />
              {canEdit && <>
                <button class="btn small primary" onClick={() => setModal({ kind: 'alloc', pool: p })} disabled={!p.site_id}><Icon name="plus" size={14} />{t('Przydziel podsieć')}</button>
                <button class="icon-btn" aria-label={t('Edytuj')} onClick={() => setModal({ kind: 'pool', pool: p })}><Icon name="edit" size={16} /></button>
                <button class="icon-btn danger" aria-label={t('Usuń pulę')} onClick={async () => {
                  if (!await ask(t('Usunąć pulę {cidr}? Sieci z niej wydzielone zostaną.', { cidr: p.cidr }), { title: 'Usuń pulę' })) return;
                  try { await api.delPool(p.id); reload(); } catch (err) { notify(err.message, 'error'); }
                }}><Icon name="trash" size={16} /></button>
              </>}
            </div>
            {p.description && <p class="muted small-text">{p.description}</p>}
            <PoolBar pool={p} />
            <p class="muted small-text">{t('Przydzielono {a} z {s} adresów ({pct}%), wolne: {f}', { a: num(p.allocated), s: num(p.size), pct: pct < 0.1 && p.allocated ? '<0,1' : pct.toFixed(pct < 10 ? 1 : 0), f: num(p.free) })}
              {p.largest_free > 0 && <> · {t('największy wolny blok: /{n}', { n: 32 - Math.log2(p.largest_free) })}</>}</p>
            {p.allocations.length > 0 && (
              <div class="table-wrap"><table>
                <thead><tr><th>{t('Sieć')}</th><th>CIDR</th><th>{t('Lokalizacja')}</th><th>VLAN</th><th>{t('Użycie')}</th></tr></thead>
                <tbody>{p.allocations.map((n) => (
                  <tr><td><a href={`#/n/${n.id}`}><i class="site-dot" style={{ background: siteColor(n.site_id) }} />{n.name}</a></td>
                    <td class="mono">{n.cidr}</td><td>{n.site}</td><td>{n.vlan ?? '—'}</td><td class="muted">{n.used}/{n.total}</td></tr>
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
        );
      })}
      {siteIds.length > 1 && (
        <div class="legend">{siteIds.map((id) => <span><i class="site-dot" style={{ background: siteColor(id) }} />{plan.sites.find((s) => s.id === id)?.name}</span>)}</div>
      )}
      {plan.unpooled.length > 0 && (
        <section class="card">
          <h3>{t('Sieci poza pulami')} ({plan.unpooled.length})</h3>
          <p class="muted small-text">{t('Nie mieszczą się w żadnej puli tenanta — to normalne dla sieci 192.168.x.x, jeśli ich nie planujesz centralnie.')}</p>
          <div class="table-wrap"><table>
            <thead><tr><th>{t('Sieć')}</th><th>CIDR</th><th>{t('Lokalizacja')}</th><th>VLAN</th></tr></thead>
            <tbody>{plan.unpooled.map((n) => <tr><td><a href={`#/n/${n.id}`}>{n.name}</a></td><td class="mono">{n.cidr}</td><td>{n.site}</td><td>{n.vlan ?? '—'}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}

// Address-space planning for one tenant: pools that belong to a location and are carved into subnets (VLAN + CIDR).
export function Planner({ tenantId, tab, notify, onChanged }) {
  const [plan, setPlan] = useState(null);
  const [modal, setModal] = useState(null);
  const load = () => api.plan(tenantId).then(setPlan).catch((e) => notify(e.message, 'error'));
  useEffect(() => { setPlan(null); load(); }, [tenantId]);
  if (!plan) return <div class="skeleton" />;
  const canEdit = plan.role === 'admin';
  const reload = () => { load(); onChanged?.(); };
  const done = (msg) => () => { setModal(null); reload(); notify(msg); };
  return (
    <div class="page">
      <header class="page-head"><div><div class="crumb">{t('Planowanie')}</div><h1>{plan.tenant.name}</h1></div>
        {canEdit && <div class="head-actions"><button class="btn primary" onClick={() => setModal({ kind: 'pool' })}><Icon name="plus" />{t('Dodaj pulę')}</button></div>}
      </header>
      {plan.conflicts.length > 0 && (
        <section class="card"><h3>{t('Konflikty')} ({plan.conflicts.length})</h3>
          <div class="issues">{plan.conflicts.map((c) => <div class="issue error">{t(c.text)}</div>)}</div></section>
      )}
      <Pools plan={plan} canEdit={canEdit} reload={reload} notify={notify} setModal={setModal} />
      {modal?.kind === 'pool' && <PoolForm tenantId={tenantId} plan={plan} pool={modal.pool} notify={notify} onClose={() => setModal(null)} onSaved={done('Zapisano')} />}
      {modal?.kind === 'alloc' && <AllocateForm plan={plan} pool={modal.pool} cidr={modal.cidr} notify={notify} onClose={() => setModal(null)}
        onSaved={(n) => { setModal(null); reload(); notify('Sieć została utworzona'); location.hash = `#/n/${n.id}`; }} />}
    </div>
  );
}
