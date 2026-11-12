#!/usr/bin/env node
// Helpers for the CI workflow.
//   check <X.Y.Z>   fail unless server/ + web/ package versions and the CHANGELOG match the tag
//   notes <X.Y.Z>   print that version's CHANGELOG section (used as the GitHub Release body)
//   build           print the version string baked into the image (tag → X.Y.Z, otherwise X.Y.Z-dev+<sha7>)
import { readFileSync } from 'node:fs';
import { parse } from './semver.mjs';

const [cmd, arg] = process.argv.slice(2);
const pkgVersion = (p) => JSON.parse(readFileSync(p, 'utf8')).version;
const die = (m) => { console.error(`✖ ${m}`); process.exit(1); };
const section = (v) => {
  const esc = v.replace(/[.+]/g, '\\$&');
  return new RegExp(`## \\[${esc}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`).exec(readFileSync('CHANGELOG.md', 'utf8'));
};

if (cmd === 'check') {
  try { parse(arg); } catch (e) { die(e.message); }
  for (const p of ['server/package.json', 'web/package.json']) {
    if (pkgVersion(p) !== arg) die(`${p} says ${pkgVersion(p)} but the tag is v${arg} — use scripts/release.mjs to cut releases`);
  }
  if (!section(arg)) die(`CHANGELOG.md has no "## [${arg}]" section`);
  console.log(`✔ v${arg} matches package versions and CHANGELOG`);
} else if (cmd === 'notes') {
  const m = section(arg);
  if (!m) die(`No CHANGELOG section for ${arg}`);
  console.log(m[1].trim());
} else if (cmd === 'build') {
  const sha = (process.env.GITHUB_SHA ?? 'local').slice(0, 7);
  console.log(process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME.replace(/^v/, '') : `${pkgVersion('server/package.json')}-dev+${sha}`);
} else {
  die('Usage: ci-version.mjs <check|notes|build> [version]');
}
