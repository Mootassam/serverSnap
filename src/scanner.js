'use strict';
// Looks around a server and lists everything worth backing up:
// Docker Compose projects, Docker volumes, databases and important folders.
const { q, normalizeRemotePath, isInside, dedupePaths } = require('./shell');
const db = require('./db');

// Folders that are usually worth keeping. `on` = ticked by default.
const KNOWN_FOLDERS = [
  { path: '/var/www', reason: 'Websites', on: true },
  { path: '/etc/nginx', reason: 'Nginx settings', on: true },
  { path: '/etc/apache2', reason: 'Apache settings', on: true },
  { path: '/etc/httpd', reason: 'Apache settings', on: true },
  { path: '/etc/caddy', reason: 'Caddy settings', on: true },
  { path: '/etc/letsencrypt', reason: 'SSL certificates', on: true },
  { path: '/var/spool/cron', reason: 'Scheduled jobs (cron)', on: true },
  { path: '/etc/cron.d', reason: 'Scheduled jobs (cron)', on: true },
  { path: '/srv', reason: 'Server data', on: false },
  { path: '/opt', reason: 'Installed apps', on: false },
  { path: '/home', reason: 'User folders', on: false },
  { path: '/root', reason: 'Root user folder', on: false },
];

// Bind-mount sources that are system plumbing, not data.
const SYSTEM_PATHS = ['/proc', '/sys', '/dev', '/run', '/var/run', '/tmp', '/var/lib/docker', '/etc/localtime',
  '/etc/timezone', '/etc/hosts', '/etc/resolv.conf', '/etc/hostname', '/etc/machine-id', '/lib/modules', '/boot',
  '/opt/containerd'];

function isSystemPath(p) {
  return p === '/' || SYSTEM_PATHS.some((s) => isInside(p, s)) || /\.sock$/.test(p);
}

function isAnonymousVolume(name) {
  return /^[0-9a-f]{64}$/.test(name);
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

// Turns `docker inspect` output into compose projects, loose containers and DB candidates.
function analyseContainers(containers) {
  const projects = new Map();
  const loose = [];
  const dbs = [];
  for (const c of containers) {
    const labels = (c.Config && c.Config.Labels) || {};
    const name = String(c.Name || '').replace(/^\//, '');
    const image = (c.Config && c.Config.Image) || '';
    const running = !!(c.State && c.State.Running);
    const mounts = (c.Mounts || []).map((m) => ({ type: m.Type, name: m.Name, source: m.Source, dest: m.Destination }));
    const project = labels['com.docker.compose.project'];
    const service = labels['com.docker.compose.service'];
    const info = { name, image, running, mounts, project: project || null, service: service || null };
    if (project) {
      if (!projects.has(project)) {
        projects.set(project, {
          name: project,
          workingDir: labels['com.docker.compose.project.working_dir'] || null,
          configFiles: String(labels['com.docker.compose.project.config_files'] || '').split(',').map((s) => s.trim()).filter(Boolean),
          services: [],
        });
      }
      projects.get(project).services.push({ name: service, container: name, image, running });
    } else {
      loose.push({ container: name, image, running });
    }
    const kind = db.kindFromImage(image);
    if (kind) dbs.push({ ...info, kind });
  }
  return { projects: [...projects.values()], loose, dbs, containers: containers.map((c) => c) };
}

function parseDu(text) {
  const sizes = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (m) sizes[m[2]] = Number(m[1]);
  }
  return sizes;
}

async function scan(remote, { onStep } = {}) {
  const step = (s) => onStep && onStep(s);
  const warnings = [];
  const asRoot = remote.priv !== 'none';
  const run = (cmd, timeoutMs = 60000) => remote.exec(cmd, { root: asRoot, timeoutMs });

  step('Reading server details');
  const hi = await run('hostname; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s; uname -m; ' +
    'df -Pk / | awk \'NR==2{print $2" "$4}\'; command -v tar gzip >/dev/null 2>&1 && echo tools-ok || echo tools-missing');
  const [hostname, os, arch, disk, tools] = hi.stdout.trim().split('\n');
  const [diskTotalKb, diskFreeKb] = String(disk || '').split(' ').map(Number);
  const host = { hostname, os, arch, diskTotalKb: diskTotalKb || null, diskFreeKb: diskFreeKb || null };
  if (tools !== 'tools-ok') warnings.push('"tar" or "gzip" is missing on this server. Install them first (apt install tar gzip).');
  if (!asRoot) warnings.push('This login has no administrator rights, so some files and all Docker data may be skipped. Use root or a sudo user for a full backup.');

  step('Looking for Docker');
  const dk = await run('command -v docker >/dev/null 2>&1 || { echo none; exit 0; }; ' +
    'docker info --format "{{.ServerVersion}}" 2>/dev/null || echo no-access; ' +
    'docker compose version --short 2>/dev/null || (command -v docker-compose >/dev/null 2>&1 && echo v1) || echo no-compose');
  const dkLines = dk.stdout.trim().split('\n');
  const docker = { installed: dkLines[0] !== 'none', version: null, compose: null };
  if (docker.installed) {
    if (dkLines[0] === 'no-access') warnings.push('Docker is installed but this login cannot use it.');
    else docker.version = dkLines[0];
    docker.compose = dkLines[1] === 'no-compose' ? null : dkLines[1] === 'v1' ? 'v1' : 'v2';
  }

  let projects = [];
  let loose = [];
  let volumes = [];
  const databases = [];
  const folders = [];

  if (docker.version) {
    step('Reading Docker containers');
    const ins = await run('ids=$(docker ps -aq); if [ -n "$ids" ]; then docker inspect $ids; else echo "[]"; fi', 90000);
    const analysed = analyseContainers(safeJson(ins.stdout, []));
    projects = analysed.projects;
    loose = analysed.loose;

    step('Reading Docker volumes');
    const vol = await run('v=$(docker volume ls -q); if [ -n "$v" ]; then docker volume inspect $v; else echo "[]"; fi', 90000);
    const usedBy = new Map();
    for (const c of analysed.containers) {
      for (const m of c.Mounts || []) {
        if (m.Type !== 'volume') continue;
        if (!usedBy.has(m.Name)) usedBy.set(m.Name, []);
        usedBy.get(m.Name).push({ container: String(c.Name).replace(/^\//, ''), dest: m.Destination });
      }
    }
    volumes = safeJson(vol.stdout, []).map((v) => {
      const labels = v.Labels || {};
      const users = usedBy.get(v.Name) || [];
      return {
        name: v.Name,
        mountpoint: v.Mountpoint,
        driver: v.Driver,
        labels,
        project: labels['com.docker.compose.project'] || null,
        usedBy: users.map((u) => u.container),
        anonymous: isAnonymousVolume(v.Name),
        db: null,
        on: users.length > 0 || !!labels['com.docker.compose.project'],
      };
    }).filter((v) => !(v.anonymous && v.usedBy.length === 0));

    step('Checking databases');
    for (const d of analysed.dbs) {
      const dataMount = d.mounts.find((m) => m.type === 'volume' && isInside(m.dest, db.KINDS[d.kind].dataDir));
      let ok = false;
      if (d.running) {
        const tool = { postgres: 'pg_dumpall', mysql: 'mysqldump mariadb-dump', mongo: 'mongodump' }[d.kind];
        const t = await run(`docker exec ${q(d.name)} sh -c ${q(`for t in ${tool}; do command -v $t >/dev/null 2>&1 && exit 0; done; exit 1`)}`, 30000);
        ok = t.code === 0;
      }
      if (!ok && !d.running) warnings.push(`Database container "${d.name}" is stopped, so only its raw files can be copied. Start it for a safe database copy.`);
      if (!ok && d.running) continue; // not really a database server (e.g. a client image)
      const entry = {
        id: `db:docker:${d.name}`,
        kind: d.kind,
        where: 'docker',
        container: d.name,
        image: d.image,
        project: d.project,
        service: d.service,
        volume: dataMount ? dataMount.name : null,
        running: d.running,
        label: `${db.KINDS[d.kind].label} — ${d.name}`,
        on: d.running,
      };
      databases.push(entry);
      const v = volumes.find((x) => x.name === entry.volume);
      if (v) v.db = { kind: d.kind, container: d.name, project: d.project, service: d.service };
    }

    // Compose project folders hold docker-compose.yml, .env and usually the uploads.
    for (const p of projects) {
      if (!p.workingDir) {
        warnings.push(`Docker project "${p.name}": its folder is unknown, so it cannot be started again automatically.`);
        continue;
      }
      folders.push({ path: p.workingDir, reason: `Docker project "${p.name}" (compose file, .env, data)`, on: true });
    }

    // Folders mounted into containers from outside their project folder.
    for (const c of analysed.containers) {
      for (const m of c.Mounts || []) {
        if (m.Type !== 'bind' || !m.Source) continue;
        let src;
        try { src = normalizeRemotePath(m.Source); } catch (_) { continue; }
        if (isSystemPath(src)) continue;
        if (folders.some((f) => isInside(src, f.path))) continue;
        folders.push({ path: src, reason: `Mounted into container "${String(c.Name).replace(/^\//, '')}"`, on: true });
      }
    }

    if (loose.length) {
      warnings.push(`${loose.length} container(s) were started without Docker Compose (${loose.map((l) => l.container).slice(0, 5).join(', ')}${loose.length > 5 ? ', …' : ''}). ` +
        'Their volumes are backed up, but after a restore you need to start them yourself.');
    }
  }

  step('Looking for databases installed on the server');
  for (const [kind, h] of Object.entries(db.HOST)) {
    const r = await run(h.detect, 30000);
    if (r.stdout.trim() === 'yes') {
      databases.push({ id: `db:host:${kind}`, kind, where: 'host', label: h.label, running: true, on: true });
    }
  }

  step('Looking for important folders');
  const exists = await run(KNOWN_FOLDERS.map((f) => `[ -e ${q(f.path)} ] && echo ${q(f.path)}`).join('; ') + '; true');
  const found = new Set(exists.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  for (const f of KNOWN_FOLDERS) {
    if (!found.has(f.path)) continue;
    if (folders.some((x) => x.path === f.path)) continue;
    folders.push({ path: f.path, reason: f.reason, on: f.on });
  }

  step('Measuring sizes');
  const measure = [...new Set([...folders.map((f) => f.path), ...volumes.map((v) => v.mountpoint).filter(Boolean)])];
  if (measure.length) {
    // One du per path: a single du skips folders it already counted, so /root would not include /root/king.
    const loop = `for p in ${measure.map(q).join(' ')}; do du -sk -- "$p"; done`;
    const du = await run(`timeout 120 sh -c ${q(loop)} 2>/dev/null; true`, 150000).catch(() => ({ stdout: '' }));
    const sizes = parseDu(du.stdout);
    for (const f of folders) f.sizeKb = sizes[f.path] ?? null;
    for (const v of volumes) v.sizeKb = sizes[v.mountpoint] ?? null;
  }

  // Ticked folders inside other ticked folders are copied once.
  const tickedRoots = dedupePaths(folders.filter((f) => f.on).map((f) => f.path));
  for (const f of folders) f.coveredBy = f.on && !tickedRoots.includes(f.path) ? tickedRoots.find((r) => isInside(f.path, r)) : null;

  return {
    scannedAt: new Date().toISOString(),
    host,
    priv: remote.priv,
    docker,
    projects,
    volumes,
    databases,
    folders,
    loose,
    warnings,
  };
}

module.exports = { scan, analyseContainers, parseDu, isSystemPath, isAnonymousVolume, KNOWN_FOLDERS };
