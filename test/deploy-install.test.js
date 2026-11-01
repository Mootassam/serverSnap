'use strict';
// buildSite: npm install retries with --legacy-peer-deps on ERESOLVE, and only then.
// Runs against a fake npm placed first in PATH, so nothing is downloaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSite } = require('../src/deploy-local');

function fakeNpm(failure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-npm-'));
  const bin = path.join(root, 'bin');
  const site = path.join(root, 'site');
  fs.mkdirSync(bin);
  fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'package.json'), '{}');
  // Node script so it behaves the same on Windows and Linux; logs every call to calls.log.
  fs.writeFileSync(path.join(bin, 'fake-npm.js'), `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.log', args.join(' ') + '\\n');
if (args[0] === 'install') {
  if (!args.includes('--legacy-peer-deps')) { console.error(${JSON.stringify(failure)}); process.exit(1); }
  fs.mkdirSync('node_modules');
}
if (args[0] === 'run') { fs.mkdirSync('build'); fs.writeFileSync('build/index.html', 'ok'); }
`);
  const js = path.join(bin, 'fake-npm.js');
  fs.writeFileSync(path.join(bin, 'npm.cmd'), `@node "${js}" %*\r\n`);
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nexec node "${js}" "$@"\n`, { mode: 0o755 });
  return { bin, site };
}

async function withPath(bin, fn) {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path');
  const old = process.env[key];
  process.env[key] = bin + path.delimiter + old;
  try { return await fn(); } finally { process.env[key] = old; }
}

test('npm install retries with --legacy-peer-deps after ERESOLVE, then builds', async () => {
  const { bin, site } = fakeNpm('npm error code ERESOLVE');
  const lines = [];
  const out = await withPath(bin, () => buildSite(site, { onLine: (l) => lines.push(l) }));
  assert.equal(out, path.join(site, 'build'));
  const calls = fs.readFileSync(path.join(site, 'calls.log'), 'utf8').trim().split(/\r?\n/);
  assert.equal(calls.length, 3);
  assert.ok(!calls[0].includes('--legacy-peer-deps'));
  assert.ok(calls[1].includes('--legacy-peer-deps'));
  assert.equal(calls[2], 'run build');
  assert.ok(lines.some((l) => l.includes('trying again')));
});

test('any other npm install failure is reported, with no retry and no build', async () => {
  const { bin, site } = fakeNpm('npm error code ENOTFOUND');
  await assert.rejects(withPath(bin, () => buildSite(site)), /ENOTFOUND/);
  const calls = fs.readFileSync(path.join(site, 'calls.log'), 'utf8').trim().split(/\r?\n/);
  assert.equal(calls.length, 1);
});
