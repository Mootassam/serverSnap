'use strict';
// ServerSnap Deploy: puts a project folder from this PC on a server.
//   docker  -> upload the project, docker compose up -d --build
//   sites   -> build website folders (dist), copy them to /var/www, nginx file (trading / normal /
//              container port), sites-enabled, HTTPS with certbot, check, roll back on failure.
// Each project folder keeps its answers in snap.json. Scripts here run on the server as root.
const fs = require('fs');
const path = require('path');
const { q } = require('./shell');
const { parseCompose, parseEnv, exposedDatabases } = require('./compose');
const { KINDS, TRADING_WS, FWD_PROTO, fillTemplate } = require('./nginx-templates');

const CONFIG_FILE = 'snap.json';
const STATE_DIR = '/root/serversnap-deploy';
const DEFAULT_EXCLUDE = ['node_modules', '.git', '.claude', '.vscode', '.idea'];
const BACKEND_NAMES = ['server', 'backend', 'api'];

// ---------- validation ----------
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const isDomain = (d) => DOMAIN_RE.test(String(d || ''));
const isPort = (p) => Number.isInteger(Number(p)) && Number(p) > 0 && Number(p) < 65536;
const isProjectName = (n) => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(String(n || ''));
const isRemoteDir = (d) => /^\/[A-Za-z0-9._\/-]+$/.test(String(d || '')) && !String(d).split('/').some((p) => p === '..' || p === '.') &&
  !['/', '/root', '/etc', '/var', '/usr', '/home', '/opt', '/srv', '/var/www', '/bin', '/boot', '/lib'].includes(String(d).replace(/\/+$/, ''));
const isRootDir = (d) => /^\/var\/www\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(String(d || '')) && !String(d).split('/').some((p) => p === '..' || p === '.');

// Project name as docker compose makes it from a folder name.
function projectNameFrom(folder) {
  return path.basename(folder).toLowerCase().replace(/[^a-z0-9_-]+/g, '').replace(/^[^a-z0-9]+/, '') || 'project';
}

// "pc.king.com" -> "king.com"
function baseDomain(d) {
  const parts = String(d).split('.');
  return parts.slice(-2).join('.');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; }
}

// ---------- looking at a project folder ----------
function readCompose(folder) {
  const file = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].map((f) => path.join(folder, f)).find((f) => fs.existsSync(f));
  if (!file) return null;
  let env = {};
  try { env = parseEnv(fs.readFileSync(path.join(folder, '.env'), 'utf8')); } catch (_) { /* no .env */ }
  const compose = parseCompose(fs.readFileSync(file, 'utf8'), env);
  compose.file = path.basename(file);
  return compose;
}

// Which compose service is built from this folder ("./web2" -> web2)
function serviceForFolder(compose, name) {
  if (!compose) return null;
  return compose.services.find((s) => s.build && path.posix.normalize(String(s.build).replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/$/, '') === name) || null;
}

function backendService(compose) {
  if (!compose) return null;
  return compose.services.find((s) => s.name === 'backend') ||
    compose.services.find((s) => s.build && BACKEND_NAMES.includes(String(s.build).replace(/^\.\//, '').replace(/\/$/, ''))) || null;
}

const hostPort = (svc) => (svc && svc.ports.find((p) => Number.isInteger(p.host)) || {}).host || null;

function readPackage(dir) {
  return readJson(path.join(dir, 'package.json'));
}

// Folders that hold a website: a package.json with a build script, a dist/ or a plain index.html.
function websiteFolders(folder, compose) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || DEFAULT_EXCLUDE.includes(e.name) || BACKEND_NAMES.includes(e.name.toLowerCase())) continue;
    const dir = path.join(folder, e.name);
    const pkg = readPackage(dir);
    const hasBuild = !!(pkg && pkg.scripts && pkg.scripts.build);
    const hasDist = fs.existsSync(path.join(dir, 'dist', 'index.html'));
    const hasIndex = fs.existsSync(path.join(dir, 'index.html'));
    if (!hasBuild && !hasDist && !hasIndex) continue;
    // a backend-looking package (no index.html, no dist) is not a website
    if (hasBuild && !hasDist && !hasIndex) continue;
    const svc = serviceForFolder(compose, e.name);
    out.push({ name: e.name, hasBuild, hasDist, hasIndex, hasModules: fs.existsSync(path.join(dir, 'node_modules')), service: svc ? svc.name : null, servicePort: hostPort(svc) });
  }
  return out;
}

function defaultDomain(folderName, main) {
  if (!main) return '';
  const n = folderName.toLowerCase();
  if (['graborders', 'phone', 'mobile', 'web', 'website', 'site', 'frontend', 'client'].includes(n)) return main;
  if (n === 'pc' || n === 'desktop') return `pc.${main}`;
  if (n === 'admin') return `admin.${main}`;
  return `${n.replace(/[^a-z0-9-]/g, '')}.${main}`;
}

// What ServerSnap suggests for a folder; an existing snap.json wins.
function detect(folder) {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`Folder not found: ${folder}`);
  const compose = readCompose(folder);
  const backend = backendService(compose);
  const backendPort = hostPort(backend);
  const sites = websiteFolders(folder, compose);
  const saved = readJson(path.join(folder, CONFIG_FILE));
  const project = projectNameFrom(folder);
  const suggestion = {
    version: 1,
    project,
    remoteDir: `/root/${path.basename(folder)}`,
    docker: !!compose,
    exclude: DEFAULT_EXCLUDE,
    email: '',
    mainDomain: '',
    sites: sites.map((s) => {
      const container = s.service && s.servicePort;
      const isAdmin = s.name.toLowerCase() === 'admin';
      return {
        id: s.name,
        folder: s.name,
        enabled: !isAdmin && !(s.service && !container),
        domain: '',
        www: !['pc', 'admin'].includes(s.name.toLowerCase()),
        kind: container ? 'proxy' : backend ? 'trading' : 'normal',
        backendPort: backendPort || null,
        port: container ? s.servicePort : null,
        build: s.hasBuild && s.hasModules ? 'build' : 'dist',
        root: null,
        ssl: true,
        ws: !!backend && !container && !isAdmin,
        skipDnsCheck: false,
      };
    }),
  };
  return {
    folder,
    saved: !!saved,
    config: saved ? normalize(saved, suggestion) : suggestion,
    suggestion,
    compose: compose ? { file: compose.file, services: compose.services } : null,
    exposed: compose ? exposedDatabases(compose) : [],
    folders: sites,
  };
}

// Fills gaps in a saved snap.json from the suggestion (folders added later appear, switched off).
function normalize(saved, suggestion) {
  const out = { ...suggestion, ...saved };
  const known = new Map((saved.sites || []).map((s) => [s.id || s.folder, s]));
  out.sites = (saved.sites || []).map((s) => ({ ...(suggestion.sites.find((x) => x.id === (s.id || s.folder)) || {}), ...s, id: s.id || s.folder }));
  for (const s of suggestion.sites) if (!known.has(s.id)) out.sites.push({ ...s, enabled: false });
  return out;
}

// Checks a config before saving or deploying; returns a list of problems (empty = fine).
function validate(cfg) {
  const errs = [];
  if (!isProjectName(cfg.project)) errs.push('Project name: small letters, numbers, - and _ only.');
  if (cfg.docker && !isRemoteDir(cfg.remoteDir)) errs.push(`Folder on the server must be a full path like /root/${cfg.project || 'project'} (not / or a system folder).`);
  if (cfg.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.email)) errs.push('The SSL email address does not look right.');
  const domains = new Set();
  for (const s of (cfg.sites || []).filter((x) => x.enabled)) {
    const label = `Website "${s.folder}"`;
    if (!isDomain(s.domain)) { errs.push(`${label}: enter a domain like example.com (small letters, no https://).`); continue; }
    if (domains.has(s.domain)) errs.push(`${label}: ${s.domain} is used twice.`);
    domains.add(s.domain);
    if (!KINDS[s.kind]) errs.push(`${label}: choose the kind of nginx file.`);
    if (s.kind === 'trading' && !isPort(s.backendPort)) errs.push(`${label}: the backend port is missing.`);
    if (s.kind === 'proxy' && !isPort(s.port)) errs.push(`${label}: the container port is missing.`);
    if (s.root && !isRootDir(s.root)) errs.push(`${label}: the website folder must be inside /var/www.`);
  }
  return errs;
}

function save(folder, cfg) {
  const errs = validate(cfg);
  if (errs.length) throw new Error(errs.join(' '));
  const clean = {
    version: 1, project: cfg.project, remoteDir: cfg.remoteDir, docker: !!cfg.docker,
    exclude: (cfg.exclude && cfg.exclude.length ? cfg.exclude : DEFAULT_EXCLUDE).map(String),
    email: cfg.email || '', mainDomain: cfg.mainDomain || '',
    sites: (cfg.sites || []).map((s) => ({
      id: s.id || s.folder, folder: s.folder, enabled: !!s.enabled, domain: String(s.domain || '').trim().toLowerCase(), www: !!s.www,
      kind: s.kind, backendPort: s.backendPort ? Number(s.backendPort) : null, port: s.port ? Number(s.port) : null,
      build: s.build === 'build' ? 'build' : 'dist', root: s.root || null, ssl: s.ssl !== false, ws: !!s.ws, skipDnsCheck: !!s.skipDnsCheck,
    })),
  };
  fs.writeFileSync(path.join(folder, CONFIG_FILE), JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

function load(folder) {
  const cfg = readJson(path.join(folder, CONFIG_FILE));
  if (!cfg) throw new Error(`No ${CONFIG_FILE} in ${folder}. Open "Edit" to set the project up.`);
  return cfg;
}

// ---------- server scripts ----------
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Shared start of every script: markers the app reads, a log on the server, nginx reload.
function preamble(project, logName) {
  return `set -u
R="\${SNAP_ROOT:-}"   # empty on a real server (tests point it at a scratch folder)
STATE="$R"${q(STATE_DIR)}
mkdir -p "$STATE/backups" "$STATE/logs"
LOG="$STATE/logs/${logName}"
exec > >(tee -a "$LOG") 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') ServerSnap Deploy: ${project} ==="
step() { echo "@@STEP $1|$2|\${3:-}"; }
warn() { echo "@@WARN $*"; }
fail() { echo "@@FAIL $*"; exit 1; }
reload_nginx() {
  if command -v systemctl >/dev/null 2>&1 && systemctl cat nginx >/dev/null 2>&1; then
    systemctl is-active --quiet nginx && systemctl reload nginx || systemctl restart nginx
  else
    nginx -s reload 2>/dev/null || nginx
  fi
}
`;
}

// Free / taken ports and the projects already running (read-only).
function inspectScript() {
  return `echo @@LISTEN
(ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null | tail -n +3) | awk '{print $4}' | sed -E 's/.*[:.]([0-9]+)$/\\1/' | sort -un
echo @@CONTAINERS
command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Names}}\t{{.State}}\t{{.Ports}}' 2>/dev/null
echo @@TOOLS
for t in docker nginx certbot curl; do command -v $t >/dev/null 2>&1 && echo "$t=1" || echo "$t=0"; done
docker compose version >/dev/null 2>&1 && echo compose=2 || { command -v docker-compose >/dev/null 2>&1 && echo compose=1 || echo compose=0; }
command -v apt-get >/dev/null 2>&1 && echo apt=1 || echo apt=0
echo @@END
`;
}

function parseInspect(text) {
  const out = { listening: [], containers: [], tools: {} };
  let sec = null;
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    if (line.startsWith('@@')) { sec = line.slice(2).trim(); continue; }
    if (!line.trim()) continue;
    if (sec === 'LISTEN' && /^\d+$/.test(line.trim())) out.listening.push(Number(line.trim()));
    else if (sec === 'CONTAINERS') {
      const [project, workingDir, name, st, ports] = line.split('\t');
      const hostPorts = [...new Set([...String(ports || '').matchAll(/:(\d+)->/g)].map((m) => Number(m[1])))];
      out.containers.push({ project: project || null, workingDir: workingDir || null, name, state: st, ports: hostPorts });
    } else if (sec === 'TOOLS') {
      const [k, v] = line.trim().split('=');
      out.tools[k] = Number(v);
    }
  }
  return out;
}

// Compose projects running on the server: name, folder, containers.
function serverProjects(inspect) {
  const map = new Map();
  for (const c of inspect.containers) {
    if (!c.project) continue;
    const p = map.get(c.project) || { name: c.project, workingDir: c.workingDir, containers: 0, running: 0, ports: [] };
    p.containers++;
    if (c.state === 'running') p.running++;
    p.ports.push(...c.ports);
    map.set(c.project, p);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Ports the project wants that something else on the server already uses.
function portConflicts(compose, project, inspect) {
  const own = new Set(inspect.containers.filter((c) => c.project === project).flatMap((c) => c.ports));
  const listening = new Set(inspect.listening);
  const out = [];
  for (const s of compose.services) {
    for (const p of s.ports) {
      if (!Number.isInteger(p.host) || own.has(p.host) || !listening.has(p.host)) continue;
      const by = inspect.containers.find((c) => c.ports.includes(p.host));
      out.push({ service: s.name, port: p.host, by: by ? (by.project ? `project ${by.project} (${by.name})` : by.name) : 'another program on the server' });
    }
  }
  return out;
}

// docker compose up for the uploaded project.
function upScript(cfg, stamp) {
  return preamble(cfg.project, `${cfg.project}-${stamp}.log`) + `
DIR="$R"${q(cfg.remoteDir)}
P=${q(cfg.project)}
cd "$DIR" || fail "The project folder $DIR is missing on the server."
if docker compose version >/dev/null 2>&1; then DC="docker compose"; elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"; else fail "Docker Compose is not installed on the server."; fi
step docker running "Build and start the containers"
$DC -p "$P" up -d --build 2>&1
rc=$?
[ $rc -eq 0 ] || fail "docker compose up failed (exit $rc). See the lines above."
sleep 5
echo "--- containers ---"
$DC -p "$P" ps 2>&1
total=$(docker ps -a --filter "label=com.docker.compose.project=$P" -q | wc -l)
up=$(docker ps --filter "label=com.docker.compose.project=$P" --filter status=running -q | wc -l)
echo "@@COUNT $up/$total"
[ "$up" -eq "$total" ] || warn "$((total - up)) of $total containers are not running. Check their logs in the Docker tab."
step docker ok "$up of $total containers running"
`;
}

// Where an existing nginx file for this domain keeps its website (to reuse it), and whether HTTPS exists.
function siteInfoScript(domain) {
  return `R="\${SNAP_ROOT:-}"
D=${q(domain)}
for f in "$R"/etc/nginx/sites-enabled/* "$R"/etc/nginx/conf.d/*.conf; do
  [ -f "$f" ] || continue
  if grep -qE "server_name[^;]*[[:space:]]$D([[:space:];]|$)" "$f"; then
    r=$(grep -m1 -E '^[[:space:]]*root[[:space:]]+' "$f" | sed -E 's/^[[:space:]]*root[[:space:]]+([^;]+);.*/\\1/')
    echo "file=$f"; [ -n "$r" ] && echo "root=$r"; break
  fi
done
[ -d "$R/etc/letsencrypt/live/$D" ] && echo cert=1 || echo cert=0
`;
}

function parseKv(text) {
  const out = {};
  for (const line of String(text).split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return out;
}

function namesFor(site) {
  return site.www ? `${site.domain} www.${site.domain}` : site.domain;
}

// The nginx file for one website, ready to write.
function nginxFile(cfg, site, root) {
  return fillTemplate(KINDS[site.kind].body, {
    NAMES: namesFor(site), ROOT: root, BACKEND: `127.0.0.1:${Number(site.backendPort)}`, PORT: Number(site.port), PROJECT: cfg.project,
  });
}

// Writes the nginx file(s), moves the new website files in, tests, HTTPS, checks; puts everything back on failure.
// opts: { root, staged (new files uploaded to ROOT.new), ws (domain or ''), wwwOk, email, stamp }
function siteScript(cfg, site, opts) {
  const D = site.domain;
  const conf = nginxFile(cfg, site, opts.root);
  const wsConf = opts.ws ? fillTemplate(TRADING_WS, { WS: opts.ws, PROJECT: cfg.project }) : '';
  const certDomains = [D, ...(site.www && opts.wwwOk ? [`www.${D}`] : [])].map((d) => `-d ${q(d)}`).join(' ');
  return preamble(cfg.project, `${cfg.project}-${opts.stamp}.log`) + `
D=${q(D)}
ROOT=${opts.root ? `"$R"${q(opts.root)}` : "''"}
STAGED=${opts.staged ? 1 : 0}
WS=${q(opts.ws || '')}
SSL=${site.ssl ? 1 : 0}
STAMP=${q(opts.stamp)}
AVAIL="$R/etc/nginx/sites-available"
ENABLED="$R/etc/nginx/sites-enabled"
BK="$STATE/backups"
MOVED=""      # other files that served this domain and were switched off: "where|backup" lines
SWAPPED=0
NEW_WS=0

# --- tools ---
if ! command -v nginx >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || fail "nginx is not installed and this server has no apt-get to install it."
  step tools running "Install nginx"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx >/dev/null 2>&1 || fail "Could not install nginx."
  step tools ok "nginx installed"
fi
mkdir -p "$AVAIL" "$ENABLED"
grep -rqs 'sites-enabled' "$R/etc/nginx/nginx.conf" || fail "/etc/nginx/nginx.conf does not load sites-enabled. Add: include /etc/nginx/sites-enabled/*;"

restore() {
  echo "!!! Putting the old setup back"
  if [ -f "$BK/$D.$STAMP" ]; then cp "$BK/$D.$STAMP" "$AVAIL/$D"; else rm -f "$AVAIL/$D" "$ENABLED/$D"; fi
  if [ "$NEW_WS" = 1 ]; then rm -f "$AVAIL/$WS" "$ENABLED/$WS"; fi
  printf '%s\\n' "$MOVED" | while IFS='|' read -r where saved; do [ -n "$where" ] && cp -P "$saved" "$where"; done
  if [ "$SWAPPED" = 1 ]; then rm -rf "$ROOT"; [ -d "$ROOT.prev" ] && mv "$ROOT.prev" "$ROOT"; fi
  nginx -t >/dev/null 2>&1 && reload_nginx
}

step nginx running "Write the nginx file"
[ -f "$AVAIL/$D" ] && cp "$AVAIL/$D" "$BK/$D.$STAMP" && echo ">>> Old file kept: $BK/$D.$STAMP"
[ -e "$AVAIL/$D" ] || [ ! -e "$ENABLED/$D" ] || { cp -P "$ENABLED/$D" "$BK/$D.$STAMP"; }

# --- other nginx files that already serve this domain (the "switch" case) ---
for f in "$ENABLED"/* "$R"/etc/nginx/conf.d/*.conf; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in "$D"|"$WS") continue;; esac
  names=$(grep -hE '^[[:space:]]*server_name[[:space:]]' "$f" 2>/dev/null | sed -E 's/^[[:space:]]*server_name[[:space:]]+//; s/;.*//' | tr ' \\t' '\\n\\n' | grep -v '^$' | sort -u)
  printf '%s\\n' "$names" | grep -qxF "$D" || continue
  other=$(printf '%s\\n' "$names" | grep -vxF "$D" | grep -vxF "www.$D" | grep -v '^$' || true)
  [ -z "$other" ] || { restore; fail "$f also serves other domains ($(echo $other)). Move $D out of it by hand first, so nothing else breaks."; }
  saved="$BK/$(basename "$f").$STAMP.off"
  cp -P "$f" "$saved" && rm -f "$f"
  MOVED="$MOVED$f|$saved
"
  echo ">>> $f served $D before: switched it off (kept in $saved)"
done

# --- the nginx file ---
echo ${q(b64(conf))} | base64 -d > "$AVAIL/$D"
ln -sf "$AVAIL/$D" "$ENABLED/$D"
${site.kind === 'trading' ? `# $fwd_proto: exactly one definition for all sites
if ! grep -rqs 'map $http_x_forwarded_proto $fwd_proto' "$R/etc/nginx/"; then
  mkdir -p "$R/etc/nginx/conf.d"
  echo ${q(b64(FWD_PROTO))} | base64 -d > "$R/etc/nginx/conf.d/fwd_proto.conf"
fi` : ''}
if [ -n "$WS" ]; then
  wsfiles=$(grep -Rls "server_name $WS;" "$ENABLED"/ 2>/dev/null || true)
  if [ -n "$wsfiles" ] && printf '%s\\n' "$wsfiles" | xargs grep -qs '/wsr/'; then
    echo ">>> $WS (live prices) is already set up"
  else
    NEW_WS=1
    echo ${q(b64(wsConf))} | base64 -d > "$AVAIL/$WS"
    ln -sf "$AVAIL/$WS" "$ENABLED/$WS"
  fi
fi

# --- the new website files ---
if [ "$STAGED" = 1 ]; then
  [ -f "$ROOT.new/index.html" ] || { restore; fail "The uploaded website has no index.html."; }
  rm -rf "$ROOT.prev"
  [ -d "$ROOT" ] && mv "$ROOT" "$ROOT.prev"
  mv "$ROOT.new" "$ROOT"
  chmod -R a+rX "$ROOT"
  SWAPPED=1
fi

if ! nginx -t 2>&1; then restore; fail "nginx did not accept the new file, so the old setup was put back."; fi
reload_nginx || { restore; fail "nginx could not reload."; }
step nginx ok "$D is served by nginx"

# --- HTTPS ---
PROTO=http
if [ "$SSL" = 1 ]; then
  step ssl running "HTTPS certificate"
  if ! command -v certbot >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx >/dev/null 2>&1 || true
    fi
  fi
  if ! command -v certbot >/dev/null 2>&1; then
    warn "certbot is not installed, so the site works on http:// only."
    step ssl warning "certbot missing"
  elif certbot --nginx --cert-name "$D" ${certDomains} --non-interactive --agree-tos --keep-until-expiring --expand --redirect ${opts.email ? `-m ${q(opts.email)}` : '--register-unsafely-without-email'} 2>&1 | tail -n 15; [ "\${PIPESTATUS[0]}" -eq 0 ]; then
    PROTO=https
    step ssl ok "https://$D"
  else
    warn "certbot could not get a certificate for $D. The site works on http:// for now. Check that the domain points to this server and port 80/443 are open."
    step ssl warning "no certificate yet"
  fi
  if [ "$NEW_WS" = 1 ]; then
    certbot --nginx -d "$WS" --non-interactive --agree-tos --keep-until-expiring --redirect ${opts.email ? `-m ${q(opts.email)}` : '--register-unsafely-without-email'} >/dev/null 2>&1 \\
      && echo ">>> https://$WS ready (live prices)" || warn "No certificate for $WS yet (live prices). Check its DNS record."
  fi
  reload_nginx
fi

# --- does it answer? ---
step check running "Open $PROTO://$D"
if command -v curl >/dev/null 2>&1; then
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 20 --resolve "$D:443:127.0.0.1" --resolve "$D:80:127.0.0.1" "$PROTO://$D/")
  echo ">>> $PROTO://$D/ answered $code"
  case "$code" in
    2*|3*) step check ok "answers $code" ;;
    *) restore; fail "$PROTO://$D/ answered $code instead of the website, so the old setup was put back." ;;
  esac
else
  warn "curl is not installed: skipped the final check."
  step check warning "not checked"
fi
echo "@@DONE $PROTO://$D"
`;
}

// Puts back the website files and nginx file from before the last deploy.
function rollbackScript(cfg, site, root) {
  return preamble(cfg.project, `${cfg.project}-rollback.log`) + `
D=${q(site.domain)}
ROOT=${root ? `"$R"${q(root)}` : "''"}
BK="$STATE/backups"
step rollback running "Put back the previous version of $D"
did=0
if [ -n "$ROOT" ] && [ -d "$ROOT.prev" ]; then
  mv "$ROOT" "$ROOT.rollback" 2>/dev/null; mv "$ROOT.prev" "$ROOT"; [ -d "$ROOT.rollback" ] && mv "$ROOT.rollback" "$ROOT.prev"
  echo ">>> Website files: previous version is back (run again to switch back)"; did=1
fi
last=$(ls -t "$BK/$D."* 2>/dev/null | grep -v '\\.off$' | head -1 || true)
if [ -n "$last" ]; then
  cp "$R/etc/nginx/sites-available/$D" "$BK/$D.undo-$(date +%Y%m%d-%H%M%S).off" 2>/dev/null
  cp "$last" "$R/etc/nginx/sites-available/$D" && rm -f "$last"
  echo ">>> nginx file: put back $last"; did=1
fi
[ "$did" = 1 ] || fail "There is no earlier version of $D to put back."
nginx -t 2>&1 || fail "nginx did not accept the old file. Deploy again to fix it."
reload_nginx
step rollback ok "previous version is live"
echo "@@DONE"
`;
}

// Every website nginx serves on the server, with its certificate end date.
function sitesListScript() {
  return `R="\${SNAP_ROOT:-}"
for f in "$R"/etc/nginx/sites-enabled/* "$R"/etc/nginx/conf.d/*.conf; do
  [ -f "$f" ] || continue
  names=$(grep -hE '^[[:space:]]*server_name[[:space:]]' "$f" | sed -E 's/^[[:space:]]*server_name[[:space:]]+//; s/;.*//' | tr '\\n' ' ')
  root=$(grep -m1 -E '^[[:space:]]*root[[:space:]]' "$f" | sed -E 's/^[[:space:]]*root[[:space:]]+([^;]+);.*/\\1/')
  proxy=$(grep -m1 -E 'proxy_pass[[:space:]]+http://(127\\.0\\.0\\.1|localhost|[0-9.]+):' "$f" | sed -E 's/.*proxy_pass[[:space:]]+([^;]+);.*/\\1/')
  ours=0; grep -q 'Made by ServerSnap Deploy' "$f" && ours=1
  ssl=0; grep -q 'ssl_certificate' "$f" && ssl=1
  printf 'SITE\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$f" "$names" "$root" "$proxy" "$ours" "$ssl"
done
for c in "$R"/etc/letsencrypt/live/*/cert.pem; do
  [ -f "$c" ] || continue
  printf 'CERT\\t%s\\t%s\\n' "$(basename "$(dirname "$c")")" "$(openssl x509 -enddate -noout -in "$c" 2>/dev/null | cut -d= -f2)"
done
`;
}

function parseSites(text) {
  const certs = {};
  const sites = [];
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const p = line.split('\t');
    if (p[0] === 'CERT') certs[p[1]] = p[2] ? new Date(p[2]).toISOString() : null;
    else if (p[0] === 'SITE') {
      const names = p[2].split(/\s+/).filter((n) => n && n !== '_' && !n.startsWith('www.'));
      sites.push({ file: p[1], names, root: p[3] || null, proxy: p[4] || null, ours: p[5] === '1', ssl: p[6] === '1' });
    }
  }
  for (const s of sites) s.certUntil = s.names.map((n) => certs[n]).find(Boolean) || null;
  return sites.filter((s) => s.names.length).sort((a, b) => a.names[0].localeCompare(b.names[0]));
}

// Reads the @@ markers from script output as they arrive.
function markerParser(onMarker, onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      const m = line.match(/^@@(STEP|WARN|FAIL|DONE|COUNT)\s?(.*)$/);
      if (m) onMarker(m[1], m[2]);
      else if (line.trim() && !line.startsWith('===')) onLine(line);
    }
  };
}

module.exports = {
  CONFIG_FILE, STATE_DIR, DEFAULT_EXCLUDE,
  detect, normalize, validate, save, load, readCompose, websiteFolders, defaultDomain, baseDomain, projectNameFrom,
  isDomain, isPort, isRemoteDir, isRootDir, isProjectName,
  inspectScript, parseInspect, serverProjects, portConflicts, upScript,
  siteInfoScript, parseKv, nginxFile, siteScript, rollbackScript, sitesListScript, parseSites, markerParser, namesFor,
};
