'use strict';
// Security check: which ports of the server are open to the whole internet, and one-click
// closing of database ports (MongoDB, Redis, MySQL, PostgreSQL) that Docker publishes.
// Docker ports skip the ufw firewall, so the fix is "127.0.0.1:" in the compose file, not ufw.
const { q } = require('./shell');
const { DB_PORTS, parseEnv } = require('./compose');
const { lockDatabases, isPublic } = require('./compose-edit');
const { STATE_DIR } = require('./deploy');

const DB_IMAGE_RE = /(^|\/)(mongo|mongodb|redis|valkey|mysql|mariadb|postgres|postgis|timescaledb)(:|@|$)/i;
const SAFE_PUBLIC = { 22: 'SSH (your login)', 80: 'websites (http)', 443: 'websites (https)' };

// Read-only look at the server.
function scanScript() {
  return `R="\${SNAP_ROOT:-}"
echo @@CONTAINERS
if command -v docker >/dev/null 2>&1; then
  docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.project.config_files"}}\t{{.Ports}}' 2>/dev/null
  echo @@USES
  for id in $(docker ps -q 2>/dev/null); do
    n=$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##')
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null |
      grep -oE '(mongodb(\\+srv)?|redis|rediss|mysql|mariadb|postgres|postgresql)://[^ ,"]+' |
      sed -E 's#^([a-z+]+)://([^@/]*@)?([^/?]+).*#\\1 \\3#' | while read -r scheme hp; do printf '%s\\t%s\\t%s\\n' "$n" "$scheme" "$hp"; done
  done
fi
echo @@LISTEN
ss -ltnpH 2>/dev/null | awk '{ printf "%s\\t%s\\n", $4, $6 }'
echo @@FILES
docker ps --format '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.config_files"}}' 2>/dev/null | sort -u | while IFS="$(printf '\\t')" read -r p f; do
  [ -n "$p" ] || continue
  case "$f" in *,*) continue;; esac
  [ -f "$R$f" ] || continue
  echo "@@FILE $p"
  base64 -w0 "$R$f" 2>/dev/null || base64 "$R$f" | tr -d '\\n'
  echo
  d=$(dirname "$f")
  if [ -f "$R$d/.env" ]; then echo "@@ENV $p"; base64 -w0 "$R$d/.env" 2>/dev/null || base64 "$R$d/.env" | tr -d '\\n'; echo; fi
done
echo @@UFW
command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1
echo @@END
`;
}

// "0.0.0.0:2757->27017/tcp, :::2757->27017/tcp" -> [{ ip, host, container }]
function parseDockerPorts(s) {
  const out = [];
  for (const m of String(s || '').matchAll(/(\[?[0-9a-f.:]*\]?):(\d+)->(\d+)\/(tcp|udp)/gi)) {
    const ip = m[1].replace(/^\[|\]$/g, '') || '::';
    if (!out.some((o) => o.host === Number(m[2]) && o.container === Number(m[3]) && isPublic(o.ip) === isPublic(ip))) {
      out.push({ ip, host: Number(m[2]), container: Number(m[3]), proto: m[4] });
    }
  }
  return out;
}

const fromB64 = (s) => Buffer.from(String(s || '').trim(), 'base64').toString('utf8');

function parseScan(text) {
  const out = { containers: [], uses: [], listen: [], files: {}, envs: {}, ufw: '' };
  let sec = null;
  let pending = null;
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const fm = line.match(/^@@(FILE|ENV) (.+)$/);
    if (fm) { pending = { kind: fm[1], project: fm[2] }; continue; }
    if (pending) { (pending.kind === 'FILE' ? out.files : out.envs)[pending.project] = fromB64(line); pending = null; continue; }
    if (/^@@[A-Z]+$/.test(line)) { sec = line.slice(2); continue; }
    if (!line.trim()) continue;
    const p = line.split('\t');
    if (sec === 'CONTAINERS') {
      out.containers.push({ id: p[0], name: p[1], image: p[2], project: p[3] || null, service: p[4] || null, workingDir: p[5] || null, configFile: p[6] || null, ports: parseDockerPorts(p[7]) });
    } else if (sec === 'USES') out.uses.push({ container: p[0], scheme: p[1], target: p[2] });
    else if (sec === 'LISTEN') {
      const m = String(p[0]).match(/^(.*):(\d+)$/);
      if (m) out.listen.push({ ip: m[1].replace(/^\[|\]$/g, '').replace(/%.*$/, ''), port: Number(m[2]), proc: ((p[1] || '').match(/\("([^"]+)"/) || [])[1] || '' });
    } else if (sec === 'UFW') out.ufw = line.trim();
  }
  return out;
}

const DB_NAME_BY_IMAGE = [[/mongo/i, 'MongoDB'], [/redis|valkey/i, 'Redis'], [/mysql|mariadb/i, 'MySQL'], [/postgres|postgis|timescale/i, 'PostgreSQL']];
function dbName(c, port) {
  if (DB_PORTS[port.container]) return DB_PORTS[port.container];
  const hit = DB_NAME_BY_IMAGE.find(([re]) => re.test(c.image));
  return hit && DB_IMAGE_RE.test(c.image) ? hit[1] : null;
}

// Turns the scan into what the screen shows: dangers (databases), other open ports, and what can be fixed.
function report(scan) {
  const dangers = [];
  const open = [];
  const dockerPorts = new Set();
  for (const c of scan.containers) {
    for (const port of c.ports) {
      if (!isPublic(port.ip)) continue;
      dockerPorts.add(port.host);
      const name = dbName(c, port);
      if (name) dangers.push({ container: c.name, project: c.project, service: c.service, image: c.image, name, host: port.host, port: port.container });
      else open.push({ port: port.host, what: `Docker: ${c.name}${c.project ? ` (project ${c.project})` : ''}`, kind: 'app' });
    }
  }
  for (const l of scan.listen) {
    if (!isPublic(l.ip) || dockerPorts.has(l.port) || open.some((o) => o.port === l.port) || dangers.some((d) => d.host === l.port)) continue;
    if (/docker-proxy/.test(l.proc)) continue;
    const dbLike = /^(mongod|redis-server|mysqld|mariadbd|postgres)$/.test(l.proc);
    if (dbLike) dangers.push({ container: null, project: null, service: null, image: l.proc, name: l.proc, host: l.port, port: l.port, native: true });
    else open.push({ port: l.port, what: SAFE_PUBLIC[l.port] || (l.proc ? `program: ${l.proc}` : 'a program'), kind: SAFE_PUBLIC[l.port] ? 'normal' : 'other' });
  }
  open.sort((a, b) => a.port - b.port);
  // other containers that reach a database through its public port: closing it would break them
  for (const d of dangers) {
    d.usedBy = scan.uses.filter((u) => {
      const m = String(u.target).match(/^(.*):(\d+)$/);
      if (!m || Number(m[2]) !== d.host) return false;
      return /^[0-9.]+$/.test(m[1]) || m[1].includes('.') || m[1] === 'host.docker.internal';
    }).map((u) => u.container);
    const file = d.project && scan.files[d.project];
    const c = scan.containers.find((x) => x.name === d.container);
    if (d.native) d.fix = { ok: false, why: `${d.name} runs directly on the server (not in Docker). Set bind 127.0.0.1 in its config file.` };
    else if (!d.project || !c || !c.configFile) d.fix = { ok: false, why: 'This container was not started by docker compose, so ServerSnap cannot change it.' };
    else if (c.configFile.includes(',')) d.fix = { ok: false, why: 'This project uses more than one compose file.' };
    else if (!file) d.fix = { ok: false, why: `The compose file ${c.configFile} was not found on the server.` };
    else {
      const env = parseEnv(scan.envs[d.project] || '');
      const res = lockDatabases(file, env, [d.service]);
      const mine = res.changes.filter((x) => x.host === d.host || x.container === d.port);
      d.fix = mine.length ? { ok: true, file: c.configFile, workingDir: c.workingDir } : { ok: false, why: `The port line for ${d.service} could not be found in ${c.configFile} (maybe written in the long form).` };
    }
    if (d.fix.ok && d.usedBy.length) d.fix = { ok: false, why: `${d.usedBy.join(', ')} connect${d.usedBy.length === 1 ? 's' : ''} to this database through the public port. Change ${d.usedBy.length === 1 ? 'it' : 'them'} to use the service name first.` };
  }
  return { dangers, open, ufw: scan.ufw };
}

// The new compose file for a project, with its database ports closed.
function lockedCompose(scan, project, services) {
  const file = scan.files[project];
  if (!file) throw new Error(`The compose file of ${project} was not found on the server.`);
  return lockDatabases(file, parseEnv(scan.envs[project] || ''), services);
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sha256 = (s) => require('crypto').createHash('sha256').update(s, 'utf8').digest('hex');

// Writes the new compose file, recreates only the database services, checks the ports
// are on 127.0.0.1 now and the containers run. Anything wrong: the old file comes back.
function lockScript({ project, file, oldText, newText, services, ports, stamp }) {
  return `set -u
R="\${SNAP_ROOT:-}"
STATE="$R"${q(STATE_DIR)}
mkdir -p "$STATE/backups" "$STATE/logs"
exec > >(tee -a "$STATE/logs/security-${project}-${stamp}.log") 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') ServerSnap Security: close databases of ${project} ==="
step() { echo "@@STEP $1|$2|\${3:-}"; }
fail() { echo "@@FAIL $*"; exit 1; }
P=${q(project)}
F="$R"${q(file)}
SERVICES=${q(services.join(' '))}
BK="$STATE/backups/$P-compose.${stamp}.yml"
[ -f "$F" ] || fail "The compose file is missing: $F"
cd "$(dirname "$F")" || fail "Cannot open the project folder."
if docker compose version >/dev/null 2>&1; then DC="docker compose"; elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"; else fail "Docker Compose is not installed on the server."; fi
have=$(sha256sum "$F" | cut -d' ' -f1)
[ "$have" = ${q(sha256(oldText))} ] || fail "The compose file changed on the server since ServerSnap read it. Press Check again."
cp -p "$F" "$BK" || fail "Could not make a backup of the compose file."
step backup ok "Old file saved as $BK"
restore() {
  echo "--- putting the old compose file back ---"
  cat "$BK" > "$F"
  $DC -p "$P" -f "$F" up -d --no-deps $SERVICES 2>&1
}
echo ${q(b64(newText))} | base64 -d > "$F.snap-new" || fail "Could not write the new file."
cat "$F.snap-new" > "$F" && rm -f "$F.snap-new"
step file ok "127.0.0.1 added in front of the database ports"
if ! $DC -p "$P" -f "$F" config -q 2>&1; then restore; fail "docker compose did not accept the changed file. The old file is back."; fi
step restart running "Restarting $SERVICES (a few seconds)"
if ! $DC -p "$P" -f "$F" up -d --no-deps $SERVICES 2>&1; then restore; fail "docker compose could not restart $SERVICES. The old file is back."; fi
sleep 5
for port in ${ports.map(Number).join(' ')}; do
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E "(^|[^0-9.])(0\\.0\\.0\\.0|\\*|\\[::\\]|::):$port$" >/dev/null; then
    restore; fail "Port $port is still open to the internet after the change. The old file is back."
  fi
done
for s in $SERVICES; do
  id=$(docker ps -q --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$s" --filter status=running)
  [ -n "$id" ] || { restore; fail "$s did not start again. The old file is back."; }
done
step restart ok "$SERVICES running, only reachable from the server itself"
echo "@@DONE closed"
`;
}

module.exports = { scanScript, parseScan, parseDockerPorts, report, lockedCompose, lockScript, sha256, SAFE_PUBLIC };
