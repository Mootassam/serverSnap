'use strict';
// Docker dashboard grouping and customer-access building blocks (no server needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const docker = require('../src/docker');
const clients = require('../src/clients');
const { sh, SH } = require('./harness');
const { q } = require('../src/shell');

const { hex, overviewText, usageText } = require('./fixtures');

test('overview: containers grouped per project, like docker ps but per customer', () => {
  const ov = docker.parseOverview(overviewText());
  const v = docker.groupOverview(ov, docker.parseUsage(usageText));
  assert.deepEqual(v.groups.map((g) => g.title), ['king', 'shubh', 'Other containers']);
  const king = v.groups[0];
  assert.equal(king.workingDir, '/root/king');
  assert.equal(king.total, 4);
  assert.equal(king.running, 4);
  assert.deepEqual(king.containers.map((c) => c.name), ['king-backend-1', 'king-db-1', 'king-redis-1', 'king-web-1']);
  // "king → database (315 MB) Â· upload (4 MB) Â· redis"
  assert.deepEqual(king.summary.map((x) => x.label), ['database', 'upload', 'redis']);
  assert.equal(king.summary[0].sizeKb, 315096);
  assert.equal(king.databases[0].kind, 'mongo');
  assert.equal(king.containers[0].usage.cpu, '1.20%');
  assert.deepEqual(king.containers.find((c) => c.name === 'king-backend-1').ports, ['8082→8082/tcp']);
  assert.deepEqual(king.containers.find((c) => c.name === 'king-redis-1').ports, ['6379/tcp']);
  // anonymous Mongo config volume belongs to king but is not in the summary
  assert.ok(king.volumes.some((x) => x.role === 'anonymous'));
  assert.equal(v.groups[1].running, 0);
  assert.deepEqual(v.unusedVolumes.map((x) => x.name), ['old_stuff']);
  assert.equal(v.host.cpus, 2);
  assert.equal(v.host.diskFreeKb, 91993528);
});

test('overview: passwords in container settings never leave the main process', () => {
  const ov = docker.parseOverview(overviewText());
  assert.ok(!JSON.stringify(ov).includes('do-not-show'));
});

test('overview: images know which containers use them', () => {
  const v = docker.groupOverview(docker.parseOverview(overviewText()), null);
  const backend = v.images.find((i) => i.tags.includes('king-backend:latest'));
  assert.deepEqual(backend.usedBy, ['king-backend-1']);
  const dangling = v.images.find((i) => !i.tags.length);
  assert.deepEqual(dangling.usedBy, []);
  assert.equal(v.groups[0].images.length >= 1, true);
});

test('overview: no docker / no access', () => {
  assert.equal(docker.parseOverview('@@SNAP@@nodocker').docker.installed, false);
  assert.equal(docker.parseOverview('@@SNAP@@noaccess').docker.access, false);
});

test('actions: databases stop last and start first', () => {
  const v = docker.groupOverview(docker.parseOverview(overviewText()), null);
  const cmd = docker.actionCommand('restart', v.groups[0].containers);
  const at = (name) => cmd.indexOf(hex(name));
  const firstStop = cmd.indexOf('docker stop');
  const firstStart = cmd.indexOf('docker start');
  assert.ok(firstStop < firstStart);
  const stopPart = cmd.slice(0, firstStart);
  const startPart = cmd.slice(firstStart);
  // app (backend 'a') stops before the database ('d'); database starts before the app
  assert.ok(stopPart.indexOf(hex('a')) < stopPart.lastIndexOf(hex('d')));
  assert.ok(startPart.indexOf(hex('d')) < startPart.lastIndexOf(hex('a')));
  assert.ok(at('a') > -1);
  assert.throws(() => docker.actionCommand('rm', v.groups[0].containers), /Unknown action/);
  assert.throws(() => docker.actionCommand('stop', [{ id: 'x; rm -rf /', image: '' }]), /Not a container id/);
  assert.throws(() => docker.logsCommand('$(reboot)'), /Not a container id/);
  assert.match(docker.logsCommand(hex('a'), 99999), /--tail 5000/);
});

test('delete: containers, a whole customer, images and volumes are built safely', () => {
  const v = docker.groupOverview(docker.parseOverview(overviewText()), null);
  const king = v.groups[0];
  const all = v.groups.flatMap((g) => g.containers);
  const cmd = docker.removeContainersCommand(king.containers, { project: 'king' });
  assert.match(cmd, /^docker rm -f /);
  assert.match(cmd, /label=com\.docker\.compose\.project=king/);
  assert.doesNotMatch(cmd, /volume rm/); // data is never deleted here
  assert.throws(() => docker.removeContainersCommand(king.containers, { project: 'king; reboot' }), /Not a project/);
  assert.throws(() => docker.removeContainersCommand([{ id: '../x', mounts: [] }]), /Not a container id/);
  // the whole customer's own volumes, including the unnamed Mongo config one
  assert.deepEqual(docker.volumesOnlyUsedBy(king.containers, all).sort(), [hex('9'), 'king_phone', 'king_redis_data', 'king_upload'].sort());
  // deleting only the backend never takes the database volume
  assert.deepEqual(docker.volumesOnlyUsedBy(king.containers.filter((c) => c.service === 'backend'), all), ['king_upload']);
  const img = v.images.find((i) => i.tags.includes('redis:6.2-alpine'));
  assert.equal(docker.removeImageCommand(img), "docker rmi 'redis:6.2-alpine' >/dev/null");
  const untagged = v.images.find((i) => !i.tags.length);
  assert.equal(docker.removeImageCommand(untagged), `docker rmi 'sha256:${hex('7')}' >/dev/null`);
  assert.doesNotMatch(docker.removeImageCommand(img), / -f/); // Docker refuses images still in use
  assert.throws(() => docker.removeImageCommand({ id: 'sha256:zz', tags: [] }), /Not an image id/);
  assert.throws(() => docker.removeImageCommand({ id: 'sha256:' + hex('1'), tags: ['$(reboot)'] }), /Not an image name/);
  assert.equal(docker.removeVolumeCommand('old_stuff'), "docker volume rm 'old_stuff' >/dev/null");
  assert.throws(() => docker.removeVolumeCommand('a b'), /Not a volume/);
});

test('dashboard scripts are valid shell', { skip: !SH }, async () => {
  for (const s of [docker.OVERVIEW_SCRIPT, docker.USAGE_SCRIPT]) {
    const r = await sh(`sh -n -c ${q(s)}`);
    assert.equal(r.code, 0, r.stderr);
  }
});

test('customer login names are safe and short', () => {
  assert.equal(clients.clientUser('king'), 'snap_king');
  assert.equal(clients.clientUser('SHUBH'), 'snap_shubh');
  assert.equal(clients.clientUser('my shop!!'), 'snap_my_shop');
  assert.ok(clients.clientUser('a'.repeat(80)).length <= 32);
  assert.throws(() => clients.clientUser('***'), /empty/);
});

test('access code: round trip, and clear errors for bad codes', () => {
  const kp = clients.makeKeyPair('t');
  assert.match(kp.publicKey, /^ssh-ed25519 /);
  const code = clients.encodeCode({ name: 'King shop', project: 'king', host: '203.0.113.5', port: 22, user: 'snap_king', privateKey: kp.privateKey, hostKey: 'SHA256:abc' });
  assert.match(code, /^SNAP1-[A-Za-z0-9_-]+$/);
  // pasted from a chat app with line breaks and spaces
  const pasted = 'Here is your code:\n' + code.match(/.{1,60}/g).join('\n  ') + '\n';
  const c = clients.decodeCode(pasted);
  assert.equal(c.user, 'snap_king');
  assert.equal(c.privateKey, kp.privateKey);
  assert.equal(c.hostKey, 'SHA256:abc');
  assert.throws(() => clients.decodeCode('hello'), /not a ServerSnap access code/);
  assert.throws(() => clients.decodeCode('SNAP1-!!!!'), /damaged|incomplete/);
});

test('customer choices: database copy and uploads ticked, raw DB files and cache not', () => {
  const v = docker.groupOverview(docker.parseOverview(overviewText()), docker.parseUsage(usageText));
  const items = clients.itemChoices(v.groups[0]);
  const on = items.filter((i) => i.on).map((i) => i.label);
  assert.deepEqual(on, ['Database (MongoDB)', 'Files: upload']);
  assert.ok(items.some((i) => !i.on && /Raw database/.test(i.label)));
  assert.ok(items.some((i) => !i.on && /Cache/.test(i.label)));
});

test('customer schedule: hourly, every 6 / 12 hours, daily', () => {
  assert.equal(clients.cronWhen('03:30', 'hourly'), '30 * * * *');
  assert.equal(clients.cronWhen('03:30', 'every6h'), '30 3,9,15,21 * * *');
  assert.equal(clients.cronWhen('14:05', 'every6h'), '5 2,8,14,20 * * *');
  assert.equal(clients.cronWhen('03:30', 'every12h'), '30 3,15 * * *');
  assert.equal(clients.cronWhen('03:30', 'daily'), '30 3 * * *');
  assert.equal(clients.cronWhen('03:30', 'nonsense'), '30 3 * * *');
  assert.equal(clients.scheduleText('03:30', 'hourly'), 'every hour, at minute 30');
  assert.equal(clients.scheduleText('03:30', 'every12h'), 'every 12 hours at 03:30, 15:30');
  assert.equal(clients.scheduleText('03:30', 'daily'), 'every day at 03:30');
  assert.match(clients.cronFile('snap_king', '03:30', 'hourly'), /^30 \* \* \* \* root \/usr\/local\/sbin\/serversnap-export-snap_king >>/m);
});

test('nightly job time', () => {
  assert.match(clients.cronFile('snap_king', '03:30'), /^30 3 \* \* \* root \/usr\/local\/sbin\/serversnap-export-snap_king /m);
  assert.match(clients.cronFile('snap_king', 'bad'), /^30 3 /m);
});

test('server scripts are valid bash', { skip: !SH }, async () => {
  const items = [{ type: 'database', kind: 'mongo', container: 'king-db-1', service: 'db', label: 'Database (MongoDB)' },
    { type: 'volume', name: 'king_upload', label: 'Files: upload' }, { type: 'files', path: "/root/king/it's uploads", label: 'Folder' }];
  const script = clients.exportScript({ project: 'king', user: 'snap_king', server: { id: '1', name: 'King "VPS"', host: 'h' }, items });
  const kp = clients.makeKeyPair('t');
  for (const s of [script, clients.installScript({ user: 'snap_king', publicKey: kp.publicKey, script, cron: clients.cronFile('snap_king') }),
    clients.removeScript('snap_king'), clients.rekeyScript('snap_king', kp.publicKey), clients.statusScript('snap_king'), clients.ROLLBACK_SSHD]) {
    // via a file: long scripts do not survive the Windows command line intact
    const f = path.join(os.tmpdir(), `ss-syntax-${process.pid}.sh`);
    fs.writeFileSync(f, s);
    const r = await sh(`bash -n "$F"`, { env: { F: f.replace(/\\/g, '/') } });
    fs.rmSync(f, { force: true });
    assert.equal(r.code, 0, r.stderr + '\n' + s.slice(0, 400));
  }
  assert.throws(() => clients.removeScript('root'), /Bad login/);
  assert.throws(() => clients.installScript({ user: 'root; reboot', publicKey: kp.publicKey, script, cron: '' }), /Bad login/);
});

test('sshd rule: only the customer group, read-only SFTP in its own folder, keys only', () => {
  const b = clients.SSHD_BLOCK;
  assert.match(b, /Match Group serversnap-clients/);
  assert.match(b, /ChrootDirectory \/srv\/serversnap\/%u/);
  // writes are stopped by folder permissions (only requests/ is theirs), so no "-R" here
  assert.match(b, /ForceCommand internal-sftp$/m);
  assert.match(b, /AuthenticationMethods publickey/);
  assert.match(b, /AllowTcpForwarding no/);
  assert.match(b, /# END ServerSnap\n$/);
});

test('status output is read back', () => {
  const m = { status: 'ok', totalBytes: 12, createdAt: '2026-10-30T03:30:00Z', items: [{ label: 'Database (MongoDB)', status: 'ok', bytes: 12 }] };
  const st = clients.parseStatus(`@@exists\nyes\n@@list\n2026-10-30_03-30-00\t${JSON.stringify(m)}\n2026-10-29_03-30-00\t\n@@log\n[x] Done\n`);
  assert.equal(st.exists, true);
  assert.equal(st.backups.length, 2);
  assert.equal(st.backups[0].status, 'ok');
  assert.equal(st.backups[1].status, 'unknown');
  assert.equal(st.log, '[x] Done');
});
