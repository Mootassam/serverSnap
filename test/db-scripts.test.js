'use strict';
// Runs the real database scripts in a shell, with a fake "docker" and fake database tools,
// to check that the right login and password are picked from the container's settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/db');
const { q } = require('../src/shell');
const { sh, SH } = require('./harness');

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ssbin-'));
const tool = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
// docker exec [-i] NAME sh -c SCRIPT  ->  sh -c SCRIPT
tool('docker', '[ "$1" = exec ] || exit 9; shift; [ "$1" = -i ] && shift; shift; exec "$@"');
tool('mysqldump', 'echo "BIN=mysqldump ARGS=$* PWD=${MYSQL_PWD:-}"');
tool('pg_dumpall', 'echo "BIN=pg_dumpall ARGS=$*"');
tool('mongodump', 'echo "BIN=mongodump ARGS=$*"');

const unixBin = () => sh(`cd ${JSON.stringify(bin.replace(/\\/g, '/'))} && pwd`).then((r) => r.stdout.trim());

async function runIn(cmd, env) {
  const p = await unixBin();
  return sh(`PATH=${p}:$PATH; ${cmd}`, { env });
}

test('MySQL: root password from the container', { skip: !SH }, async () => {
  const r = await runIn(db.dumpCommand('mysql', 'db1'), { MYSQL_ROOT_PASSWORD: "p'w d" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ARGS=-uroot .*--all-databases/);
  assert.match(r.stdout, /PWD=p'w d$/m);
});

test('MySQL: random root password -> falls back to the app user and its database', { skip: !SH }, async () => {
  const r = await runIn(db.dumpCommand('mysql', 'db1'), { MYSQL_RANDOM_ROOT_PASSWORD: 'yes', MYSQL_USER: 'app', MYSQL_PASSWORD: 'apppw', MYSQL_DATABASE: 'shop' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ARGS=-uapp .*--no-tablespaces --databases shop/);
  assert.match(r.stdout, /PWD=apppw$/m);
});

test('MySQL: password from a Docker secret file (MYSQL_ROOT_PASSWORD_FILE)', { skip: !SH }, async () => {
  const f = path.join(bin, 'rootpw');
  fs.writeFileSync(f, 'fromfile');
  const unixFile = (await sh(`cd ${JSON.stringify(bin.replace(/\\/g, '/'))} && pwd`)).stdout.trim() + '/rootpw';
  const r = await runIn(db.dumpCommand('mysql', 'db1'), { MYSQL_ROOT_PASSWORD_FILE: unixFile });
  assert.match(r.stdout, /PWD=fromfile$/m);
});

test('PostgreSQL: uses POSTGRES_USER or postgres', { skip: !SH }, async () => {
  let r = await runIn(db.dumpCommand('postgres', 'pg'), { POSTGRES_USER: 'shop' });
  assert.match(r.stdout, /ARGS=-U shop/);
  r = await runIn(db.dumpCommand('postgres', 'pg'), {});
  assert.match(r.stdout, /ARGS=-U postgres/);
});

test('MongoDB: passes root login when set', { skip: !SH }, async () => {
  const r = await runIn(db.dumpCommand('mongo', 'mg'), { MONGO_INITDB_ROOT_USERNAME: 'admin', MONGO_INITDB_ROOT_PASSWORD: 'x y' });
  assert.match(r.stdout, /ARGS=--username admin --password x y --authenticationDatabase admin --archive/);
});

test('all generated scripts are valid shell', { skip: !SH }, async () => {
  for (const kind of Object.keys(db.KINDS)) {
    for (const fn of [db.dumpCommand, db.loadCommand, db.readyCommand]) {
      // docker exec [-i] NAME sh -c SCRIPT -> only syntax-check SCRIPT
      const r = await sh(`docker() { shift; [ "$1" = -i ] && shift; shift; sh -n -c "$3"; }; ${fn(kind, 'c')}`);
      assert.equal(r.code, 0, `${kind} ${fn.name}: ${r.stderr}`);
    }
  }
  for (const h of Object.values(db.HOST)) {
    for (const s of [h.detect, h.dump, h.load, h.has]) {
      const r = await sh(`sh -n -c ${q(s)}`);
      assert.equal(r.code, 0, r.stderr);
    }
  }
});

test.after(() => fs.rmSync(bin, { recursive: true, force: true }));
