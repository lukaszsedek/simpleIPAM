// Minimal .xlsx reader: ZIP central directory + inflate, shared/inline strings, numbers. Returns [{ name, rows: string[][] }].
import { inflateRawSync } from 'node:zlib';

const un = (s) => s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
});

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('To nie jest plik .xlsx');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Uszkodzony plik .xlsx');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    total += usize;
    if (usize > 40_000_000 || total > 80_000_000) throw new Error('Plik .xlsx jest zbyt duży');
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(start, start + csize);
    files.set(name, (method === 0 ? data : inflateRawSync(data)).toString('utf8'));
  }
  return files;
}

const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? 'A') n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const textOf = (x) => un([...x.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

export function readXlsx(buf) {
  const files = unzip(buf);
  const shared = [...(files.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rels = Object.fromEntries([...(files.get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1], target = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    return [id, target];
  }));
  const sheets = [...(files.get('xl/workbook.xml') ?? '').matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: un(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? ''), rid: /\br:id="([^"]*)"/.exec(m[0])?.[1],
  }));
  return sheets.map(({ name, rid }) => {
    const target = (rels[rid] ?? '').replace(/^\/?(xl\/)?/, 'xl/');
    const xml = files.get(target);
    const rows = [];
    for (const rm of (xml ?? '').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\br="([A-Z]+\d+)"/.exec(cm[1])?.[1];
        const type = /\bt="([^"]*)"/.exec(cm[1])?.[1];
        const inner = cm[2] ?? '';
        let v = '';
        if (type === 'inlineStr') v = textOf(inner);
        else {
          const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
          v = type === 's' ? shared[Number(raw)] ?? '' : un(raw);
        }
        row[ref ? colIndex(ref) : row.length] = v;
      }
      rows.push(Array.from(row, (x) => x ?? ''));
      if (rows.length > 20_000) break;
    }
    return { name, rows };
  });
}
