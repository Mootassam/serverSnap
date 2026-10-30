'use strict';
// What to back up, remembered as the user's changes from the defaults. Anything new that
// appears on the server later (a new project, volume or database) is included automatically.
const { normalizeRemotePath } = require('./shell');

function keyOf(kind, id) { return `${kind}:${id}`; }

function emptySelection() {
  return { ticked: [], unticked: [], extraFolders: [], excludes: [] };
}

// scan + saved choices -> { folders, volumes, databases, excludes } for planItems().
function resolve(scan, saved) {
  const s = { ...emptySelection(), ...(saved || {}) };
  const ticked = new Set(s.ticked);
  const unticked = new Set(s.unticked);
  const on = (key, def) => (unticked.has(key) ? false : ticked.has(key) ? true : !!def);
  const folders = scan.folders.filter((f) => on(keyOf('folder', f.path), f.on)).map((f) => f.path);
  for (const p of s.extraFolders) {
    if (on(keyOf('folder', p), true) && !folders.includes(p)) folders.push(p);
  }
  return {
    folders,
    volumes: scan.volumes.filter((v) => on(keyOf('volume', v.name), v.on)).map((v) => v.name),
    databases: scan.databases.filter((d) => on(keyOf('db', d.id), d.on)).map((d) => d.id),
    excludes: s.excludes,
  };
}

// Records one tick/untick, keeping the lists minimal.
function setChoice(saved, key, value, defaultOn) {
  const s = { ...emptySelection(), ...(saved || {}) };
  s.ticked = s.ticked.filter((k) => k !== key);
  s.unticked = s.unticked.filter((k) => k !== key);
  if (value && !defaultOn) s.ticked.push(key);
  if (!value && defaultOn) s.unticked.push(key);
  return s;
}

function addFolder(saved, p) {
  const s = { ...emptySelection(), ...(saved || {}) };
  const clean = normalizeRemotePath(p);
  if (!s.extraFolders.includes(clean)) s.extraFolders = [...s.extraFolders, clean];
  s.unticked = s.unticked.filter((k) => k !== keyOf('folder', clean));
  return s;
}

function removeFolder(saved, p) {
  const s = { ...emptySelection(), ...(saved || {}) };
  s.extraFolders = s.extraFolders.filter((x) => x !== p);
  s.ticked = s.ticked.filter((k) => k !== keyOf('folder', p));
  s.unticked = s.unticked.filter((k) => k !== keyOf('folder', p));
  return s;
}

module.exports = { keyOf, emptySelection, resolve, setChoice, addFolder, removeFolder };
