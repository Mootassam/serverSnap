'use strict';
// Client download access: one locked login per customer (Compose project) that can only read
// its own backup folder over SFTP, plus a nightly job *on the server* that fills that folder
// with the customer's databases and files. Works even when the admin's PC is off.
const { utils } = require('ssh2');
const { q, slug, normalizeRemotePath, relFromRoot } = require('./shell');
const db = require('./db');

const BASE = '/srv/serversnap';
const GROUP = 'serversnap-clients';
const KEYS_DIR = '/etc/serversnap/keys';
const SSHD = '/etc/ssh/sshd_config';
const CODE_PREFIX = 'SNAP1-';

// Linux login for a project: "snap_" + safe name, at most 32 characters.
function clientUser(project) {
  const s = String(project || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  if (!s) throw new Error('Project name is empty.');
  return ('snap_' + s).slice(0, 32);
}

function makeKeyPair(comment) {
  const k = utils.generateKeyPairSync('ed25519', { comment });
  return { privateKey: k.private, publicKey: k.public.trim() };
}

// The access code the customer pastes into ServerSnap Client.
function encodeCode(a) {
  const body = { v: 1, n: a.name, s: a.project, h: a.host, p: Number(a.port) || 22, u: a.user, k: a.privateKey, f: a.hostKey };
  return CODE_PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

function decodeCode(text) {
  const t = String(text || '').replace(/\s+/g, '');
  const start = t.indexOf(CODE_PREFIX);
  if (start < 0) throw new Error('This is not a ServerSnap access code. It starts with "SNAP1-".');
  let j;
  try { j = JSON.parse(Buffer.from(t.slice(start + CODE_PREFIX.length), 'base64url').toString('utf8')); } catch (_) {
    throw new Error('The access code is damaged. Copy the whole code again.');
  }
  if (j.v !== 1 || !j.h || !j.u || !j.k || !j.s) throw new Error('The access code is incomplete. Copy the whole code again.');
  return { name: j.n || j.s, project: j.s, host: j.h, port: Number(j.p) || 22, user: j.u, privateKey: j.k, hostKey: j.f || null };
}

// ---------- what a customer gets ----------

// Default choice for a dashboard group: database copies + data volumes; no raw DB files, no cache.
function itemChoices(group) {
  const out = [];
  for (const d of group.databases || []) {
    out.push({ key: `db:${d.container}`, type: 'database', kind: d.kind, container: d.container, service: d.service, label: `Database (${db.KINDS[d.kind].label})`, on: true });
  }
  for (const v of group.volumes || []) {
    if (v.role === 'anonymous') continue;
    out.push({ key: `volume:${v.name}`, type: 'volume', name: v.name, label: v.role === 'database' ? `Raw database files (${v.label})` : v.role === 'cache' ? `Cache (${v.name})` : `Files: ${v.label}`, sizeKb: v.sizeKb, on: v.role === 'data' });
  }
  const seen = new Set();
  for (const c of group.containers || []) {
    for (const m of c.mounts || []) {
      if (m.type !== 'bind' || !m.source) continue;
      let p;
      try { p = normalizeRemotePath(m.source); } catch (_) { continue; }
      if (seen.has(p) || /^\/(proc|sys|dev|run|var\/run|etc|tmp)(\/|$)/.test(p) || /\.sock$/.test(p)) continue;
      seen.add(p);
      out.push({ key: `files:${p}`, type: 'files', path: p, label: `Folder ${p}`, on: false });
    }
  }
  return out;
}

function fileFor(item) {
  if (item.type === 'database') return `databases/${slug(item.container)}.${db.KINDS[item.kind].ext}`;
  if (item.type === 'volume') return `volumes/${slug(item.name)}.tar.gz`;
  return `files/${slug(item.path)}.tar.gz`;
}

// Static part of each manifest item (same shape as an app backup, so the admin can restore it too).
function manifestItem(item, project) {
  const file = fileFor(item);
  if (item.type === 'database') return { id: `db:docker:${item.container}`, type: 'database', label: item.label, kind: item.kind, where: 'docker', container: item.container, project, service: item.service || null, file };
  if (item.type === 'volume') return { id: `volume:${item.name}`, type: 'volume', label: item.label, name: item.name, file };
  return { id: `files:${item.path}`, type: 'files', label: item.label, path: item.path, file };
}

// Inner JSON of an object: '"a":1,"b":2' (the script adds status, size and checksum).
const inner = (o) => JSON.stringify(o).slice(1, -1);

function itemBlock(item, project) {
  const m = manifestItem(item, project);
  const f = q(m.file);
  const meta = q(inner(m));
  const lines = [`log ${q('Copying ' + item.label)}`];
  if (item.type === 'database') {
    const find = item.service
      ? `docker ps -q --filter ${q('label=com.docker.compose.project=' + project)} --filter ${q('label=com.docker.compose.service=' + item.service)} | head -n 1`
      : `docker ps -q --filter ${q('name=^/' + item.container + '$')} | head -n 1`;
    lines.push(
      `C=$(${find})`,
      `if [ -z "$C" ]; then finish_item ${meta} failed ${f} "database container is not running"`,
      `else docker exec "$C" sh -c ${q(db.dumpScript(item.kind))} 2>"$D/.err" | gzip -6 > "$D/"${f}; rc=\${PIPESTATUS[0]}`,
      `  if [ "$rc" -eq 0 ]; then finish_item ${meta} ok ${f} ""; else rm -f "$D/"${f}; finish_item ${meta} failed ${f} "$(tail -n 3 "$D/.err")"; fi`,
      'fi');
  } else if (item.type === 'volume') {
    lines.push(
      `MP=$(docker volume inspect -f '{{.Mountpoint}}' ${q(item.name)} 2>/dev/null)`,
      `if [ -n "$MP" ] && [ -d "$MP" ]; then tar -czf "$D/"${f} -C "$MP" . 2>"$D/.err"; rc=$?`,
      `  if [ "$rc" -eq 0 ]; then finish_item ${meta} ok ${f} ""; elif [ "$rc" -eq 1 ]; then finish_item ${meta} warning ${f} "some files changed while copying"; else rm -f "$D/"${f}; finish_item ${meta} failed ${f} "$(tail -n 3 "$D/.err")"; fi`,
      `else finish_item ${meta} failed ${f} "volume not found"; fi`);
  } else {
    const rel = q(relFromRoot(item.path));
    lines.push(
      `if [ -e ${q(item.path)} ]; then (cd / && tar -czf "$D/"${f} --exclude=var/lib/docker ${rel}) 2>"$D/.err"; rc=$?`,
      `  if [ "$rc" -eq 0 ]; then finish_item ${meta} ok ${f} ""; elif [ "$rc" -eq 1 ]; then finish_item ${meta} warning ${f} "some files changed while copying"; else rm -f "$D/"${f}; finish_item ${meta} failed ${f} "$(tail -n 3 "$D/.err")"; fi`,
      `else finish_item ${meta} failed ${f} "folder not found"; fi`);
  }
  return lines.join('\n');
}

// The nightly job (bash, runs as root on the server).
function exportScript({ project, user, server, items, keep = 7, base = BASE }) {
  if (!items.length) throw new Error('Choose at least one thing the customer can download.');
  const head = inner({
    app: 'ServerSnap',
    format: 1,
    server: { id: server.id, name: server.name, host: server.host },
    client: { project, user },
    projects: [],
    loose: [],
  });
  return `#!/bin/bash
# Made by ServerSnap: daily download copy for customer "${project.replace(/[^\w.-]/g, '_')}" (login ${user}).
# ServerSnap rewrites this file; change the settings in the app instead.
set -u
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
umask 027
U=${q(user)}
KEEP=${Math.max(1, Math.min(90, Number(keep) || 7))}
BASE=${q(base)}
OUT="$BASE/$U/backups"
WORK="$BASE/.work/$U"
log() { printf '[%s] %s\\n' "$(date '+%F %T')" "$*"; }
mkdir -p "$OUT" "$BASE/.work" || exit 1
exec 9>"$BASE/.work/$U.lock"
if command -v flock >/dev/null 2>&1; then flock -n 9 || { log "Another copy is already running."; exit 0; }; fi
STAMP=$(date +%Y-%m-%d_%H-%M-%S); NAME=$STAMP; n=1
while [ -e "$OUT/$NAME" ]; do n=$((n+1)); NAME="$STAMP-$n"; done
D="$WORK/$NAME"
rm -rf "$WORK"; mkdir -p "$D/databases" "$D/volumes" "$D/files" || exit 1
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ITEMS=""; OKN=0; BAD=0; TOTAL=0
finish_item() {
  local st="$2" f="$3" b=0 h="" m
  m=$(printf '%s' "$4" | tr -d '"\\\\' | tr '\\r\\n\\t' '   ' | cut -c1-300)
  if [ "$st" != failed ] && [ -f "$D/$f" ]; then
    b=$(stat -c %s "$D/$f"); h=$(sha256sum "$D/$f" | cut -d' ' -f1); OKN=$((OKN+1)); TOTAL=$((TOTAL+b))
  else st=failed; BAD=$((BAD+1)); fi
  [ -n "$ITEMS" ] && ITEMS="$ITEMS,"
  ITEMS="$ITEMS{$1,\\"status\\":\\"$st\\",\\"bytes\\":$b,\\"sha256\\":\\"$h\\",\\"error\\":\\"$m\\"}"
  log "  $st, $b bytes $m"
}
log "Backup $NAME starting"
${items.map((i) => itemBlock(i, project)).join('\n')}
rm -f "$D/.err"
if [ "$OKN" -eq 0 ]; then log "Nothing could be copied."; rm -rf "$WORK"; exit 1; fi
STATUS=ok; [ "$BAD" -gt 0 ] && STATUS=partial
printf '{%s,"name":"%s","status":"%s","createdAt":"%s","finishedAt":"%s","totalBytes":%s,"items":[%s]}\\n' \\
  ${q(head)} "$NAME" "$STATUS" "$STARTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TOTAL" "$ITEMS" > "$D/manifest.json"
chown root:"$U" "$OUT" && chmod 750 "$OUT" &&
  chown -R root:"$U" "$D" && find "$D" -type d -exec chmod 750 {} + && find "$D" -type f -exec chmod 640 {} + ||
  { log "Could not set file permissions."; rm -rf "$WORK"; exit 1; }
mv "$D" "$OUT/$NAME" || { log "Could not publish the backup."; rm -rf "$WORK"; exit 1; }
rm -rf "$WORK"
ls -1 "$OUT" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_' | sort | head -n -"$KEEP" | while IFS= read -r x; do rm -rf -- "$OUT/$x"; done
log "Done: $NAME ($STATUS, $TOTAL bytes)"
[ "$STATUS" = ok ]
`;
}

function cronFile(user, time) {
  const m = String(time || '03:30').match(/^(\d{1,2}):(\d{2})$/);
  const hh = m ? Math.min(23, Number(m[1])) : 3;
  const mm = m ? Math.min(59, Number(m[2])) : 30;
  return `# Made by ServerSnap: daily customer backup for ${user}\nSHELL=/bin/bash\n${mm} ${hh} * * * root /usr/local/sbin/serversnap-export-${user} >> /var/log/serversnap-${user}.log 2>&1\n`;
}

const SSHD_BLOCK = `
# BEGIN ServerSnap (customer download logins: read-only, own folder only)
Match Group ${GROUP}
    ChrootDirectory ${BASE}/%u
    ForceCommand internal-sftp -R
    AuthorizedKeysFile ${KEYS_DIR}/%u
    AuthenticationMethods publickey
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitTTY no
# END ServerSnap
`;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Shell that reloads sshd however this server runs it.
const RELOAD_SSHD = 'if command -v systemctl >/dev/null 2>&1; then systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true; ' +
  'else service ssh reload 2>/dev/null || service sshd reload 2>/dev/null || true; fi';

// Creates or updates the customer's login, key, nightly job and the SSH rule. Idempotent.
// Prints "SSHD-CHANGED" when it edited sshd_config (the caller then checks it can still log in).
function installScript({ user, publicKey, script, cron }) {
  if (!/^snap_[a-z0-9_-]{1,27}$/.test(user)) throw new Error(`Bad login name: ${user}`);
  const keyLine = `restrict ${publicKey.trim()}`;
  return `set -e
U=${q(user)}; BASE=${q(BASE)}; G=${q(GROUP)}
for t in useradd usermod getent base64 sha256sum gzip tar; do command -v "$t" >/dev/null 2>&1 || { echo "The server is missing the tool: $t" >&2; exit 2; }; done
[ -f ${SSHD} ] || { echo "No ${SSHD} on this server." >&2; exit 2; }
# The chroot folders must belong to root and be writable only by root.
for d in / /srv; do
  [ -d "$d" ] || mkdir -p "$d"
  o=$(stat -c '%u %a' "$d"); case "$o" in "0 "*) ;; *) echo "$d must belong to root for locked logins (now: $o)." >&2; exit 2;; esac
  p=\${o#* }; case "$p" in *[2367]?|*?[2367]) echo "$d is writable by other users (mode $p); locked logins need it to be 755." >&2; exit 2;; esac
done
getent group "$G" >/dev/null || groupadd "$G"
if ! id "$U" >/dev/null 2>&1; then
  NL=$(command -v nologin || echo /usr/sbin/nologin)
  useradd -M -U -G "$G" -d /backups -s "$NL" -c "ServerSnap customer download" "$U"
fi
usermod -a -G "$G" "$U"
usermod -p '*' "$U"
mkdir -p "$BASE/$U/backups" "$BASE/.work" ${KEYS_DIR}
chown root:root "$BASE" "$BASE/$U" /etc/serversnap ${KEYS_DIR}; chmod 755 "$BASE" "$BASE/$U" /etc/serversnap ${KEYS_DIR}
chown root:"$U" "$BASE/$U/backups"; chmod 750 "$BASE/$U/backups"; chmod 700 "$BASE/.work"
printf '%s\\n' ${q(keyLine)} > ${KEYS_DIR}/"$U"; chown root:root ${KEYS_DIR}/"$U"; chmod 644 ${KEYS_DIR}/"$U"
printf '%s' ${q(b64(script))} | base64 -d > /usr/local/sbin/serversnap-export-"$U"; chmod 700 /usr/local/sbin/serversnap-export-"$U"
printf '%s' ${q(b64(cron))} | base64 -d > /etc/cron.d/serversnap-"$U"; chmod 644 /etc/cron.d/serversnap-"$U"
if ! grep -q '^# BEGIN ServerSnap' ${SSHD}; then
  cp -p ${SSHD} ${SSHD}.serversnap-backup
  printf '%s' ${q(b64(SSHD_BLOCK))} | base64 -d >> ${SSHD}
  mkdir -p /run/sshd
  S=$(command -v sshd || echo /usr/sbin/sshd)
  if ! E=$("$S" -t 2>&1); then cp -p ${SSHD}.serversnap-backup ${SSHD}; echo "SSH refused the new setting, nothing was changed: $E" >&2; exit 3; fi
  ${RELOAD_SSHD}
  echo SSHD-CHANGED
fi
echo INSTALLED
`;
}

// Puts sshd_config back as it was before ServerSnap touched it (safety net).
const ROLLBACK_SSHD = `[ -f ${SSHD}.serversnap-backup ] && cp -p ${SSHD}.serversnap-backup ${SSHD} && { ${RELOAD_SSHD}; }; true`;

// Changes only the key (new access code; the old one stops working at once).
function rekeyScript(user, publicKey) {
  if (!/^snap_[a-z0-9_-]{1,27}$/.test(user)) throw new Error(`Bad login name: ${user}`);
  return `set -e; [ -f ${KEYS_DIR}/${user} ] || { echo "This customer access does not exist on the server." >&2; exit 2; }
printf '%s\\n' ${q(`restrict ${publicKey.trim()}`)} > ${KEYS_DIR}/${user}; pkill -KILL -u ${q(user)} 2>/dev/null || true; echo OK`;
}

function removeScript(user, { keepFiles = false } = {}) {
  if (!/^snap_[a-z0-9_-]{1,27}$/.test(user)) throw new Error(`Bad login name: ${user}`);
  const U = q(user);
  return [
    `rm -f ${KEYS_DIR}/${user} /etc/cron.d/serversnap-${user} /usr/local/sbin/serversnap-export-${user}`,
    `pkill -KILL -u ${U} 2>/dev/null || true`,
    `if id ${U} >/dev/null 2>&1; then userdel ${U} 2>/dev/null || { sleep 1; userdel ${U}; }; fi`,
    `getent group ${U} >/dev/null 2>&1 && groupdel ${U} 2>/dev/null || true`,
    keepFiles ? `echo kept` : `rm -rf -- ${q(`${BASE}/${user}`)} ${q(`${BASE}/.work/${user}`)} ${q(`${BASE}/.work/${user}.lock`)}`,
    'echo REMOVED',
  ].join('\n');
}

// Backups on the server for one customer + the end of the job's log.
function statusScript(user) {
  if (!/^snap_[a-z0-9_-]{1,27}$/.test(user)) throw new Error(`Bad login name: ${user}`);
  const out = `${BASE}/${user}/backups`;
  return `echo @@exists; [ -f ${KEYS_DIR}/${user} ] && echo yes || echo no
echo @@list; for d in $(ls -1 ${q(out)} 2>/dev/null | grep -E '^[0-9]{4}-' | sort -r); do printf '%s\\t' "$d"; tr -d '\\n' < ${q(out)}/"$d"/manifest.json 2>/dev/null; echo; done
echo @@log; tail -n 30 /var/log/serversnap-${user}.log 2>/dev/null; true`;
}

function parseStatus(text) {
  const parts = {};
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (/^@@\w+$/.test(line)) { cur = line.slice(2); parts[cur] = []; continue; }
    if (cur) parts[cur].push(line);
  }
  const backups = (parts.list || []).filter(Boolean).map((l) => {
    const tab = l.indexOf('\t');
    const name = tab < 0 ? l : l.slice(0, tab);
    let m = null;
    try { m = JSON.parse(l.slice(tab + 1)); } catch (_) { /* half-written or missing manifest */ }
    return { name, status: m ? m.status : 'unknown', totalBytes: m ? m.totalBytes : null, createdAt: m ? m.createdAt : null, items: m ? m.items.map((i) => ({ label: i.label, status: i.status, bytes: i.bytes })) : [] };
  });
  return { exists: (parts.exists || [])[0] === 'yes', backups, log: (parts.log || []).join('\n').trim() };
}

module.exports = {
  BASE, GROUP, SSHD_BLOCK, ROLLBACK_SSHD,
  clientUser, makeKeyPair, encodeCode, decodeCode, itemChoices, manifestItem, fileFor,
  exportScript, cronFile, installScript, rekeyScript, removeScript, statusScript, parseStatus,
};
