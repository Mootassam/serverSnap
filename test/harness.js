'use strict';
// A small SSH server for tests: every command runs in a local POSIX shell (Git Bash on Windows).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Server, utils } = require('ssh2');

function findShell() {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\sh.exe']
    : ['/bin/sh'];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const SH = findShell();
const ENV = { ...process.env };
if (process.platform === 'win32' && SH) ENV.PATH = path.dirname(SH) + ';' + ENV.PATH; // usr\bin: tar, gzip, find…

// Runs a script locally, like the server would.
function sh(script, { env, stdin } = {}) {
  return new Promise((resolve) => {
    const p = spawn(SH, ['-c', script], { env: { ...ENV, ...(env || {}) } });
    const out = []; const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    if (stdin != null) p.stdin.end(stdin); else p.stdin.end();
  });
}

const { STATUS_CODE } = utils.sftp;

// Read-only SFTP inside `root` (like a customer login locked in its own folder).
function serveSftp(sftp, root) {
  const handles = new Map();
  let next = 0;
  const real = (p) => {
    const v = path.posix.normalize('/' + String(p || '/')).replace(/\/+$/, '') || '/';
    return { v, local: path.join(root, ...v.split('/').filter(Boolean)) };
  };
  const attrsOf = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
  const newHandle = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(++next); handles.set(next, value); return b; };
  const get = (b) => handles.get(b.readUInt32BE(0));
  sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: real(p).v, longname: real(p).v, attrs: {} }]));
  for (const ev of ['STAT', 'LSTAT']) {
    sftp.on(ev, (id, p) => fs.stat(real(p).local, (e, st) => (e ? sftp.status(id, STATUS_CODE.NO_SUCH_FILE) : sftp.attrs(id, attrsOf(st)))));
  }
  sftp.on('OPENDIR', (id, p) => fs.readdir(real(p).local, (e, list) => (e ? sftp.status(id, STATUS_CODE.NO_SUCH_FILE) : sftp.handle(id, newHandle({ dir: real(p).local, list, sent: false })))));
  sftp.on('READDIR', (id, hb) => {
    const h = get(hb);
    if (!h || !h.list) return sftp.status(id, STATUS_CODE.FAILURE);
    if (h.sent) return sftp.status(id, STATUS_CODE.EOF);
    h.sent = true;
    sftp.name(id, h.list.map((n) => { const st = fs.statSync(path.join(h.dir, n)); return { filename: n, longname: n, attrs: attrsOf(st) }; }));
  });
  // Like the real customer login: everything is read-only except the /requests folder.
  const writable = (v) => v.startsWith('/requests/') && fs.existsSync(path.join(root, 'requests'));
  sftp.on('OPEN', (id, p, flags) => {
    const wants = flags & (utils.sftp.OPEN_MODE.WRITE | utils.sftp.OPEN_MODE.CREAT);
    if (wants && !writable(real(p).v)) return sftp.status(id, STATUS_CODE.PERMISSION_DENIED);
    fs.open(real(p).local, wants ? 'w' : 'r', (e, fd) => (e ? sftp.status(id, STATUS_CODE.NO_SUCH_FILE) : sftp.handle(id, newHandle({ fd }))));
  });
  sftp.on('WRITE', (id, hb, offset, data) => {
    const h = get(hb);
    fs.write(h.fd, data, 0, data.length, offset, (e) => sftp.status(id, e ? STATUS_CODE.FAILURE : STATUS_CODE.OK));
  });
  sftp.on('REMOVE', (id, p) => {
    if (!writable(real(p).v)) return sftp.status(id, STATUS_CODE.PERMISSION_DENIED);
    fs.unlink(real(p).local, (e) => sftp.status(id, e ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.OK));
  });
  sftp.on('FSETSTAT', (id) => sftp.status(id, STATUS_CODE.OK));
  sftp.on('SETSTAT', (id) => sftp.status(id, STATUS_CODE.PERMISSION_DENIED));
  sftp.on('FSTAT', (id, hb) => { const h = get(hb); fs.fstat(h.fd, (e, st) => (e ? sftp.status(id, STATUS_CODE.FAILURE) : sftp.attrs(id, attrsOf(st)))); });
  sftp.on('READ', (id, hb, offset, length) => {
    const h = get(hb);
    const buf = Buffer.alloc(length);
    fs.read(h.fd, buf, 0, length, offset, (e, n) => {
      if (e) return sftp.status(id, STATUS_CODE.FAILURE);
      if (!n) return sftp.status(id, STATUS_CODE.EOF);
      sftp.data(id, buf.subarray(0, n));
    });
  });
  sftp.on('close', () => { for (const h of handles.values()) if (h.fd != null) fs.close(h.fd, () => {}); handles.clear(); });
  sftp.on('CLOSE', (id, hb) => {
    const h = get(hb);
    handles.delete(hb.readUInt32BE(0));
    if (h && h.fd != null) fs.close(h.fd, () => sftp.status(id, STATUS_CODE.OK)); else sftp.status(id, STATUS_CODE.OK);
  });
}

// keyUsers: { username: publicKeyString } -> those users log in with that key and only get SFTP in sftpRoot.
function startServer({ password = 'secret', env = {}, keyUsers = {}, sftpRoot = null } = {}) {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const log = [];
  const clients = new Set();
  const allowed = Object.fromEntries(Object.entries(keyUsers).map(([u, k]) => [u, utils.parseKey(k)]));
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    let keyUser = false;
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      const k = allowed[ctx.username];
      if (k && ctx.method === 'publickey' && ctx.key.algo === k.type && ctx.key.data.equals(k.getPublicSSH())) {
        if (ctx.signature && k.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(['publickey']);
        keyUser = true;
        return ctx.accept();
      }
      if (!k && ctx.method === 'password' && ctx.password === password) ctx.accept(); else ctx.reject(k ? ['publickey'] : ['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp, rejectSftp) => (keyUser && sftpRoot ? serveSftp(acceptSftp(), sftpRoot) : rejectSftp()));
        if (keyUser) { session.on('exec', (_a, reject) => reject()); session.on('shell', (_a, reject) => reject()); return; }
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          log.push(info.command);
          const child = spawn(SH, ['-c', info.command], { env: { ...ENV, ...env } });
          stream.on('close', () => { if (child.exitCode == null) child.kill(); });
          stream.pipe(child.stdin);
          child.stdin.on('error', () => { /* command exited before reading all input */ });
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr);
          let pending = 2;
          const done = () => { if (--pending === 0) { stream.exit(child.exitCode ?? 0); stream.end(); } };
          child.stdout.on('end', done);
          child.on('exit', done);
        });
      });
    });
    client.on('error', () => { /* client went away */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, password, log, close: () => { for (const c of clients) c.end(); server.close(); } }));
  });
}

module.exports = { SH, sh, startServer };
