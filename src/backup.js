'use strict';
// Makes a backup: every chosen database, Docker volume and folder becomes one file
// inside a dated folder on this PC, described by manifest.json.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { q, relFromRoot, dedupePaths, isInside, slug } = require('./shell');
const db = require('./db');

const FORMAT = 1;
const MAX_ATTEMPTS = 3;
const ALWAYS_EXCLUDE = ['var/lib/docker', 'opt/containerd'];

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Turns the user's ticks into a list of backup items (pure, no I/O).
function planItems(scan, selection) {
  const used = new Set();
  const unique = (base) => {
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = base.replace(/(\.[^/]+)$/, `-${i}$1`);
    used.add(name.toLowerCase());
    return name;
  };
  const items = [];

  for (const id of selection.databases || []) {
    const d = scan.databases.find((x) => x.id === id);
    if (!d) continue;
    const base = d.where === 'docker' ? d.container : `server-${d.kind}`;
    items.push({
      id: d.id, type: 'database', label: d.label, kind: d.kind, where: d.where,
      container: d.container || null, project: d.project || null, service: d.service || null, volume: d.volume || null,
      file: unique(`databases/${slug(base)}.${db.KINDS[d.kind].ext}`),
    });
  }
  for (const name of selection.volumes || []) {
    const v = scan.volumes.find((x) => x.name === name);
    if (!v) continue;
    items.push({
      id: `volume:${v.name}`, type: 'volume', label: `Docker volume ${v.name}`, name: v.name, mountpoint: v.mountpoint,
      labels: v.labels || {}, project: v.project, db: v.db, sizeKb: v.sizeKb ?? null,
      file: unique(`volumes/${slug(v.name)}.tar.gz`),
    });
  }
  for (const p of dedupePaths(selection.folders || [])) {
    const f = scan.folders.find((x) => x.path === p);
    items.push({
      id: `files:${p}`, type: 'files', label: `Folder ${p}`, path: p, sizeKb: f ? f.sizeKb ?? null : null,
      file: unique(`files/${slug(p)}.tar.gz`),
    });
  }
  return items;
}

// Compose projects that can be started again: their folder is part of the backup.
function restorableProjects(scan, items) {
  const roots = items.filter((i) => i.type === 'files').map((i) => i.path);
  return scan.projects.filter((p) => p.workingDir && roots.some((r) => isInside(p.workingDir, r)));
}

function itemCommand(item, selection) {
  if (item.type === 'files') {
    const ex = [...ALWAYS_EXCLUDE, ...(selection.excludes || [])].filter(Boolean).map((e) => `--exclude=${q(e)}`).join(' ');
    return `cd / && tar -czf - ${ex} ${q(relFromRoot(item.path))}`;
  }
  if (item.type === 'volume') {
    const mp = item.mountpoint ? q(item.mountpoint) : "''";
    return `if [ -n ${mp} ] && [ -d ${mp} ]; then cd ${mp} && tar -czf - .; ` +
      `else docker run --rm -v ${q(item.name + ':/v:ro')} alpine:3 tar -czf - -C /v .; fi`;
  }
  if (item.type === 'database') {
    return item.where === 'docker' ? db.dumpCommand(item.kind, item.container) : db.HOST[item.kind].dump;
  }
  throw new Error(`Unknown item type ${item.type}`);
}

async function writeJson(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

async function freeBytes(dir) {
  try {
    const s = await fsp.statfs(dir);
    return s.bavail * s.bsize;
  } catch (_) { return null; }
}

/**
 * opts: {
 *   server: { id, name, host, ... }, scan, selection: { folders, volumes, databases, excludes, hostDbPassword },
 *   destRoot, connect: async () => Remote (connected, privilege detected), signal, onEvent(e)
 * }
 * Resolves with the final manifest (status 'ok' | 'partial' | 'failed').
 */
async function runBackup(opts) {
  const { server, scan, selection, destRoot, connect, signal } = opts;
  const emit = (e) => { try { opts.onEvent && opts.onEvent(e); } catch (_) { /* UI errors never stop a backup */ } };
  const log = (msg, level = 'info') => emit({ type: 'log', level, msg, at: Date.now() });

  const serverDir = path.join(destRoot, slug(server.name || server.host));
  await fsp.mkdir(serverDir, { recursive: true });
  await cleanStale(serverDir);
  const name = stamp();
  const work = path.join(serverDir, name + '.inprogress');
  await fsp.mkdir(work, { recursive: true });
  for (const sub of ['files', 'volumes', 'databases']) await fsp.mkdir(path.join(work, sub), { recursive: true });

  const items = planItems(scan, selection);
  const manifest = {
    app: 'ServerSnap',
    format: FORMAT,
    name,
    status: 'running',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    server: { id: server.id, name: server.name, host: server.host, port: server.port, username: server.username },
    source: { hostname: scan.host.hostname, os: scan.host.os, arch: scan.host.arch, docker: scan.docker },
    projects: restorableProjects(scan, items),
    loose: scan.loose || [],
    excludes: selection.excludes || [],
    items: items.map((i) => ({ ...i, status: 'waiting', bytes: 0, sha256: null, warning: null, error: null })),
    totalBytes: 0,
  };
  const mfile = path.join(work, 'manifest.json');
  await writeJson(mfile, manifest);
  emit({ type: 'start', manifest });

  const estimate = items.reduce((s, i) => s + (i.sizeKb || 0) * 1024, 0);
  const free = await freeBytes(serverDir);
  if (free != null && estimate > 0 && free < estimate * 0.6) {
    log(`Warning: this disk has ${fmt(free)} free and the server data is about ${fmt(estimate)} before compression. The backup may not fit.`, 'warn');
  }

  let remote = null;
  const getRemote = async () => {
    if (remote && remote.connected) return remote;
    remote = await connect();
    return remote;
  };

  try {
    for (const item of manifest.items) {
      if (signal && signal.aborted) break;
      item.status = 'running';
      emit({ type: 'item', item });
      log(`Copying ${item.label}…`);
      const started = Date.now();
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const r = await getRemote();
          if (item.type !== 'database' || item.where === 'host') {
            if (r.priv === 'none') throw new Error('Needs administrator (root) rights on the server.');
          }
          const res = await r.download(itemCommand(item, selection), path.join(work, item.file), {
            root: r.priv !== 'none',
            gzip: item.type === 'database',
            // Host MySQL may need a password; it goes on stdin, never on the command line.
            stdin: item.type === 'database' && item.where === 'host' && item.kind === 'mysql' ? (selection.hostDbPassword || '') + '\n' : null,
            okCodes: item.type === 'database' ? [0] : [0, 1],
            signal,
            onBytes: (b) => emit({ type: 'progress', id: item.id, bytes: b }),
          });
          item.bytes = res.bytes;
          item.sha256 = res.sha256;
          item.seconds = Math.round((Date.now() - started) / 1000);
          if (res.code === 1) {
            item.warning = 'Some files changed or could not be read while copying: ' + lastLine(res.stderr);
            item.status = 'warning';
            log(`${item.label}: done with a warning — ${item.warning}`, 'warn');
          } else {
            item.status = 'ok';
            log(`${item.label}: done (${fmt(res.bytes)})`);
          }
          break;
        } catch (err) {
          if (err.code === 'ABORTED') throw err;
          const lost = err.code === 'CONNECTION_LOST' || /ECONNRESET|EPIPE|No response|keepalive|Not connected/i.test(err.message);
          if (lost && attempt < MAX_ATTEMPTS) {
            const wait = attempt * 10;
            log(`${item.label}: connection dropped, trying again in ${wait}s (try ${attempt + 1} of ${MAX_ATTEMPTS})`, 'warn');
            if (remote) remote.close();
            remote = null;
            await sleep(wait * 1000, signal);
            continue;
          }
          item.status = 'failed';
          item.error = err.message;
          log(`${item.label}: FAILED — ${err.message}`, 'error');
          break;
        }
      }
      emit({ type: 'item', item });
      await writeJson(mfile, manifest);
    }
  } catch (err) {
    if (err.code !== 'ABORTED') throw err;
    log('Backup stopped.', 'warn');
    for (const i of manifest.items) if (i.status === 'waiting' || i.status === 'running') i.status = 'skipped';
    manifest.stopped = true;
  } finally {
    if (remote) remote.close();
  }

  const okCount = manifest.items.filter((i) => i.status === 'ok' || i.status === 'warning').length;
  manifest.status = okCount === 0 ? 'failed' : okCount === manifest.items.length ? 'ok' : 'partial';
  manifest.finishedAt = new Date().toISOString();
  manifest.totalBytes = manifest.items.reduce((s, i) => s + (i.bytes || 0), 0);
  await writeJson(mfile, manifest);

  let finalDir = path.join(serverDir, name);
  if (manifest.status === 'failed') {
    await fsp.rm(work, { recursive: true, force: true });
    finalDir = null;
  } else {
    await fsp.rename(work, finalDir);
  }
  manifest.dir = finalDir;
  emit({ type: 'done', manifest });
  return manifest;
}

// Removes leftovers of backups that were cut off (app closed, PC off) more than 6 hours ago.
async function cleanStale(serverDir) {
  const entries = await fsp.readdir(serverDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith('.inprogress')) continue;
    const full = path.join(serverDir, e.name);
    const st = await fsp.stat(full).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 6 * 3600 * 1000) await fsp.rm(full, { recursive: true, force: true });
  }
}

// All finished backups under destRoot, newest first.
async function listBackups(destRoot) {
  const out = [];
  const servers = await fsp.readdir(destRoot, { withFileTypes: true }).catch(() => []);
  for (const s of servers) {
    if (!s.isDirectory()) continue;
    const sdir = path.join(destRoot, s.name);
    const runs = await fsp.readdir(sdir, { withFileTypes: true }).catch(() => []);
    for (const r of runs) {
      if (!r.isDirectory() || r.name.endsWith('.inprogress')) continue;
      const dir = path.join(sdir, r.name);
      try {
        const m = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
        if (m.app !== 'ServerSnap') continue;
        m.dir = dir;
        out.push(m);
      } catch (_) { /* not a ServerSnap backup */ }
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Which backups to delete so only the newest `keep` remain. The newest complete one is always kept.
function pickForDeletion(backups, keep) {
  if (!keep || keep < 1) return [];
  const sorted = [...backups].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const keepSet = new Set(sorted.slice(0, keep));
  const newestOk = sorted.find((b) => b.status === 'ok');
  if (newestOk) keepSet.add(newestOk);
  return sorted.filter((b) => !keepSet.has(b));
}

async function applyRetention(destRoot, serverId, keep, log) {
  const all = (await listBackups(destRoot)).filter((b) => b.server && b.server.id === serverId);
  for (const b of pickForDeletion(all, keep)) {
    await fsp.rm(b.dir, { recursive: true, force: true });
    if (log) log(`Removed old backup ${b.name}`);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('Stopped by you.'); e.code = 'ABORTED'; reject(e); }, { once: true });
  });
}

function lastLine(s) {
  return String(s || '').trim().split('\n').filter((l) => !/Removing leading/.test(l)).slice(-1)[0] || '';
}

function fmt(bytes) {
  if (bytes == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

module.exports = { runBackup, planItems, restorableProjects, itemCommand, listBackups, pickForDeletion, applyRetention, stamp, fmt, sleep };
