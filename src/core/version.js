'use strict';
// Just enough version handling for "this app needs Pane >= x".
// Supported specs: "1.2.3" and ">=1.2.3" (at least), "^1.2.3" (same major;
// for 0.x, same minor), "=1.2.3" (exactly: an app pinned to one Pane, which
// then never moves to a newer Pane). Missing parts count as 0, so ">=0.1" works.

const PART = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

function parse(text) {
  const m = PART.exec(String(text).trim());
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function parseSpec(spec) {
  let s = String(spec).trim();
  let op = '>=';
  if (s.startsWith('>=')) s = s.slice(2).trim();
  else if (s.startsWith('^')) { op = '^'; s = s.slice(1).trim(); }
  else if (s.startsWith('=')) { op = '='; s = s.slice(1).trim(); }
  const want = parse(s);
  return want ? { op, want } : null;
}

const isValidSpec = (spec) => parseSpec(spec) !== null;

function satisfies(version, spec) {
  if (spec === undefined || spec === null || spec === '') return true;
  const have = parse(version);
  const parsed = parseSpec(spec);
  if (!have || !parsed) return false;
  const { op, want } = parsed;
  if (op === '=') return compare(have, want) === 0;
  if (op === '^') {
    if (have[0] !== want[0]) return false;
    if (want[0] === 0 && have[1] !== want[1]) return false;
  }
  return compare(have, want) >= 0;
}

module.exports = { parse, compare, satisfies, isValidSpec };
