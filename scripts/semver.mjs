// Strict SemVer 2.0.0 (without build metadata): MAJOR.MINOR.PATCH[-prerelease]
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function parse(v) {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`"${v}" is not a valid SemVer version (expected MAJOR.MINOR.PATCH[-prerelease], e.g. 0.2.0 or 1.0.0-rc.1)`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

// negative / 0 / positive like a sort comparator; a prerelease sorts before its release
export function compare(a, b) {
  const x = parse(a), y = parse(b);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const px = x.pre.split('.'), py = y.pre.split('.');
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    if (px[i] === undefined) return -1;
    if (py[i] === undefined) return 1;
    const nx = /^\d+$/.test(px[i]), ny = /^\d+$/.test(py[i]);
    if (nx && ny) { if (+px[i] !== +py[i]) return +px[i] - +py[i]; }
    else if (nx) return -1;
    else if (ny) return 1;
    else if (px[i] !== py[i]) return px[i] < py[i] ? -1 : 1;
  }
  return 0;
}

export function bump(current, kind) {
  const { major, minor, patch } = parse(current);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  parse(kind);
  return kind;
}
