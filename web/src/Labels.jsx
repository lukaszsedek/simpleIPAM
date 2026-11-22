import { useMemo, useState } from 'preact/hooks';
import qrcode from 'qrcode-generator';
import { Modal, Field, TYPE_LABELS } from './ui.jsx';
import { t } from './i18n.js';

// Label sizes in millimetres: [width, height]. 70×37 is the common A4 sheet of 24, 105×48 a sheet of 12.
const SIZES = { small: [50, 25, 'Mała 50×25 mm'], standard: [70, 37, 'Standardowa 70×37 mm'], large: [105, 48, 'Duża 105×48 mm'] };
const MAX_LABELS = 300;

const defaultBase = () => { try { return localStorage.qrBase || ''; } catch { return ''; } };
const pageBase = () => `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;

// The QR code is a plain link, so any phone camera opens the entry; the app asks to sign in first if needed.
export const entryLink = (base, netId, ip) => `${base.replace(/\/+$/, '')}/#/n/${netId}?ip=${ip}`;
export const networkLink = (base, netId) => `${base.replace(/\/+$/, '')}/#/n/${netId}`;

const svgOf = (url) => {
  const q = qrcode(0, 'M');
  q.addData(url);
  q.make();
  return q.createSvgTag({ cellSize: 1, margin: 0, scalable: true }).replace(/<rect[^>]*fill="white"[^>]*\/>/, '');   // transparent background, black modules
};

function Qr({ url }) {
  const html = useMemo(() => svgOf(url), [url]);
  return <span class="qr" role="img" aria-label={url} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Labels({ net, entries, selected, onClose }) {
  const [size, setSize] = useState('standard');
  const [scope, setScope] = useState(selected.size ? 'sel' : 'all');
  const [withNet, setWithNet] = useState(false);
  const [mac, setMac] = useState(true);
  const [border, setBorder] = useState(true);
  const [paper, setPaper] = useState('plain');
  const [base, setBase] = useState(defaultBase() || pageBase());
  const valid = /^https?:\/\/[^\s/]+/i.test(base);
  const list = useMemo(() => entries.filter((e) => e.status !== 'free' && (scope === 'all' || selected.has(e.id))), [entries, scope, selected]);
  const shown = list.slice(0, MAX_LABELS);
  const [w, h] = SIZES[size];
  const saveBase = (v) => { setBase(v); try { if (v && v !== pageBase()) localStorage.qrBase = v; else localStorage.removeItem('qrBase'); } catch { /* not persisted */ } };

  return (
    <Modal title="Etykiety z kodem QR" onClose={onClose} wide>
      <style>{`@media print { @page { margin: ${paper === 'sheet' ? '0' : '10mm'}; } }`}</style>
      <div class="label-opts form-grid">
        <Field label="Rozmiar etykiety">
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {Object.entries(SIZES).map(([k, v]) => <option value={k}>{t(v[2])}</option>)}
          </select>
        </Field>
        <Field label="Papier">
          <select value={paper} onChange={(e) => setPaper(e.target.value)}>
            <option value="plain">{t('Zwykły papier (margines 10 mm)')}</option>
            <option value="sheet">{t('Arkusz naklejek (bez marginesu)')}</option>
          </select>
        </Field>
        <Field label="Które urządzenia">
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">{t('Wszystkie wpisy sieci ({n})', { n: entries.filter((e) => e.status !== 'free').length })}</option>
            {selected.size > 0 && <option value="sel">{t('Zaznaczone ({n})', { n: selected.size })}</option>}
          </select>
        </Field>
        <Field label="Adres aplikacji w kodzie QR" hint="Telefon musi móc go otworzyć — wpisz nazwę lub IP widoczne w Twojej sieci, nie localhost." span>
          <input class="mono" value={base} onInput={(e) => saveBase(e.target.value.trim())} aria-invalid={!valid} />
        </Field>
        <div class="event-list span">
          <label class="toggle"><input type="checkbox" checked={withNet} onChange={(e) => setWithNet(e.target.checked)} /> {t('Dodaj etykietę całej sieci (np. na szafę)')}</label>
          <label class="toggle"><input type="checkbox" checked={mac} onChange={(e) => setMac(e.target.checked)} /> {t('Pokaż adres MAC')}</label>
          <label class="toggle"><input type="checkbox" checked={border} onChange={(e) => setBorder(e.target.checked)} /> {t('Ramka do wycięcia')}</label>
        </div>
        {valid && /\/\/(localhost|127\.|\[::1\])/i.test(base) && <p class="warn-text small-text span">{t('localhost działa tylko na tym komputerze — telefon po zeskanowaniu nic nie otworzy. Wpisz adres, pod którym aplikacja jest dostępna w sieci.')}</p>}
        {!valid && <p class="error-text small-text span" role="alert">{t('Adres musi zaczynać się od http:// lub https://')}</p>}
        {list.length > MAX_LABELS && <p class="muted small-text span">{t('Pokazano pierwsze {n} etykiet — resztę wydrukuj z zaznaczenia.', { n: MAX_LABELS })}</p>}
      </div>

      <div class={`label-sheet ${border ? 'bordered' : ''}`} style={{ '--lw': `${w}mm`, '--lh': `${h}mm` }}>
        {valid && withNet && (
          <div class="label net">
            <Qr url={networkLink(base, net.id)} />
            <div class="label-text">
              <b class="label-title">{net.name}</b>
              <span class="mono">{net.cidr}</span>
              {net.vlan && <span>VLAN {net.vlan}</span>}
              {net.gateway && <span>{t('Brama')} <span class="mono">{net.gateway}</span></span>}
              <small>{net.site?.name}</small>
            </div>
          </div>
        )}
        {valid && shown.map((e) => (
          <div class="label">
            <Qr url={entryLink(base, net.id, e.ip)} />
            <div class="label-text">
              <b class="label-title mono">{e.ip}</b>
              <span class="label-name">{e.alias || e.fqdn || TYPE_LABELS[e.type]}</span>
              {mac && e.mac && <small class="mono">{e.mac}</small>}
              <small>{net.name}</small>
            </div>
          </div>
        ))}
      </div>

      <div class="modal-actions label-actions">
        <span class="muted small-text">{t('Etykiet: {n}', { n: shown.length + (withNet ? 1 : 0) })} — {t('w oknie drukowania wyłącz nagłówki i stopki oraz ustaw skalę 100%.')}</span>
        <button type="button" class="btn ghost" onClick={onClose}>{t('Zamknij')}</button>
        <button type="button" class="btn primary" disabled={!valid || (!shown.length && !withNet)} onClick={() => window.print()}>{t('Drukuj')}</button>
      </div>
    </Modal>
  );
}
