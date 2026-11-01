'use strict';
// "Deploy with a backup": a customer's data goes into the new project before its backend starts.
// Reads what a backup holds (ServerSnap / Client backup folders, MongoDB dumps, SQL dumps,
// .zip / .tar.gz of uploaded files) and loads it on the server in the right order:
//   database container only → safety copy of what is there → load → (the deploy starts the rest)
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { q } = require('./shell');
const db = require('./db');
const local = require('./deploy-local');

const STATE_DIR = '/root/serversnap-deploy';
const rp = (p) => '"${SNAP_ROOT:-}"' + q(p);
// PIPESTATUS needs bash, whatever the login shell is
const bash = (cmd) => `bash -c ${q(cmd)}`;
const ARCHIVE_MAGIC = 0x8199e26d;

// ---------- reading a backup on this PC ----------

// First bytes of a file (to tell gzip from a raw mongo archive).
function head(file, n = 4) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, got); } finally { fs.closeSync(fd); }
}
const isGzip = (file) => { const b = head(file, 2); return b.length === 2 && b[0] === 0x1f && b[1] === 0x8b; };
const isArchive = (buf) => buf.length >= 4 && buf.readUInt32LE(0) === ARCHIVE_MAGIC;

// The top-level string fields of one BSON document (enough for the archive prelude).
function bsonStrings(buf, at) {
  const len = buf.readInt32LE(at);
  if (len < 5 || at + len > buf.length) return null;
  const out = {};
  let i = at + 4;
  const end = at + len - 1;
  const fixed = { 0x01: 8, 0x07: 12, 0x08: 1, 0x09: 8, 0x0a: 0, 0x10: 4, 0x11: 8, 0x12: 8, 0x13: 16 };
  while (i < end) {
    const type = buf[i++];
    const z = buf.indexOf(0, i);
    if (z < 0 || z >= end) return null;
    const name = buf.toString('utf8', i, z);
    i = z + 1;
    if (type === 0x02) { const n = buf.readInt32LE(i); out[name] = buf.toString('utf8', i + 4, i + 4 + n - 1); i += 4 + n; }
    else if (type === 0x03 || type === 0x04) i += buf.readInt32LE(i);
    else if (type === 0x05) i += 5 + buf.readInt32LE(i);
    else if (type in fixed) i += fixed[type];
    else return null;
  }
  return { fields: out, next: at + len };
}

// Databases and collections in a mongodump --archive (raw or gzipped). Reads only the start.
async function archiveNames(file) {
  const want = 4 * 1024 * 1024;
  const chunks = [];
  let got = 0;
  await new Promise((resolve) => {
    const src = fs.createReadStream(file, { end: isGzip(file) ? 64 * 1024 * 1024 : want });
    const s = isGzip(file) ? src.pipe(zlib.createGunzip()) : src;
    const stop = () => { src.destroy(); resolve(); };
    s.on('data', (d) => { chunks.push(d); got += d.length; if (got >= want) stop(); });
    s.on('end', resolve);
    s.on('error', resolve);
  });
  const buf = Buffer.concat(chunks);
  if (!isArchive(buf)) return null;
  const dbs = {};
  let at = 4;
  const headerDoc = bsonStrings(buf, at); // version info
  if (!headerDoc) return null;
  at = headerDoc.next;
  while (at + 4 <= buf.length && buf.readInt32LE(at) !== -1) {
    const d = bsonStrings(buf, at);
    if (!d) break;
    if (d.fields.db && d.fields.collection) (dbs[d.fields.db] = dbs[d.fields.db] || []).push(d.fields.collection);
    at = d.next;
  }
  return dbs;
}

// A mongodump folder: <db>/<collection>.bson[.gz] (or the db folder itself).
function dumpDirNames(dir) {
  const dbs = {};
  let gzip = false;
  const take = (dbName, folder) => {
    for (const f of fs.readdirSync(folder)) {
      const m = /^(.+)\.bson(\.gz)?$/.exec(f);
      if (!m) continue;
      if (m[2]) gzip = true;
      (dbs[dbName] = dbs[dbName] || []).push(m[1]);
    }
  };
  take(path.basename(dir), dir);
  const single = Object.keys(dbs).length > 0;
  if (!single) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) take(e.name, path.join(dir, e.name));
  }
  return { dbs, gzip, single };
}

const sizeOf = (p) => { try { return fs.statSync(p).size; } catch (_) { return null; } };

// What a picked file or folder holds -> { kind: 'serversnap'|'mongo'|'sql'|'files', items: [...] }
// Each item: { id, type: 'database'|'files', kind?, file, format, label, bytes, dbs?, gzip? }
async function inspectSource(p) {
  if (!fs.existsSync(p)) throw new Error(`${p} is not there anymore.`);
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const man = path.join(p, 'manifest.json');
    if (fs.existsSync(man)) {
      const m = JSON.parse(fs.readFileSync(man, 'utf8'));
      const items = [];
      for (const it of m.items || []) {
        if (it.status && it.status !== 'ok' && it.status !== 'warning') continue;
        const file = path.join(p, it.file);
        if (!fs.existsSync(file)) continue;
        if (it.type === 'database') {
          const item = { id: it.id, type: 'database', kind: it.kind, file, format: it.kind === 'mongo' ? 'archive' : 'sql', gz: true, label: it.label || `${it.kind} ${it.container || ''}`, bytes: sizeOf(file), from: it.service || it.container || null };
          if (it.kind === 'mongo') item.dbs = await archiveNames(file);
          items.push(item);
        } else {
          items.push({ id: it.id, type: 'files', file, format: 'tar.gz', label: it.label || it.name || it.path, bytes: sizeOf(file), from: it.name || it.path || null });
        }
      }
      if (!items.length) throw new Error('This backup folder has no finished parts to load.');
      return { kind: 'serversnap', source: p, made: m.finishedAt || m.startedAt || null, server: m.server || null, items };
    }
    const d = dumpDirNames(p);
    if (Object.keys(d.dbs).length) {
      return { kind: 'mongo', source: p, items: [{ id: 'mongo-dir', type: 'database', kind: 'mongo', file: p, format: 'dir', gzip: d.gzip, single: d.single, label: `MongoDB dump folder ${path.basename(p)}`, dbs: d.dbs, bytes: null }] };
    }
    return { kind: 'files', source: p, items: [{ id: 'files-dir', type: 'files', file: p, format: 'dir', label: `Folder ${path.basename(p)}`, bytes: null }] };
  }
  const name = path.basename(p).toLowerCase();
  const bytes = st.size;
  if (/\.(zip)$/.test(name) || /\.(tar\.gz|tgz|tar)$/.test(name)) {
    return { kind: 'files', source: p, items: [{ id: 'files', type: 'files', file: p, format: name.endsWith('.zip') ? 'zip' : name.endsWith('.tar') ? 'tar' : 'tar.gz', label: path.basename(p), bytes }] };
  }
  if (/\.sql(\.gz)?$/.test(name)) {
    const kind = /pg_dump|postgres/i.test(head(p, 2048).toString('latin1')) ? 'postgres' : 'mysql';
    return { kind: 'sql', source: p, items: [{ id: 'sql', type: 'database', kind, file: p, format: 'sql', gz: isGzip(p), label: path.basename(p), bytes }] };
  }
  // anything else: a mongo archive, gzipped as a whole file or with --gzip inside
  const gz = isGzip(p);
  const raw = gz ? null : head(p, 4);
  if (gz || isArchive(raw)) {
    const dbs = await archiveNames(p);
    if (dbs || gz) {
      return { kind: 'mongo', source: p, items: [{ id: 'mongo', type: 'database', kind: 'mongo', file: p, format: 'archive', gz, innerGzip: !gz && /\.gz$/.test(name), label: path.basename(p), bytes, dbs }] };
    }
  }
  throw new Error(`ServerSnap cannot read ${path.basename(p)}. Use a ServerSnap backup folder, a MongoDB dump (.archive, .gz or folder), a .sql / .sql.gz file, or a .zip / .tar.gz of files.`);
}

// The database a project's backend uses ("mongodb://db:27017/grap" -> "grap"), from its compose / .env text.
function projectDbName(folder) {
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', '.env', 'server/.env', 'backend/.env']) {
    let t;
    try { t = fs.readFileSync(path.join(folder, f), 'utf8'); } catch (_) { continue; }
    const m = /mongodb(?:\+srv)?:\/\/[^\s"'/]+\/([A-Za-z0-9_-]+)/.exec(t);
    if (m) return m[1];
  }
  return null;
}

// Database services of the project, with their kind.
function dbServices(compose) {
  return (compose.services || []).map((s) => ({ name: s.name, kind: db.kindFromImage(s.image) })).filter((s) => s.kind);
}

const SAFE_SUB = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

// data: { items: [{ type:'database', kind, file, format, gz, gzip?, innerGzip?, service, renameFrom?, renameTo? }
//                 | { type:'files', file, format, target: { type:'folder', path } | { type:'volume', name } }] }
function validate(data, compose) {
  const items = (data && data.items) || [];
  if (!items.length) throw new Error('Choose at least one part of the backup to load.');
  const services = dbServices(compose);
  for (const it of items) {
    if (!fs.existsSync(it.file)) throw new Error(`${it.file} is not there anymore.`);
    if (it.type === 'database') {
      const s = services.find((x) => x.name === it.service);
      if (!s) throw new Error(`Choose which database container gets ${path.basename(it.file)}.`);
      if (s.kind !== it.kind) throw new Error(`${path.basename(it.file)} is a ${db.KINDS[it.kind].label} dump, but "${s.name}" runs ${db.KINDS[s.kind].label}.`);
      for (const n of [it.renameFrom, it.renameTo]) if (n && !SAFE_NAME.test(n)) throw new Error(`"${n}" is not a valid database name.`);
      if (!!it.renameFrom !== !!it.renameTo) throw new Error('To rename the database, fill in both names.');
    } else {
      const t = it.target || {};
      if (t.type === 'folder' && !(SAFE_SUB.test(t.path || '') && !t.path.split('/').includes('..'))) throw new Error(`"${t.path}" is not a folder inside the project (like uploads or server/public).`);
      if (t.type === 'volume' && !SAFE_NAME.test(t.name || '')) throw new Error(`"${t.name}" is not a valid volume name.`);
      if (t.type !== 'folder' && t.type !== 'volume') throw new Error(`Choose where the files of ${path.basename(it.file)} go.`);
    }
  }
}

// ---------- loading it on the server ----------

function composeCmd() {
  return 'if docker compose version >/dev/null 2>&1; then DC="docker compose"; elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"; else echo "Docker Compose is missing" >&2; exit 1; fi';
}

// Stops the project's other containers (the backend must not write while the data changes).
function stopOthersScript(project, keep) {
  const keepRe = keep.map((k) => k.replace(/[^A-Za-z0-9_-]/g, '')).join('|') || '^$';
  return `for c in $(docker ps -q --filter ${q('label=com.docker.compose.project=' + project)}); do
  s=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c" 2>/dev/null)
  echo "$s" | grep -Eqx ${q(keepRe)} || { docker stop "$c" >/dev/null && echo "stopped $s"; }
done; true`;
}

function startServiceScript(cfg, service) {
  return `cd ${rp(cfg.remoteDir)} || exit 1
${composeCmd()}
$DC -p ${q(cfg.project)} up -d --no-deps ${q(service)} 2>&1 || exit 1
docker ps -q --filter ${q('label=com.docker.compose.project=' + cfg.project)} --filter ${q('label=com.docker.compose.service=' + service)} | head -n 1`;
}

// mongorestore arguments for one item (shell words).
function mongoArgs(it, dirInContainer) {
  const a = [];
  if (it.format === 'dir') a.push('--dir', q(dirInContainer));
  else a.push('--archive');
  if (it.innerGzip || (it.format === 'dir' && it.gzip)) a.push('--gzip');
  if (it.renameFrom && it.renameTo && it.renameFrom !== it.renameTo) a.push('--nsFrom', q(`${it.renameFrom}.*`), '--nsTo', q(`${it.renameTo}.*`));
  return a.join(' ');
}

async function waitReady(remote, kind, container, signal, seconds = 120) {
  for (let i = 0; i < seconds / 3; i++) {
    const r = await remote.exec(db.readyCommand(kind, container), { root: true, timeoutMs: 30000, signal });
    if (r.code === 0) return true;
    await new Promise((res) => setTimeout(res, 3000));
  }
  return false;
}

async function packed(it, signal) {
  // folders and .zip files travel as .tar.gz (Windows tar reads zip too)
  if (it.format === 'tar.gz' || it.format === 'tar') return { file: it.file, temp: false };
  const out = path.join(os.tmpdir(), `serversnap-data-${process.pid}-${Date.now()}.tar.gz`);
  if (it.format === 'zip') await local.run(local.tarBin(), ['-czf', out, `@${it.file}`], { signal });
  else if (it.single) await local.run(local.tarBin(), ['-czf', out, '-C', path.dirname(it.file), path.basename(it.file)], { signal });
  else await local.run(local.tarBin(), ['-czf', out, '-C', it.file, '.'], { signal });
  return { file: out, temp: true };
}

async function loadDatabase(remote, cfg, it, { say, step, signal, stamp, n }) {
  const id = `data:${n}`;
  const label = `Load ${path.basename(it.file)} into ${it.service}`;
  step(id, label, 'running', 'starting the database');
  const container = (await remote.run(startServiceScript(cfg, it.service), { root: true, timeoutMs: 10 * 60 * 1000, signal })).trim().split('\n').pop();
  if (!/^[0-9a-f]{6,64}$/.test(container)) throw new Error(`The database container "${it.service}" did not start.`);
  step(id, null, 'running', 'waiting for the database');
  if (!(await waitReady(remote, it.kind, container, signal))) throw new Error(`The database "${it.service}" did not get ready within 2 minutes. See its logs in the Docker tab.`);

  // safety copy of what is in the database now (put back if the load fails)
  step(id, null, 'running', 'safety copy of the current data');
  const safety = `${STATE_DIR}/backups/${cfg.project}-${it.service}-before-load-${stamp}.gz`;
  const dump = await remote.exec(bash(`mkdir -p ${rp(STATE_DIR + '/backups')} && ${db.dumpCommand(it.kind, container)} | gzip -6 > ${rp(safety)}; echo "rc=\${PIPESTATUS[0]}"`), { root: true, timeoutMs: 60 * 60 * 1000, signal });
  const hasSafety = /rc=0/.test(dump.stdout);
  if (hasSafety) say(`Safety copy of the old data: ${safety}`);
  else say(`Could not make a safety copy of the current data (${(dump.stderr || '').trim().split('\n').pop() || 'empty database?'}). Going on: an empty new database has nothing to lose.`, 'warn');

  step(id, null, 'running', 'loading');
  try {
    if (it.kind === 'mongo' && it.format === 'dir') {
      const tmp = '/tmp/serversnap-load';
      const pk = await packed(it, signal);
      try {
        await remote.upload(`docker exec -i ${q(container)} sh -c ${q(`rm -rf ${tmp} && mkdir -p ${tmp} && tar -xzf - -C ${tmp}`)}`, pk.file, { root: true, signal });
      } finally { if (pk.temp) fs.rm(pk.file, { force: true }, () => {}); }
      // packed as <db>/<collection>.bson, so --dir sees one folder per database
      await remote.run(bash(`${db.mongoRestoreCommand(container, mongoArgs(it, tmp))} 2>&1 | tail -n 5; rc=\${PIPESTATUS[0]}; ` +
        `docker exec ${q(container)} rm -rf ${tmp}; exit $rc`), { root: true, timeoutMs: 2 * 60 * 60 * 1000, signal });
    } else {
      const cmd = it.kind === 'mongo' ? db.mongoRestoreCommand(container, mongoArgs(it)) : db.loadCommand(it.kind, container);
      const gunzipOnServer = it.gz ? 'gzip -dc | ' : '';
      const r = await remote.upload(`${gunzipOnServer}${cmd}`, it.file, {
        root: true, signal, onBytes: it.bytes ? (b) => step(id, null, 'running', `loading ${Math.round((b / it.bytes) * 100)}%`) : undefined,
      });
      if (r.stderr && /error/i.test(r.stderr) && it.kind === 'mongo') say(r.stderr.trim().split('\n').slice(-3).join(' '), 'warn');
    }
  } catch (err) {
    if (err.code === 'ABORTED') throw err;
    if (hasSafety) {
      say('Loading failed: putting the old data back…', 'warn');
      const back = it.kind === 'mongo' ? db.mongoRestoreCommand(container, '--archive') : db.loadCommand(it.kind, container);
      const r = await remote.exec(`gzip -dc ${rp(safety)} | ${back}`, { root: true, timeoutMs: 60 * 60 * 1000 });
      say(r.code === 0 ? 'The old data is back.' : `Putting the old data back failed too. It is saved in ${safety}.`, r.code === 0 ? 'info' : 'error');
    }
    step(id, null, 'failed', err.message.split('\n').pop());
    throw new Error(`Loading ${path.basename(it.file)} failed: ${err.message}`);
  }
  step(id, null, 'ok', it.renameTo && it.renameFrom !== it.renameTo ? `as database ${it.renameTo}` : 'done');
}

async function loadFiles(remote, cfg, it, { step, signal, n }) {
  const id = `data:${n}`;
  const t = it.target;
  const where = t.type === 'folder' ? `${cfg.remoteDir}/${t.path}` : `volume ${cfg.project}_${t.name}`;
  step(id, `Put ${path.basename(it.file)} into ${where}`, 'running');
  const pk = await packed(it, signal);
  try {
    const flags = it.format === 'tar' ? '-xf' : '-xzf';
    const cmd = t.type === 'folder'
      ? `mkdir -p ${rp(`${cfg.remoteDir}/${t.path}`)} && tar ${flags} - -C ${rp(`${cfg.remoteDir}/${t.path}`)} --no-same-owner`
      : `V=${q(`${cfg.project}_${t.name}`)}; docker volume inspect "$V" >/dev/null 2>&1 || docker volume create ` +
        `--label com.docker.compose.project=${q(cfg.project)} --label com.docker.compose.volume=${q(t.name)} "$V" >/dev/null || exit 1; ` +
        `MP=$(docker volume inspect -f '{{.Mountpoint}}' "$V") && tar ${flags} - -C "$MP"`;
    const size = sizeOf(pk.file);
    await remote.upload(cmd, pk.file, { root: true, signal, onBytes: size ? (b) => step(id, null, 'running', `${Math.round((b / size) * 100)}%`) : undefined });
  } finally { if (pk.temp) fs.rm(pk.file, { force: true }, () => {}); }
  step(id, null, 'ok');
}

// Called by the deploy after the project is uploaded and before "up -d --build".
async function loadData(remote, cfg, compose, data, opts) {
  const { say, step, signal } = opts;
  const dbItems = data.items.filter((i) => i.type === 'database');
  const keep = [...new Set(dbItems.map((i) => i.service))];
  step('data:stop', 'Stop the backend while the data loads', 'running');
  const out = await remote.run(stopOthersScript(cfg.project, keep), { root: true, timeoutMs: 5 * 60 * 1000, signal });
  const stopped = out.split('\n').filter((l) => l.startsWith('stopped')).length;
  step('data:stop', null, 'ok', stopped ? `${stopped} stopped` : 'nothing was running');
  let n = 0;
  for (const it of dbItems) await loadDatabase(remote, cfg, it, { ...opts, n: ++n });
  for (const it of data.items.filter((i) => i.type === 'files')) await loadFiles(remote, cfg, it, { ...opts, n: ++n });
  say('✅ The backup is loaded. Starting the whole project now.');
}

module.exports = { inspectSource, archiveNames, dumpDirNames, bsonStrings, projectDbName, dbServices, validate, loadData, mongoArgs, stopOthersScript, ARCHIVE_MAGIC };
