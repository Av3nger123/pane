'use strict';
// Turning untrusted relative paths (URLs, manifest fields) into files that are
// guaranteed to sit inside a given folder.

const path = require('path');

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Returns an absolute path inside `root`, or null. Rejects "..", hidden
// segments (".git", ".env"), NUL bytes and absolute paths.
// `decode: true` treats the input as a URL pathname (percent-encoded).
function resolveInside(root, relPath, { decode = true } = {}) {
  if (typeof relPath !== 'string') return null;
  let rel = relPath;
  if (decode) {
    try { rel = decodeURIComponent(rel); } catch { return null; }
  }
  if (rel.includes('\0')) return null;
  rel = rel.replace(/\\/g, '/');
  if (!decode && (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel))) return null;
  rel = rel.replace(/^\/+/, '');
  const segments = rel.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((s) => s.startsWith('.'))) return null;
  const abs = path.resolve(root, ...segments);
  return isInside(path.resolve(root), abs) ? abs : null;
}

module.exports = { isInside, resolveInside };
