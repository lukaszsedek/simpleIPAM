import { useEffect, useRef } from 'preact/hooks';
import { t } from './i18n.js';

// Label tables hold Polish source text; reading them translates on the fly, so a language switch needs no rebuild.
const tmap = (o) => new Proxy(o, { get: (target, k) => (typeof target[k] === 'string' ? t(target[k]) : target[k]) });

const PATHS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  cloud: 'M7 18a4 4 0 010-8 5.5 5.5 0 0110.7-1A4.5 4.5 0 0117 18H7z',
  lab: 'M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3',
  building: 'M4 21V5l8-2v18M12 9h8v12M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2M4 21h16',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5',
  edit: 'M4 20h4L19 9l-4-4L4 16v4z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  sun: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  moon: 'M20 14a8 8 0 01-10-10 8 8 0 1010 10z',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 9l5-5 5 5M5 20h14',
  radar: 'M12 12l6-6M12 3a9 9 0 109 9M12 7a5 5 0 105 5',
  history: 'M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5M12 7v5l3 2',
  x: 'M6 6l12 12M18 6L6 18',
  menu: 'M4 6h16M4 12h16M4 18h16',
  wand: 'M5 19L17 7M15 5l1-2 1 2 2 1-2 1-1 2-1-2-2-1zM6 5l.5-1 .5 1 1 .5-1 .5-.5 1-.5-1-1-.5z',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  check: 'M5 12l5 5 9-10',
  users: 'M16 20v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-2a4 4 0 00-3-3.9M16 3.1a3.5 3.5 0 010 6.8',
  tenant: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6M9 10h.01M15 10h.01',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  cloud2: 'M12 16V8M8 12l4-4 4 4M7 18a4 4 0 010-8 5.5 5.5 0 0110.7-1A4.5 4.5 0 0117 18',
  code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14',
  logout: 'M9 4H5v16h4M16 8l4 4-4 4M20 12H9',
  chevron: 'M9 6l6 6-6 6',
  key: 'M15 7a4 4 0 11-3.5 6L4 20.5V17h3v-3h3l1.5-1.5A4 4 0 0115 7z',
};

export const Icon = ({ name, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={PATHS[name] ?? PATHS.server} />
  </svg>
);

// Brand mark: the address map (gateway green, used white, reserved amber, free faded). Same artwork as public/logo.svg.
export const Logo = ({ size = 28 }) => (
  <svg class="logo" width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="simpleIPAM">
    <defs><linearGradient id="logo-g" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6366f1" /><stop offset="1" stop-color="#9b5cf6" /></linearGradient></defs>
    <rect width="64" height="64" rx="15" fill="url(#logo-g)" />
    <rect x="9.55" y="9.55" width="8.6" height="8.6" rx="2.4" fill="#34d399"/>
    <rect x="21.65" y="9.55" width="8.6" height="8.6" rx="2.4" fill="#fff"/>
    <rect x="33.75" y="9.55" width="8.6" height="8.6" rx="2.4" fill="#fff"/>
    <rect x="45.85" y="9.55" width="8.6" height="8.6" rx="2.4" fill="#fff"/>
    <rect x="9.55" y="21.65" width="8.6" height="8.6" rx="2.4" fill="#fff"/>
    <rect x="21.65" y="21.65" width="8.6" height="8.6" rx="2.4" fill="#fff"/>
    <rect x="33.75" y="21.65" width="8.6" height="8.6" rx="2.4" fill="#fff" fill-opacity=".28"/>
    <rect x="45.85" y="21.65" width="8.6" height="8.6" rx="2.4" fill="#fbbf24"/>
    <rect x="9.55" y="33.75" width="8.6" height="8.6" rx="2.4" fill="#fff" fill-opacity=".28"/>
    <rect x="21.65" y="33.75" width="8.6" height="8.6" rx="2.4" fill="#fff"/>
    <rect x="33.75" y="33.75" width="8.6" height="8.6" rx="2.4" fill="#fff" fill-opacity=".28"/>
    <rect x="45.85" y="33.75" width="8.6" height="8.6" rx="2.4" fill="#fff" fill-opacity=".28"/>
    <rect x="9.55" y="45.85" width="8.6" height="8.6" rx="2.4" fill="#fff" fill-opacity=".28"/>
    <rect x="21.65" y="45.85" width="8.6" height="8.6" rx="2.4" fill="#fff" fill-opacity=".28"/>
    <rect x="33.75" y="45.85" width="8.6" height="8.6" rx="2.4" fill="#fff"/>
    <rect x="45.85" y="45.85" width="8.6" height="8.6" rx="2.4" fill="#fff" fill-opacity=".28"/>
  </svg>
);

export const SITE_ICONS = ['home', 'building', 'lab', 'cloud', 'server'];

export function Modal({ title, onClose, children, wide }) {
  const ref = useRef();
  useEffect(() => {
    const opener = document.activeElement;      // give focus back to whatever opened the dialog
    const onKey = (e) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab' || !ref.current) return;      // keep Tab inside the dialog
      const f = [...ref.current.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex="0"]')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    };
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector('input,select,textarea')?.focus();
    return () => { window.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, []);
  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal ${wide ? 'wide' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-label={t(title)}>
        <header>
          <h2>{t(title)}</h2>
          <button class="icon-btn" onClick={onClose} aria-label={t('Zamknij')}><Icon name="x" /></button>
        </header>
        {children}
      </div>
    </div>
  );
}

export const Field = ({ label, hint, children, span }) => (
  <label class={`field ${span ? 'span' : ''}`}>
    <span>{t(label)}</span>
    {children}
    {hint && <small>{t(hint)}</small>}
  </label>
);

export function Toasts({ items }) {
  return (
    <div class="toasts" aria-live="polite">
      {items.map((i) => <div key={i.id} class={`toast ${i.kind}`}>{t(i.text)}</div>)}
    </div>
  );
}

export const TYPE_LABELS = tmap({
  server: 'Serwer', vm: 'VM', container: 'Kontener', router: 'Router', switch: 'Switch', ap: 'Access Point',
  iot: 'IoT', printer: 'Drukarka', pc: 'Komputer', phone: 'Telefon', nas: 'NAS', other: 'Inne',
});
export const ROLE_LABELS = { admin: 'Admin', contributor: 'Contributor', reader: 'Reader', none: 'None' };
export const RANK = { none: 0, reader: 1, contributor: 2, admin: 3 };
export const STATUS_LABELS = tmap({ used: 'Zajęty', reserved: 'Zarezerwowany', free: 'Wolny' });
