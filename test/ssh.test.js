'use strict';
// End-to-end over a real SSH connection (local test server): connect, run commands,
// back up folders, wipe them, restore them, compare byte for byte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Remote } = require('../src/ssh');
const { runBackup } = require('../src/backup');
const { runRestore } = require('../src/restore');
const { startServer, sh, SH } = require('./harness');

let srv;
const tag = 'ss-int-' + crypto.randomBytes(4).toString('hex');
const remoteDir = `/tmp/${tag}`;
const local = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-local-'));

async function connect(extra = {}) {
  const r = new Remote({ host: '127.0.0.1', port: srv.port, username: 'test', password: srv.password, ...extra });
  await r.connect();
  r.priv = 'root'; // the test shell has no sudo; behave like a root login
  return r;
}

test.before(async () => { if (SH) srv = await startServer(); });
test.after(async () => {
  if (srv) srv.close();
  if (SH) await sh(`rm -rf ${remoteDir}`);
  fs.rmSync(local, { recursive: true, force: true });
});

test('connect, run commands, exit codes and stderr', { skip: !SH }, async () => {
  const r = await connect();
  assert.match(r.hostKey, /^SHA256:/);
  const a = await r.exec('echo out; echo err >&2; exit 3');
  assert.deepEqual([a.code, a.stdout.trim(), a.stderr.trim()], [3, 'out', 'err']);
  assert.equal((await r.exec('cat', { stdin: 'piped' })).stdout, 'piped');
  await assert.rejects(r.run('echo boom >&2; exit 1'), /boom/);
  r.close();
});

test('wrong password and changed server key are explained clearly', { skip: !SH }, async () => {
  await assert.rejects(connect({ password: 'nope' }), /Wrong username, password or key/);
  await assert.rejects(connect({ knownHostKey: 'SHA256:somethingElse' }), (e) => e.code === 'HOSTKEY_CHANGED');
});

test('gzip on download and gunzip on upload round-trip', { skip: !SH }, async () => {
  const r = await connect();
  const f = path.join(local, 'dump.sql.gz');
  const d = await r.download('printf "CREATE TABLE x;\\n"', f, { gzip: true });
  assert.ok(d.bytes > 0 && d.sha256.length === 64);
  assert.ok(!fs.existsSync(f + '.part'));
  const u = await r.upload('cat', f, { gunzip: true });
  assert.equal(u.stdout, 'CREATE TABLE x;\n');
  r.close();
});

test('a failed command leaves no half file', { skip: !SH }, async () => {
  const r = await connect();
  const f = path.join(local, 'bad.tar.gz');
  await assert.rejects(r.download('echo partial; echo "tar: fatal" >&2; exit 2', f), /fatal/);
  assert.ok(!fs.existsSync(f) && !fs.existsSync(f + '.part'));
  r.close();
});

test('stopping a running copy', { skip: !SH }, async () => {
  const r = await connect();
  const ac = new AbortController();
  const f = path.join(local, 'big.bin');
  const p = r.download('i=0; while [ $i -lt 400 ]; do head -c 65536 /dev/zero; i=$((i+1)); done', f, {
    signal: ac.signal, onBytes: (b) => { if (b > 100000) ac.abort(); },
  });
  await assert.rejects(p, (e) => e.code === 'ABORTED');
  assert.ok(!fs.existsSync(f + '.part'));
  r.close();
});

test('back up folders, wipe them, restore them: identical', { skip: !SH }, async () => {
  const site = `${remoteDir}/site`;
  const big = crypto.randomBytes(1024 * 1024).toString('base64');
  fs.writeFileSync(path.join(local, 'big.txt'), big);
  const bigUnix = (await sh(`cd ${JSON.stringify(local.replace(/\\/g, '/'))} && pwd`)).stdout.trim() + '/big.txt';
  const prep = await sh(`mkdir -p ${site}/img "${site}/we'ird dir" ${remoteDir}/conf && echo '<h1>hi</h1>' > ${site}/index.html && ` +
    `cp ${bigUnix} ${site}/img/big.txt && echo x > "${site}/we'ird dir/a b.txt" && echo cfg > ${remoteDir}/conf/app.conf`);
  assert.equal(prep.code, 0, prep.stderr);
  const before = (await sh(`cd ${remoteDir} && find . -type f | sort | xargs -I{} md5sum "{}"`)).stdout;

  const scan = {
    host: { hostname: 'test' }, docker: {}, projects: [], volumes: [], databases: [], loose: [],
    folders: [{ path: site, on: true, sizeKb: 1400 }, { path: `${remoteDir}/conf`, on: true }, { path: `${remoteDir}/missing`, on: true }],
  };
  const events = [];
  const server = { id: 'srv1', name: 'Test box', host: '127.0.0.1', port: srv.port, username: 'test' };
  const m = await runBackup({
    server, scan, destRoot: local, connect: () => connect(),
    selection: { folders: [site, `${remoteDir}/conf`, `${remoteDir}/missing`], volumes: [], databases: [], excludes: [] },
    onEvent: (e) => events.push(e),
  });
  assert.equal(m.status, 'partial'); // the missing folder fails, the rest succeed
  const byPath = Object.fromEntries(m.items.map((i) => [i.path, i]));
  assert.equal(byPath[site].status, 'ok');
  assert.equal(byPath[`${remoteDir}/missing`].status, 'failed');
  assert.ok(fs.existsSync(path.join(m.dir, 'manifest.json')));
  assert.ok(events.some((e) => e.type === 'progress'));

  await sh(`rm -rf ${remoteDir}/site ${remoteDir}/conf`);
  const manifest = JSON.parse(fs.readFileSync(path.join(m.dir, 'manifest.json'), 'utf8'));
  manifest.dir = m.dir;
  const summary = await runRestore({
    manifest, connect: () => connect(),
    options: { items: manifest.items.map((i) => i.id), startProjects: false },
  });
  assert.equal(summary.status, 'ok', JSON.stringify(summary.results));
  const after = (await sh(`cd ${remoteDir} && find . -type f | sort | xargs -I{} md5sum "{}"`)).stdout;
  assert.equal(after, before);
});

test('a damaged backup file is refused before anything is changed', { skip: !SH }, async () => {
  const dirs = fs.readdirSync(path.join(local, 'Test_box'));
  const dir = path.join(local, 'Test_box', dirs[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.dir = dir;
  const item = manifest.items.find((i) => i.status === 'ok');
  fs.appendFileSync(path.join(dir, item.file), 'garbage');
  let connected = false;
  await assert.rejects(runRestore({ manifest, connect: async () => { connected = true; return connect(); }, options: { items: [item.id] } }), /damaged/);
  assert.equal(connected, false);
});
