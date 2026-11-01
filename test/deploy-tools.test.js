'use strict';
// Fast upload, checks, cleanup, deploy with a backup, server setup, auto-repair, .env editor,
// change domain and the database viewer. Server scripts run for real in a local shell against
// a scratch folder with fake docker / nginx / curl / systemctl.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { sh, SH } = require('./harness');
const sync = require('../src/deploy-sync');
const data = require('../src/deploy-data');
const setup = require('../src/server-setup');
const watchdog = require('../src/watchdog');
const envEdit = require('../src/env-edit');
const domain = require('../src/domain-change');
const dbview = require('../src/dbview');
const { parseCompose } = require('../src/compose');

const posix = (p) => p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `snap-${name}-`));
const write = (root, rel, text) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));

function scratch(fakes = {}) {
  const root = tmp('root').replace(/\\/g, '/');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  for (const [n, body] of Object.entries(fakes)) fs.writeFileSync(path.join(root, 'bin', n), body, { mode: 0o755 });
  return root;
}
const env = (root, more = {}) => ({ SNAP_ROOT: posix(root), ...more });
const runIn = (root, script, more) => sh(`PATH=${posix(root)}/bin:$PATH bash -s`, { stdin: script, env: env(root, more) });

// A remote that runs every command in the local shell (like the server would).
function fakeRemote(root) {
  const shell = (cmd, stdin) => sh(`PATH=${posix(root)}/bin:$PATH; ${cmd}`, { stdin, env: env(root) });
  return {
    priv: 'root',
    calls: [],
    async exec(cmd, o = {}) { this.calls.push(cmd); return shell(cmd, o.stdin); },
    async run(cmd, o = {}) { this.calls.push(cmd); const r = await shell(cmd, o.stdin); if (r.code) throw new Error(r.stderr || `exit ${r.code}`); return r.stdout; },
    async upload(cmd, file) {
      this.calls.push(cmd);
      return new Promise((resolve, reject) => {
        const p = spawn(SH, ['-c', `PATH=${posix(root)}/bin:$PATH; ${cmd}`], { env: { ...process.env, PATH: `${path.dirname(SH)};${process.env.PATH}`, ...env(root) } });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => (code ? reject(new Error(err || `exit ${code}`)) : resolve({ code, stderr: err })));
        fs.createReadStream(file).pipe(p.stdin);
      });
    },
  };
}

// ---------- fast upload ----------
test('sync: only changed files go up; a website folder is mirrored from the live copy', { skip: !SH, timeout: 60000 }, async () => {
  const root = scratch();
  const proj = tmp('proj');
  write(proj, 'server/index.js', 'v1');
  write(proj, 'server/big.bin', 'x'.repeat(50000));
  write(proj, 'node_modules/a/i.js', 'skip me');
  write(proj, 'web/index.html', 'goes up as dist');
  const remote = fakeRemote(root);
  const first = await sync.syncDir(remote, proj, '/srv/app', { exclude: ['node_modules', './web'] });
  assert.equal(first.sent, 2);
  assert.ok(exists(root, 'srv/app/server/big.bin'));
  assert.ok(!exists(root, 'srv/app/node_modules') && !exists(root, 'srv/app/web'));
  write(root, 'srv/app/uploads/photo.jpg', 'only on the server');
  write(proj, 'server/index.js', 'v2');
  const second = await sync.syncDir(remote, proj, '/srv/app', { exclude: ['node_modules', './web'] });
  assert.deepEqual([second.sent, second.same], [1, 1], 'only index.js changed');
  assert.equal(read(root, 'srv/app/server/index.js'), 'v2');
  assert.ok(exists(root, 'srv/app/uploads/photo.jpg'), 'server-only files stay');
  const none = await sync.syncDir(remote, proj, '/srv/app', { exclude: ['node_modules', './web'] });
  assert.equal(none.sent, 0);

  // website: starts from the live folder, sends the new file, removes the one gone from dist
  const dist = tmp('dist');
  write(dist, 'index.html', '<b>new</b>');
  write(dist, 'app.apk', 'A'.repeat(80000));
  write(root, 'var/www/x.com/html/index.html', '<b>old</b>');
  write(root, 'var/www/x.com/html/app.apk', 'A'.repeat(80000));
  write(root, 'var/www/x.com/html/assets/old-123.js', 'old bundle');
  const site = await sync.syncDir(remote, dist, '/var/www/x.com/html.new', { mirror: true, liveDir: '/var/www/x.com/html' });
  assert.deepEqual([site.sent, site.removed], [1, 1], 'the APK did not travel again');
  assert.equal(read(root, 'var/www/x.com/html.new/index.html'), '<b>new</b>');
  assert.ok(!exists(root, 'var/www/x.com/html.new/assets'), 'old file and its empty folder are gone');
  assert.equal(read(root, 'var/www/x.com/html/index.html'), '<b>old</b>', 'the live site is untouched');
});

test('sync: sha1sum output with odd names counts as changed', () => {
  const m = sync.parseSums('da39a3ee5e6b4b0d3255bfef95601890afd80709  ./a b.txt\n\\da39a3ee5e6b4b0d3255bfef95601890afd80709  odd\\nname\n');
  assert.deepEqual([...m.keys()], ['a b.txt']);
  const d = sync.diff(new Map([['a', '1'], ['b', '2']]), new Map([['a', '1'], ['c', '3']]), true);
  assert.deepEqual(d, { changed: ['b'], extra: ['c'], same: 1 });
});

// ---------- checks ----------
test('checks: disk and memory in plain words', { skip: !SH }, async () => {
  const root = scratch();
  const r = await runIn(root, sync.checksScript('/srv/new/app'));
  const c = sync.parseChecks(r.stdout);
  assert.ok(c.project > 0, r.stdout + r.stderr);
  assert.deepEqual(sync.judgeChecks({ project: 10 * sync.GB, docker: 20 * sync.GB, mem: 900000 }, { needDocker: true }), { fails: [], warns: [] });
  assert.match(sync.judgeChecks({ project: 10 * sync.GB, docker: 0.5 * sync.GB }, { needDocker: true }).fails[0], /almost full \(0\.5 GB free\)/);
  assert.equal(sync.judgeChecks({ project: 10 * sync.GB, docker: 0.5 * sync.GB }, { needDocker: false }).fails.length, 0, 'websites only: Docker space does not matter');
  assert.match(sync.judgeChecks({ project: 2 * sync.GB }, { needDocker: false }).warns[0], /only 2\.0 GB/);
  assert.match(sync.judgeChecks({ project: 9 * sync.GB, mem: 100000 }, { needDocker: true }).warns[0], /swap/);
});

// ---------- cleanup ----------
const DOCKER_CLEAN = `#!/bin/sh
echo "docker $*" >> "$SNAP_ROOT/calls.log"
case "$*" in
  "ps -a --filter"*"--format {{.Image}}") echo king-backend; echo mongo:4.0-xenial; echo king-web;;
  "image prune -f") echo "Deleted: sha256:abc"; echo "Total reclaimed space: 1.2GB";;
  "system df"*) echo "Images=3GB";;
esac
exit 0
`;
test('cleanup: the previous build is kept under a second name, leftovers go', { skip: !SH }, async () => {
  const root = scratch({ docker: DOCKER_CLEAN });
  await runIn(root, sync.keepPreviousScript('king'));
  const calls = read(root, 'calls.log');
  assert.match(calls, /docker tag king-backend king-backend:serversnap-prev/);
  assert.match(calls, /docker tag king-web king-web:serversnap-prev/);
  assert.doesNotMatch(calls, /tag mongo/, 'images from Docker Hub are not touched');
  const r = await runIn(root, sync.cleanupScript());
  assert.equal(sync.freedText(r.stdout), '1.2 GB');
  assert.match(read(root, 'calls.log'), /builder prune -f --filter until=168h/);
  assert.equal(sync.freedText('Total reclaimed space: 0B'), null);
});

// ---------- deploy with a backup ----------
function bsonDoc(fields) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    const name = Buffer.from(k + '\0');
    if (typeof v === 'string') { const s = Buffer.from(v + '\0'); const len = Buffer.alloc(4); len.writeInt32LE(s.length); parts.push(Buffer.from([0x02]), name, len, s); }
    else { const n = Buffer.alloc(4); n.writeInt32LE(v); parts.push(Buffer.from([0x10]), name, n); }
  }
  const body = Buffer.concat([...parts, Buffer.from([0])]);
  const len = Buffer.alloc(4); len.writeInt32LE(body.length + 4);
  return Buffer.concat([len, body]);
}
function fakeArchive() {
  const magic = Buffer.alloc(4); magic.writeUInt32LE(data.ARCHIVE_MAGIC);
  const end = Buffer.alloc(4); end.writeInt32LE(-1);
  return Buffer.concat([magic, bsonDoc({ version: '0.1', server_version: '4.0.28', concurrent_collections: 4 }),
    bsonDoc({ db: 'trade', collection: 'users', metadata: '{}', size: 10 }), bsonDoc({ db: 'trade', collection: 'orders', metadata: '{}', size: 3 }),
    bsonDoc({ db: 'admin', collection: 'system.version', metadata: '{}', size: 1 }), end, Buffer.from('body…')]);
}

test('backup: mongo archives (raw, gzipped), dump folders, SQL, zip and ServerSnap backups are read', async () => {
  const dir = tmp('data');
  const raw = path.join(dir, 'db.archive');
  fs.writeFileSync(raw, fakeArchive());
  const gz = path.join(dir, 'db.archive.gz');
  fs.writeFileSync(gz, zlib.gzipSync(fakeArchive()));
  const a = await data.inspectSource(raw);
  assert.deepEqual(a.items[0].dbs, { trade: ['users', 'orders'], admin: ['system.version'] });
  assert.equal(a.items[0].gz, false);
  const b = await data.inspectSource(gz);
  assert.equal(b.items[0].gz, true);
  assert.deepEqual(b.items[0].dbs.trade, ['users', 'orders']);
  // mongodump folder: dump/<db>/*.bson, and a single db folder
  write(dir, 'dump/trade/users.bson.gz', 'x');
  write(dir, 'dump/trade/users.metadata.json.gz', 'x');
  const c = await data.inspectSource(path.join(dir, 'dump'));
  assert.deepEqual([c.kind, c.items[0].dbs, c.items[0].gzip, c.items[0].single], ['mongo', { trade: ['users'] }, true, false]);
  const single = await data.inspectSource(path.join(dir, 'dump', 'trade'));
  assert.equal(single.items[0].single, true);
  // SQL and files
  write(dir, 'shop.sql', '-- MySQL dump 10.13\nCREATE TABLE x (id int);');
  assert.deepEqual([(await data.inspectSource(path.join(dir, 'shop.sql'))).items[0].kind], ['mysql']);
  write(dir, 'pg.sql', '-- PostgreSQL database dump\n');
  assert.equal((await data.inspectSource(path.join(dir, 'pg.sql'))).items[0].kind, 'postgres');
  write(dir, 'uploads.zip', 'PK');
  assert.equal((await data.inspectSource(path.join(dir, 'uploads.zip'))).items[0].format, 'zip');
  // a ServerSnap / Client backup folder
  const bk = path.join(dir, 'backup');
  write(bk, 'databases/king-db-1.archive.gz', zlib.gzipSync(fakeArchive()).toString('latin1'));
  fs.writeFileSync(path.join(bk, 'databases/king-db-1.archive.gz'), zlib.gzipSync(fakeArchive()));
  write(bk, 'volumes/king_upload.tar.gz', 'x');
  fs.writeFileSync(path.join(bk, 'manifest.json'), JSON.stringify({ finishedAt: '2026-10-30T10:00:00Z', items: [
    { id: 'db:docker:king-db-1', type: 'database', kind: 'mongo', container: 'king-db-1', service: 'db', file: 'databases/king-db-1.archive.gz', status: 'ok' },
    { id: 'volume:king_upload', type: 'volume', name: 'king_upload', file: 'volumes/king_upload.tar.gz', status: 'ok' },
    { id: 'db:docker:gone', type: 'database', kind: 'mongo', file: 'databases/gone.archive.gz', status: 'failed' }] }));
  const s = await data.inspectSource(bk);
  assert.equal(s.kind, 'serversnap');
  assert.deepEqual(s.items.map((i) => i.type), ['database', 'files']);
  assert.deepEqual(s.items[0].dbs.trade, ['users', 'orders']);
  write(dir, 'notes.txt', 'hello');
  await assert.rejects(data.inspectSource(path.join(dir, 'notes.txt')), /cannot read notes\.txt/);
});

test('backup: checks the targets, renames the database, and the server commands are valid shell', { skip: !SH }, async () => {
  const dir = tmp('data2');
  const f = write(dir, 'db.archive', 'x');
  const compose = parseCompose('services:\n  backend:\n    build: ./server\n  db:\n    image: mongo:4.0-xenial\n  sql:\n    image: mysql:8\n');
  assert.deepEqual(data.dbServices(compose), [{ name: 'db', kind: 'mongo' }, { name: 'sql', kind: 'mysql' }]);
  assert.throws(() => data.validate({ items: [{ type: 'database', kind: 'mongo', file: f, service: 'sql' }] }, compose), /runs MySQL/);
  assert.throws(() => data.validate({ items: [{ type: 'database', kind: 'mongo', file: f, service: 'db', renameFrom: 'a' }] }, compose), /both names/);
  assert.throws(() => data.validate({ items: [{ type: 'files', file: f, target: { type: 'folder', path: '../etc' } }] }, compose), /not a folder inside/);
  assert.doesNotThrow(() => data.validate({ items: [{ type: 'database', kind: 'mongo', file: f, service: 'db', renameFrom: 'trade', renameTo: 'grap' }, { type: 'files', file: f, target: { type: 'folder', path: 'server/uploads' } }] }, compose));
  assert.equal(data.mongoArgs({ format: 'archive', renameFrom: 'trade', renameTo: 'grap' }), "--archive --nsFrom 'trade.*' --nsTo 'grap.*'");
  assert.equal(data.mongoArgs({ format: 'dir', gzip: true }, '/tmp/x'), "--dir '/tmp/x' --gzip");
  assert.equal(data.mongoArgs({ format: 'archive', innerGzip: true }), '--archive --gzip');
  const r = await sh(`bash -n <<'EOF'\n${data.stopOthersScript('king', ['db'])}\nEOF`);
  assert.equal(r.code, 0, r.stderr);
  const proj = tmp('dbname');
  write(proj, 'docker-compose.yml', 'services:\n  backend:\n    environment:\n      DATABASE_CONNECTION: mongodb://db:27017/grap\n');
  assert.equal(data.projectDbName(proj), 'grap');
});

// ---------- server setup ----------
test('setup: every part is valid bash, and a failed part does not stop the others', { skip: !SH }, async () => {
  const all = setup.PARTS.map((p) => p.id);
  const script = setup.setupScript({ parts: all, swapGb: 2, sshPort: 2222, timezone: 'Asia/Kolkata' });
  const syn = await sh(`bash -n <<'EOF_SETUP'\n${script}\nEOF_SETUP`);
  assert.equal(syn.code, 0, syn.stderr);
  assert.match(script, /ufw allow 2222\/tcp/);
  assert.ok(script.indexOf('ufw allow 2222') < script.indexOf('ufw --force enable'), 'the SSH port opens before the firewall goes on');
  assert.throws(() => setup.setupScript({ parts: ['timezone'], timezone: 'x; rm -rf /' }), /time zone/);
  assert.throws(() => setup.setupScript({ parts: [] }), /at least one/);
  // fake apt that fails for fail2ban only: the other parts still run
  const root = scratch({
    'apt-get': '#!/bin/sh\necho "apt $*" >> "$SNAP_ROOT/calls.log"\ncase "$*" in *fail2ban*) echo "E: no fail2ban" >&2; exit 100;; esac\nexit 0\n',
    git: '#!/bin/sh\necho "git version 2.43.0"\n',
    'fail2ban-server': '', // not executable on purpose? (removed below)
  });
  fs.rmSync(path.join(root, 'bin', 'fail2ban-server'));
  const r = await runIn(root, setup.setupScript({ parts: ['base', 'fail2ban', 'updates'] }));
  const markers = r.stdout.split('\n').filter((l) => l.startsWith('@@'));
  assert.ok(markers.includes('@@STEP base|ok|git version 2.43.0'), r.stdout);
  assert.ok(markers.some((m) => m.startsWith('@@STEP fail2ban|failed|')), r.stdout);
  assert.ok(markers.some((m) => m.startsWith('@@STEP updates|')), 'updates still ran after fail2ban failed');
  assert.ok(markers.includes('@@DONE 1 failed'));
  const c = setup.parseCheck('os=Ubuntu 24.04 LTS\napt=1\ndocker=Docker version 27.1\nswap=0\nmem=2000000\n');
  assert.deepEqual([c.os, c.swap, c.mem], ['Ubuntu 24.04 LTS', 0, 2000000]);
});

// ---------- auto-repair ----------
const WD_DOCKER = `#!/bin/bash
echo "docker $*" >> "$SNAP_ROOT/calls.log"
case "$1" in
  ps) case "$*" in
        *publish=8082*) echo c3;;
        *) echo c1; echo c2; echo c3; echo c4;;
      esac;;
  inspect) case "$*" in
      "inspect -f {{.Name}} "*) echo /king-backend-1;;
      *c1) echo "king|/king-backend-1|exited|1|false|";;
      *c2) echo "king|/king-web-1|exited|0|false|";;
      *c3) echo "king|/king-db-1|running|0|false|";;
      *c4) echo "other|/other-api-1|exited|2|false|";;
    esac;;
esac
exit 0
`;
test('watchdog: starts crashed containers, leaves stopped ones, restarts a 502 site, gives up after 3', { skip: !SH, timeout: 60000 }, async () => {
  const root = scratch({
    docker: WD_DOCKER,
    curl: '#!/bin/sh\necho "curl $*" >> "$SNAP_ROOT/calls.log"\nprintf %s "${FAKE_CODE:-200}"\n',
    nginx: '#!/bin/sh\nexit 0\n',
    systemctl: '#!/bin/sh\necho "systemctl $*" >> "$SNAP_ROOT/calls.log"\ncase "$*" in "is-active --quiet nginx") exit ${FAKE_NGINX_DOWN:-0};; esac\nexit 0\n',
  });
  const cfg = { projects: ['king'], sites: [{ url: 'https://king.com/api/', port: 8082 }], disk: false };
  const ins = await runIn(root, watchdog.installScript(cfg));
  assert.match(ins.stdout, /installed/, ins.stderr);
  assert.match(read(root, 'etc/cron.d/serversnap-watchdog'), /^\* \* \* \* \* root \/usr\/local\/sbin\/serversnap-watchdog/m);
  const bin = `${posix(root)}/usr/local/sbin/serversnap-watchdog`;
  const tick = (more) => sh(`PATH=${posix(root)}/bin:$PATH bash ${bin}`, { env: env(root, more) });
  await tick({ FAKE_CODE: '502', FAKE_NGINX_DOWN: '3' });
  let calls = read(root, 'calls.log');
  assert.match(calls, /docker start c1/, 'crashed backend is started');
  assert.doesNotMatch(calls, /docker start c2/, 'a container stopped by hand (exit 0) is left alone');
  assert.doesNotMatch(calls, /docker start c4/, 'other projects are not watched');
  assert.match(calls, /systemctl restart nginx/);
  assert.doesNotMatch(calls, /docker restart c3/, 'one bad answer is not enough');
  await tick({ FAKE_CODE: '502' });
  await tick({ FAKE_CODE: '502' });
  calls = read(root, 'calls.log');
  assert.match(calls, /docker restart c3/, 'third 502 in a row restarts the container on port 8082');
  for (let i = 0; i < 3; i++) await tick({});
  const log = read(root, 'var/log/serversnap-watchdog.log');
  assert.equal((log.match(/FIXED king-backend-1 crashed/g) || []).length, 3, log);
  assert.match(log, /GAVE UP c-king-backend-1/);
  const st = watchdog.parseStatus((await runIn(root, watchdog.statusScript())).stdout);
  assert.equal(st.on, true);
  assert.deepEqual(st.config.projects, ['king']);
  assert.deepEqual(st.config.sites, [{ url: 'https://king.com/api/', port: 8082 }]);
  assert.equal(st.events[0].kind, 'gave_up', 'newest first');
  await runIn(root, watchdog.removeScript());
  assert.equal(watchdog.parseStatus((await runIn(root, watchdog.statusScript())).stdout).on, false);
});

// ---------- .env editor ----------
test('env: values change in place, comments and quotes stay, new keys go at the end', () => {
  const text = '# Redis\nREDIS_HOST=redis\nREDIS_PASSWORD="old pass"   # set by template\n\nexport API_URL=http://1.2.3.4:8082\nDEBUG=1\n';
  const rows = envEdit.entries(text);
  assert.deepEqual(rows.map((r) => [r.key, r.value, r.secret]), [['REDIS_HOST', 'redis', false], ['REDIS_PASSWORD', 'old pass', true], ['API_URL', 'http://1.2.3.4:8082', false], ['DEBUG', '1', false]]);
  const out = envEdit.rebuild(text, [
    { key: 'REDIS_HOST', value: 'redis' }, { key: 'REDIS_PASSWORD', value: 'n3w pass' }, { key: 'API_URL', value: 'https://api.new.com' }, { key: 'NEW_ONE', value: 'a b' },
  ]);
  assert.equal(out, '# Redis\nREDIS_HOST=redis\nREDIS_PASSWORD="n3w pass"\n\nexport API_URL=https://api.new.com\nNEW_ONE="a b"\n');
  assert.throws(() => envEdit.rebuild(text, [{ key: 'BAD KEY', value: 1 }]), /not a valid name/);
  assert.throws(() => envEdit.checkRel('../../etc/passwd'), /not a \.env file/);
  assert.doesNotThrow(() => envEdit.checkRel('server/.env.production'));
});

test('env: which containers read the file', () => {
  const yml = 'services:\n  backend:\n    build: ./server\n    env_file:\n      - ./config/app.env\n  worker:\n    image: node\n    env_file: config/.env\n  db:\n    image: mongo\n';
  const compose = parseCompose(yml);
  assert.deepEqual(envEdit.envFileMap(yml), { backend: ['./config/app.env'], worker: ['config/.env'] });
  assert.deepEqual(envEdit.affected(compose, yml, '.env').map((a) => a.service), ['backend', 'worker', 'db']);
  assert.deepEqual(envEdit.affected(compose, yml, 'server/.env'), [{ service: 'backend', rebuild: true, why: 'server/.env is in its build folder server' }]);
  assert.deepEqual(envEdit.affected(compose, yml, 'config/.env').map((a) => [a.service, a.rebuild]), [['worker', false]]);
});

test('env: the server file is replaced and the old one kept', { skip: !SH }, async () => {
  const root = scratch();
  write(root, 'srv/king/server/.env', 'A=1\n');
  const list = envEdit.parseList((await runIn(root, envEdit.listScript('/srv/king'))).stdout);
  assert.deepEqual(list.map((f) => f.rel), ['server/.env']);
  const r = await runIn(root, envEdit.writeScript('/srv/king', 'server/.env', 'A=2\n', 'S1'));
  assert.match(r.stdout, /saved/, r.stderr);
  assert.equal(read(root, 'srv/king/server/.env'), 'A=2\n');
  assert.equal(read(root, 'srv/king/server/.env.serversnap-S1'), 'A=1\n');
  const again = envEdit.parseList((await runIn(root, envEdit.listScript('/srv/king'))).stdout);
  assert.equal(again.length, 1, 'backups are not listed');
  const b64 = (await runIn(root, envEdit.readCommand('/srv/king', 'server/.env'))).stdout;
  assert.equal(Buffer.from(b64.trim(), 'base64').toString(), 'A=2\n');
  assert.equal(envEdit.parseList((await runIn(root, envEdit.listScript('/nope'))).stdout), null);
});

// ---------- change domain ----------
test('domain: subdomains follow, look-alike names do not, old files are kept', async () => {
  const sites = [{ id: 'graborders', domain: 'kingtrade.site' }, { id: 'pc', domain: 'pc.kingtrade.site' }];
  const pairs = domain.pairsFor(sites, { graborders: 'kingtrade.co', pc: 'pc.kingtrade.co' }, 'kingtrade.site', 'kingtrade.co');
  assert.deepEqual(pairs.map((p) => p.from), ['pc.kingtrade.site', 'kingtrade.site']);
  const r = domain.replaceAll('https://kingtrade.site/api ws.kingtrade.site KINGTRADE.SITE notkingtrade.site kingtrade.site-old', pairs);
  assert.equal(r.text, 'https://kingtrade.co/api ws.kingtrade.co kingtrade.co notkingtrade.site kingtrade.site-old');
  assert.equal(r.count, 3);
  const proj = tmp('dom');
  write(proj, 'graborders/src/config.js', "export const API = 'https://kingtrade.site/api';");
  write(proj, 'server/src/cors.js', "origin: ['https://kingtrade.site', 'https://pc.kingtrade.site']");
  write(proj, 'graborders/dist/index.html', 'kingtrade.site (old build, skipped)');
  write(proj, 'graborders/package.json', '{}');
  write(proj, 'logo.png', Buffer.from([0x89, 0x50, 0, 0, 0x6b]).toString('latin1'));
  const cfg = { sites: [{ id: 'graborders', folder: 'graborders' }, { id: 'pc', folder: 'pc' }] };
  const files = await domain.findUsages(proj, cfg, pairs);
  assert.deepEqual(files.map((f) => [f.rel, f.count, f.inSite]), [['graborders/src/config.js', 1, true], ['server/src/cors.js', 2, false]]);
  const n = await domain.applyFiles(proj, files.map((f) => f.rel), pairs, 'S1');
  assert.equal(n, 2);
  assert.equal(read(proj, 'server/src/cors.js'), "origin: ['https://kingtrade.co', 'https://pc.kingtrade.co']");
  assert.match(read(proj, '.serversnap-backup/domain-S1/server/src/cors.js'), /kingtrade\.site/);
  const nc = domain.newConfig({ mainDomain: 'kingtrade.site', sites: [{ id: 'pc', domain: 'pc.kingtrade.site', root: '/var/www/pc/html' }] }, { pc: 'pc.kingtrade.co' }, 'kingtrade.co');
  assert.deepEqual([nc.mainDomain, nc.sites[0].domain, nc.sites[0].root], ['kingtrade.co', 'pc.kingtrade.co', undefined]);
});

test('domain: the old domain answers with a 301 and keeps its certificate', { skip: !SH }, async () => {
  const root = scratch({ nginx: '#!/bin/sh\necho "nginx $*" >> "$SNAP_ROOT/calls.log"\ncase "$1" in -t) [ -n "$FAKE_NGINX_FAIL" ] && exit 1;; esac\nexit 0\n' });
  for (const d of ['etc/nginx/sites-available', 'etc/nginx/sites-enabled']) fs.mkdirSync(path.join(root, d), { recursive: true });
  write(root, 'etc/nginx/sites-available/old.com', 'server { server_name old.com www.old.com; root /var/www/old.com/html; }');
  fs.copyFileSync(path.join(root, 'etc/nginx/sites-available/old.com'), path.join(root, 'etc/nginx/sites-enabled/old.com')); // Windows: no symlinks without admin
  write(root, 'etc/letsencrypt/live/old.com/fullchain.pem', 'x');
  write(root, 'etc/letsencrypt/live/old.com/privkey.pem', 'x');
  const r = await runIn(root, domain.redirectScript('king', 'old.com', 'new.com', { stamp: 'S1' }));
  assert.ok(r.stdout.includes('@@DONE ok'), r.stdout + r.stderr);
  const f = read(root, 'etc/nginx/sites-available/old.com');
  assert.match(f, /server_name old\.com www\.old\.com;/);
  assert.match(f, /return 301 https:\/\/new\.com\$request_uri;/);
  assert.match(f, /ssl_certificate \/etc\/letsencrypt\/live\/old\.com\/fullchain\.pem;/);
  // nginx refuses it -> the old file comes back
  write(root, 'etc/nginx/sites-available/b.com', 'server { server_name b.com; }');
  const bad = await runIn(root, domain.redirectScript('king', 'b.com', 'new.com', { www: false, stamp: 'S2' }), { FAKE_NGINX_FAIL: '1' });
  assert.match(bad.stdout, /@@FAIL nginx did not accept/);
  assert.equal(read(root, 'etc/nginx/sites-available/b.com'), 'server { server_name b.com; }');
  assert.throws(() => domain.redirectScript('king', 'bad domain', 'new.com', {}), /not a domain/);
});

// ---------- database viewer ----------
test('db viewer: search filters, CSV export, and the shell helpers keep ids and dates', () => {
  assert.deepEqual(dbview.buildFilter({ field: 'email', text: 'a@b.com' }), { email: { $regex: 'a@b\\.com', $options: 'i' } });
  assert.deepEqual(dbview.buildFilter({ text: '65f0c0ffee0000000000abcd' }), { _id: { $oid: '65f0c0ffee0000000000abcd' } });
  assert.deepEqual(dbview.buildFilter({ text: 'ravi', keys: ['_id', 'email', 'phone', 'balance'] }), { $or: [{ email: { $regex: 'ravi', $options: 'i' } }, { phone: { $regex: 'ravi', $options: 'i' } }] });
  assert.deepEqual(dbview.buildFilter({ field: 'phone', text: '9876543210' }), { $or: [{ phone: 9876543210 }, { phone: { $regex: '9876543210', $options: 'i' } }] });
  assert.deepEqual(dbview.buildFilter({ json: '{"balance":{"$gt":1000}}' }), { balance: { $gt: 1000 } });
  assert.throws(() => dbview.buildFilter({ json: '{"$where":"sleep(1)"}' }), /not allowed/);
  assert.throws(() => dbview.buildFilter({ json: '[1]' }), /JSON object/);
  assert.deepEqual(dbview.buildFilter({}), {});
  assert.throws(() => dbview.checkName('a b', 'collection'), /not a valid collection name/);
  const csv = dbview.toCsv([{ _id: { $oid: 'abc' }, email: 'a@b.com', at: { $date: '2026-01-01T00:00:00Z' } }, { _id: { $oid: 'def' }, note: 'x, "y"' }]);
  assert.equal(csv, '﻿_id,email,at,note\r\nabc,a@b.com,2026-01-01T00:00:00Z,\r\ndef,,,"x, ""y"""\r\n');

  // run the in-container helpers with a pretend mongo shell
  function ObjectId(s) { if (!(this instanceof ObjectId)) return new ObjectId(s); this.str = s; }
  const printed = [];
  const ctx = { print: (x) => printed.push(x), ObjectId, NumberLong: function (x) { return { _bsontype: 'Long', toString: () => String(x) }; }, NumberDecimal: function (x) { return x; }, JSON, Object, Array, Date, String, Number };
  const args = { coll: 'users', id: { $oid: '65f0c0ffee0000000000abcd' }, doc: { at: { $date: '2026-01-01T00:00:00.000Z' }, n: { $numberLong: '5' } } };
  vm.runInNewContext(`var SNAP_ARGS = ${JSON.stringify(JSON.stringify(args))};\n${dbview.PRELUDE}\nsnapSend({ id: A.id, isId: A.id instanceof ObjectId, at: A.doc.at, isDate: A.doc.at instanceof Date, n: A.doc.n });`, ctx);
  const back = dbview.parse({ stdout: `noise\n${printed[0]}\n`, code: 0 });
  assert.deepEqual(back, { id: { $oid: '65f0c0ffee0000000000abcd' }, isId: true, at: { $date: '2026-01-01T00:00:00.000Z' }, isDate: true, n: { $numberLong: '5' } });
  assert.throws(() => dbview.parse({ stdout: '', stderr: 'MongoServerError: Authentication failed.\n    at x', code: 1 }), /Authentication failed/);
});

test('db viewer: the command reaches the mongo shell with the database name and the script', { skip: !SH }, async () => {
  const root = scratch({
    docker: '#!/bin/bash\n[ "$1" = exec ] && { shift 3; exec "$@"; }\nexit 1\n',
    // a fake shell named mongosh (found first), so the test never reaches a real database on this PC
    // $1=--quiet $2=db $3=--eval $4=script
    mongosh: '#!/bin/bash\nn=$(printf %s "$4" | grep -c snapSend)\necho "@@JSON [\\"$2\\",\\"$3\\",$n]"\n',
  });
  const { cmd, stdin } = dbview.command('abc123', 'grap', dbview.JS.collections);
  assert.match(cmd, /^docker exec -i 'abc123' sh -c /);
  const r = await sh(`PATH=${posix(root)}/bin:$PATH; ${cmd}`, { stdin, env: env(root) });
  const [dbName, flag, n] = dbview.parse(r);
  assert.deepEqual([dbName, flag], ['grap', '--eval'], r.stderr);
  assert.ok(n >= 2, 'the helpers and the action both arrive');
});
