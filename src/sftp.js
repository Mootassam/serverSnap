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

function writeFile(sftp, file, data) {
  return new Promise((resolve, reject) => sftp.writeFile(file, data, (err) => (err ? reject(err) : resolve())));
}

function exists(sftp, file) {
  return new Promise((resolve) => sftp.stat(file, (err) => resolve(!err)));
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

const isBackupName = (n) => /^\d{4}-\d{2}-\d{2}_[\d-]+$/.test(n);

async function backupNames(sftp) {
  return (await readdir(sftp, '/backups')).map((e) => e.filename).filter(isBackupName).sort();
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(abortError()); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

// "Make a backup now" from the customer's app: leave a note in /requests, then wait until the
// server (it checks every minute) has made a new backup. Resolves with the new backup's name.
// onState('waiting' | 'making') shows progress.
async function requestBackup(sftp, { onState, signal, pollMs = 5000, timeoutMs = 3 * 3600 * 1000, skipAfterMs = 20000 } = {}) {
  const before = new Set(await backupNames(sftp));
  try {
    await writeFile(sftp, '/requests/now', new Date().toISOString() + '\n');
  } catch (err) {
    const e = new Error('Your host has not turned on "Make a backup now" for you yet. Ask them to open ServerSnap → Customers → Change → Save.');
    e.cause = err;
    throw e;
  }
  const started = Date.now();
  let goneSince = null;
  let made = false;
  if (onState) onState('waiting');
  for (;;) {
    await sleep(pollMs, signal);
    const names = await backupNames(sftp);
    const fresh = names.filter((n) => !before.has(n));
    // a backup that is still being written has no manifest yet
    for (const n of fresh.reverse()) if (await exists(sftp, `/backups/${n}/manifest.json`)) return n;
    const asked = await exists(sftp, '/requests/now');
    const running = await exists(sftp, '/backups/.running');
    if (running) { made = true; goneSince = null; if (onState) onState('making'); continue; }
    if (!asked && !made) {
      // the server took the note but made nothing: the last backup is too recent
      goneSince = goneSince || Date.now();
      if (Date.now() - goneSince >= skipAfterMs) {
        const e = new Error('The server made no new backup: the last one is only a few minutes old. Download that one, or try again in 10 minutes.');
        e.code = 'TOO_SOON';
        throw e;
      }
    }
    if (made && !running) {
      // it may have finished between our two looks: check once more
      const after = (await backupNames(sftp)).filter((n) => !before.has(n)).reverse();
      for (const n of after) if (await exists(sftp, `/backups/${n}/manifest.json`)) return n;
      throw new Error('The server could not make the backup. Ask your host to check the server log.');
    }
    if (Date.now() - started > timeoutMs) throw new Error('No new backup after a long wait. Ask your host to check the server.');
  }
}

module.exports = { readdir, readFile, writeFile, exists, download, sha256File, requestBackup, backupNames, isBackupName };
