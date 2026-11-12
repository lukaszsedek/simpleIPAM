#!/usr/bin/env node
// Cuts a release: bumps the version in server/ and web/, rolls the CHANGELOG, commits and tags.
// It never pushes — review, then run the push command it prints (the tag triggers the release workflow).
//
//   node scripts/release.mjs <X.Y.Z | major | minor | patch> [--dry-run] [--skip-tests]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { bump, compare } from './semver.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const target = args.find((a) => !a.startsWith('--'));
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();
const die = (m) => { console.error(`✖ ${m}`); process.exit(1); };
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const save = (p, o) => writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`);

if (!target) die('Usage: node scripts/release.mjs <X.Y.Z | major | minor | patch> [--dry-run] [--skip-tests]');

const current = json('server/package.json').version;
let next;
try { next = bump(current, target); } catch (e) { die(e.message); }
if (compare(next, current) <= 0) die(`New version ${next} must be greater than the current ${current}`);
const tag = `v${next}`;

if (sh('git', ['branch', '--show-current']) !== 'main') die('Releases are cut from the main branch');
if (sh('git', ['status', '--porcelain'])) die('Working tree is not clean — commit or stash your changes first');
if (sh('git', ['tag', '--list', tag])) die(`Tag ${tag} already exists`);

const log = readFileSync('CHANGELOG.md', 'utf8');
const m = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/.exec(log);
if (!m || !m[1].trim()) die('CHANGELOG.md has nothing under "## [Unreleased]" — describe the changes first');

console.log(`${dry ? '[dry run] ' : ''}${current} → ${next} (${tag})`);
console.log(`Release notes:\n${m[1].trim().split('\n').map((l) => `  ${l}`).join('\n')}\n`);
if (dry) process.exit(0);

if (!args.includes('--skip-tests')) sh('npm', ['test'], { cwd: 'server', stdio: 'inherit' });

for (const p of ['server/package.json', 'web/package.json']) save(p, { ...json(p), version: next });
const lock = json('web/package-lock.json');
lock.version = next;
if (lock.packages?.['']) lock.packages[''].version = next;
save('web/package-lock.json', lock);

const date = new Date().toISOString().slice(0, 10);
writeFileSync('CHANGELOG.md', log.replace('## [Unreleased]', `## [Unreleased]\n\n## [${next}] - ${date}`));

sh('git', ['add', 'server/package.json', 'web/package.json', 'web/package-lock.json', 'CHANGELOG.md']);
sh('git', ['commit', '-m', `Release ${tag}`]);
sh('git', ['tag', '-a', tag, '-m', `simpleIPAM ${next}`]);
console.log(`✔ Committed and tagged ${tag}. To publish:\n\n    git push origin main --follow-tags\n`);
