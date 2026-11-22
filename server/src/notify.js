// Outgoing notifications: ntfy (plain POST) or a generic JSON webhook. Messages are Polish like the rest of the server.
// The JSON carries both `text` (Slack-compatible) and `content` (Discord-compatible), so those webhooks work unchanged.

export const EVENTS = {
  new_host: 'Nowe urządzenia w sieci',
  moved: 'Urządzenie zmieniło adres',
  mac_change: 'Zmiana adresu MAC',
};

export function parseUrl(v) {
  let u;
  try { u = new URL(String(v)); } catch { return null; }
  return /^https?:$/.test(u.protocol) ? u : null;
}

// Several findings from one scan become one message: a heading per event, at most `max` lines each.
export function compose(items, max = 12) {
  const groups = new Map();
  for (const i of items) groups.set(i.event, [...(groups.get(i.event) ?? []), i]);
  const parts = [];
  for (const [event, list] of groups) {
    const lines = list.slice(0, max).map((i) => `• ${i.network ? `[${i.network}] ` : ''}${i.text}`);
    if (list.length > max) lines.push(`…i ${list.length - max} więcej`);
    parts.push(`${EVENTS[event] ?? event} (${list.length})\n${lines.join('\n')}`);
  }
  const title = groups.size === 1 ? `simpleIPAM: ${EVENTS[[...groups.keys()][0]]?.toLowerCase()} (${items.length})` : `simpleIPAM: ${items.length} zdarzeń w sieci`;
  return { title, text: parts.join('\n\n'), events: [...groups.keys()], count: items.length };
}

// RFC 2047 so non-ASCII titles survive an HTTP header (ntfy decodes it).
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export async function send(cfg, msg, { fetch: f = globalThis.fetch } = {}) {
  const url = parseUrl(cfg.url);
  if (!url) throw new Error('nieprawidłowy adres URL');
  const common = { method: 'POST', signal: AbortSignal.timeout(8000), redirect: 'error' };
  const res = cfg.kind === 'webhook'
    ? await f(url, { ...common, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'simpleIPAM', title: msg.title, text: `${msg.title}\n${msg.text}`, content: `${msg.title}\n${msg.text}`, events: msg.events ?? [], count: msg.count ?? 0 }) })
    : await f(url, { ...common, headers: { Title: header(msg.title), Tags: 'computer', 'content-type': 'text/plain; charset=utf-8' }, body: msg.text });
  if (!res.ok) throw new Error(`odpowiedź HTTP ${res.status}`);
}
