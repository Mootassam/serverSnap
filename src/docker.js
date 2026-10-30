'use strict';
// Live Docker dashboard: reads containers, volumes and images in one SSH round trip,
// groups them per Compose project ("customer"), and starts / stops / restarts containers.
const { q, isInside } = require('./shell');
const db = require('./db');

const SECTION = '@@SNAP@@';

// One command that prints everything the dashboard needs (fast: no sizes, no stats).
const OVERVIEW_SCRIPT = [
  `command -v docker >/dev/null 2>&1 || { echo ${SECTION}nodocker; exit 0; }`,
  `V=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || { echo ${SECTION}noaccess; exit 0; }`,
  `echo ${SECTION}version; echo "$V"`,
  `echo ${SECTION}containers; ids=$(docker ps -aq); if [ -n "$ids" ]; then docker inspect $ids; else echo '[]'; fi`,
  `echo ${SECTION}volumes; v=$(docker volume ls -q); if [ -n "$v" ]; then docker volume inspect $v; else echo '[]'; fi`,
  `echo ${SECTION}images; for i in $(docker image ls -q --no-trunc | sort -u); do docker image inspect --format '{{.Id}}{{"\\t"}}{{json .RepoTags}}{{"\\t"}}{{.Size}}{{"\\t"}}{{.Created}}' "$i"; done`,
].join('\n');

// Slower extras: CPU / memory per container, volume sizes, server load.
const USAGE_SCRIPT = [
  `command -v docker >/dev/null 2>&1 || exit 0`,
  `echo ${SECTION}stats; timeout 30 docker stats --no-stream --format '{{json .}}' 2>/dev/null`,
  `echo ${SECTION}sizes; docker volume ls -q | while read -r v; do mp=$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null) || continue; ` +
    `s=$(timeout 60 du -sk -- "$mp" 2>/dev/null | cut -f1); echo "$v $s"; done`,
  `echo ${SECTION}host; cat /proc/loadavg 2>/dev/null; nproc 2>/dev/null; free -k 2>/dev/null | awk '/^Mem:/{print $2" "$3}'; df -Pk / | awk 'NR==2{print $2" "$3" "$4}'`,
].join('\n');

function sections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith(SECTION)) { cur = line.slice(SECTION.length).trim(); out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  return out;
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

// "8082/tcp": [{HostIp, HostPort}, …] -> ["8082→8082/tcp"]; unpublished ports -> "6379/tcp".
function formatPorts(ports) {
  const out = new Set();
  for (const [inner, binds] of Object.entries(ports || {})) {
    if (!binds || !binds.length) { out.add(inner); continue; }
    for (const b of binds) out.add(`${b.HostIp && !['0.0.0.0', '::', ''].includes(b.HostIp) ? b.HostIp + ':' : ''}${b.HostPort}→${inner}`);
  }
  return [...out];
}

// Docker inspect -> what the window shows. Environment variables are left out on purpose (passwords).
function shapeContainer(c) {
  const labels = (c.Config && c.Config.Labels) || {};
  const st = c.State || {};
  const image = (c.Config && c.Config.Image) || '';
  return {
    id: c.Id,
    shortId: String(c.Id || '').slice(0, 12),
    name: String(c.Name || '').replace(/^\//, ''),
    image,
    imageId: c.Image || null,
    project: labels['com.docker.compose.project'] || null,
    service: labels['com.docker.compose.service'] || null,
    workingDir: labels['com.docker.compose.project.working_dir'] || null,
    state: st.Status || (st.Running ? 'running' : 'exited'),
    running: !!st.Running,
    health: st.Health ? st.Health.Status : null,
    exitCode: st.ExitCode ?? null,
    startedAt: st.StartedAt && !st.StartedAt.startsWith('0001') ? st.StartedAt : null,
    finishedAt: st.FinishedAt && !st.FinishedAt.startsWith('0001') ? st.FinishedAt : null,
    createdAt: c.Created || null,
    restartCount: c.RestartCount || 0,
    restartPolicy: (c.HostConfig && c.HostConfig.RestartPolicy && c.HostConfig.RestartPolicy.Name) || 'no',
    command: [].concat((c.Config && c.Config.Entrypoint) || [], (c.Config && c.Config.Cmd) || []).join(' '),
    ports: formatPorts(c.NetworkSettings && c.NetworkSettings.Ports),
    networks: Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {}),
    mounts: (c.Mounts || []).map((m) => ({ type: m.Type, name: m.Name || null, source: m.Source || null, dest: m.Destination })),
    dbKind: db.kindFromImage(image),
  };
}

function shapeImage(line) {
  const [id, tags, size, created] = line.split('\t');
  if (!id || !id.startsWith('sha256:')) return null;
  return { id, shortId: id.slice(7, 19), tags: (safeJson(tags, []) || []).filter((t) => t !== '<none>:<none>'), size: Number(size) || 0, createdAt: created || null };
}

function parseOverview(text) {
  const s = sections(text);
  if ('nodocker' in s) return { docker: { installed: false }, containers: [], volumes: [], images: [] };
  if ('noaccess' in s) return { docker: { installed: true, access: false }, containers: [], volumes: [], images: [] };
  return {
    docker: { installed: true, access: true, version: s.version || null },
    containers: (safeJson(s.containers, []) || []).map(shapeContainer),
    volumes: (safeJson(s.volumes, []) || []).map((v) => ({ name: v.Name, mountpoint: v.Mountpoint, driver: v.Driver, labels: v.Labels || {}, createdAt: v.CreatedAt || null })),
    images: String(s.images || '').split('\n').map(shapeImage).filter(Boolean),
  };
}

function parseUsage(text) {
  const s = sections(text);
  const stats = {};
  for (const line of String(s.stats || '').split('\n')) {
    const j = safeJson(line, null);
    if (j && j.Name) stats[j.Name] = { cpu: j.CPUPerc, mem: j.MemUsage, memPerc: j.MemPerc, net: j.NetIO, disk: j.BlockIO, pids: j.PIDs };
  }
  const sizes = {};
  for (const line of String(s.sizes || '').split('\n')) {
    const m = line.match(/^(\S+) (\d+)$/);
    if (m) sizes[m[1]] = Number(m[2]);
  }
  const h = String(s.host || '').split('\n');
  const load = (h[0] || '').split(' ').slice(0, 3).map(Number);
  const [memTotalKb, memUsedKb] = (h[2] || '').split(' ').map(Number);
  const [diskTotalKb, diskUsedKb, diskFreeKb] = (h[3] || '').split(' ').map(Number);
  return { stats, sizes, host: { load, cpus: Number(h[1]) || null, memTotalKb: memTotalKb || null, memUsedKb: memUsedKb || null, diskTotalKb: diskTotalKb || null, diskUsedKb: diskUsedKb || null, diskFreeKb: diskFreeKb || null } };
}

const isAnonymous = (name) => /^[0-9a-f]{64}$/.test(name);
const isCacheImage = (image) => /(^|\/)(redis|valkey|keydb|memcached)(:|@|$)/i.test(String(image));

// What a volume is for, in plain words: "database", "redis", or its compose name ("upload").
function volumeRole(vol, users) {
  for (const u of users) {
    if (u.container.dbKind && isInside(u.dest, db.KINDS[u.container.dbKind].dataDir)) return { role: 'database', label: 'database', kind: u.container.dbKind };
  }
  if (isAnonymous(vol.name)) return { role: 'anonymous', label: 'unnamed' };
  if (users.some((u) => isCacheImage(u.container.image))) return { role: 'cache', label: 'redis' };
  return { role: 'data', label: vol.labels['com.docker.compose.volume'] || vol.name };
}

const STATE_ORDER = { running: 0, restarting: 1, paused: 2, created: 3, exited: 4, dead: 5 };

// Groups everything per Compose project. Containers started without Compose go to "Other".
function groupOverview(ov, usage) {
  const sizes = (usage && usage.sizes) || {};
  const stats = (usage && usage.stats) || {};
  const users = new Map();
  for (const c of ov.containers) {
    for (const m of c.mounts) {
      if (m.type !== 'volume' || !m.name) continue;
      if (!users.has(m.name)) users.set(m.name, []);
      users.get(m.name).push({ container: c, dest: m.dest });
    }
  }
  const groups = new Map();
  const groupFor = (name) => {
    const key = name || '';
    if (!groups.has(key)) groups.set(key, { name: name || null, title: name || 'Other containers', workingDir: null, containers: [], volumes: [], imageIds: new Set() });
    return groups.get(key);
  };
  for (const c of ov.containers) {
    const g = groupFor(c.project);
    if (c.workingDir && !g.workingDir) g.workingDir = c.workingDir;
    g.containers.push({ ...c, usage: stats[c.name] || null });
    if (c.imageId) g.imageIds.add(c.imageId);
  }
  const unusedVolumes = [];
  for (const v of ov.volumes) {
    const u = users.get(v.name) || [];
    const r = volumeRole(v, u);
    const entry = { ...v, ...r, sizeKb: sizes[v.name] ?? null, usedBy: u.map((x) => x.container.name), mountedAt: u.map((x) => x.dest) };
    const project = v.labels['com.docker.compose.project'] || (u[0] && u[0].container.project) || null;
    if (!project && !u.length) { unusedVolumes.push(entry); continue; }
    groupFor(project).volumes.push(entry);
  }
  const usedImages = new Map();
  for (const c of ov.containers) {
    if (!c.imageId) continue;
    if (!usedImages.has(c.imageId)) usedImages.set(c.imageId, []);
    usedImages.get(c.imageId).push(c.name);
  }
  const images = ov.images.map((i) => ({ ...i, usedBy: usedImages.get(i.id) || [] }));
  const imageById = new Map(images.map((i) => [i.id, i]));
  const out = [...groups.values()].map((g) => {
    g.containers.sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || String(a.service || a.name).localeCompare(String(b.service || b.name)));
    const order = { database: 0, data: 1, cache: 2, anonymous: 3 };
    g.volumes.sort((a, b) => order[a.role] - order[b.role] || a.label.localeCompare(b.label));
    const summary = g.volumes.filter((v) => v.role !== 'anonymous').map((v) => ({ label: v.label, sizeKb: v.sizeKb, role: v.role }));
    const imgs = [...g.imageIds].map((id) => imageById.get(id)).filter(Boolean);
    const { imageIds, ...rest } = g;
    return {
      ...rest,
      images: imgs,
      summary,
      running: g.containers.filter((c) => c.running).length,
      total: g.containers.length,
      storageKb: g.volumes.reduce((s, v) => s + (v.sizeKb || 0), 0),
      databases: g.containers.filter((c) => c.dbKind).map((c) => ({ container: c.name, service: c.service, kind: c.dbKind, running: c.running })),
    };
  });
  out.sort((a, b) => (a.name === null) - (b.name === null) || String(a.title).localeCompare(String(b.title)));
  return {
    docker: ov.docker,
    groups: out,
    images: images.sort((a, b) => (b.usedBy.length > 0) - (a.usedBy.length > 0) || b.size - a.size),
    unusedVolumes,
    host: (usage && usage.host) || null,
  };
}

const ID_RE = /^[0-9a-f]{12,64}$/;
const ACTIONS = ['start', 'stop', 'restart'];

function checkIds(ids) {
  if (!ids.length) throw new Error('No containers to act on.');
  for (const id of ids) if (!ID_RE.test(id)) throw new Error(`Not a container id: ${id}`);
}

// Databases start first and stop last, so the apps never lose their database mid-request.
function actionCommand(action, containers) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action: ${action}`);
  checkIds(containers.map((c) => c.id));
  const dbs = containers.filter((c) => c.dbKind || isCacheImage(c.image));
  const apps = containers.filter((c) => !dbs.includes(c));
  const ids = (list) => list.map((c) => q(c.id)).join(' ');
  const stop = [apps, dbs].filter((l) => l.length).map((l) => `docker stop -t 20 ${ids(l)} >/dev/null`);
  const start = [dbs, apps].filter((l) => l.length).map((l) => `docker start ${ids(l)} >/dev/null`);
  if (action === 'stop') return stop.join(' && ');
  if (action === 'start') return start.join(' && ');
  return [...stop, ...start].join(' && ');
}

const VOLUME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const IMAGE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;

// Deletes containers (running ones are stopped first). With project: also the project's own
// Docker networks. Volumes (the data) are never touched here.
function removeContainersCommand(containers, { project = null } = {}) {
  checkIds(containers.map((c) => c.id));
  const parts = [`docker rm -f ${containers.map((c) => q(c.id)).join(' ')} >/dev/null`];
  if (project) {
    if (!PROJECT_RE.test(project)) throw new Error(`Not a project name: ${project}`);
    parts.push(`for n in $(docker network ls -q --filter ${q('label=com.docker.compose.project=' + project)}); do docker network rm "$n" >/dev/null 2>&1; done; true`);
  }
  return parts.join(' && ');
}

// Named volumes used only by these containers (safe to delete together with them).
function volumesOnlyUsedBy(containers, allContainers) {
  const ids = new Set(containers.map((c) => c.id));
  const mine = new Set(containers.flatMap((c) => c.mounts.filter((m) => m.type === 'volume' && m.name).map((m) => m.name)));
  for (const c of allContainers) {
    if (ids.has(c.id)) continue;
    for (const m of c.mounts) if (m.type === 'volume') mine.delete(m.name);
  }
  return [...mine];
}

// One image: by its names (so an image with several tags goes completely), or by id when it has none.
// No -f: Docker refuses when a container still uses it.
function removeImageCommand(image) {
  if (!IMAGE_ID_RE.test(image.id)) throw new Error(`Not an image id: ${image.id}`);
  for (const t of image.tags) if (!IMAGE_TAG_RE.test(t)) throw new Error(`Not an image name: ${t}`);
  return `docker rmi ${(image.tags.length ? image.tags : [image.id]).map(q).join(' ')} >/dev/null`;
}

// No -f: Docker refuses when a container still uses the volume.
function removeVolumeCommand(name) {
  if (!VOLUME_RE.test(name)) throw new Error(`Not a volume name: ${name}`);
  return `docker volume rm ${q(name)} >/dev/null`;
}

function logsCommand(id, lines = 300) {
  checkIds([id]);
  const n = Math.max(10, Math.min(5000, Number(lines) || 300));
  return `docker logs --tail ${n} --timestamps ${q(id)} 2>&1 | tail -c 1000000`;
}

async function overview(remote) {
  const r = await remote.exec(OVERVIEW_SCRIPT, { root: remote.priv !== 'none', timeoutMs: 60000 });
  return parseOverview(r.stdout);
}

async function usage(remote) {
  const r = await remote.exec(USAGE_SCRIPT, { root: remote.priv !== 'none', timeoutMs: 120000 });
  return parseUsage(r.stdout);
}

module.exports = {
  OVERVIEW_SCRIPT, USAGE_SCRIPT, ACTIONS,
  sections, parseOverview, parseUsage, shapeContainer, formatPorts, volumeRole, groupOverview,
  actionCommand, logsCommand, overview, usage, isCacheImage,
  removeContainersCommand, removeImageCommand, removeVolumeCommand, volumesOnlyUsedBy,
};
