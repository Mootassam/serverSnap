'use strict';
// Deploy helpers that make a deploy fast and safe:
//   - fast upload: only the files that differ from the server copy go up (sha1 compare)
//   - checks before the server is touched (disk space, memory)
//   - cleanup after a good deploy (old Docker images, keeping the previous one for going back)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { q } = require('./shell');
const local = require('./deploy-local');

// A server path as a shell word (SNAP_ROOT is empty on real servers; tests set it).
const rp = (p) => '"${SNAP_ROOT:-}"' + q(p);

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// Every file under dir (relative "a/b.js" paths) with its sha1.
// exclude: names skipped at any depth ("node_modules") or from the top only ("./web").
async function manifest(dir, exclude = []) {
  const anywhere = new Set(exclude.filter((x) => !x.startsWith('./')));
  const top = new Set(exclude.filter((x) => x.startsWith('./')).map((x) => x.slice(2).replace(/\/+$/, '')));
  const files = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (anywhere.has(e.name) || (!rel && top.has(e.name))) continue;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile()) files.push(r);
    }
  };
  walk(dir, '');
  const out = new Map();
  // a few files at a time: fast on an SSD, gentle on a slow laptop
  for (let i = 0; i < files.length; i += 16) {
    const part = files.slice(i, i + 16);
    const sums = await Promise.all(part.map((f) => sha1File(path.join(dir, f))));
    part.forEach((f, k) => out.set(f, sums[k]));
  }
  return out;
}

// "sha1sum" output -> Map(path -> sha1). Escaped names (backslash/newline) are left out, so they count as changed.
function parseSums(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{40}) [ *](?:\.\/)?(.+)$/.exec(line.replace(/\r$/, ''));
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

// What has to go up, and (for a mirrored folder) what has to go away.
function diff(localMap, remoteMap, mirror) {
  const changed = [...localMap.keys()].filter((f) => remoteMap.get(f) !== localMap.get(f)).sort();
  const extra = mirror ? [...remoteMap.keys()].filter((f) => !localMap.has(f)).sort() : [];
  return { changed, extra, same: localMap.size - changed.length };
}

// Shell that prints the sha1 of the given files (null-separated on stdin), from inside dir.
function sumsCommand(dir) {
  return `cd ${rp(dir)} 2>/dev/null || exit 0; xargs -0 -r sha1sum -- 2>/dev/null; exit 0`;
}
// Shell that prints the sha1 of every file under dir.
function allSumsCommand(dir) {
  return `cd ${rp(dir)} 2>/dev/null || exit 0; find . -type f -print0 | xargs -0 -r sha1sum -- 2>/dev/null; exit 0`;
}

// Packs only the listed files (relative paths) into a .tar.gz. Returns its path.
async function packList(dir, list, { signal, name = 'snap' } = {}) {
  const stamp = `${process.pid}-${Date.now()}`;
  const listFile = path.join(os.tmpdir(), `serversnap-${name}-${stamp}.list`);
  const out = path.join(os.tmpdir(), `serversnap-${name}-${stamp}.tar.gz`);
  fs.writeFileSync(listFile, list.join('\n') + '\n');
  try {
    await local.run(local.tarBin(), ['-czf', out, '-C', dir, '-T', listFile], { signal });
  } finally {
    fs.rm(listFile, { force: true }, () => {});
  }
  return out;
}

/**
 * Sends a local folder to the server, but only what changed.
 *   mirror=false (the project folder): files are added or replaced, nothing on the server is removed
 *     (data folders such as uploads/ live only on the server).
 *   mirror=true (a website): stageDir becomes an exact copy of localDir, starting from the live
 *     copy liveDir so unchanged files (images, the APK…) do not travel again.
 * Returns { sent, removed, same, bytes, full }.
 */
async function syncDir(remote, localDir, target, { exclude = [], mirror = false, liveDir = null, full = false, say = () => {}, onBytes, signal, name } = {}) {
  const mine = await manifest(localDir, exclude);
  if (mirror) {
    // start the new folder from the live one (or empty)
    const seed = liveDir && !full ? `if [ -d ${rp(liveDir)} ]; then cp -a ${rp(liveDir)} ${rp(target)}; else mkdir -p ${rp(target)}; fi`
      : `mkdir -p ${rp(target)}`;
    await remote.run(`rm -rf ${rp(target)} && ${seed}`, { root: true, timeoutMs: 10 * 60 * 1000, signal });
  } else {
    await remote.run(`mkdir -p ${rp(target)}`, { root: true, timeoutMs: 60000, signal });
  }
  let theirs = new Map();
  if (!full) {
    theirs = parseSums(mirror
      ? await remote.run(allSumsCommand(target), { root: true, timeoutMs: 10 * 60 * 1000, signal })
      : await remote.run(sumsCommand(target), { root: true, stdin: [...mine.keys()].join('\0'), timeoutMs: 10 * 60 * 1000, signal }));
  }
  const d = diff(mine, theirs, mirror);
  let bytes = 0;
  if (d.changed.length) {
    const file = await packList(localDir, d.changed, { signal, name });
    try {
      bytes = fs.statSync(file).size;
      say(`Sending ${d.changed.length} changed file${d.changed.length === 1 ? '' : 's'} (${(bytes / 1048576).toFixed(1)} MB)${d.same ? `, ${d.same} unchanged stay on the server` : ''}…`);
      await remote.upload(`tar -xzf - -C ${rp(target)} --no-same-owner`, file, { root: true, signal, onBytes: onBytes ? (b) => onBytes(b, bytes) : undefined });
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
  } else {
    say(`Nothing changed in ${path.basename(localDir)} since the copy on the server (${d.same} files).`);
  }
  if (d.extra.length) {
    await remote.run(`cd ${rp(target)} && xargs -0 -r rm -f -- && find . -mindepth 1 -type d -empty -delete; true`, { root: true, stdin: d.extra.join('\0'), timeoutMs: 5 * 60 * 1000, signal });
  }
  return { sent: d.changed.length, removed: d.extra.length, same: d.same, bytes, full: full || !theirs.size };
}

// ---------- checks before the server is touched ----------
const GB = 1024 * 1024;
// Free space where the project goes and where Docker keeps images, plus memory.
function checksScript(remoteDir) {
  const dir = remoteDir ? rp(remoteDir) : '"${SNAP_ROOT:-}/"';
  return `free_kb() { d="$1"; while [ ! -e "$d" ] && [ "$d" != "/" ] && [ -n "$d" ]; do d=$(dirname "$d"); done; df -Pk "$d" 2>/dev/null | awk 'NR==2 {print $4}'; }
echo "project=$(free_kb ${dir})"
if [ -d /var/lib/docker ]; then echo "docker=$(free_kb /var/lib/docker)"; fi
echo "web=$(free_kb "\${SNAP_ROOT:-}/var/www")"
awk '/^MemAvailable:/ {print "mem=" $2} /^MemTotal:/ {print "memtotal=" $2}' /proc/meminfo 2>/dev/null
`;
}

function parseChecks(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^(\w+)=(\d+)\s*$/.exec(line.trim());
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

// -> { fails: [], warns: [] } in plain words. needDocker: the deploy builds images.
function judgeChecks(c, { needDocker }) {
  const fails = [];
  const warns = [];
  const free = [c.project, needDocker ? c.docker : null].filter((n) => Number.isFinite(n));
  const min = free.length ? Math.min(...free) : null;
  if (min != null) {
    const gb = (min / GB).toFixed(1);
    if (min < 1 * GB) fails.push(`The server disk is almost full (${gb} GB free). Free some space first (Docker tab: delete unused images and volumes), then deploy again.`);
    else if (min < 3 * GB) warns.push(`The server disk has only ${gb} GB free. The deploy should work, but clean up soon.`);
  }
  if (Number.isFinite(c.mem) && c.mem < 150 * 1024) {
    warns.push(`The server has only ${Math.round(c.mem / 1024)} MB of free memory. Building can be slow or fail; a swap file helps (Server setup).`);
  }
  return { fails, warns };
}

// ---------- after a deploy ----------
// Before "up --build": the images this project builds get a second name, so the previous
// version stays on the server (one step back) while older ones can be cleaned up.
function keepPreviousScript(project) {
  return `for img in $(docker ps -a --filter ${q('label=com.docker.compose.project=' + project)} --format '{{.Image}}' 2>/dev/null | sort -u); do
  case "$img" in ${q(project + '-')}*|${q(project + '_')}*) docker tag "$img" "\${img%%:*}:serversnap-prev" >/dev/null 2>&1 && echo "kept $img";; esac
done; true`;
}

// Removes images nothing uses any more (untagged leftovers) and old build cache.
function cleanupScript() {
  return `set -u
echo "@@BEFORE $(docker system df --format '{{.Type}}={{.Size}}' 2>/dev/null | tr '\\n' ' ')"
docker image prune -f 2>&1 | tail -n 1
docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
echo "@@AFTER $(docker system df --format '{{.Type}}={{.Size}}' 2>/dev/null | tr '\\n' ' ')"
true`;
}

// "Total reclaimed space: 1.2GB" -> "1.2 GB"
function freedText(out) {
  const m = /reclaimed space:\s*([\d.]+\s*[kKMGT]?B)/.exec(String(out));
  return m && !/^0\s*B$/.test(m[1]) ? m[1].replace(/([\d.])([kKMGT]?B)/, '$1 $2') : null;
}

module.exports = {
  manifest, parseSums, diff, sumsCommand, allSumsCommand, packList, syncDir,
  checksScript, parseChecks, judgeChecks, keepPreviousScript, cleanupScript, freedText, GB,
};
