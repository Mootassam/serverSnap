'use strict';
// Runs the real nightly customer job (bash) with a fake "docker", then checks the result
// is a valid ServerSnap backup: manifest, checksums, contents, and "keep the newest N".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const clients = require('../src/clients');
const { sh, SH } = require('./harness');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssexport-'));
const bin = path.join(tmp, 'bin');
const base = path.join(tmp, 'srv');
const vols = path.join(tmp, 'volumes');
fs.mkdirSync(bin);
fs.mkdirSync(path.join(vols, 'king_upload', 'img'), { recursive: true });
fs.writeFileSync(path.join(vols, 'king_upload', 'img', 'photo.jpg'), 'JPEGDATA');
const tool = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

const unix = async (p) => (await sh(`cd ${JSON.stringify(p.replace(/\\/g, '/'))} && pwd`)).stdout.trim();

let uBin; let uBase; let uVols; let uTmp;
test.before(async () => {
  [uBin, uBase, uVols, uTmp] = await Promise.all([unix(bin), unix(tmp).then((t) => t + '/srv'), unix(vols), unix(tmp)]);
  fs.mkdirSync(base);
  // docker ps -q …            -> a container id (empty when DB_DOWN is set)
  // docker exec ID sh -c S    -> a fake Mongo archive (fails when DB_FAIL is set)
  // docker volume inspect …   -> the volume folder under $VOLS
  tool('docker', [
    'case "$1" in',
    '  ps) [ -n "${DB_DOWN:-}" ] || echo c0ffee123456 ;;',
    '  exec) if [ -n "${DB_FAIL:-}" ]; then echo "auth failed" >&2; exit 2; fi; printf "MONGO-ARCHIVE-%s" "$2" ;;',
    '  volume) n=$(eval echo \\${$#}); [ -d "$VOLS/$n" ] && echo "$VOLS/$n" || { echo "no such volume" >&2; exit 1; } ;;',
    '  *) exit 9 ;;',
    'esac'].join('\n'));
  tool('chown', 'exit 0');
});

const items = [
  { type: 'database', kind: 'mongo', container: 'king-db-1', service: 'db', label: 'Database (MongoDB)' },
  { type: 'volume', name: 'king_upload', label: 'Files: upload' },
];

async function runJob(env = {}, keep = 2, list = items) {
  const script = clients.exportScript({ project: 'king', user: 'snap_king', server: { id: 's1', name: 'King "VPS" \\ main', host: '203.0.113.5' }, items: list, keep, base: uBase });
  const file = path.join(tmp, 'job.sh');
  fs.writeFileSync(file, script);
  return sh(`PATH=${uBin}:$PATH VOLS=${uVols} bash ${uTmp}/job.sh`, { env });
}

const backupsDir = () => path.join(base, 'snap_king', 'backups');
const names = () => fs.readdirSync(backupsDir()).sort();
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('makes a complete backup the apps can read and restore', { skip: !SH }, async () => {
  const r = await runJob();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(names().length, 1);
  const dir = path.join(backupsDir(), names()[0]);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(m.app, 'ServerSnap');
  assert.equal(m.format, 1);
  assert.equal(m.status, 'ok');
  assert.equal(m.server.name, 'King "VPS" \\ main');
  assert.equal(m.client.project, 'king');
  assert.equal(m.items.length, 2);
  for (const it of m.items) {
    const f = path.join(dir, ...it.file.split('/'));
    assert.equal(it.status, 'ok');
    assert.equal(it.bytes, fs.statSync(f).size);
    assert.equal(it.sha256, sha(f));
  }
  const dbItem = m.items.find((i) => i.type === 'database');
  assert.equal(dbItem.where, 'docker');
  assert.equal(dbItem.service, 'db');
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'databases', 'king-db-1.archive.gz'))).toString(), 'MONGO-ARCHIVE-c0ffee123456');
  const list = await sh(`tar -tzf ${uBase}/snap_king/backups/${names()[0]}/volumes/king_upload.tar.gz`);
  assert.match(list.stdout, /\.\/img\/photo\.jpg/);
  // nothing half-made is left behind
  assert.deepEqual(fs.readdirSync(path.join(base, '.work')).filter((x) => !x.endsWith('.lock')), []);
});

test('keeps only the newest N backups', { skip: !SH }, async () => {
  await runJob();
  await runJob();
  const n = names();
  assert.equal(n.length, 2);
  assert.ok(n.every((x) => /^\d{4}-\d{2}-\d{2}_[\d-]+$/.test(x)));
});

test('a failing database is reported, the rest is still kept (partial)', { skip: !SH }, async () => {
  const before = names();
  const r = await runJob({ DB_FAIL: '1' }, 5);
  assert.notEqual(r.code, 0);
  const added = names().filter((x) => !before.includes(x));
  assert.equal(added.length, 1);
  const m = JSON.parse(fs.readFileSync(path.join(backupsDir(), added[0], 'manifest.json'), 'utf8'));
  assert.equal(m.status, 'partial');
  const dbItem = m.items.find((i) => i.type === 'database');
  assert.equal(dbItem.status, 'failed');
  assert.match(dbItem.error, /auth failed/);
  assert.equal(m.items.find((i) => i.type === 'volume').status, 'ok');
});

test('when nothing can be copied, nothing is published', { skip: !SH }, async () => {
  const before = names();
  const r = await runJob({ DB_DOWN: '1' }, 5, [items[0], { type: 'volume', name: 'missing', label: 'x' }]);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout, /Nothing could be copied/);
  assert.deepEqual(names(), before);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
