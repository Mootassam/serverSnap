'use strict';
// Helpers for building POSIX shell commands that run on the server.

// Quote any value as one single-quoted shell word.
function q(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// A path relative to "/" for `tar -C /` (tar warns about absolute names).
function relFromRoot(p) {
  const clean = normalizeRemotePath(p);
  return clean === '/' ? '.' : clean.replace(/^\/+/, '');
}

// "/var//www/" -> "/var/www". Rejects relative paths and "..".
function normalizeRemotePath(p) {
  const s = String(p || '').trim();
  if (!s.startsWith('/')) throw new Error(`Path must start with "/": ${s || '(empty)'}`);
  const parts = s.split('/').filter(Boolean);
  if (parts.some((x) => x === '..' || x === '.')) throw new Error(`Path must not contain "." or "..": ${s}`);
  return '/' + parts.join('/');
}

// True when `child` is `parent` itself or lies inside it.
function isInside(child, parent) {
  if (parent === '/') return true;
  return child === parent || child.startsWith(parent + '/');
}

// Drop paths that are already covered by another path in the list.
function dedupePaths(paths) {
  const norm = [...new Set(paths.map(normalizeRemotePath))].sort((a, b) => a.length - b.length);
  const out = [];
  for (const p of norm) if (!out.some((o) => isInside(p, o))) out.push(p);
  return out.sort();
}

// A short file-name-safe slug for archive names.
function slug(s) {
  const out = String(s).replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return (out || 'root').slice(0, 80);
}

module.exports = { q, relFromRoot, normalizeRemotePath, isInside, dedupePaths, slug };
