import { useEffect, useState } from 'preact/hooks';
import { api } from './api.js';
import { Icon, Modal, Field, ROLE_LABELS } from './ui.jsx';
import { t } from './i18n.js';

const RoleSelect = ({ value, onChange, allowNone = true, ...rest }) => (
  <select class={`role-select ${value}`} value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
    {Object.entries(ROLE_LABELS).filter(([k]) => allowNone || k !== 'none').map(([k, l]) => <option value={k}>{l}</option>)}
  </select>
);

function PasswordModal({ target, onClose, notify }) {
  const [pw, setPw] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try { await api.setUserPassword(target.id, pw); notify('Hasło zostało zmienione'); onClose(); }
    catch (err) { notify(err.message, 'error'); }
  };
  return (
    <Modal title={`Nowe hasło: ${target.username}`} onClose={onClose}>
      <form class="form-grid" onSubmit={submit}>
        <Field label="Nowe hasło" hint="min. 8 znaków; użytkownik zostanie wylogowany" span>
          <input type="password" autocomplete="new-password" value={pw} onInput={(e) => setPw(e.target.value)} required minLength={8} /></Field>
        <footer><button type="button" class="btn ghost" onClick={onClose}>{t('Anuluj')}</button><button class="btn primary">{t('Zmień')}</button></footer>
      </form>
    </Modal>
  );
}

export function Users({ tenants, me, notify, onChanged }) {
  const [users, setUsers] = useState([]);
  const [pwFor, setPwFor] = useState(null);
  const [add, setAdd] = useState({});   // userId -> { scope: 'tenant:1' | 'site:3', role } draft
  const load = () => api.users().then(setUsers).catch((e) => notify(e.message, 'error'));
  useEffect(() => { load(); }, []);

  const act = async (fn, ok) => {
    try { await fn(); if (ok) notify(ok); } catch (e) { notify(e.message, 'error'); }
    load();
    onChanged?.();
  };
  const sites = tenants.flatMap((t) => t.sites.map((s) => ({ ...s, tenantName: t.name })));
  const label = (kind, id) => kind === 'tenant'
    ? `tenant: ${tenants.find((t) => String(t.id) === String(id))?.name ?? `#${id}`}`
    : (() => { const s = sites.find((x) => String(x.id) === String(id)); return s ? `${s.tenantName} / ${s.name}` : `#${id}`; })();
  const scopeArg = (kind, id) => (kind === 'tenant' ? { tenant_id: Number(id) } : { site_id: Number(id) });

  return (
    <div class="admin-section">
      <p class="muted">{t('Obowiązuje najbardziej szczegółowa rola: lokalizacja → tenant → globalna. „None” na niższym poziomie odbiera dostęp mimo roli wyżej.')}</p>
      <section class="card table-card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>{t('Użytkownik')}</th><th>{t('Rola globalna')}</th><th>{t('Role w tenantach i lokalizacjach')}</th><th /></tr></thead>
            <tbody>
              {users.map((u) => {
                const d = add[u.id] ?? { scope: '', role: 'reader' };
                const assigned = (k, id) => (k === 'tenant' ? id in u.tenant_roles : id in u.site_roles);
                const options = [
                  ...tenants.filter((t) => !assigned('tenant', t.id)).map((t) => [`tenant:${t.id}`, `tenant: ${t.name}`]),
                  ...sites.filter((s) => !assigned('site', s.id)).map((s) => [`site:${s.id}`, `${s.tenantName} / ${s.name}`]),
                ];
                const chip = (kind, id, role) => (
                  <span class={`chip role ${role}`}>{label(kind, id)}
                    <RoleSelect value={role} onChange={(r) => act(() => api.setRole(u.id, scopeArg(kind, id), r))} />
                    <button class="chip-x" aria-label={t('Usuń przypisanie')} onClick={() => act(() => api.resetRole(u.id, kind, id))}><Icon name="x" size={12} /></button>
                  </span>
                );
                return (
                  <tr key={u.id}>
                    <td><b>{u.username}</b>{u.id === me.id && <span class="chip accent" style="margin-left:8px">{t('to Ty')}</span>}
                      {u.no_roles && <span class="chip warn" style="margin-left:8px" title={t('Nowe konto bez żadnej roli — nie widzi żadnych danych')}>{t('brak uprawnień')}</span>}
                      <div class="muted small-text">{t('od {d}', { d: u.created_at.slice(0, 10) })}</div></td>
                    <td><RoleSelect value={u.global_role} onChange={(r) => act(() => api.setRole(u.id, {}, r), 'Zapisano rolę')} /></td>
                    <td>
                      <div class="role-chips">
                        {Object.entries(u.tenant_roles).map(([id, role]) => chip('tenant', id, role))}
                        {Object.entries(u.site_roles).map(([id, role]) => chip('site', id, role))}
                        {options.length > 0 && (
                          <span class="add-role">
                            <select value={d.scope} onChange={(e) => setAdd({ ...add, [u.id]: { ...d, scope: e.target.value } })}>
                              <option value="">{t('+ tenant / lokalizacja…')}</option>
                              {options.map(([v, l]) => <option value={v}>{l}</option>)}
                            </select>
                            {d.scope && <>
                              <RoleSelect value={d.role} onChange={(r) => setAdd({ ...add, [u.id]: { ...d, role: r } })} />
                              <button class="btn small primary" onClick={() => {
                                const [kind, id] = d.scope.split(':');
                                act(() => api.setRole(u.id, scopeArg(kind, id), d.role), 'Zapisano rolę');
                                setAdd({ ...add, [u.id]: undefined });
                              }}>{t('Dodaj')}</button>
                            </>}
                          </span>
                        )}
                      </div>
                    </td>
                    <td class="row-actions always">
                      <button class="icon-btn" title={t('Zmień hasło')} aria-label={t('Zmień hasło')} onClick={() => setPwFor(u)}><Icon name="key" size={16} /></button>
                      {u.id !== me.id && <button class="icon-btn danger" aria-label={t('Usuń użytkownika')}
                        onClick={() => confirm(t('Usunąć użytkownika {name}?', { name: u.username })) && act(() => api.delUser(u.id), 'Usunięto użytkownika')}><Icon name="trash" size={16} /></button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {pwFor && <PasswordModal target={pwFor} notify={notify} onClose={() => setPwFor(null)} />}
    </div>
  );
}
