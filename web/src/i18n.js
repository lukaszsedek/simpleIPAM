import { useEffect, useState } from 'preact/hooks';
import en from './i18n/en.js';
import de from './i18n/de.js';

// Polish is the source language: the Polish text itself is the key, so the code stays readable and `pl` needs no dictionary.
// `{name}` placeholders are filled from `vars`; keys with placeholders also match server messages that arrive already
// interpolated (see `tr`), so backend error texts are translated here without the server knowing about languages.
export const LANGS = { pl: 'Polski', en: 'English', de: 'Deutsch' };
const DICTS = { en, de };

const read = () => { try { return localStorage.getItem('lang'); } catch { return null; } };
const detect = () => {
  const s = read();
  if (s && LANGS[s]) return s;
  const n = (navigator.language ?? 'en').slice(0, 2).toLowerCase();
  return LANGS[n] ? n : 'en';
};

let lang = detect();
if (typeof document !== 'undefined') document.documentElement.lang = lang;
const listeners = new Set();

export const getLang = () => lang;
export function setLang(l) {
  if (!LANGS[l] || l === lang) return;
  lang = l;
  try { localStorage.setItem('lang', l); } catch { /* private mode: the choice just will not persist */ }
  document.documentElement.lang = l;
  listeners.forEach((f) => f(l));
}
// Components that must re-render on a language switch call this (App does, and every child re-renders with it).
export function useLang() {
  const [l, set] = useState(lang);
  useEffect(() => { listeners.add(set); return () => listeners.delete(set); }, []);
  return l;
}

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s);

let patterns = null;
const patternsFor = (dict) => {
  if (patterns?.dict !== dict) {
    patterns = {
      dict,
      list: Object.keys(dict).filter((k) => /\{\w+\}/.test(k)).map((k) => {
        const names = [];
        const src = k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (m, n) => { names.push(n); return '(.+?)'; });
        return { re: new RegExp(`^${src}$`, 's'), names, to: dict[k] };
      }),
    };
  }
  return patterns.list;
};

// Exact key first, then the placeholder patterns, so an already interpolated string (a template literal in the code, or a
// message built by the server) is translated too; anything unknown comes back unchanged.
export function t(key, vars) {
  const dict = DICTS[lang];
  if (!dict || typeof key !== 'string') return fill(key, vars);
  if (dict[key] !== undefined) return fill(dict[key], vars);
  if (!vars) {
    for (const p of patternsFor(dict)) {
      const m = p.re.exec(key);
      if (m) return fill(p.to, Object.fromEntries(p.names.map((n, i) => [n, dict[m[i + 1]] ?? m[i + 1]])));
    }
  }
  return fill(key, vars);
}
export const tr = t;

export const locale = () => ({ pl: 'pl-PL', en: 'en-GB', de: 'de-DE' }[lang]);
