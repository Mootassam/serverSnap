'use strict';
// Edit a project's .env files on the server from the app: a backup is kept, comments and order
// stay, and only the containers that read the file are restarted (or rebuilt).
const path = require('path');
const { q } = require('./shell');

const rp = (p) => '"${SNAP_ROOT:-}"' + q(p);
const REL_RE = /^(?:[A-Za-z0-9._-]+\/){0,3}\.env(?:\.[A-Za-z0-9_-]+)?$/;
const SECRET_RE = /PASS|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL|AUTH/i;

function checkRel(rel) {
  if (!REL_RE.test(String(rel || '')) || String(rel).split('/').includes('..')) throw new Error(`"${rel}" is not a .env file inside the project.`);
  return rel;
}

// .env files of the project on the server (not in node_modules), as "size<TAB>mtime<TAB>rel".
function listScript(remoteDir) {
  return `cd ${rp(remoteDir)} 2>/dev/null || { echo "@@MISSING"; exit 0; }
find . -maxdepth 4 \\( -name node_modules -o -name .git \\) -prune -o -type f \\( -name '.env' -o -name '.env.*' \\) -print 2>/dev/null | sed 's#^\\./##' | sort | while read -r f; do
  case "$f" in *.serversnap-*|*.example|*.sample|*.bak) continue;; esac
  printf '%s\\t%s\\t%s\\n' "$(stat -c %s "$f" 2>/dev/null || echo 0)" "$(stat -c %Y "$f" 2>/dev/null || echo 0)" "$f"
done`;
}

function parseList(text) {
  if (/@@MISSING/.test(text)) return null;
  return String(text).replace(/\r/g, '').split('\n').filter(Boolean).map((l) => {
    const [size, mtime, rel] = l.split('\t');
    return { rel, size: Number(size) || 0, mtime: Number(mtime) ? new Date(Number(mtime) * 1000).toISOString() : null };
  }).filter((f) => REL_RE.test(f.rel));
}

function readCommand(remoteDir, rel) {
  return `base64 < ${rp(`${remoteDir}/${checkRel(rel)}`)} | tr -d '\\n'`;
}

// Writes the new text; the old file stays next to it as <file>.serversnap-<stamp> (last 5 kept).
function writeScript(remoteDir, rel, text, stamp) {
  const file = rp(`${remoteDir}/${checkRel(rel)}`);
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `set -e
F=${file}
[ -f "$F" ] && cp -p "$F" "$F.serversnap-${stamp}"
if [ -f "$F" ]; then cp -p "$F" "$F.new"; fi
echo ${q(b64)} | base64 -d > "$F.new"
mv "$F.new" "$F"
ls -1t "$F".serversnap-* 2>/dev/null | tail -n +6 | xargs -r rm -f
echo saved`;
}

// ---------- keeping the file as it was, except the values that changed ----------
// "KEY=value", "export KEY=value", quoted values; everything else is kept as it is.
function parseLines(text) {
  return String(text).replace(/\r\n/g, '\n').split('\n').map((raw) => {
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/.exec(raw);
    if (!m) return { type: 'other', raw };
    let value = m[4];
    let quote = '';
    const qm = /^(["'])(.*)\1\s*(#.*)?$/.exec(value);
    if (qm) { quote = qm[1]; value = qm[2]; } else value = value.replace(/\s+#.*$/, '').trim();
    return { type: 'kv', key: m[2], value, quote, raw, prefix: m[1], eq: m[3] };
  });
}

// For the editor: [{ key, value, secret }] in file order.
function entries(text) {
  return parseLines(text).filter((l) => l.type === 'kv').map((l) => ({ key: l.key, value: l.value, secret: SECRET_RE.test(l.key) }));
}

const needsQuotes = (v) => /[\s#"'$`\\]/.test(v);
function format(prefix, key, eq, value, quote) {
  if (!quote && needsQuotes(value)) quote = value.includes('"') ? "'" : '"';
  return `${prefix || ''}${key}${eq || '='}${quote}${value}${quote}`;
}

// rows: the full list from the editor [{ key, value }]. Changed values are replaced in place,
// removed keys are dropped, new keys go at the end. Comments and blank lines stay.
function rebuild(text, rows) {
  const want = new Map();
  for (const r of rows) {
    const k = String(r.key || '').trim();
    if (!k) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) throw new Error(`"${k}" is not a valid name (letters, numbers and _ only).`);
    if (/[\r\n]/.test(String(r.value))) throw new Error(`${k}: the value must be on one line.`);
    want.set(k, String(r.value ?? ''));
  }
  const seen = new Set();
  const out = [];
  for (const l of parseLines(text)) {
    if (l.type !== 'kv') { out.push(l.raw); continue; }
    if (!want.has(l.key) || seen.has(l.key)) continue;
    seen.add(l.key);
    const v = want.get(l.key);
    out.push(v === l.value ? l.raw : format(l.prefix, l.key, l.eq, v, l.quote));
  }
  const added = [...want.keys()].filter((k) => !seen.has(k));
  if (added.length) {
    while (out.length && out[out.length - 1] === '') out.pop();
    for (const k of added) out.push(format('', k, '=', want.get(k), ''));
  }
  let s = out.join('\n');
  if (!s.endsWith('\n')) s += '\n';
  return s;
}

// Which containers read the file, and how to make them see the change.
//   .env next to docker-compose.yml → compose fills ${VARS} from it: recreate every service
//   env_file: pointing to it        → recreate that service
//   inside a build folder           → probably copied into the image: rebuild that service
function affected(compose, composeText, rel) {
  checkRel(rel);
  const dir = path.posix.dirname(rel);
  const out = [];
  if (rel === '.env') return (compose.services || []).map((s) => ({ service: s.name, rebuild: false, why: 'docker-compose.yml reads .env' }));
  const envFiles = envFileMap(composeText);
  for (const s of compose.services || []) {
    const files = (envFiles[s.name] || []).map((f) => f.replace(/^\.\//, ''));
    const ctx = s.build ? s.build.replace(/^\.\//, '').replace(/\/$/, '') : null;
    if (files.includes(rel)) out.push({ service: s.name, rebuild: false, why: `env_file: ${rel}` });
    else if (ctx && (dir === ctx || dir.startsWith(ctx + '/'))) out.push({ service: s.name, rebuild: true, why: `${rel} is in its build folder ${ctx}` });
  }
  return out;
}

// env_file entries per service, read straight from the compose text.
function envFileMap(text) {
  const map = {};
  let svc = null;
  let inServices = false;
  let inEnvFile = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^\S/.test(line)) { inServices = /^services:/.test(line); svc = null; continue; }
    if (!inServices) continue;
    const s = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (s) { svc = s[1]; inEnvFile = false; continue; }
    if (!svc) continue;
    const one = /^\s{4}env_file:\s*(\S.*)?$/.exec(line);
    if (one) {
      inEnvFile = !one[1];
      if (one[1]) {
        const v = one[1].trim();
        const list = v.startsWith('[') ? v.slice(1, -1).split(',') : [v];
        for (const x of list) if (x.trim()) (map[svc] = map[svc] || []).push(x.trim().replace(/^["']|["']$/g, ''));
      }
      continue;
    }
    if (inEnvFile) {
      const item = /^\s{4,}-\s*(?:path:\s*)?(\S+)/.exec(line);
      if (item) { (map[svc] = map[svc] || []).push(item[1].replace(/^["']|["']$/g, '')); continue; }
      if (/^\s{4}\S/.test(line)) inEnvFile = false;
    }
  }
  return map;
}

// Restart (recreate) or rebuild the chosen services so they read the new values.
function applyScript(cfg, services, rebuild) {
  const names = services.filter((s) => /^[A-Za-z0-9_.-]+$/.test(s));
  if (!names.length) return null;
  return `cd ${rp(cfg.remoteDir)} || { echo "@@FAIL The project folder is missing on the server."; exit 1; }
if docker compose version >/dev/null 2>&1; then DC="docker compose"; elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"; else echo "@@FAIL Docker Compose is missing"; exit 1; fi
echo "@@STEP apply|running|${rebuild ? 'rebuilding' : 'restarting'} ${names.join(', ')}"
$DC -p ${q(cfg.project)} up -d ${rebuild ? '--build ' : ''}--force-recreate --no-deps ${names.map(q).join(' ')} 2>&1 || { echo "@@FAIL docker compose up failed"; exit 1; }
echo "@@STEP apply|ok|${names.join(', ')}"`;
}

module.exports = { listScript, parseList, readCommand, writeScript, parseLines, entries, rebuild, affected, envFileMap, applyScript, checkRel, SECRET_RE };
