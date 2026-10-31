'use strict';
// Security (closing open databases), Site Doctor and "new client from a template".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lockDatabases, remapPorts, splitPort } = require('../src/compose-edit');
const { parseCompose } = require('../src/compose');
const security = require('../src/security');
const doctor = require('../src/doctor');
const template = require('../src/template');
const { sh, SH } = require('./harness');

const COMPOSE = `# keep this comment
services:
  backend:
    build: ./server
    ports:
      - 8082:8082   # api
  db:
    image: mongo:4.0-xenial
    ports:
      - "\${DB_PORT:-2747}:27017"
  cache:
    image: redis:6
    ports:
      - 6379:6379
  safe:
    image: mongo:7
    ports:
      - 127.0.0.1:2800:27017
  long:
    image: mongo:7
    ports:
      - target: 27017
        published: 2900
  web:
    build: ./admin
    ports:
      - '3062:80'
volumes:
  phone:
`;

test('compose edit: closes database ports, keeps everything else', () => {
  assert.deepEqual(splitPort('${DB_PORT:-2747}:27017'), ['${DB_PORT:-2747}', '27017']);
  const r = lockDatabases(COMPOSE, {});
  assert.deepEqual(r.changes.map((c) => `${c.service} ${c.from} -> ${c.to}`), [
    'db ${DB_PORT:-2747}:27017 -> 127.0.0.1:${DB_PORT:-2747}:27017',
    'cache 6379:6379 -> 127.0.0.1:6379:6379',
  ]);
  assert.match(r.text, /- "127\.0\.0\.1:\$\{DB_PORT:-2747\}:27017"/);
  assert.match(r.text, /# keep this comment/);
  assert.match(r.text, /- 8082:8082   # api/);
  assert.ok(r.skipped.some((x) => x.service === 'long'));
  // the result still reads the same, now with 127.0.0.1
  const db = parseCompose(r.text, {}).services.find((s) => s.name === 'db');
  assert.deepEqual(db.ports[0], { ip: '127.0.0.1', host: 2747, container: 27017 });
  // only one service
  assert.equal(lockDatabases(COMPOSE, {}, ['cache']).changes.length, 1);
  // Windows line ends stay
  assert.match(lockDatabases(COMPOSE.replace(/\n/g, '\r\n'), {}).text, /\r\n/);
});

test('compose edit: new host ports', () => {
  const r = remapPorts(COMPOSE, { DB_PORT: '2747' }, { 'backend:8082': 8090, 'db:2747': 2748, 'web:3062': 3070 });
  assert.match(r.text, /- 8090:8082   # api/);
  assert.match(r.text, /- "2748:27017"/);
  assert.match(r.text, /- '3070:80'/);
  assert.equal(r.changes.length, 3);
});

// ---------- security scan ----------
const KING_FILE = 'services:\n  backend:\n    ports:\n      - 8082:8082\n  db:\n    image: mongo:4.0-xenial\n    ports:\n      - 2757:27017\n';
const b64 = (s) => Buffer.from(s).toString('base64');
const SCAN = [
  '@@CONTAINERS',
  'aaa\tking-db-1\tmongo:4.0-xenial\tking\tdb\t/root/king\t/root/king/docker-compose.yml\t0.0.0.0:2757->27017/tcp, :::2757->27017/tcp',
  'bbb\tking-backend-1\tking-backend\tking\tbackend\t/root/king\t/root/king/docker-compose.yml\t0.0.0.0:8082->8082/tcp',
  'ccc\tshubh-db-1\tmongo:4.0-xenial\tshubh\tdb\t/root/SHUBH\t/root/SHUBH/docker-compose.yml\t0.0.0.0:2747->27017/tcp',
  'ddd\tother-api-1\tother\tother\tapi\t/root/other\t/root/other/docker-compose.yml\t',
  'eee\tsafe-db-1\tmongo:7\tsafe\tdb\t/root/safe\t/root/safe/docker-compose.yml\t127.0.0.1:2800->27017/tcp',
  '@@USES',
  'king-backend-1\tmongodb\tdb:27017',
  'other-api-1\tmongodb\t203.0.113.50:2747',
  '@@LISTEN',
  '0.0.0.0:22\tusers:(("sshd",pid=1,fd=3))',
  '0.0.0.0:80\tusers:(("nginx",pid=2,fd=6))',
  '0.0.0.0:2757\tusers:(("docker-proxy",pid=3,fd=4))',
  '0.0.0.0:6379\tusers:(("redis-server",pid=4,fd=6))',
  '127.0.0.1:2800\tusers:(("docker-proxy",pid=5,fd=4))',
  '0.0.0.0:9000\tusers:(("node",pid=6,fd=4))',
  '@@FILES',
  '@@FILE king', b64(KING_FILE),
  '@@FILE shubh', b64(KING_FILE.replace('2757', '2747')),
  '@@UFW',
  'Status: active',
  '@@END',
].join('\n');

test('security: finds open databases, what blocks a fix, and other ports', () => {
  const scan = security.parseScan(SCAN);
  assert.equal(scan.files.king, KING_FILE);
  const r = security.report(scan);
  const by = Object.fromEntries(r.dangers.map((d) => [d.container || d.name, d]));
  assert.deepEqual(Object.keys(by).sort(), ['king-db-1', 'redis-server', 'shubh-db-1']);
  assert.equal(by['king-db-1'].fix.ok, true);
  assert.equal(by['king-db-1'].fix.file, '/root/king/docker-compose.yml');
  // another container reaches SHUBH's database through the public port: closing it would break that app
  assert.equal(by['shubh-db-1'].fix.ok, false);
  assert.match(by['shubh-db-1'].fix.why, /other-api-1 connects/);
  assert.equal(by['redis-server'].native, true);
  assert.deepEqual(r.open.map((o) => `${o.port}:${o.kind}`), ['22:normal', '80:normal', '8082:app', '9000:other']);
  assert.equal(r.ufw, 'Status: active');
  assert.match(security.lockedCompose(scan, 'king', ['db']).text, /127\.0\.0\.1:2757:27017/);
});

// ---------- the lock script, run for real with fake docker / ss ----------
const FAKES = {
  docker: `#!/bin/sh
echo "docker $*" >> "$SNAP_ROOT/calls.log"
case "$*" in
  "compose version") exit 0;;
  *" config -q") exit \${FAKE_CONFIG_RC:-0};;
  *" up -d --no-deps "*) exit \${FAKE_UP_RC:-0};;
  "ps -q "*) [ -n "$FAKE_DB_DOWN" ] || echo abc;;
esac
exit 0
`,
  ss: `#!/bin/sh
if [ -z "$FAKE_SS_OPEN" ] && grep -q '127.0.0.1:2757' "$SNAP_ROOT/root/king/docker-compose.yml"; then
  echo "LISTEN 0 4096 127.0.0.1:2757 0.0.0.0:*"
else
  echo "LISTEN 0 4096 0.0.0.0:2757 0.0.0.0:*"
fi
echo "LISTEN 0 4096 0.0.0.0:8082 0.0.0.0:*"
`,
};

const posix = (p) => p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
function scratch(fakes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapsec-')).replace(/\\/g, '/');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  for (const [n, body] of Object.entries(fakes)) fs.writeFileSync(path.join(root, 'bin', n), body, { mode: 0o755 });
  return root;
}
async function runOn(root, script, env = {}) {
  const r = await sh(`PATH=${posix(root)}/bin:$PATH bash -s`, { stdin: script, env: { SNAP_ROOT: posix(root), ...env } });
  const markers = r.stdout.split('\n').filter((l) => l.startsWith('@@'));
  return { ...r, markers, fail: (markers.find((m) => m.startsWith('@@FAIL')) || '').slice(7), done: (markers.find((m) => m.startsWith('@@DONE')) || '').slice(7) };
}

test('lock script: closes the port, or puts the old file back', { skip: !SH, timeout: 60000 }, async () => {
  const root = scratch(FAKES);
  const file = path.join(root, 'root/king/docker-compose.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const newText = lockDatabases(KING_FILE, {}).text;
  const args = { project: 'king', file: '/root/king/docker-compose.yml', oldText: KING_FILE, newText, services: ['db'], ports: [2757], stamp: 'S1' };

  // the port is still open afterwards -> old file back
  fs.writeFileSync(file, KING_FILE);
  const stillOpen = await runOn(root, security.lockScript(args), { FAKE_SS_OPEN: '1' });
  assert.match(stillOpen.fail, /still open/);
  assert.equal(fs.readFileSync(file, 'utf8'), KING_FILE);

  // the database does not come back -> old file back
  const down = await runOn(root, security.lockScript({ ...args, stamp: 'S2' }), { FAKE_DB_DOWN: '1' });
  assert.match(down.fail, /did not start again/);
  assert.equal(fs.readFileSync(file, 'utf8'), KING_FILE);

  // someone changed the file meanwhile -> nothing is touched
  fs.writeFileSync(file, KING_FILE + '# edited\n');
  const changed = await runOn(root, security.lockScript({ ...args, stamp: 'S3' }));
  assert.match(changed.fail, /changed on the server/);
  assert.equal(fs.readFileSync(file, 'utf8'), KING_FILE + '# edited\n');

  // works
  fs.writeFileSync(file, KING_FILE);
  const ok = await runOn(root, security.lockScript({ ...args, stamp: 'S4' }));
  assert.equal(ok.fail, '', ok.stdout + ok.stderr);
  assert.equal(ok.done, 'closed');
  assert.match(fs.readFileSync(file, 'utf8'), /- 127\.0\.0\.1:2757:27017/);
  assert.equal(fs.readFileSync(path.join(root, 'root/serversnap-deploy/backups/king-compose.S4.yml'), 'utf8'), KING_FILE);
  assert.match(fs.readFileSync(path.join(root, 'calls.log'), 'utf8'), /docker compose -p king -f .*docker-compose\.yml up -d --no-deps db/);
});

// ---------- Site Doctor ----------
const base = {
  nginx: true, active: 'active', testOk: true, testLines: [], file: '/etc/nginx/sites-enabled/king.com', upstreams: ['127.0.0.1:8082'],
  listen: { 8082: true }, upcode: { 8082: 404 }, containers: { 8082: { id: 'abc123def456', name: 'king-backend-1', state: 'running', status: 'Up 2 days', restarts: 0 } },
  logs: {}, root: '/var/www/king.com/html', index: true, certFile: '/etc/letsencrypt/live/king.com/fullchain.pem',
  certEnd: new Date(Date.now() + 60 * 86400000).toISOString(), certNames: ['king.com', 'www.king.com'], local443: 200, diskPct: 40, memTotal: 4000, memAvail: 2000, errlog: [],
};
const dnsOk = { ok: true, ips: ['1.2.3.4'], serverIps: ['1.2.3.4'] };

test('doctor: everything fine', () => {
  const r = doctor.diagnose({ domain: 'king.com', dns: dnsOk, outside: { code: 200, ms: 120 }, server: base });
  assert.equal(r.level, 'ok');
  assert.match(r.verdict, /works/);
});

test('doctor: 502 because the backend container stopped -> start button', () => {
  const s = { ...base, listen: { 8082: false }, upcode: { 8082: 0 }, local443: 502,
    containers: { 8082: { ...base.containers[8082], state: 'exited', status: 'Exited (1) 3 minutes ago' } }, logs: { abc123def456: ['Error: Cannot find module'] } };
  const r = doctor.diagnose({ domain: 'king.com', dns: dnsOk, outside: { code: 502, ms: 90, server: 'nginx' }, server: s });
  assert.equal(r.level, 'fail');
  const port = r.findings.find((f) => f.title === 'Port 8082');
  assert.equal(port.level, 'fail');
  assert.deepEqual(port.fix, { action: 'start-container', id: 'abc123def456', label: 'Start king-backend-1' });
  assert.deepEqual(port.logs, ['Error: Cannot find module']);
  assert.match(r.verdict, /king-backend-1 is exited/);
});

test('doctor: DNS points elsewhere (Namecheap proxy), server itself fine', () => {
  const r = doctor.diagnose({ domain: 'king.com', dns: { ok: false, ips: ['198.51.100.7'], serverIps: ['1.2.3.4'] }, outside: { code: 502, ms: 300, server: 'APISIX' }, server: base });
  assert.match(r.verdict, /points to 198.51.100.7, not to this server/);
  assert.match(r.findings.find((f) => f.title === 'From the internet').text, /server itself is fine/);
  // behind Cloudflare on purpose: not a DNS problem
  const cf = doctor.diagnose({ domain: 'king.com', dns: { ok: false, ips: ['104.21.1.1'], serverIps: ['1.2.3.4'] }, outside: { code: 200, ms: 80, server: 'cloudflare' }, server: base });
  assert.equal(cf.level, 'ok');
});

test('doctor: expired certificate, nginx down, disk full', () => {
  const r = doctor.diagnose({ domain: 'king.com', dns: dnsOk, outside: { code: 0, error: 'CERT_HAS_EXPIRED' }, server: { ...base, certEnd: new Date(Date.now() - 3 * 86400000).toISOString(), active: 'inactive', diskPct: 97 } });
  const by = Object.fromEntries(r.findings.map((f) => [f.title, f]));
  assert.deepEqual(by.HTTPS.fix, { action: 'renew-cert', name: 'king.com', label: 'Renew the certificate' });
  assert.equal(by.nginx.fix.action, 'start-nginx');
  assert.equal(by.Disk.level, 'fail');
  assert.match(by['From the internet'].text, /certificate has expired/);
  assert.match(doctor.fixCommand(by.HTTPS.fix), /certbot renew --cert-name 'king\.com'/);
  assert.throws(() => doctor.fixCommand({ action: 'renew-cert', name: 'x; rm -rf /' }));
  assert.throws(() => doctor.fixCommand({ action: 'rm' }));
  assert.equal(doctor.checkDomain('https://King.com/path'), 'king.com');
  assert.throws(() => doctor.checkDomain('not a domain'));
});

test('doctor script: reads the nginx file, website files and the backend port', { skip: !SH }, async () => {
  const root = scratch({
    nginx: '#!/bin/sh\necho "nginx: configuration file test is successful"\nexit 0\n',
    ss: '#!/bin/sh\necho "LISTEN 0 4096 0.0.0.0:8082 0.0.0.0:*"\n',
    curl: '#!/bin/sh\nprintf 200\n',
    docker: '#!/bin/sh\ncase "$*" in "ps -a --filter publish=8082"*) printf "abc123\\tking-backend-1\\trunning\\tUp 2 days\\n";; "inspect --format {{.RestartCount}} abc123") echo 4;; "logs"*) echo "boom";; esac\n',
  });
  fs.mkdirSync(path.join(root, 'etc/nginx/sites-enabled'), { recursive: true });
  fs.mkdirSync(path.join(root, 'var/www/king.com/html'), { recursive: true });
  fs.writeFileSync(path.join(root, 'var/www/king.com/html/index.html'), 'x');
  fs.writeFileSync(path.join(root, 'etc/nginx/sites-enabled/king.com'),
    'server {\n  server_name king.com www.king.com;\n  root /var/www/king.com/html;\n  location /api/ { proxy_pass http://127.0.0.1:8082/api/; }\n  location /socket.io/ { proxy_pass http://127.0.0.1:8082; }\n}\n');
  const r = await runOn(root, doctor.doctorScript('king.com'));
  const s = doctor.parseDoctor(r.stdout);
  assert.equal(s.nginx, true);
  assert.equal(s.testOk, true);
  assert.match(s.file, /sites-enabled\/king\.com$/);
  assert.equal(s.index, true);
  assert.deepEqual(s.upstreams, ['127.0.0.1:8082']);
  assert.equal(s.listen['8082'], true);
  assert.equal(s.containers['8082'].restarts, 4);
  assert.deepEqual(s.logs.abc123, ['boom']);
  assert.equal(s.local80, 200);
});

// ---------- new client from a template ----------
function makeTemplate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaptpl-'));
  const src = path.join(dir, 'king');
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); fs.writeFileSync(path.join(src, f), s); };
  w('docker-compose.yml', 'services:\n  backend:\n    build: ./server\n    ports:\n      - 8082:8082\n    environment:\n      REDIS_URL: redis://:Sup3rSecretPass@redis:6379\n  db:\n    image: mongo:4.0-xenial\n    ports:\n      - 2757:27017\n  redis:\n    image: redis:6\n    command: redis-server --requirepass Sup3rSecretPass\n');
  w('server/package.json', '{"scripts":{"build":"tsc"}}');
  w('server/.env', 'AUTH_JWT_SECRET=oldJwtSecretValue1\nRESEND_KEY=re_keep_me\n');
  w('graborders/package.json', '{"scripts":{"build":"vite build"}}');
  w('graborders/index.html', '<title>Kingtrade</title>');
  w('graborders/src/api.ts', 'export const a = "https://kingtrade.site/api"; // old: http://203.0.113.50:8082/api\nconst v = "1.2.3.4.5"; const lib = "v10.2.3.4";\n');
  w('graborders/src/i18n.ts', 'title: "kingtrade", footer: "KINGTRADE", mail: "kingtrade.help@gmail.com"');
  w('graborders/dist/index.html', 'built for kingtrade.site');
  w('graborders/node_modules/x/index.js', 'x');
  w('graborders/public/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0x6b, 0x69, 0x6e, 0x67]));
  w('PC/package.json', '{"scripts":{"build":"vite build"}}');
  w('PC/index.html', 'pc.kingtrade.site');
  w('kingtrade.site', 'server { server_name kingtrade.site; resolver 1.1.1.1; }');
  w('snap.json', JSON.stringify({ version: 1, project: 'king', remoteDir: '/root/king', docker: true, mainDomain: 'kingtrade.site', sites: [
    { id: 'graborders', folder: 'graborders', enabled: true, domain: 'kingtrade.site', www: true, kind: 'trading', backendPort: 8082, build: 'dist', ssl: true, ws: true },
    { id: 'PC', folder: 'PC', enabled: true, domain: 'pc.kingtrade.site', www: false, kind: 'trading', backendPort: 8082, build: 'dist', ssl: true, ws: true },
  ] }));
  return { dir, src };
}

test('template: plan finds domain, brand, IP, ports and secrets; create makes a separate client', async () => {
  const { dir, src } = makeTemplate();
  const target = path.join(dir, 'Newclient');
  const p = await template.plan({ source: src, target, newDomain: 'newclient.com', serverIp: '5.6.7.8', taken: [8083] });
  assert.equal(p.oldDomain, 'kingtrade.site');
  assert.equal(p.project, 'newclient');
  assert.deepEqual(p.ports.map((x) => `${x.service}:${x.from}->${x.to}`), ['backend:8082->8084', 'db:2757->2758']);
  const kinds = p.pairs.map((x) => `${x.kind}:${x.from}`);
  assert.ok(kinds.includes('secret:Sup3rSecretPass') && kinds.includes('secret:oldJwtSecretValue1'), kinds.join(' '));
  assert.ok(kinds.includes('ipport:203.0.113.50:8082') && kinds.includes('ip:203.0.113.50'));
  assert.ok(!kinds.some((k) => /1\.1\.1\.1|1\.2\.3\.4|10\.2\.3\.4/.test(k)), 'DNS servers and version numbers are not addresses');
  assert.ok(kinds.includes('domain:kingtrade.site') && kinds.includes('brand:kingtrade') && kinds.includes('brand:KINGTRADE'));
  assert.ok(p.skipped.includes('graborders/dist') && p.skipped.includes('graborders/node_modules'));

  const r = await template.create(p);
  const read = (f) => fs.readFileSync(path.join(target, f), 'utf8');
  const compose = read('docker-compose.yml');
  assert.match(compose, /- 8084:8082/);
  assert.match(compose, /- 127\.0\.0\.1:2758:27017/);
  assert.doesNotMatch(compose, /Sup3rSecretPass/);
  const pass = compose.match(/--requirepass (\S+)/)[1];
  assert.match(compose, new RegExp(`redis://:${pass}@redis`), 'the Redis password changed in both places the same way');
  assert.doesNotMatch(read('server/.env'), /oldJwtSecretValue1/);
  assert.match(read('server/.env'), /RESEND_KEY=re_keep_me/);
  assert.equal(read('graborders/src/api.ts').split('\n')[0], 'export const a = "https://newclient.com/api"; // old: http://5.6.7.8:8084/api');
  assert.match(read('graborders/src/api.ts'), /"1\.2\.3\.4\.5"/);
  assert.equal(read('graborders/src/i18n.ts'), 'title: "newclient", footer: "NEWCLIENT", mail: "newclient.help@gmail.com"');
  assert.equal(read('graborders/index.html'), '<title>Newclient</title>');
  assert.ok(fs.existsSync(path.join(target, 'newclient.com')), 'files named after the domain are renamed');
  assert.ok(!fs.existsSync(path.join(target, 'graborders/dist')));
  assert.ok(!fs.existsSync(path.join(target, 'graborders/node_modules')));
  assert.deepEqual([...fs.readFileSync(path.join(target, 'graborders/public/logo.png'))].slice(-4), [0x6b, 0x69, 0x6e, 0x67], 'binary files are copied as they are');
  // deploy settings for the new client
  const cfg = JSON.parse(read('snap.json'));
  assert.equal(cfg.project, 'newclient');
  assert.equal(cfg.remoteDir, '/root/Newclient');
  assert.deepEqual(cfg.sites.filter((x) => x.enabled).map((x) => `${x.domain}:${x.backendPort}:${x.build}`), ['newclient.com:8084:build', 'pc.newclient.com:8084:build']);
  assert.ok(r.changed >= 6);
  // the template is untouched
  assert.match(fs.readFileSync(path.join(src, 'docker-compose.yml'), 'utf8'), /- 2757:27017/);
  // a second copy into the same folder is refused
  await assert.rejects(template.plan({ source: src, target, newDomain: 'other.com' }), /already exists/);
});

test('scan script: containers, who uses which database, listeners, compose files', { skip: !SH }, async () => {
  const root = scratch({
    docker: `#!/bin/sh
case "$*" in
  "ps --format {{.ID}}"*) printf 'aaa\tking-db-1\tmongo:4.0\tking\tdb\t/root/king\t/root/king/docker-compose.yml\t0.0.0.0:2757->27017/tcp\n';;
  "ps -q") echo aaa;;
  "inspect --format {{.Name}} aaa") echo /king-backend-1;;
  "inspect --format"*) printf 'PATH=/bin\nDATABASE_CONNECTION=mongodb://admin:pw@203.0.113.50:2757/grap?x=1\n';;
  "ps --format {{.Label"*) printf 'king\t/root/king/docker-compose.yml\nmulti\t/a.yml,/b.yml\n';;
esac
`,
    ss: '#!/bin/sh\necho "LISTEN 0 4096 0.0.0.0:2757 0.0.0.0:* users:((\\"docker-proxy\\",pid=3,fd=4))"\n',
  });
  fs.mkdirSync(path.join(root, 'root/king'), { recursive: true });
  fs.writeFileSync(path.join(root, 'root/king/docker-compose.yml'), KING_FILE);
  fs.writeFileSync(path.join(root, 'root/king/.env'), 'DB_PORT=2757\n');
  const r = await runOn(root, security.scanScript());
  const scan = security.parseScan(r.stdout);
  assert.equal(scan.containers[0].name, 'king-db-1');
  assert.deepEqual(scan.containers[0].ports, [{ ip: '0.0.0.0', host: 2757, container: 27017, proto: 'tcp' }]);
  assert.deepEqual(scan.uses, [{ container: 'king-backend-1', scheme: 'mongodb', target: '203.0.113.50:2757' }], r.stdout + r.stderr);
  assert.equal(scan.files.king, KING_FILE);
  assert.equal(scan.envs.king, 'DB_PORT=2757\n');
  assert.ok(!scan.files.multi);
  assert.deepEqual(scan.listen, [{ ip: '0.0.0.0', port: 2757, proc: 'docker-proxy' }]);
  assert.doesNotMatch(r.stdout, /admin:pw/, 'passwords in connection strings are not sent back');
});
