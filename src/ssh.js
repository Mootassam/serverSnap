'use strict';
// One SSH connection to a server: run commands, stream files in and out,
// and run commands as root (directly, with passwordless sudo, or sudo + password).
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline, Transform } = require('stream');
const { Client } = require('ssh2');
const { q } = require('./shell');

const STDERR_CAP = 64 * 1024;

class HostKeyError extends Error {
  constructor(expected, got) {
    super(`The server's identity changed (expected ${expected}, got ${got}). ` +
      'If you reinstalled the server this is normal: use "Forget server key" and connect again. ' +
      'Otherwise someone may be intercepting the connection.');
    this.code = 'HOSTKEY_CHANGED';
    this.expected = expected;
    this.got = got;
  }
}

class ConnectionLost extends Error {
  constructor(msg) { super(msg || 'Connection to the server was lost.'); this.code = 'CONNECTION_LOST'; }
}

function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

// Counts bytes and sha256 of whatever flows through.
function meter(onBytes) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      hash.update(chunk);
      if (onBytes) onBytes(bytes);
      cb(null, chunk);
    },
  });
  t.result = () => ({ bytes, sha256: hash.digest('hex') });
  return t;
}

function tail(buf) {
  return buf.length > STDERR_CAP ? buf.slice(buf.length - STDERR_CAP) : buf;
}

class Remote {
  /**
   * server: { host, port, username, password?, privateKey?, passphrase?, sudoPassword?, knownHostKey? }
   */
  constructor(server) {
    this.server = server;
    this.client = null;
    this.hostKey = null;      // fingerprint seen on this connection
    this.priv = null;         // 'root' | 'sudo' | 'sudo-pass' | 'none'
    this._pending = new Set();
    this._closed = true;
  }

  connect() {
    const s = this.server;
    return new Promise((resolve, reject) => {
      const client = new Client();
      let mismatch = null;
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) { client.end(); reject(mismatch || err); } else resolve();
      };
      client.on('ready', () => {
        this.client = client;
        this._closed = false;
        done();
      });
      client.on('error', (err) => {
        if (!settled) return done(friendlyConnectError(err, s));
        this._failAll(new ConnectionLost(`Connection to the server was lost: ${err.message}`));
      });
      client.on('close', () => {
        this._closed = true;
        this._failAll(new ConnectionLost());
        done(new ConnectionLost('The server closed the connection.'));
      });
      const cfg = {
        host: s.host,
        port: Number(s.port) || 22,
        username: s.username,
        readyTimeout: 25000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        hostVerifier: (key) => {
          const fp = fingerprint(key);
          this.hostKey = fp;
          if (s.knownHostKey && s.knownHostKey !== fp) {
            mismatch = new HostKeyError(s.knownHostKey, fp);
            return false;
          }
          return true;
        },
      };
      if (s.privateKey) {
        cfg.privateKey = s.privateKey;
        if (s.passphrase) cfg.passphrase = s.passphrase;
      }
      if (s.password) {
        cfg.password = s.password;
        cfg.tryKeyboard = true;
        client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => s.password)));
      }
      try { client.connect(cfg); } catch (err) { done(friendlyConnectError(err, s)); }
    });
  }

  close() {
    if (this.client) this.client.end();
    this.client = null;
    this._closed = true;
  }

  get connected() { return !!this.client && !this._closed; }

  _failAll(err) {
    for (const reject of [...this._pending]) reject(err);
    this._pending.clear();
  }

  // Wraps a command so it runs as root, and tells what (if anything) to send first on stdin.
  _wrap(cmd, root) {
    if (!root || this.priv === 'root') return { cmd, prefix: null };
    if (this.priv === 'sudo') return { cmd: `sudo -n sh -c ${q(cmd)}`, prefix: null };
    if (this.priv === 'sudo-pass') {
      return { cmd: `sudo -k -S -p '' sh -c ${q(cmd)}`, prefix: this.server.sudoPassword + '\n' };
    }
    throw new Error('This needs administrator (root) rights on the server, but this login has none. ' +
      'Log in as root, or give the user sudo rights.');
  }

  _channel(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new ConnectionLost('Not connected to the server.'));
      this.client.exec(cmd, (err, stream) => (err ? reject(err) : resolve(stream)));
    });
  }

  // Runs one command and collects its output.
  // opts: { root, stdin (string), timeoutMs, signal, onData (live output) }
  async exec(command, opts = {}) {
    const { cmd, prefix } = this._wrap(command, opts.root);
    const stream = await this._channel(cmd);
    return new Promise((resolve, reject) => {
      const out = [];
      let err = Buffer.alloc(0);
      let code = null;
      let timer = null;
      const fail = (e) => finish(e);
      const finish = (e, value) => {
        if (timer) clearTimeout(timer);
        this._pending.delete(fail);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        if (e) { try { stream.close(); } catch (_) { /* already closed */ } reject(e); } else resolve(value);
      };
      const onAbort = () => fail(abortError());
      this._pending.add(fail);
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener('abort', onAbort);
      }
      if (opts.timeoutMs) timer = setTimeout(() => fail(new Error(`Command timed out after ${Math.round(opts.timeoutMs / 1000)}s`)), opts.timeoutMs);
      stream.on('data', (d) => { out.push(d); if (opts.onData) opts.onData(d); });
      stream.stderr.on('data', (d) => { err = tail(Buffer.concat([err, d])); if (opts.onData) opts.onData(d); });
      stream.on('exit', (c) => { code = c; });
      stream.on('close', (c) => {
        finish(null, {
          code: code ?? c ?? -1,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: err.toString('utf8'),
        });
      });
      if (prefix) stream.write(prefix);
      if (opts.stdin != null) stream.write(opts.stdin);
      stream.end();
    });
  }

  // Like exec but throws when the command fails.
  async run(command, opts = {}) {
    const r = await this.exec(command, opts);
    if (r.code !== 0) {
      const e = new Error((r.stderr || r.stdout || `exit code ${r.code}`).trim().split('\n').slice(-3).join(' '));
      e.result = r;
      throw e;
    }
    return r.stdout;
  }

  // Runs a command and saves its stdout to a local file (optionally gzipping it here).
  // Writes to "<file>.part" and renames only when the command succeeded.
  // opts: { root, stdin, gzip, onBytes, signal, okCodes }
  async download(command, file, opts = {}) {
    const { cmd, prefix } = this._wrap(command, opts.root);
    const stream = await this._channel(cmd);
    const part = file + '.part';
    return new Promise((resolve, reject) => {
      let err = Buffer.alloc(0);
      let code = null;
      let closed = false;
      let written = false;
      let failed = null;
      const m = meter(opts.onBytes);
      const out = fs.createWriteStream(part);
      const stages = opts.gzip ? [stream, zlib.createGzip({ level: 6 }), m, out] : [stream, m, out];

      const fail = (e) => {
        if (failed) return;
        failed = e;
        try { stream.close(); } catch (_) { /* already closed */ }
        out.destroy();
        cleanup();
        fs.rm(part, { force: true }, () => reject(e));
      };
      const onAbort = () => fail(abortError());
      const cleanup = () => {
        this._pending.delete(fail);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      };
      const maybeDone = () => {
        if (failed || !closed || !written) return;
        cleanup();
        const okCodes = opts.okCodes || [0];
        const stderr = err.toString('utf8');
        if (!okCodes.includes(code)) {
          const e = new Error(lastLines(stderr) || `exit code ${code}`);
          e.result = { code, stderr };
          fs.rm(part, { force: true }, () => reject(e));
          return;
        }
        fs.rename(part, file, (renameErr) => {
          if (renameErr) return reject(renameErr);
          resolve({ code, stderr, ...m.result() });
        });
      };

      this._pending.add(fail);
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener('abort', onAbort);
      }
      stream.stderr.on('data', (d) => { err = tail(Buffer.concat([err, d])); });
      stream.on('exit', (c) => { code = c; });
      stream.on('close', (c) => { if (code == null) code = c ?? -1; closed = true; maybeDone(); });
      pipeline(stages, (pipeErr) => {
        if (pipeErr) return fail(pipeErr);
        written = true;
        maybeDone();
      });
      if (prefix) stream.write(prefix);
      if (opts.stdin != null) stream.write(opts.stdin);
      stream.end(); // closes the command's stdin only; its output keeps flowing
    });
  }

  // Streams a local file into a command's stdin (optionally gunzipping it here first).
  // opts: { root, prefixLine, gunzip, onBytes, signal, okCodes }
  async upload(command, file, opts = {}) {
    const { cmd, prefix } = this._wrap(command, opts.root);
    const stream = await this._channel(cmd);
    return new Promise((resolve, reject) => {
      let err = Buffer.alloc(0);
      let out = Buffer.alloc(0);
      let code = null;
      let settled = false;
      const m = meter(opts.onBytes);
      const finish = (e, v) => {
        if (settled) return;
        settled = true;
        this._pending.delete(fail);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        if (e) { try { stream.close(); } catch (_) { /* already closed */ } reject(e); } else resolve(v);
      };
      const fail = (e) => finish(e);
      const onAbort = () => fail(abortError());
      this._pending.add(fail);
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener('abort', onAbort);
      }
      stream.on('data', (d) => { out = tail(Buffer.concat([out, d])); });
      stream.stderr.on('data', (d) => { err = tail(Buffer.concat([err, d])); });
      stream.on('exit', (c) => { code = c; });
      stream.on('close', (c) => {
        if (code == null) code = c ?? -1;
        const okCodes = opts.okCodes || [0];
        const stderr = err.toString('utf8');
        if (!okCodes.includes(code)) {
          const e = new Error(lastLines(stderr) || lastLines(out.toString('utf8')) || `exit code ${code}`);
          e.result = { code, stderr };
          return finish(e);
        }
        finish(null, { code, stderr, stdout: out.toString('utf8'), ...m.result() });
      });
      if (prefix) stream.write(prefix);
      if (opts.prefixLine != null) stream.write(opts.prefixLine + '\n');
      const src = fs.createReadStream(file);
      const stages = opts.gunzip ? [src, m, zlib.createGunzip(), stream] : [src, m, stream];
      pipeline(stages, (pipeErr) => { if (pipeErr) fail(pipeErr); });
    });
  }

  // SFTP session (customer download logins only allow SFTP).
  sftp() {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new ConnectionLost('Not connected to the server.'));
      this.client.sftp((err, s) => (err ? reject(err) : resolve(s)));
    });
  }

  // Works out how this login can act as root. Sets this.priv.
  async detectPrivilege() {
    const id = await this.exec('id -u', { timeoutMs: 20000 });
    if (id.stdout.trim() === '0') return (this.priv = 'root');
    const nopass = await this.exec('sudo -n true', { timeoutMs: 20000 });
    if (nopass.code === 0) return (this.priv = 'sudo');
    if (this.server.sudoPassword) {
      const withPass = await this.exec(`sudo -k -S -p '' true`, { stdin: this.server.sudoPassword + '\n', timeoutMs: 20000 });
      if (withPass.code === 0) return (this.priv = 'sudo-pass');
    }
    return (this.priv = 'none');
  }
}

function lastLines(s, n = 4) {
  return String(s || '').trim().split('\n').filter(Boolean).slice(-n).join('\n');
}

function abortError() {
  const e = new Error('Stopped by you.');
  e.code = 'ABORTED';
  return e;
}

function friendlyConnectError(err, s) {
  const m = String(err && err.message || err);
  let msg = m;
  if (/All configured authentication methods failed/i.test(m)) msg = 'Wrong username, password or key.';
  else if (/ECONNREFUSED/.test(m)) msg = `The server refused the connection on port ${s.port || 22}. Is SSH running and is the port right?`;
  else if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(m)) msg = `No answer from ${s.host}. Check the IP address, the port, and any firewall.`;
  else if (/ENOTFOUND|EAI_AGAIN/.test(m)) msg = `Cannot find the server "${s.host}". Check the address.`;
  else if (/EHOSTUNREACH|ENETUNREACH/.test(m)) msg = 'The server cannot be reached. Check your internet connection.';
  else if (/Cannot parse privateKey|Encrypted private OpenSSH key detected|bad passphrase/i.test(m)) msg = 'The SSH key could not be read. Is the key file right, and does it need a passphrase?';
  const e = new Error(msg);
  e.code = err && err.code;
  e.cause = err;
  return e;
}

module.exports = { Remote, HostKeyError, ConnectionLost, fingerprint, lastLines };
