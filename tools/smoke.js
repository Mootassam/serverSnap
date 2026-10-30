'use strict';
// Opens the real app with sample data, screenshots every page, and lists any page errors.
// Run: node tools/smoke.js   (pictures land in %TEMP%\serversnap-smoke)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(os.tmpdir(), 'serversnap-smoke');
fs.rmSync(dir, { recursive: true, force: true });
const root = path.join(dir, 'backups');
const bdir = path.join(root, 'Shop_server', '2026-10-28_03-00-00');
fs.mkdirSync(path.join(bdir, 'files'), { recursive: true });
fs.mkdirSync(path.join(dir, 'userData'), { recursive: true });

const scan = {
  scannedAt: new Date(Date.now() - 3600e3).toISOString(),
  host: { hostname: 'shop-vps', os: 'Ubuntu 24.04.1 LTS', arch: 'x86_64', diskFreeKb: 31457280 },
  priv: 'root',
  docker: { installed: true, version: '27.3.1', compose: 'v2' },
  projects: [{ name: 'shop', workingDir: '/opt/shop', configFiles: ['/opt/shop/docker-compose.yml'], services: [] }],
  volumes: [
    { name: 'shop_pgdata', mountpoint: '/var/lib/docker/volumes/shop_pgdata/_data', labels: {}, project: 'shop', usedBy: ['shop-db-1'], anonymous: false, db: { kind: 'postgres', container: 'shop-db-1' }, on: true, sizeKb: 245000 },
    { name: 'shop_uploads', mountpoint: '/var/lib/docker/volumes/shop_uploads/_data', labels: {}, project: 'shop', usedBy: ['shop-web-1'], anonymous: false, db: null, on: true, sizeKb: 1830000 },
  ],
  databases: [
    { id: 'db:docker:shop-db-1', kind: 'postgres', where: 'docker', container: 'shop-db-1', project: 'shop', service: 'db', running: true, label: 'PostgreSQL — shop-db-1', on: true },
    { id: 'db:host:mysql', kind: 'mysql', where: 'host', running: true, label: 'MySQL / MariaDB (on the server)', on: true },
  ],
  folders: [
    { path: '/opt/shop', reason: 'Docker project "shop" (compose file, .env, data)', on: true, sizeKb: 52000 },
    { path: '/var/www', reason: 'Websites', on: true, sizeKb: 410000 },
    { path: '/etc/nginx', reason: 'Nginx settings', on: true, sizeKb: 96 },
    { path: '/etc/letsencrypt', reason: 'SSL certificates', on: true, sizeKb: 210 },
    { path: '/home', reason: 'User folders', on: false, sizeKb: 1200000 },
  ],
  loose: [{ container: 'portainer', image: 'portainer/portainer-ce', running: true }],
  warnings: ['1 container(s) were started without Docker Compose (portainer). Their volumes are backed up, but after a restore you need to start them yourself.'],
};
const server = {
  id: 'srv-1', name: 'Shop server', host: '203.0.113.10', port: 22, username: 'root', authType: 'password', keyPath: null,
  secrets: {}, knownHostKey: 'SHA256:abcdEFGHijklMNOPqrstUVWXyz0123456789+/abcd', createdAt: new Date().toISOString(),
  selection: null, schedule: { enabled: true, every: 'daily', time: '03:00', weekday: 1, since: new Date(Date.now() - 864e5).toISOString() },
  keep: 7, lastRun: { at: new Date(Date.now() - 5 * 3600e3).toISOString(), status: 'ok', name: '2026-10-28_03-00-00', bytes: 1.6e9 },
  lastScan: scan,
};
fs.writeFileSync(path.join(dir, 'userData', 'serversnap.json'), JSON.stringify({
  version: 1, settings: { backupRoot: root, telegram: { token: '', chatId: '' }, closeToTray: true, startWithWindows: false }, servers: [server],
}, null, 2));
fs.writeFileSync(path.join(bdir, 'files', 'var_www.tar.gz'), 'x');
fs.writeFileSync(path.join(bdir, 'manifest.json'), JSON.stringify({
  app: 'ServerSnap', format: 1, name: '2026-10-28_03-00-00', status: 'ok', createdAt: '2026-10-28T03:00:00Z', finishedAt: '2026-10-28T03:09:00Z',
  server: { id: 'srv-1', name: 'Shop server', host: '203.0.113.10' }, projects: scan.projects, loose: scan.loose, totalBytes: 1.6e9,
  items: [
    { id: 'db:docker:shop-db-1', type: 'database', label: 'PostgreSQL — shop-db-1', kind: 'postgres', where: 'docker', container: 'shop-db-1', project: 'shop', service: 'db', file: 'databases/shop-db-1.sql.gz', status: 'ok', bytes: 31e6 },
    { id: 'volume:shop_pgdata', type: 'volume', label: 'Docker volume shop_pgdata', name: 'shop_pgdata', db: { container: 'shop-db-1' }, file: 'volumes/shop_pgdata.tar.gz', status: 'ok', bytes: 80e6 },
    { id: 'files:/opt/shop', type: 'files', label: 'Folder /opt/shop', path: '/opt/shop', file: 'files/opt_shop.tar.gz', status: 'ok', bytes: 9e6 },
    { id: 'files:/var/www', type: 'files', label: 'Folder /var/www', path: '/var/www', file: 'files/var_www.tar.gz', status: 'ok', bytes: 1.4e9 },
  ],
}, null, 2));

// Docker dashboard and customer access answers (no real server in the self-test).
const docker = require('../src/docker');
const fx = require('../test/fixtures');
const view = docker.groupOverview(docker.parseOverview(fx.overviewText()), docker.parseUsage(fx.usageText));
view.usageAt = Date.now();
fs.writeFileSync(path.join(dir, 'docker.json'), JSON.stringify(view));
server.clients = [{ id: 'c1', project: 'king', user: 'snap_king', name: 'King Trading', time: '03:30', keep: 7, createdAt: new Date().toISOString(),
  items: [{ key: 'db:king-db-1', type: 'database', label: 'Database (MongoDB)' }, { key: 'volume:king_upload', type: 'volume', label: 'Files: upload' }] }];
const data = JSON.parse(fs.readFileSync(path.join(dir, 'userData', 'serversnap.json'), 'utf8'));
data.servers[0].clients = server.clients;
fs.writeFileSync(path.join(dir, 'userData', 'serversnap.json'), JSON.stringify(data, null, 2));
fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ exists: true, log: '[2026-10-30 03:30:01] Backup starting\n[2026-10-30 03:31:12] Done: 2026-10-30_03-30-00 (ok, 330231808 bytes)',
  backups: [{ name: '2026-10-30_03-30-00', status: 'ok', totalBytes: 330231808, createdAt: '2026-10-30T03:30:00Z', items: [] }] }));

const steps = [
  ['1-server', null],
  ['2-schedule', "state.page.tab='schedule'; render();"],
  ['3-add-server', 'serverModal();'],
  ['4-backups', "closeModal(); go({name:'backups'});"],
  ['5-restore', "document.querySelector('td.actions .btn.primary').click();"],
  ['6-settings', "closeModal(); go({name:'settings'});"],
  ['7-activity', "go({name:'activity'});"],
  ['8-docker', "go({name:'server', id:'srv-1', tab:'docker'});"],
  ['9-docker-shubh', "state.docker.sel='shubh'; redrawDocker();"],
  ['10-docker-images', "state.docker.sel='#images'; redrawDocker();"],
  ['11-customers', "state.page.tab='clients'; render();"],
  ['12-customer-modal', "clientModal(state.servers[0], 'king'); setTimeout(() => { const s = document.querySelectorAll('.modal select')[1]; s.value = 'hourly'; s.dispatchEvent(new Event('change')); }, 500);"],
  ['13-pick-containers', "closeModal(); state.page.tab='docker'; state.docker.sel='king'; render(); setTimeout(() => { const g = state.docker.data.groups[0]; state.docker.pick.containers.add(g.containers[0].id); state.docker.pick.containers.add(g.containers[3].id); redrawDocker(); }, 300);"],
  ['14-delete-customer', "const g = state.docker.data.groups[0]; deleteContainersModal(g, g.containers, true); document.querySelector('.modal input[type=checkbox]').click();"],
  ['15-images-pick', "closeModal(); state.docker.sel='#images'; for (const i of state.docker.data.images) if (!i.usedBy.length) state.docker.pick.images.add(i.id); redrawDocker();"],
  ['16-volumes-pick', "state.docker.sel='#volumes'; redrawDocker(); document.querySelector('.dk-detail .btn').click();"],
];
fs.writeFileSync(path.join(dir, 'steps.json'), JSON.stringify(steps));

// The customer app, with one website and two backups waiting.
const code = require('../src/clients').encodeCode({ name: 'King Trading', project: 'king', host: '203.0.113.10', port: 22, user: 'snap_king', privateKey: 'x', hostKey: 'SHA256:x' });
fs.mkdirSync(path.join(dir, 'clientData'), { recursive: true });
fs.writeFileSync(path.join(dir, 'clientData', 'serversnap-client.json'), JSON.stringify({
  version: 1, settings: { downloadRoot: path.join(dir, 'client-downloads'), autoDownload: true, keep: 14, closeToTray: true, startWithWindows: false },
  accesses: [{ id: 'a1', name: 'King Trading', project: 'king', host: '203.0.113.10', port: 22, user: 'snap_king', hostKey: 'SHA256:x', keyEnc: 'p0:eA==', addedAt: new Date().toISOString(), lastCheck: new Date().toISOString() }],
}));
const items = [{ label: 'Database (MongoDB)', type: 'database', status: 'ok', bytes: 31e6 }, { label: 'Files: upload', type: 'volume', status: 'ok', bytes: 4e6 }];
fs.writeFileSync(path.join(dir, 'client-backups.json'), JSON.stringify([
  { name: '2026-10-30_03-30-00', status: 'ok', createdAt: '2026-10-30T03:30:00Z', totalBytes: 35e6, items },
  { name: '2026-10-29_03-30-00', status: 'ok', createdAt: '2026-10-29T03:30:00Z', totalBytes: 34e6, items },
]));
fs.mkdirSync(path.join(dir, 'client-downloads', 'King_Trading', '2026-10-29_03-30-00'), { recursive: true });
fs.writeFileSync(path.join(dir, 'client-downloads', 'King_Trading', '2026-10-29_03-30-00', 'manifest.json'), '{}');
fs.writeFileSync(path.join(dir, 'client-steps.json'), JSON.stringify([
  ['c1-site', null],
  ['c2-add-code', `addModal(); document.querySelector('textarea').value=${JSON.stringify(code.slice(0, 90) + '…')};`],
  ['c3-backup-now', "closeModal(); state.jobs.set('x', { id: 'x', accessId: 'a1', state: 'running', kind: 'backup-now', phase: 'making', title: 'King Trading: new backup' }); go({name:'site', id:'a1'});"],
  ['c4-settings', "state.jobs.clear(); go({name:'settings'});"],
]));

const electron = require('electron');
const r = spawnSync(electron, [path.join(__dirname, '..')], { env: { ...process.env, SERVERSNAP_SMOKE: dir }, stdio: 'inherit', timeout: 120000 });
const rc = spawnSync(electron, [path.join(__dirname, '..'), '--client'], { env: { ...process.env, SERVERSNAP_SMOKE: dir }, stdio: 'inherit', timeout: 90000 });
const consoleFile = path.join(dir, 'console.txt');
console.log(`exit admin ${r.status}, client ${rc.status}; screenshots in ${dir}`);
console.log(fs.existsSync(consoleFile) ? 'PAGE ERRORS:\n' + fs.readFileSync(consoleFile, 'utf8') : 'no page errors');
