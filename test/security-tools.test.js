'use strict';
// Attack Shield and Privacy & Lockdown. The server scripts run for real in a local shell
// against a scratch folder with fake auth/nginx logs and fake sshd / ufw / fail2ban-client /
// systemctl / journalctl / last / geoiplookup on PATH.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sh, SH } = require('./harness');
const shield = require('../src/attack-shield');
const privacy = require('../src/privacy');

const posix = (p) => p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `snap-${name}-`));
const write = (root, rel, text) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));

function scratch(fakes = {}) {
  const root = tmp('sec').replace(/\\/g, '/');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  for (const [n, body] of Object.entries(fakes)) fs.writeFileSync(path.join(root, 'bin', n), body, { mode: 0o755 });
  return root;
}
const env = (root, more = {}) => ({ SNAP_ROOT: posix(root), HOME: `${posix(root)}/root`, ...more });
const runIn = (root, script, more) => sh(`PATH=${posix(root)}/bin:$PATH bash -s`, { stdin: script, env: env(root, more) });

// ---------- fakes ----------
const T = '\t';
const FAKE = {
  // prints nothing for the sshd journal query; exits 0 for --rotate / --vacuum-time
  journalctl: '#!/bin/sh\nexit 0\n',
  last: '#!/bin/sh\necho "root pts/0 1.2.3.4 Mon"\necho "root pts/0 5.6.7.8 Sun"\n',
  'fail2ban-client': `#!/bin/sh
if [ "$1" = status ] && [ -z "$2" ]; then printf 'Status\\n|- Jail list:${T}sshd\\n'; exit 0; fi
if [ "$1" = status ] && [ "$2" = sshd ]; then printf '   |- Banned IP list:${T}203.0.113.9\\n'; exit 0; fi
if [ "$1" = set ]; then echo "$@" >> "$SNAP_ROOT/f2b.log"; exit 0; fi
exit 0
`,
  ufw: `#!/bin/sh
if [ "$1" = status ] && [ "$2" = numbered ]; then printf 'Status: active\\n[ 1] Anywhere DENY IN %s\\n' "203.0.113.5"; exit 0; fi
if [ "$1" = status ]; then printf 'Status: active\\nTo Action From\\nAnywhere DENY IN 203.0.113.5\\n'; exit 0; fi
echo "$@" >> "$SNAP_ROOT/ufw.log"
exit 0
`,
  geoiplookup: '#!/bin/sh\necho "GeoIP Country Edition: RU, Russia"\n',
};

// ---------- Attack Shield ----------
test('shield: validIp accepts public, refuses private / loopback / own', () => {
  assert.equal(shield.validIp('203.0.113.9'), '203.0.113.9');
  assert.equal(shield.validIp('8.8.8.8'), '8.8.8.8');
  for (const bad of ['127.0.0.1', '10.0.0.4', '192.168.1.5', '172.16.0.1', '0.0.0.0', '169.254.1.1', '224.0.0.1', 'nope', '999.1.1.1']) {
    assert.equal(shield.validIp(bad), null, bad);
  }
});

test('shield: status scan reads SSH tries, nginx scans, bans, blocks and country', { skip: !SH, timeout: 60000 }, async () => {
  const root = scratch(FAKE);
  write(root, 'var/log/auth.log', [
    'Nov  1 10:00:00 h sshd[1]: Failed password for root from 203.0.113.9 port 2 ssh2',
    'Nov  1 10:00:01 h sshd[1]: Failed password for invalid user admin from 203.0.113.9 port 2 ssh2',
    'Nov  1 10:00:02 h sshd[1]: Invalid user admin from 203.0.113.9 port 2',
    'Nov  1 10:00:03 h sshd[1]: Failed password for root from 45.9.148.2 port 2 ssh2',
    'Nov  1 10:00:04 h sshd[1]: Failed password for root from 45.9.148.2 port 2 ssh2',
  ].join('\n') + '\n');
  write(root, 'var/log/nginx/access.log', [
    '198.51.100.7 - - [01/Nov/2026:10:00:00 +0000] "GET /wp-login.php HTTP/1.1" 404 1 "-" "bot"',
    '198.51.100.7 - - [01/Nov/2026:10:00:01 +0000] "GET /.env HTTP/1.1" 404 1 "-" "bot"',
    '198.51.100.7 - - [01/Nov/2026:10:00:02 +0000] "GET /phpmyadmin HTTP/1.1" 403 1 "-" "bot"',
  ].join('\n') + '\n');

  const r = await runIn(root, shield.statusScript({ days: 7, min: 2 }));
  assert.equal(r.code, 0, r.stderr);
  const st = shield.parseStatus(r.stdout);

  const ssh9 = st.ssh.find((s) => s.ip === '203.0.113.9');
  assert.ok(ssh9 && ssh9.count === 3, 'three SSH tries from .9');
  assert.ok(ssh9.users.includes('admin'), 'captured the username tried');
  assert.ok(st.ssh.some((s) => s.ip === '45.9.148.2'));
  const web = st.web.find((w) => w.ip === '198.51.100.7');
  assert.ok(web && web.count === 3, 'three nginx scans');
  assert.ok(st.banned.some((b) => b.ip === '203.0.113.9' && b.jail === 'sshd'), 'fail2ban ban read');
  assert.ok(st.blocked.includes('203.0.113.5'), 'our ufw block read');
  assert.equal(st.geo['203.0.113.9'], 'Russia', 'country from geoiplookup');

  const list = shield.attackers(st);
  const a9 = list.find((a) => a.ip === '203.0.113.9');
  assert.equal(a9.banned, 'sshd');
  assert.equal(a9.country, 'Russia');
  assert.equal(a9.total, 3);
});

test('shield: block adds a ufw rule and a fail2ban ban; unblock removes them', { skip: !SH, timeout: 60000 }, async () => {
  const root = scratch(FAKE);
  const b = await runIn(root, shield.blockScript('203.0.113.77'));
  assert.equal(b.code, 0, b.stderr);
  assert.deepEqual(shield.parseResult(b.stdout), { ok: true, ip: '203.0.113.77' });
  assert.ok(read(root, 'ufw.log').includes('203.0.113.77'), 'ufw rule added');
  assert.ok(read(root, 'f2b.log').includes('banip 203.0.113.77'), 'fail2ban ban added');

  const u = await runIn(root, shield.unblockScript('203.0.113.77'));
  assert.equal(u.code, 0, u.stderr);
  assert.equal(shield.parseResult(u.stdout).ok, true);
  assert.ok(read(root, 'f2b.log').includes('unbanip 203.0.113.77'), 'fail2ban unban added');
});

test('shield: blockScript refuses a private / invalid IP before running', () => {
  assert.throws(() => shield.blockScript('10.0.0.5'), /public IP/);
  assert.throws(() => shield.blockScript('not-an-ip'), /public IP/);
});

// ---------- Privacy & Lockdown ----------
const sshdOk = (passauth = 'yes', port = '22') => `#!/bin/sh
for a in "$@"; do [ "$a" = "-t" ] && exit 0; done
# -T dump
echo "port ${port}"
echo "passwordauthentication ${passauth}"
echo "permitrootlogin yes"
`;
const systemctlActive = '#!/bin/sh\n[ "$1" = is-active ] && { echo active; exit 0; }\nexit 0\n';

test('privacy: check reads keys, password login, port, firewall and fail2ban', { skip: !SH, timeout: 60000 }, async () => {
  const root = scratch({ sshd: sshdOk('yes', '22'), systemctl: systemctlActive, ufw: FAKE.ufw, last: FAKE.last });
  write(root, 'root/.ssh/authorized_keys', 'ssh-ed25519 AAAA me@pc\n# a comment\n');
  const r = await runIn(root, privacy.checkScript());
  assert.equal(r.code, 0, r.stderr);
  const c = privacy.parseCheck(r.stdout);
  assert.equal(c.keys, 1, 'one real key (comment not counted)');
  assert.equal(c.passwordLogin, true);
  assert.equal(c.port, 22);
  assert.equal(c.ufwOn, true);
  assert.equal(c.fail2banOn, true);
});

test('privacy: clear logins empties wtmp/btmp and the auth logs', { skip: !SH, timeout: 60000 }, async () => {
  const root = scratch({ journalctl: FAKE.journalctl, last: FAKE.last });
  write(root, 'var/log/wtmp', 'binary-login-records');
  write(root, 'var/log/btmp', 'bad-login-records');
  write(root, 'var/log/auth.log', 'Failed password for root from 203.0.113.9\n');
  write(root, 'var/log/auth.log.1', 'old attempts\n');
  const r = await runIn(root, privacy.clearLoginsScript({ web: false }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /@@DONE cleared/);
  assert.equal(read(root, 'var/log/wtmp'), '', 'wtmp emptied');
  assert.equal(read(root, 'var/log/btmp'), '', 'btmp emptied');
  assert.equal(read(root, 'var/log/auth.log'), '', 'auth.log emptied');
  assert.equal(read(root, 'var/log/auth.log.1'), '', 'rotated auth log emptied');
});

test('privacy: retention writes a logrotate rule and a journald limit', { skip: !SH, timeout: 60000 }, async () => {
  const root = scratch({ systemctl: systemctlActive });
  const r = await runIn(root, privacy.retentionScript(10));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /@@DONE set/);
  assert.match(read(root, 'etc/logrotate.d/serversnap'), /rotate 10/);
  assert.match(read(root, 'etc/systemd/journald.conf.d/serversnap.conf'), /MaxRetentionSec=10day/);
});

test('privacy: lockdown REFUSES key-only when no SSH key is installed', { skip: !SH, timeout: 60000 }, async () => {
  const root = scratch({ sshd: sshdOk(), systemctl: systemctlActive });
  const r = await runIn(root, privacy.lockdownScript({ keyOnly: true }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no SSH key/i, 'warns no key');
  assert.match(r.stdout, /@@DONE/);
  assert.ok(!exists(root, 'etc/ssh/sshd_config.d/00-serversnap.conf'), 'password login left ON');
});

test('privacy: lockdown turns off password login when a key exists', { skip: !SH, timeout: 60000 }, async () => {
  const root = scratch({ sshd: sshdOk(), systemctl: systemctlActive });
  write(root, 'root/.ssh/authorized_keys', 'ssh-ed25519 AAAA me@pc\n');
  write(root, 'etc/ssh/sshd_config', '# base config\n');
  const r = await runIn(root, privacy.lockdownScript({ keyOnly: true }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /@@DONE locked/);
  assert.match(read(root, 'etc/ssh/sshd_config.d/00-serversnap.conf'), /PasswordAuthentication no/);
});

test('privacy: lockdown moves SSH port but keeps 22 open', { skip: !SH, timeout: 60000 }, async () => {
  const root = scratch({ sshd: sshdOk(), systemctl: systemctlActive, ufw: FAKE.ufw });
  const r = await runIn(root, privacy.lockdownScript({ sshPort: 2222 }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /@@DONE locked/);
  const dropin = read(root, 'etc/ssh/sshd_config.d/00-serversnap.conf');
  assert.match(dropin, /Port 2222/);
  assert.match(dropin, /Port 22/, '22 kept until confirmed');
});
