'use strict';
// New client from a template: copies a project folder (King, SHUBH, …) to a new folder and makes
// it a separate client — new domain, new brand name, new free ports, new server IP, new Redis /
// JWT passwords, databases closed to the internet — then writes its snap.json so it can be
// deployed. The template folder itself is never changed.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const deploy = require('./deploy');
const { parseCompose, parseEnv } = require('./compose');
const { remapPorts, lockDatabases } = require('./compose-edit');

const SKIP_DIRS = new Set(['node_modules', '.git', '.serversnap-backup', '.claude', '.vscode', '.idea', '.next', '.cache', '.turbo', 'coverage']);
const BUILD_DIRS = new Set(['dist', 'build']); // skipped when next to a package.json: they hold the old domain, rebuilt on deploy
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']); // copied as they are
const MAX_TEXT = 4 * 1024 * 1024;
const SECRET_KEYS = /^(REDIS_PASSWORD|AUTH_JWT_SECRET|JWT_SECRET|SESSION_SECRET|COOKIE_SECRET|APP_SECRET)$/;
const PUBLIC_DNS = new Set(['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112', '208.67.222.222']);
const PRIVATE_IP =/^(127\.|10\.|0\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|255\.|169\.254\.)/;

const randomSecret = (n = 20) => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return [...crypto.randomBytes(n)].map((b) => abc[b % abc.length]).join('');
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every file to copy: { rel, abs, size }. Folders we skip are listed in `skipped`.
async function walk(root) {
  const files = [];
  const skipped = [];
  async function go(dir, rel) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    const hasPkg = entries.some((e) => e.isFile() && e.name === 'package.json');
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (hasPkg && BUILD_DIRS.has(e.name))) { skipped.push(r); continue; }
        await go(abs, r);
      } else if (e.isFile()) {
        if (!rel && e.name === 'snap.json') continue; // a new one is written
        if (SKIP_FILES.has(e.name)) { files.push({ rel: r, abs, size: 0, keep: true }); continue; }
        const st = await fsp.stat(abs);
        files.push({ rel: r, abs, size: st.size });
      }
    }
  }
  await go(root, '');
  return { files, skipped };
}

async function readText(abs, size) {
  if (size > MAX_TEXT) return null;
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

// "kingtrade" -> pairs for kingtrade / Kingtrade / KINGTRADE
function casePairs(from, to) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const out = [[from.toLowerCase(), to.toLowerCase()], [cap(from.toLowerCase()), cap(to.toLowerCase())], [from.toUpperCase(), to.toUpperCase()]];
  return out.filter(([a], i) => out.findIndex(([b]) => b === a) === i);
}

// The template's main domain: snap.json, else a file or folder in the project named like a domain.
function guessDomain(folder) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(folder, deploy.CONFIG_FILE), 'utf8'));
    const d = cfg.mainDomain || ((cfg.sites || []).find((s) => s.domain) || {}).domain;
    if (d) return deploy.baseDomain(d);
  } catch (_) { /* no snap.json */ }
  try {
    const names = fs.readdirSync(folder).filter((n) => deploy.isDomain(n.toLowerCase()) && !/\.(json|ya?ml|md|txt|sh|js|ts|conf|bak|log|env)$/i.test(n));
    if (names.length) return deploy.baseDomain(names.sort((a, b) => a.length - b.length)[0].toLowerCase());
  } catch (_) { /* unreadable */ }
  return '';
}

function readComposeRaw(folder) {
  const file = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find((f) => fs.existsSync(path.join(folder, f)));
  if (!file) return null;
  let env = {};
  try { env = parseEnv(fs.readFileSync(path.join(folder, '.env'), 'utf8')); } catch (_) { /* none */ }
  const text = fs.readFileSync(path.join(folder, file), 'utf8');
  return { file, text, env, parsed: parseCompose(text, env) };
}

// Next free port above `from` that nobody uses.
function freePort(from, taken) {
  let p = Number(from) + 1;
  while (taken.has(p) && p < 65535) p++;
  taken.add(p);
  return p;
}

// What would change. input: { source, target, newDomain, oldDomain?, newBrand?, serverIp?, taken: [ports] }
async function plan(input) {
  const source = path.resolve(input.source);
  if (!fs.existsSync(path.join(source))) throw new Error(`Folder not found: ${source}`);
  const target = path.resolve(input.target);
  if (path.resolve(target) === source || target.startsWith(source + path.sep)) throw new Error('The new folder must be outside the template folder.');
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`${target} already exists and is not empty. Choose a new folder name.`);
  const newDomain = String(input.newDomain || '').trim().toLowerCase();
  if (!deploy.isDomain(newDomain)) throw new Error('Enter the new client\'s domain, like newclient.com');
  const oldDomain = String(input.oldDomain || guessDomain(source)).trim().toLowerCase();
  const oldBrand = oldDomain ? oldDomain.split('.')[0] : '';
  const newBrand = input.newBrand != null ? String(input.newBrand).trim() : newDomain.split('.')[0];

  const compose = readComposeRaw(source);
  const taken = new Set((input.taken || []).map(Number));
  if (compose) for (const s of compose.parsed.services) for (const p of s.ports) if (Number.isInteger(p.host)) taken.add(p.host);
  const ports = [];
  if (compose) {
    for (const s of compose.parsed.services) {
      for (const p of s.ports) {
        if (!Number.isInteger(p.host)) continue;
        ports.push({ service: s.name, container: p.container, from: p.host, to: freePort(p.host, taken) });
      }
    }
  }

  const { files, skipped } = await walk(source);
  // secrets and IPs found in the text files
  const secrets = new Map();
  const ips = new Map();
  const texts = [];
  for (const f of files) {
    if (f.keep) continue;
    const text = await readText(f.abs, f.size);
    if (text == null) continue;
    texts.push({ rel: f.rel, text });
    if (/(^|\/)\.env(\.|$)/.test(f.rel) || /(^|\/)\.env$/.test(f.rel)) {
      for (const [k, v] of Object.entries(parseEnv(text))) if (SECRET_KEYS.test(k) && v && v.length >= 8 && !v.includes('${')) secrets.set(v, k);
    }
    if (/(^|\/)(docker-)?compose\.ya?ml$/.test(f.rel)) {
      for (const m of text.matchAll(/--requirepass\s+([^\s"'$]{8,})/g)) secrets.set(m[1], 'Redis password');
    }
    for (const m of text.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g)) {
      const ip = m[1];
      if (PRIVATE_IP.test(ip) || PUBLIC_DNS.has(ip) || ip.split('.').some((x) => Number(x) > 255) || /^\d+\.\d+\.\d+\.0$/.test(ip)) continue;
      // version numbers like 1.2.3.4 next to letters are not addresses
      const after = text.slice(m.index + ip.length, m.index + ip.length + 2);
      if (/[\w.]/.test(text[m.index - 1] || '') || /^\w/.test(after) || /^\.\d/.test(after)) continue;
      const seen = ips.get(ip) || { n: 0, withPort: false };
      seen.n++;
      if (/^:\d/.test(after)) seen.withPort = true; // "ip:8082" = a server address
      ips.set(ip, seen);
    }
  }

  // the replace list, in the order it is applied
  const pairs = [];
  for (const [value, key] of secrets) pairs.push({ kind: 'secret', label: `New ${key}`, from: value, to: randomSecret(), on: true, hidden: true });
  const serverIp = String(input.serverIp || '').trim();
  for (const [ip, seen] of ips) {
    const toIp = serverIp && /^\d+\.\d+\.\d+\.\d+$/.test(serverIp) ? serverIp : ip;
    for (const p of ports) if (p.to !== p.from) pairs.push({ kind: 'ipport', label: `Address of ${p.service}`, from: `${ip}:${p.from}`, to: `${toIp}:${p.to}`, on: true });
    if (toIp !== ip) pairs.push({ kind: 'ip', label: seen.withPort ? 'Server IP' : 'IP address', from: ip, to: toIp, on: seen.withPort });
  }
  if (oldDomain && oldDomain !== newDomain) pairs.push({ kind: 'domain', label: 'Domain', from: oldDomain, to: newDomain, on: true });
  if (oldBrand && newBrand && oldBrand.length >= 4 && oldBrand !== newBrand.toLowerCase()) {
    for (const [a, b] of casePairs(oldBrand, newBrand)) pairs.push({ kind: 'brand', label: 'Brand name', from: a, to: b, on: true });
  }
  for (const x of input.extra || []) if (x && x.from && x.from !== x.to) pairs.push({ kind: 'extra', label: 'Your change', from: String(x.from), to: String(x.to || ''), on: true });

  // how often each pair hits, with a few example lines
  for (const p of pairs) {
    p.count = 0; p.files = 0; p.examples = [];
    const re = new RegExp(escapeRe(p.from), 'g');
    for (const t of texts) {
      const n = (t.text.match(re) || []).length;
      if (!n) continue;
      p.count += n; p.files++;
      if (p.examples.length < 3 && !p.hidden) {
        const line = t.text.split(/\r?\n/).find((l) => l.includes(p.from)) || '';
        p.examples.push(`${t.rel}: ${line.trim().slice(0, 140)}`);
      }
    }
  }
  const totalBytes = files.reduce((n, f) => n + (f.size || 0), 0);
  return {
    source, target, newDomain, oldDomain, newBrand, oldBrand, serverIp,
    project: deploy.projectNameFrom(target),
    ports, pairs: pairs.filter((p) => p.count > 0 || p.kind === 'domain'),
    lockDb: input.lockDb !== false,
    composeFile: compose ? compose.file : null,
    fileCount: files.length, totalBytes, skipped,
  };
}

function applyPairs(text, pairs) {
  let out = text;
  for (const p of pairs) if (p.on && p.from) out = out.split(p.from).join(p.to);
  return out;
}

// Does the copy. onProgress({ done, total }) now and then. Returns a summary.
async function create(p, { onProgress, signal } = {}) {
  const source = path.resolve(p.source);
  const target = path.resolve(p.target);
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`${target} already exists and is not empty.`);
  const pairs = (p.pairs || []).filter((x) => x.on && x.from);
  const renamePairs = pairs.filter((x) => x.kind === 'domain' || x.kind === 'brand' || x.kind === 'extra');
  const portMap = {};
  for (const x of p.ports || []) if (Number(x.to) && Number(x.to) !== x.from) portMap[`${x.service}:${x.from}`] = Number(x.to);
  const { files } = await walk(source);
  let changed = 0;
  let done = 0;
  for (const f of files) {
    if (signal && signal.aborted) throw Object.assign(new Error('Stopped'), { code: 'ABORTED' });
    const relNew = f.rel.split('/').map((part) => applyPairs(part, renamePairs)).join('/');
    const dest = path.join(target, ...relNew.split('/'));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const text = f.keep ? null : await readText(f.abs, f.size);
    if (text == null) {
      await fsp.copyFile(f.abs, dest);
    } else {
      let out = text;
      if (p.composeFile && f.rel === p.composeFile) {
        let env = {};
        try { env = parseEnv(fs.readFileSync(path.join(source, '.env'), 'utf8')); } catch (_) { /* none */ }
        out = remapPorts(out, env, portMap).text;
        if (p.lockDb) out = lockDatabases(out, env).text;
      }
      out = applyPairs(out, pairs);
      if (out !== text) changed++;
      await fsp.writeFile(dest, out);
    }
    if (++done % 200 === 0 && onProgress) onProgress({ done, total: files.length });
  }
  if (onProgress) onProgress({ done, total: files.length });
  const cfg = writeConfig(p, portMap, renamePairs.concat(pairs.filter((x) => x.kind === 'ip')));
  return { folder: target, files: files.length, changed, config: cfg };
}

// snap.json for the new client: the template's settings with the new domains, ports and names.
function writeConfig(p, portMap, pairs) {
  const target = path.resolve(p.target);
  const sug = deploy.detect(target).suggestion;
  let base = null;
  try { base = JSON.parse(applyPairs(fs.readFileSync(path.join(path.resolve(p.source), deploy.CONFIG_FILE), 'utf8'), pairs)); } catch (_) { /* none */ }
  const byFrom = new Map((p.ports || []).map((x) => [x.from, Number(x.to) || x.from]));
  const port = (v) => (v ? byFrom.get(Number(v)) || Number(v) : v);
  const cfg = base ? deploy.normalize(base, sug) : sug;
  cfg.project = p.project || sug.project;
  cfg.remoteDir = `/root/${path.basename(target)}`;
  cfg.mainDomain = p.newDomain;
  cfg.sites = cfg.sites.map((s) => {
    const out = { ...s, backendPort: port(s.backendPort), port: port(s.port), root: null };
    if (!base) out.domain = deploy.defaultDomain(s.folder, p.newDomain);
    if (out.kind !== 'proxy') out.build = 'build'; // dist folders were not copied
    return out;
  });
  const errs = deploy.validate(cfg);
  if (errs.length) return { ...cfg, notSaved: errs };
  return deploy.save(target, cfg);
}

module.exports = { plan, create, walk, guessDomain, casePairs, applyPairs, freePort, randomSecret };
