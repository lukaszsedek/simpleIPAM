import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import en from '../../web/src/i18n/en.js';
import de from '../../web/src/i18n/de.js';

const holes = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join();

test('English and German cover the same keys and keep the placeholders', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(de).sort());
  for (const k of Object.keys(en)) {
    assert.equal(holes(en[k]), holes(k), `en placeholders differ for: ${k}`);
    assert.equal(holes(de[k]), holes(k), `de placeholders differ for: ${k}`);
    assert.ok(en[k].trim() && de[k].trim(), `empty translation for: ${k}`);
  }
});

test('every literal t(...) key used by the web app has a translation', () => {
  const dir = new URL('../../web/src/', import.meta.url);
  const missing = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsx'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/\bt[x]?\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      const key = m[1].replace(/\\'/g, "'");
      if (!(key in en)) missing.push(`${f}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});
