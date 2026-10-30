'use strict';
// Small promise helpers over an ssh2 SFTP session.
const fs = require('fs');
const crypto = require('crypto');

function readdir(sftp, dir) {
  return new Promise((resolve, reject) => sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list))));
}

function readFile(sftp, file, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const s = sftp.createReadStream(file);
    s.on('data', (d) => {
      size += d.length;
      if (size > maxBytes) { s.destroy(); reject(new Error(`${file} is too big`)); return; }
      chunks.push(d);
    });
    s.on('error', reject);
    s.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

const call = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

const CHUNK = 64 * 1024;
const PARALLEL = 32; // reads in flight: fast even on far-away servers

// Downloads to "<local>.part" with many reads in flight, checks the checksum, then renames.
// Everything is closed and the .part removed on failure or when stopped.
async function download(sftp, remote, local, { sha256, onBytes, signal } = {}) {
  const part = local + '.part';
  if (signal && signal.aborted) throw abortError();
  const rh = await call((cb) => sftp.open(remote, 'r', cb));
  let fd = null;
  let failure = null;
  const onAbort = () => { failure = failure || abortError(); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const size = (await call((cb) => sftp.fstat(rh, cb))).size;
    fd = await fs.promises.open(part, 'w');
    let nextPos = 0;
    let done = 0;
    const worker = async () => {
      const buf = Buffer.allocUnsafe(CHUNK);
      while (!failure && nextPos < size) {
        const pos = nextPos;
        nextPos += CHUNK;
        const want = Math.min(CHUNK, size - pos);
        let got = 0;
        while (got < want && !failure) {
          const n = await call((cb) => sftp.read(rh, buf, got, want - got, pos + got, cb));
          if (!n) throw new Error(`${remote} ended early (the server file changed?). Try again.`);
          got += n;
        }
        if (failure) return;
        await fd.write(buf, 0, got, pos);
        done += got;
        if (onBytes) onBytes(done);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(PARALLEL, Math.ceil(size / CHUNK))) }, () => worker().catch((e) => { failure = failure || e; })));
    if (failure) throw failure;
    await fd.close();
    fd = null;
    if (sha256) {
      const got = await sha256File(part);
      if (got !== sha256) throw new Error(`${remote} arrived damaged (checksum does not match). Try again.`);
    }
    await fs.promises.rename(part, local);
  } catch (err) {
    if (fd) await fd.close().catch(() => {});
    fd = null;
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw err;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (fd) await fd.close().catch(() => {});
    await call((cb) => sftp.close(rh, cb)).catch(() => {});
  }
}

function abortError() {
  const e = new Error('Stopped by you.');
  e.code = 'ABORTED';
  return e;
}

module.exports = { readdir, readFile, download, sha256File };
