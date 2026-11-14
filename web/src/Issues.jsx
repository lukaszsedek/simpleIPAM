import { useEffect, useState } from 'preact/hooks';
import { api } from './api.js';
import { t } from './i18n.js';

const LEVELS = [['all', 'Wszystkie'], ['error', 'Błędy'], ['warn', 'Ostrzeżenia'], ['info', 'Informacje']];

// Everything that needs attention, across all networks, grouped by network.
export function Issues({ notify }) {
  const [data, setData] = useState(null);
  const [level, setLevel] = useState('all');
  useEffect(() => { api.allIssues().then(setData).catch((e) => notify(e.message, 'error')); }, []);
  if (!data) return <div class="skeleton" />;
  const items = data.items.filter((i) => level === 'all' || i.level === level);
  const groups = new Map();
  for (const i of items) groups.set(i.network_id, [...(groups.get(i.network_id) ?? []), i]);
  const count = (l) => data.items.filter((i) => l === 'all' || i.level === l).length;
  return (
    <div class="page">
      <header class="page-head"><div><div class="crumb">{t('Przegląd')}</div><h1>{t('Do sprawdzenia')}</h1></div></header>
      <div class="segmented" role="tablist">
        {LEVELS.map(([k, l]) => <button class={level === k ? 'on' : ''} onClick={() => setLevel(k)}>{t(l)} <small>{count(k)}</small></button>)}
      </div>
      {!items.length && <section class="card"><p class="muted">{data.total ? t('Brak pozycji o tym poziomie.') : t('Wszystko w porządku — nic do sprawdzenia.')} 🎉</p></section>}
      {[...groups].map(([id, list]) => (
        <section class="card">
          <h3><a href={`#/n/${id}`}>{list[0].tenant} / {list[0].site} / {list[0].network}</a> <span class="mono cidr">{list[0].cidr}</span></h3>
          <div class="issues">{list.map((i) => <div class={`issue ${i.level}`}>{t(i.text)}</div>)}</div>
        </section>
      ))}
    </div>
  );
}
