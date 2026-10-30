'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, relFromRoot, normalizeRemotePath, dedupePaths, slug } = require('../src/shell');
const { kindFromImage } = require('../src/db');
const { analyseContainers, parseDu } = require('../src/scanner');
const { planItems, pickForDeletion, restorableProjects } = require('../src/backup');
const { planRestore, volumeRestoreCommand } = require('../src/restore');
const selection = require('../src/selection');
const { nextRunAfter, nextRun } = require('../src/scheduler');
const { sh, SH } = require('./harness');

test('q() survives quotes, spaces and $ when run by a real shell', { skip: !SH }, async () => {
  const nasty = `it's a "test" $HOME \`id\` \\ ; rm -rf /`;
  const r = await sh(`printf %s ${q(nasty)}`);
  assert.equal(r.stdout, nasty);
  const nested = await sh(`sh -c ${q(`printf %s ${q(nasty)}`)}`);
  assert.equal(nested.stdout, nasty);
});

test('paths', () => {
  assert.equal(normalizeRemotePath('/var//www/'), '/var/www');
  assert.throws(() => normalizeRemotePath('var/www'));
  assert.throws(() => normalizeRemotePath('/var/../etc'));
  assert.equal(relFromRoot('/var/www'), 'var/www');
  assert.equal(relFromRoot('/'), '.');
  assert.deepEqual(dedupePaths(['/var/www/site', '/var/www', '/etc/nginx', '/var/www2']), ['/etc/nginx', '/var/www', '/var/www2']);
  assert.equal(slug('/var/www/my site!'), 'var_www_my_site');
});

test('database images are recognised, look-alikes are not', () => {
  assert.equal(kindFromImage('postgres:16-alpine'), 'postgres');
  assert.equal(kindFromImage('postgis/postgis:15-3.4'), 'postgres');
  assert.equal(kindFromImage('mysql:8'), 'mysql');
  assert.equal(kindFromImage('mariadb:11@sha256:abc'), 'mysql');
  assert.equal(kindFromImage('bitnami/mariadb'), 'mysql');
  assert.equal(kindFromImage('mongo:7'), 'mongo');
  assert.equal(kindFromImage('phpmyadmin/phpmyadmin'), null);
  assert.equal(kindFromImage('dpage/pgadmin4'), null);
  assert.equal(kindFromImage('mongo-express'), null);
  assert.equal(kindFromImage('prometheuscommunity/postgres-exporter'), null);
  assert.equal(kindFromImage('nginx:alpine'), null);
  assert.equal(kindFromImage('registry.example.com:5000/team/postgres:16'), 'postgres');
});

const INSPECT = [
  { Name: '/shop-db-1', Config: { Image: 'postgres:16', Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'db', 'com.docker.compose.project.working_dir': '/opt/shop', 'com.docker.compose.project.config_files': '/opt/shop/docker-compose.yml,/opt/shop/docker-compose.prod.yml' } },
    State: { Running: true }, Mounts: [{ Type: 'volume', Name: 'shop_pgdata', Source: '/var/lib/docker/volumes/shop_pgdata/_data', Destination: '/var/lib/postgresql/data' }] },
  { Name: '/shop-web-1', Config: { Image: 'shop-web', Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web', 'com.docker.compose.project.working_dir': '/opt/shop', 'com.docker.compose.project.config_files': '/opt/shop/docker-compose.yml' } },
    State: { Running: true }, Mounts: [{ Type: 'bind', Source: '/srv/uploads', Destination: '/app/uploads' }, { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }] },
  { Name: '/portainer', Config: { Image: 'portainer/portainer-ce', Labels: {} }, State: { Running: false }, Mounts: [] },
];

test('docker inspect -> projects, loose containers, databases', () => {
  const a = analyseContainers(INSPECT);
  assert.equal(a.projects.length, 1);
  assert.equal(a.projects[0].workingDir, '/opt/shop');
  assert.deepEqual(a.projects[0].configFiles, ['/opt/shop/docker-compose.yml', '/opt/shop/docker-compose.prod.yml']);
  assert.deepEqual(a.projects[0].services.map((s) => s.name), ['db', 'web']);
  assert.deepEqual(a.loose.map((l) => l.container), ['portainer']);
  assert.equal(a.dbs.length, 1);
  assert.equal(a.dbs[0].kind, 'postgres');
  assert.deepEqual(parseDu('120\t/var/www\n4\t/etc/nginx\n'), { '/var/www': 120, '/etc/nginx': 4 });
});

function fakeScan() {
  return {
    host: { hostname: 'h' }, docker: { version: '27' }, loose: [],
    projects: [{ name: 'shop', workingDir: '/opt/shop', configFiles: ['/opt/shop/docker-compose.yml'], services: [] }],
    volumes: [
      { name: 'shop_pgdata', mountpoint: '/var/lib/docker/volumes/shop_pgdata/_data', labels: { 'com.docker.compose.project': 'shop' }, project: 'shop', usedBy: ['shop-db-1'], db: { kind: 'postgres', container: 'shop-db-1', project: 'shop', service: 'db' }, on: true, sizeKb: 100 },
      { name: 'cache', mountpoint: '/x', labels: {}, usedBy: [], on: false },
    ],
    databases: [{ id: 'db:docker:shop-db-1', kind: 'postgres', where: 'docker', container: 'shop-db-1', project: 'shop', service: 'db', label: 'PostgreSQL — shop-db-1', on: true }],
    folders: [{ path: '/opt/shop', on: true, sizeKb: 10 }, { path: '/var/www', on: true }, { path: '/home', on: false }],
  };
}

test('selection remembers changes and includes new things automatically', () => {
  const scan = fakeScan();
  let s = selection.emptySelection();
  let r = selection.resolve(scan, s);
  assert.deepEqual(r.folders, ['/opt/shop', '/var/www']);
  assert.deepEqual(r.volumes, ['shop_pgdata']);
  s = selection.setChoice(s, 'folder:/home', true, false);
  s = selection.setChoice(s, 'folder:/var/www', false, true);
  s = selection.addFolder(s, '/data//x/');
  r = selection.resolve(scan, s);
  assert.deepEqual(r.folders, ['/opt/shop', '/home', '/data/x']);
  // ticking back to the default leaves no trace
  s = selection.setChoice(s, 'folder:/var/www', true, true);
  assert.ok(!s.unticked.includes('folder:/var/www'));
  // a new volume that shows up later is included by default
  scan.volumes.push({ name: 'new_vol', on: true, usedBy: ['x'] });
  assert.ok(selection.resolve(scan, s).volumes.includes('new_vol'));
});

test('backup plan: databases first, unique names, nested folders once', () => {
  const scan = fakeScan();
  scan.folders.push({ path: '/opt/shop/data', on: true });
  const items = planItems(scan, { databases: ['db:docker:shop-db-1'], volumes: ['shop_pgdata'], folders: ['/opt/shop', '/opt/shop/data', '/var/www'] });
  assert.deepEqual(items.map((i) => i.type), ['database', 'volume', 'files', 'files']);
  assert.deepEqual(items.filter((i) => i.type === 'files').map((i) => i.path), ['/opt/shop', '/var/www']);
  assert.equal(items[0].file, 'databases/shop-db-1.sql.gz');
  assert.equal(restorableProjects(scan, items).length, 1);
});

test('retention keeps the newest N and always the newest complete one', () => {
  const b = (d, status) => ({ createdAt: `2026-10-${d}T00:00:00Z`, status, name: d });
  const list = [b('20', 'ok'), b('21', 'partial'), b('22', 'partial'), b('23', 'partial')];
  assert.deepEqual(pickForDeletion(list, 2).map((x) => x.name), ['21']);
  assert.deepEqual(pickForDeletion(list, 10), []);
});

test('restore plan uses database dumps instead of raw database files', () => {
  const m = {
    projects: [{ name: 'shop', workingDir: '/opt/shop' }],
    items: [
      { id: 'db:docker:shop-db-1', type: 'database', where: 'docker', container: 'shop-db-1', project: 'shop', status: 'ok' },
      { id: 'volume:shop_pgdata', type: 'volume', name: 'shop_pgdata', db: { container: 'shop-db-1' }, status: 'ok' },
      { id: 'files:/opt/shop', type: 'files', path: '/opt/shop', status: 'warning' },
      { id: 'files:/var/www', type: 'files', path: '/var/www', status: 'failed' },
    ],
  };
  const all = m.items.map((i) => i.id);
  let p = planRestore(m, { items: all });
  assert.equal(p.volumes[0].fromDump, true);
  assert.deepEqual(p.files.map((f) => f.path), ['/opt/shop']); // failed items are never restored
  assert.deepEqual(p.projects.map((x) => x.name), ['shop']);
  p = planRestore(m, { items: all, useDumps: false });
  assert.equal(p.volumes[0].fromDump, false);
  p = planRestore(m, { items: all, startProjects: false });
  assert.equal(p.projects.length, 0);
});

test('volume restore command keeps compose labels', () => {
  const c = volumeRestoreCommand({ name: 'shop_pgdata', labels: { 'com.docker.compose.project': 'shop' } });
  assert.match(c, /--label 'com.docker.compose.project=shop'/);
});

test('schedule maths', () => {
  const at = (s) => new Date(s);
  assert.equal(nextRunAfter({ every: 'daily', time: '03:00' }, at('2026-10-29T01:00:00')).toString(), at('2026-10-29T03:00:00').toString());
  assert.equal(nextRunAfter({ every: 'daily', time: '03:00' }, at('2026-10-29T03:00:00')).toString(), at('2026-10-30T03:00:00').toString());
  // 2026-10-29 is a Thursday (4); next Monday (1) is 2026-11-02
  assert.equal(nextRunAfter({ every: 'weekly', time: '02:30', weekday: 1 }, at('2026-10-29T10:00:00')).toString(), at('2026-11-02T02:30:00').toString());
  assert.equal(nextRunAfter({ every: 'every6h' }, at('2026-10-29T13:20:00')).toString(), at('2026-10-29T18:00:00').toString());
  assert.equal(nextRunAfter({ every: 'hourly' }, at('2026-10-29T23:59:00')).toString(), at('2026-10-30T00:00:00').toString());
  // missed while the PC was off -> due now
  const server = { schedule: { enabled: true, every: 'daily', time: '03:00', since: '2026-10-01T00:00:00' }, lastRun: { at: '2026-10-27T03:00:05' } };
  assert.ok(nextRun(server) < at('2026-10-29T12:00:00'));
  assert.equal(nextRun({ schedule: { enabled: false } }), null);
});
