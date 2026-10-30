'use strict';
// The customer side: an access code logs in with its key only, lists the backups,
// downloads them in parallel, and refuses damaged files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Remote } = require('../src/ssh');
const clients = require('../src/clients');
const sftpUtil = require('../src/sftp');
const { startServer } = require('./harness');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssclient-'));
const root = path.join(tmp, 'chroot');
const name = '2026-10-30_03-30-00';
const bdir = path.join(root, 'backups', name);
fs.mkdirSync(path.join(bdir, 'databases'), { recursive: true });
fs.mkdirSync(path.join(bdir, 'volumes'), { recursive: true });
const big = crypto.randomBytes(3 * 1024 * 1024 + 123); // several parallel chunks
fs.writeFileSync(path.join(bdir, 'databases', 'king-db-1.archive.gz'), big);
fs.writeFileSync(path.join(bdir, 'volumes', 'king_upload.tar.gz'), 'small');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const manifest = {
  app: 'ServerSnap', format: 1, name, status: 'ok', createdAt: '2026-10-30T03:30:00Z', totalBytes: big.length + 5,
  items: [
    { id: 'db:docker:king-db-1', type: 'database', label: 'Database (MongoDB)', file: 'databases/king-db-1.archive.gz', status: 'ok', bytes: big.length, sha256: sha(big) },
    { id: 'volume:king_upload', type: 'volume', label: 'Files: upload', file: 'volumes/king_upload.tar.gz', status: 'ok', bytes: 5, sha256: sha(Buffer.from('small')) },
  ],
};
fs.writeFileSync(path.join(bdir, 'manifest.json'), JSON.stringify(manifest));

const kp = clients.makeKeyPair('test');
let srv;
test.before(async () => { srv = await startServer({ keyUsers: { snap_king: kp.publicKey }, sftpRoot: root }); });
test.after(() => { srv.close(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

function fromCode(privateKey = kp.privateKey) {
  const code = clients.encodeCode({ name: 'King', project: 'king', host: '127.0.0.1', port: srv.port, user: 'snap_king', privateKey, hostKey: null });
  const a = clients.decodeCode(code);
  return new Remote({ host: a.host, port: a.port, username: a.user, privateKey: a.privateKey });
}

test('access code logs in, lists and downloads every file intact', async () => {
  const r = fromCode();
  await r.connect();
  try {
    const sftp = await r.sftp();
    const list = (await sftpUtil.readdir(sftp, '/backups')).map((e) => e.filename);
    assert.deepEqual(list, [name]);
    const m = JSON.parse((await sftpUtil.readFile(sftp, `/backups/${name}/manifest.json`)).toString());
    const out = path.join(tmp, 'pc', name);
    let progress = 0;
    for (const it of m.items) {
      const local = path.join(out, ...it.file.split('/'));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      await sftpUtil.download(sftp, `/backups/${name}/${it.file}`, local, { sha256: it.sha256, onBytes: (b) => { progress = Math.max(progress, b); } });
      assert.equal(sha(fs.readFileSync(local)), it.sha256);
    }
    assert.ok(progress >= 5);
    assert.ok(!fs.readdirSync(path.join(out, 'databases')).some((f) => f.endsWith('.part')));
  } finally { r.close(); }
});

test('a damaged download is thrown away', async () => {
  const r = fromCode();
  await r.connect();
  try {
    const sftp = await r.sftp();
    const local = path.join(tmp, 'bad.bin');
    await assert.rejects(sftpUtil.download(sftp, `/backups/${name}/volumes/king_upload.tar.gz`, local, { sha256: '0'.repeat(64) }), /damaged/);
    assert.ok(!fs.existsSync(local));
    assert.ok(!fs.existsSync(local + '.part'));
  } finally { r.close(); }
});

test('the customer login cannot run commands or write files', async () => {
  const r = fromCode();
  await r.connect();
  try {
    await assert.rejects(r.exec('id'));
  } finally { r.close(); }
  const r2 = fromCode();
  await r2.connect();
  try {
    const sftp = await r2.sftp();
    await assert.rejects(new Promise((res, rej) => sftp.open('/backups/x', 'w', (e, h) => (e ? rej(e) : res(h)))));
  } finally { r2.close(); }
});

test('a cancelled or wrong code is refused with a clear message', async () => {
  const other = clients.makeKeyPair('other');
  const r = fromCode(other.privateKey);
  await assert.rejects(r.connect(), /Wrong username, password or key/);
});

test('stopping a download leaves no half file', async () => {
  const r = fromCode();
  await r.connect();
  try {
    const sftp = await r.sftp();
    const ac = new AbortController();
    const local = path.join(tmp, 'stopped.bin');
    const p = sftpUtil.download(sftp, `/backups/${name}/databases/king-db-1.archive.gz`, local, { sha256: manifest.items[0].sha256, signal: ac.signal, onBytes: () => ac.abort() });
    await assert.rejects(p, (e) => e.code === 'ABORTED');
    assert.ok(!fs.existsSync(local));
    assert.ok(!fs.existsSync(local + '.part'));
  } finally { r.close(); }
});
