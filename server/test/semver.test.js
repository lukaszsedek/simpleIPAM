import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, compare, bump } from '../../scripts/semver.mjs';

test('parse accepts SemVer and rejects everything else', () => {
  assert.deepEqual(parse('1.2.3'), { major: 1, minor: 2, patch: 3, pre: null });
  assert.equal(parse('1.0.0-rc.1').pre, 'rc.1');
  for (const bad of ['1.2', 'v1.2.3', '01.2.3', '1.2.3.4', '1.2.3-', '1.2.3+build', 'latest', '']) assert.throws(() => parse(bad), /not a valid SemVer/, bad);
});

test('compare follows the SemVer precedence rules', () => {
  const ordered = ['0.1.0', '0.1.1', '0.2.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '2.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.ok(compare(ordered[i], ordered[i + 1]) < 0, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.ok(compare(ordered[i + 1], ordered[i]) > 0);
  }
  assert.equal(compare('1.2.3', '1.2.3'), 0);
});

test('bump', () => {
  assert.equal(bump('0.1.0', 'patch'), '0.1.1');
  assert.equal(bump('0.1.7', 'minor'), '0.2.0');
  assert.equal(bump('1.4.2', 'major'), '2.0.0');
  assert.equal(bump('0.1.0', '1.0.0-rc.1'), '1.0.0-rc.1');
  assert.throws(() => bump('0.1.0', 'bogus'), /not a valid SemVer/);
});
