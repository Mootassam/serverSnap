'use strict';
// ServerSnap Deploy: compose reading, project detection, and the server scripts run for real
// in a local shell against a scratch folder with fake nginx / certbot / curl / docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCompose, exposedDatabases } = require('../src/compose');
const deploy = require('../src/deploy');
const { sh, SH } = require('./harness');

const KING_COMPOSE = `# REMOVE THE DUPLICATE VERSION AND SERVICES SECTION AT THE BOTTOM!
services:
  backend:
    build: ./server
    ports:
      - 8082:8082
    restart: unless-stopped
    environment:
      DATABASE_CONNECTION: mongodb://db:27017/grap   # inline comment
  db:
    image: mongo:4.0-xenial
    ports:
      - 2757:27017
  redis:
    image: redis:6.2-alpine
    command: >
      sh -c "redis-server --port 6379"
  web:
    build: ./admin
    ports:
      - "3062:80"
  # web1:
  #   build: ./graborders
  #   ports:
  #     - 3015:80
  web2:
    build:
      context: ./web2
    ports:
      - target: 80
        published: 3013
  safe:
    image: mongo:7
    ports: ["127.0.0.1:2800:27017"]
volumes:
  phone:
`;

test('compose: services, builds, ports; commented services ignored', () => {
  const c = parseCompose(KING_COMPOSE);
  const by = Object.fromEntries(c.services.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(by), ['backend', 'db', 'redis', 'web', 'web2', 'safe']);
  assert.equal(by.backend.build, './server');
  assert.deepEqual(by.backend.ports, [{ ip: null, host: 8082, container: 8082 }]);
  assert.equal(by.web.ports[0].host, 3062);
  assert.equal(by.web2.build, './web2');
  assert.deepEqual(by.web2.ports, [{ ip: null, host: 3013, container: 80 }]);
  assert.deepEqual(by.safe.ports, [{ ip: '127.0.0.1', host: 2800, container: 27017 }]);
  // only the database open to the internet is reported, not the one on 127.0.0.1
  assert.deepEqual(exposedDatabases(c).map((x) => `${x.name}:${x.host}`), ['MongoDB:2757']);
});

test('compose: ${VAR:-default} from .env', () => {
  const text = 'services:\n  db:\n    image: mongo\n    ports:\n      - "${DB_PORT:-2747}:27017"\n  web:\n    ports:\n      - ${WEB_PORT:-3061}:80\n';
  assert.equal(parseCompose(text, {}).services[0].ports[0].host, 2747);
  assert.equal(parseCompose(text, { DB_PORT: '2999' }).services[0].ports[0].host, 2999);
  assert.equal(parseCompose(text, { WEB_PORT: '' }).services[1].ports[0].host, 3061);
});

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdeploy-'));
  const proj = path.join(dir, 'Milan');
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(proj, f)), { recursive: true }); fs.writeFileSync(path.join(proj, f), s); };
  w('docker-compose.yml', KING_COMPOSE);
  w('server/package.json', JSON.stringify({ scripts: { build: 'tsc', start: 'node dist' } }));
  w('admin/package.json', JSON.stringify({ scripts: { build: 'vite build' } }));
  w('admin/index.html', '<html></html>');
  w('graborders/package.json', JSON.stringify({ scripts: { build: 'vite build' } }));
  w('graborders/index.html', '<html></html>');
  w('graborders/dist/index.html', '<html>built</html>');
  w('PC/package.json', JSON.stringify({ scripts: { build: 'vite build' } }));
  w('PC/index.html', '<html></html>');
  fs.mkdirSync(path.join(proj, 'PC', 'node_modules'));
  w('web2/package.json', JSON.stringify({ scripts: { build: 'vite build' } }));
  w('web2/index.html', '<html></html>');
  w('notes/readme.txt', 'x');
  return proj;
}

test('detect: suggests "site" (website + API) for backend sites, a port for the container site, admin off', () => {
  const proj = makeProject();
  const d = deploy.detect(proj);
  assert.equal(d.saved, false);
  const c = d.config;
  assert.equal(c.project, 'milan');
  assert.equal(c.remoteDir, '/root/Milan');
  assert.equal(c.docker, true);
  const by = Object.fromEntries(c.sites.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(by).sort(), ['PC', 'admin', 'graborders', 'web2']);
  assert.equal(by.graborders.kind, 'site');
  assert.equal(by.graborders.backendPort, 8082);
  assert.equal(by.graborders.socket, false);
  assert.equal(by.graborders.apk, false);
  assert.equal(by.graborders.build, 'dist');      // no node_modules: use the dist that is there
  assert.equal(by.PC.build, 'build');             // node_modules there: build it
  assert.equal(by.PC.www, false);
  assert.equal(by.web2.kind, 'proxy');
  assert.equal(by.web2.port, 3013);
  assert.equal(by.admin.enabled, false);
  assert.deepEqual(d.exposed.map((x) => x.host), [2757]);
  assert.equal(deploy.defaultDomain('PC', 'milan.com'), 'pc.milan.com');
  assert.equal(deploy.defaultDomain('graborders', 'milan.com'), 'milan.com');
});

test('validate catches bad input; save writes snap.json that detect then reads back', () => {
  const proj = makeProject();
  const c = deploy.detect(proj).config;
  for (const s of c.sites) s.enabled = false;
  const g = c.sites.find((s) => s.id === 'graborders');
  g.enabled = true;
  g.domain = 'https://Milan.com';
  assert.match(deploy.validate(c).join(' '), /enter a domain/);
  g.domain = 'milan.com';
  c.remoteDir = '/root';
  assert.match(deploy.validate(c).join(' '), /Folder on the server/);
  c.remoteDir = '/root/milan';
  g.backendPort = null;
  assert.match(deploy.validate(c).join(' '), /backend port/);
  g.backendPort = 8082;
  g.root = '/etc/nginx';
  assert.match(deploy.validate(c).join(' '), /inside \/var\/www/);
  g.root = null;
  assert.deepEqual(deploy.validate(c), []);
  deploy.save(proj, c);
  const again = deploy.detect(proj);
  assert.equal(again.saved, true);
  assert.equal(again.config.sites.find((s) => s.id === 'graborders').domain, 'milan.com');
  assert.equal(again.config.sites.find((s) => s.id === 'PC').enabled, false);
});

test('port conflicts: other projects and programs, not our own containers', () => {
  const compose = parseCompose(KING_COMPOSE);
  const insp = deploy.parseInspect([
    '@@LISTEN', '22', '80', '2757', '3062', '8082', '@@CONTAINERS',
    'milan\t/root/Milan\tmilan-backend-1\trunning\t0.0.0.0:8082->8082/tcp, :::8082->8082/tcp',
    'king\t/root/king\tking-web-1\trunning\t0.0.0.0:3062->80/tcp',
    '@@TOOLS', 'docker=1', 'compose=2', '@@END'].join('\n'));
  assert.equal(insp.tools.compose, 2);
  const c = deploy.portConflicts(compose, 'milan', insp);
  assert.deepEqual(c.map((x) => [x.port, x.by]), [[2757, 'another program on the server'], [3062, 'project king (king-web-1)']]);
  assert.deepEqual(deploy.serverProjects(insp).map((p) => [p.name, p.workingDir, p.running]), [['king', '/root/king', 1], ['milan', '/root/Milan', 1]]);
});

test('nginx files: names, backend on 127.0.0.1, container port', () => {
  const cfg = { project: 'milan' };
  const t = deploy.nginxFile(cfg, { kind: 'trading', domain: 'milan.com', www: true, backendPort: 8083 }, '/var/www/milan.com/html');
  assert.match(t, /server_name milan\.com www\.milan\.com;/);
  assert.match(t, /proxy_pass http:\/\/127\.0\.0\.1:8083\/api\/;/);
  assert.match(t, /root \/var\/www\/milan\.com\/html;/);
  assert.match(t, /location ~\* \\\.apk\$/);
  assert.doesNotMatch(t, /__[A-Z]+__/);
  const n = deploy.nginxFile(cfg, { kind: 'normal', domain: 'shop.com', www: false }, '/var/www/shop.com/html');
  assert.match(n, /try_files \$uri \$uri\/ \/index\.html =404;/);
  assert.doesNotMatch(n, /proxy_pass/);
  const p = deploy.nginxFile(cfg, { kind: 'proxy', domain: 'app.com', www: false, port: 3013 }, null);
  assert.match(p, /proxy_pass http:\/\/127\.0\.0\.1:3013;/);
});

test('nginx "Website + API": always /api/; socket.io and APK are optional', () => {
  const cfg = { project: 'nexus' };
  const base = { kind: 'site', domain: 'nexus.com', www: true, backendPort: 8084 };
  // plain: API yes, no socket, no apk
  const plain = deploy.nginxFile(cfg, base, '/var/www/nexus.com/html');
  assert.match(plain, /location \^~ \/api\/ \{/);
  assert.match(plain, /proxy_pass http:\/\/127\.0\.0\.1:8084\/api\/;/);
  assert.match(plain, /try_files \$uri \$uri\/ \/index\.html;/);
  assert.doesNotMatch(plain, /socket\.io/);
  assert.doesNotMatch(plain, /\\\.apk\$/);
  assert.doesNotMatch(plain, /__[A-Z]+__/);
  assert.doesNotMatch(plain, /tradingview/i, 'no TradingView clutter');
  // with both toggles on
  const full = deploy.nginxFile(cfg, { ...base, socket: true, apk: true }, '/var/www/nexus.com/html');
  assert.match(full, /location \^~ \/socket\.io\/ \{/);
  assert.match(full, /proxy_pass http:\/\/127\.0\.0\.1:8084;/, 'socket proxies to the backend root');
  assert.match(full, /location ~\* \\\.apk\$ \{/);
  assert.match(full, /application\/vnd\.android\.package-archive/);
  assert.doesNotMatch(full, /__[A-Z]+__/);
});

test('validate: a "site" needs a backend port', () => {
  const proj = makeProject();
  const c = deploy.detect(proj).config;
  for (const s of c.sites) s.enabled = false;
  const g = c.sites.find((s) => s.id === 'graborders');
  g.enabled = true; g.domain = 'nexus.com';
  assert.equal(g.kind, 'site');
  g.backendPort = null;
  assert.match(deploy.validate(c).join(' '), /backend port/);
  g.backendPort = 8084;
  assert.deepEqual(deploy.validate(c), []);
  // socket / apk survive a save + reload
  g.socket = true; g.apk = true;
  deploy.save(proj, c);
  const again = deploy.detect(proj).config.sites.find((s) => s.id === 'graborders');
  assert.equal(again.socket, true);
  assert.equal(again.apk, true);
});

// ---------- the server scripts, run for real ----------
const FAKES = {
  nginx: `#!/bin/sh
echo "nginx $*" >> "$SNAP_ROOT/calls.log"
case "$1" in -t) if [ -n "$FAKE_NGINX_FAIL" ]; then echo "nginx: [emerg] unexpected"; exit 1; fi; echo "nginx: configuration file test is successful";; esac
exit 0
`,
  certbot: `#!/bin/sh
echo "certbot $*" >> "$SNAP_ROOT/calls.log"
exit \${FAKE_CERTBOT_RC:-0}
`,
  curl: `#!/bin/sh
echo "curl $*" >> "$SNAP_ROOT/calls.log"
printf %s "\${FAKE_CODE:-200}"
`,
  docker: `#!/bin/sh
echo "docker $*" >> "$SNAP_ROOT/calls.log"
case "$*" in
  "compose version") exit 0;;
  *" up -d --build"*) echo "Container milan-backend-1 Started"; exit \${FAKE_UP_RC:-0};;
  "compose -p "*" ps") echo "NAME STATUS";;
  *"status=running -q"*) echo a; [ -n "$FAKE_DOWN" ] || echo b;;
  *"ps -a --filter"*) echo a; echo b;;
esac
exit 0
`,
};

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snaproot-')).replace(/\\/g, '/');
  for (const d of ['etc/nginx/sites-available', 'etc/nginx/sites-enabled', 'etc/nginx/conf.d', 'bin', 'var/www']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/nginx/nginx.conf'), 'http {\n  include /etc/nginx/conf.d/*.conf;\n  include /etc/nginx/sites-enabled/*;\n}\n');
  for (const [n, body] of Object.entries(FAKES)) fs.writeFileSync(path.join(root, 'bin', n), body, { mode: 0o755 });
  return root;
}

// Git Bash paths: C:/Users/... -> /c/Users/...
const posix = (p) => p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);

async function runOn(root, script, env = {}) {
  const r = await sh(`PATH=${posix(root)}/bin:$PATH bash -s`, { stdin: script, env: { SNAP_ROOT: posix(root), ...env } });
  const markers = r.stdout.split('\n').filter((l) => l.startsWith('@@'));
  return { ...r, markers, fail: (markers.find((m) => m.startsWith('@@FAIL')) || '').slice(7), done: (markers.find((m) => m.startsWith('@@DONE')) || '').slice(7) };
}

const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (root, f) => fs.existsSync(path.join(root, f));
const CFG = { project: 'milan' };
const SITE = { id: 'graborders', folder: 'graborders', domain: 'milan.com', www: true, kind: 'trading', backendPort: 8083, ssl: true, ws: true };

function stage(root, rootDir, html) {
  fs.mkdirSync(path.join(root, rootDir + '.new'), { recursive: true });
  fs.writeFileSync(path.join(root, rootDir + '.new', 'index.html'), html);
}

test('site script: fresh trading website with www, live prices and HTTPS', { skip: !SH }, async () => {
  const root = scratch();
  const webRoot = 'var/www/milan.com/html';
  stage(root, webRoot, 'v1');
  const r = await runOn(root, deploy.siteScript(CFG, SITE, { root: `/${webRoot}`, staged: true, ws: 'ws.milan.com', wwwOk: true, email: '', stamp: 'S1' }));
  assert.equal(r.fail, '', r.stdout + r.stderr);
  assert.equal(r.done, 'https://milan.com');
  const conf = read(root, 'etc/nginx/sites-available/milan.com');
  assert.match(conf, /server_name milan\.com www\.milan\.com;/);
  assert.match(conf, /127\.0\.0\.1:8083/);
  assert.ok(exists(root, 'etc/nginx/sites-enabled/milan.com'));
  assert.ok(exists(root, 'etc/nginx/sites-available/ws.milan.com'));
  assert.ok(exists(root, 'etc/nginx/conf.d/fwd_proto.conf'));
  assert.equal(read(root, `${webRoot}/index.html`), 'v1');
  assert.ok(!exists(root, `${webRoot}.new`));
  const calls = read(root, 'calls.log');
  assert.match(calls, /certbot --nginx --cert-name milan\.com -d milan\.com -d www\.milan\.com .*--redirect --register-unsafely-without-email/);
  assert.match(calls, /certbot --nginx -d ws\.milan\.com/);
  assert.match(calls, /curl .*https:\/\/milan\.com\//);
  assert.ok(r.markers.includes('@@STEP ssl|ok|https://milan.com'));

  // deploying again keeps the old version for rollback, and does not add ws twice
  fs.writeFileSync(path.join(root, 'etc/nginx/sites-available/ws.milan.com'), read(root, 'etc/nginx/sites-available/ws.milan.com'));
  fs.copyFileSync(path.join(root, 'etc/nginx/sites-available/ws.milan.com'), path.join(root, 'etc/nginx/sites-enabled/ws.milan.com'));
  stage(root, webRoot, 'v2');
  const r2 = await runOn(root, deploy.siteScript(CFG, SITE, { root: `/${webRoot}`, staged: true, ws: 'ws.milan.com', wwwOk: true, stamp: 'S2' }));
  assert.equal(r2.fail, '', r2.stdout);
  assert.match(r2.stdout, /already set up/);
  assert.equal(read(root, `${webRoot}/index.html`), 'v2');
  assert.equal(read(root, `${webRoot}.prev/index.html`), 'v1');
  assert.ok(exists(root, 'root/serversnap-deploy/backups/milan.com.S2'));

  // rollback: v1 files and the S1-era nginx file come back
  fs.appendFileSync(path.join(root, 'etc/nginx/sites-available/milan.com'), '# changed later\n');
  const rb = await runOn(root, deploy.rollbackScript(CFG, SITE, `/${webRoot}`));
  assert.equal(rb.fail, '', rb.stdout);
  assert.equal(read(root, `${webRoot}/index.html`), 'v1');
  assert.doesNotMatch(read(root, 'etc/nginx/sites-available/milan.com'), /changed later/);

  // the list of websites on the server
  const sites = deploy.parseSites((await runOn(root, deploy.sitesListScript())).stdout);
  const m = sites.find((s) => s.names.includes('milan.com'));
  assert.ok(m && m.ours, JSON.stringify(sites));
  assert.match(m.root, /var\/www\/milan\.com\/html$/);
});

test('site script: switching an existing hand-made site off and back on failure', { skip: !SH }, async () => {
  const root = scratch();
  // an old hand-made file serving the domain (the "already hosted" case)
  const old = 'server {\n  listen 80;\n  server_name milan.com www.milan.com;\n  root /var/www/milan/html;\n}\n';
  fs.writeFileSync(path.join(root, 'etc/nginx/sites-enabled/milan-old'), old);
  const webRoot = 'var/www/milan.com/html';
  fs.mkdirSync(path.join(root, webRoot), { recursive: true });
  fs.writeFileSync(path.join(root, webRoot, 'index.html'), 'live');

  // the health check fails -> everything is put back
  stage(root, webRoot, 'broken');
  const bad = await runOn(root, deploy.siteScript(CFG, { ...SITE, kind: 'normal', ws: false }, { root: `/${webRoot}`, staged: true, ws: '', wwwOk: true, stamp: 'S1' }), { FAKE_CODE: '502' });
  assert.match(bad.fail, /answered 502/);
  assert.equal(read(root, 'etc/nginx/sites-enabled/milan-old'), old);
  assert.ok(!exists(root, 'etc/nginx/sites-enabled/milan.com'));
  assert.ok(!exists(root, 'etc/nginx/sites-available/milan.com'));
  assert.equal(read(root, `${webRoot}/index.html`), 'live');

  // nginx -t fails -> also put back
  stage(root, webRoot, 'broken');
  const bad2 = await runOn(root, deploy.siteScript(CFG, { ...SITE, kind: 'normal' }, { root: `/${webRoot}`, staged: true, ws: '', wwwOk: true, stamp: 'S2' }), { FAKE_NGINX_FAIL: '1' });
  assert.match(bad2.fail, /nginx did not accept/);
  assert.equal(read(root, 'etc/nginx/sites-enabled/milan-old'), old);
  assert.equal(read(root, `${webRoot}/index.html`), 'live');

  // works -> the old file is switched off (kept in backups)
  stage(root, webRoot, 'new');
  const ok = await runOn(root, deploy.siteScript(CFG, { ...SITE, kind: 'normal' }, { root: `/${webRoot}`, staged: true, ws: '', wwwOk: false, stamp: 'S3' }), { FAKE_CERTBOT_RC: '1' });
  assert.equal(ok.fail, '', ok.stdout);
  assert.ok(!exists(root, 'etc/nginx/sites-enabled/milan-old'));
  assert.ok(exists(root, 'root/serversnap-deploy/backups/milan-old.S3.off'));
  assert.equal(read(root, `${webRoot}/index.html`), 'new');
  // certbot failed: still live on http, with a warning
  assert.equal(ok.done, 'http://milan.com');
  assert.ok(ok.markers.some((m) => m.startsWith('@@WARN certbot could not')));
  const lastCertbot = read(root, 'calls.log').split('\n').filter((l) => l.startsWith('certbot')).pop();
  assert.doesNotMatch(lastCertbot, /-d www\.milan\.com/);
});

test('site script: refuses to touch a file that also serves other domains', { skip: !SH }, async () => {
  const root = scratch();
  const shared = 'server {\n  server_name milan.com king.com;\n}\n';
  fs.writeFileSync(path.join(root, 'etc/nginx/sites-enabled/shared'), shared);
  const r = await runOn(root, deploy.siteScript(CFG, { ...SITE, kind: 'proxy', port: 3013, ws: false }, { root: null, staged: false, ws: '', wwwOk: true, stamp: 'S1' }));
  assert.match(r.fail, /also serves other domains \(king\.com\)/);
  assert.equal(read(root, 'etc/nginx/sites-enabled/shared'), shared);
  assert.ok(!exists(root, 'etc/nginx/sites-available/milan.com'));
});

test('docker script: compose up and container count', { skip: !SH }, async () => {
  const root = scratch();
  fs.mkdirSync(path.join(root, 'srv/milan'), { recursive: true });
  const cfg = { project: 'milan', remoteDir: '/srv/milan' };
  const r = await runOn(root, deploy.upScript(cfg, 'S1'));
  assert.equal(r.fail, '', r.stdout + r.stderr);
  assert.ok(r.markers.includes('@@COUNT 2/2'));
  assert.match(read(root, 'calls.log'), /docker compose -p milan up -d --build/);
  const down = await runOn(root, deploy.upScript(cfg, 'S2'), { FAKE_DOWN: '1' });
  assert.ok(down.markers.some((m) => m.startsWith('@@WARN 1 of 2 containers')));
  const failed = await runOn(root, deploy.upScript(cfg, 'S3'), { FAKE_UP_RC: '3' });
  assert.match(failed.fail, /docker compose up failed/);
  const missing = await runOn(root, deploy.upScript({ project: 'milan', remoteDir: '/nope' }, 'S4'));
  assert.match(missing.fail, /is missing on the server/);
});

test('full deploy over SSH: upload, docker, two websites, redeploy and rollback', { skip: !SH, timeout: 240000 }, async () => {
  const { startServer } = require('./harness');
  const { Remote } = require('../src/ssh');
  const { runDeploy, runRollback } = require('../src/deploy-job');
  const root = scratch();
  const proj = makeProject();
  fs.mkdirSync(path.join(proj, 'node_modules', 'x'), { recursive: true });
  const cfg = deploy.detect(proj).config;
  for (const s of cfg.sites) Object.assign(s, { enabled: false, skipDnsCheck: true });
  Object.assign(cfg.sites.find((s) => s.id === 'graborders'), { enabled: true, domain: 'milan.com', kind: 'normal', build: 'dist', ws: false });
  Object.assign(cfg.sites.find((s) => s.id === 'web2'), { enabled: true, domain: 'app.milan.com', www: false });
  cfg.remoteDir = '/srv/milan';
  deploy.save(proj, cfg);

  const srv = await startServer({ env: { SNAP_ROOT: posix(root), PATH: `${path.join(root, 'bin')};${path.dirname(SH)};${process.env.PATH}` } });
  const connect = async () => {
    const r = new Remote({ host: '127.0.0.1', port: srv.port, username: 'u', password: srv.password });
    await r.connect();
    r.priv = 'root'; // the test server runs as the local user
    return r;
  };
  const events = [];
  try {
    const res = await runDeploy({ server: { host: '127.0.0.1' }, folder: proj, mode: 'all', connect, onEvent: (e) => events.push(e) });
    const logText = events.filter((e) => e.type === 'log').map((e) => e.msg).join('\n');
    assert.equal(res.status, 'ok', `${JSON.stringify(res)}\n${logText}`);
    assert.deepEqual(res.urls.sort(), ['https://app.milan.com', 'https://milan.com']);
    // the project went up without node_modules and without the website folder (it goes up as dist)
    assert.ok(exists(root, 'srv/milan/docker-compose.yml'));
    assert.ok(exists(root, 'srv/milan/server/package.json'));
    assert.ok(!exists(root, 'srv/milan/node_modules'));
    assert.ok(!exists(root, 'srv/milan/graborders'));
    assert.ok(exists(root, 'srv/milan/web2/package.json'), 'web2 is built by docker compose, so it is uploaded');
    assert.match(read(root, 'calls.log'), /docker compose -p milan up -d --build/);
    assert.equal(read(root, 'var/www/milan.com/html/index.html'), '<html>built</html>');
    assert.match(read(root, 'etc/nginx/sites-available/app.milan.com'), /proxy_pass http:\/\/127\.0\.0\.1:3013;/);
    const items = Object.fromEntries(events.filter((e) => e.type === 'item').map((e) => [e.item.id, e.item]));
    assert.equal(items['up:docker'].status, 'ok');
    assert.equal(items['site:graborders:check'].status, 'ok');

    // a new build goes live, and Roll back brings the old one back
    fs.writeFileSync(path.join(proj, 'graborders', 'dist', 'index.html'), '<html>v2</html>');
    const again = await runDeploy({ server: { host: '127.0.0.1' }, folder: proj, mode: 'sites', siteIds: ['graborders'], connect, onEvent: () => {} });
    assert.equal(again.status, 'ok');
    assert.equal(read(root, 'var/www/milan.com/html/index.html'), '<html>v2</html>');
    await runRollback({ folder: proj, siteId: 'graborders', connect, onEvent: () => {} });
    assert.equal(read(root, 'var/www/milan.com/html/index.html'), '<html>built</html>');
  } finally {
    srv.close();
  }
});
