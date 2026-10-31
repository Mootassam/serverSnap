'use strict';
// Runs a deploy for the Activity page: one step per part, live server output in the log.
//   mode: 'all' (Docker + websites) | 'docker' | 'sites'
const fs = require('fs');
const path = require('path');
const deploy = require('./deploy');
const local = require('./deploy-local');
const { KINDS } = require('./nginx-templates');
const { q } = require('./shell');

const LONG = 60 * 60 * 1000;
// A server path as a shell word (SNAP_ROOT is empty on real servers; tests set it).
const rp = (p) => '"${SNAP_ROOT:-}"' + q(p);

function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Runs a generated script as root, turning its @@ markers into steps and its lines into the log.
async function runScript(remote, script, { say, step, signal, stepPrefix }) {
  const result = { fail: null, warnings: [], done: null, count: null };
  const parse = deploy.markerParser((kind, rest) => {
    if (kind === 'STEP') {
      const [id, status, detail] = rest.split('|');
      step(`${stepPrefix}:${id}`, null, status, detail);
    } else if (kind === 'WARN') { result.warnings.push(rest); say(rest, 'warn'); }
    else if (kind === 'FAIL') { result.fail = rest; say(rest, 'error'); }
    else if (kind === 'DONE') result.done = rest;
    else if (kind === 'COUNT') result.count = rest;
  }, (line) => say(line));
  const r = await remote.exec('bash -s', { root: true, stdin: script, onData: parse, signal, timeoutMs: LONG });
  parse('\n');
  if (r.code !== 0 && !result.fail) result.fail = (r.stderr || `exit code ${r.code}`).trim().split('\n').slice(-3).join(' ');
  return result;
}

async function upload(remote, dir, target, { exclude, say, step, id, label, signal }) {
  step(id, label, 'running');
  const file = await local.pack(dir, { exclude, signal, name: path.basename(dir) });
  try {
    const size = fs.statSync(file).size;
    say(`Uploading ${label.toLowerCase()} (${(size / 1048576).toFixed(1)} MB)…`);
    await remote.upload(target, file, { root: true, signal, onBytes: (b) => step(id, label, 'running', `${Math.round((b / size) * 100)}%`) });
    step(id, label, 'ok', `${(size / 1048576).toFixed(1)} MB`);
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

/**
 * opts: { server (host…), folder, mode, siteIds?, connect(), signal, onEvent }
 * Returns { status: 'ok' | 'partial' | 'failed', urls: [], problems: [] }
 */
async function runDeploy({ server, folder, mode = 'all', siteIds = null, connect, signal, onEvent }) {
  const say = (msg, level = 'info') => onEvent({ type: 'log', level, msg, at: Date.now() });
  const labels = {};
  const step = (id, label, status, detail) => {
    if (label) labels[id] = label;
    onEvent({ type: 'item', item: { id, label: labels[id] || id, status, detail: detail || '' } });
  };
  const cfg = deploy.load(folder);
  const errs = deploy.validate(cfg);
  if (errs.length) throw new Error(errs.join(' '));
  const stamp = stampNow();
  const problems = [];
  const urls = [];
  let failed = 0;
  const doDocker = mode !== 'sites' && cfg.docker;
  const sites = mode === 'docker' ? [] : cfg.sites.filter((s) => s.enabled && (!siteIds || siteIds.includes(s.id)));
  if (!doDocker && !sites.length) throw new Error(mode === 'docker' ? 'This project does not use Docker (see Edit).' : 'No website is switched on for this project (see Edit).');

  step('connect', 'Connect to the server', 'running');
  const remote = await connect();
  try {
    if (remote.priv === 'none') throw new Error('Deploying needs root (or sudo) on the server.');
    const insp = deploy.parseInspect(await remote.run(deploy.inspectScript(), { root: true, timeoutMs: 60000 }));
    step('connect', null, 'ok', server.host);
    say(`Logs on the server: ${deploy.STATE_DIR}/logs/${cfg.project}-${stamp}.log`);

    // ---------- Docker ----------
    if (doDocker) {
      if (!insp.tools.docker) throw new Error('Docker is not installed on the server. Install it first (curl -fsSL https://get.docker.com | sh).');
      if (!insp.tools.compose) throw new Error('Docker Compose is not installed on the server.');
      const compose = deploy.readCompose(folder);
      if (!compose) throw new Error('docker-compose.yml is missing in the project folder.');
      const conflicts = deploy.portConflicts(compose, cfg.project, insp);
      if (conflicts.length) {
        throw new Error('These ports are already used on the server: ' +
          conflicts.map((c) => `${c.port} (${c.service}) by ${c.by}`).join('; ') +
          '. Change the port in docker-compose.yml (the left number in "8082:8082"), then deploy again.');
      }
      const same = deploy.serverProjects(insp).find((p) => p.name === cfg.project);
      if (same && same.workingDir && same.workingDir !== cfg.remoteDir) {
        say(`Note: project ${cfg.project} is already running from ${same.workingDir} on the server, but this deploy uses ${cfg.remoteDir}.`, 'warn');
      }
      // website folders that are uploaded as dist anyway do not need to go up with the project
      const skip = cfg.sites.filter((s) => s.enabled && s.kind !== 'proxy' && !(compose.services || []).some((x) => x.build && x.build.replace(/^\.\//, '').replace(/\/$/, '') === s.folder)).map((s) => `./${s.folder}`);
      await upload(remote, folder, `mkdir -p ${rp(cfg.remoteDir)} && tar -xzf - -C ${rp(cfg.remoteDir)} --no-same-owner`,
        { exclude: [...(cfg.exclude || deploy.DEFAULT_EXCLUDE), ...skip], say, step, id: 'upload', label: 'Upload the project', signal });
      step('up:docker', 'Build and start the containers (can take a few minutes)', 'running');
      const r = await runScript(remote, deploy.upScript(cfg, stamp), { say, step, signal, stepPrefix: 'up' });
      if (r.fail) { step('up:docker', null, 'failed', r.fail); throw new Error(r.fail); }
      if (r.warnings.length) { problems.push(...r.warnings); step('up:docker', null, 'warning', r.count ? `${r.count} running` : ''); }
    }

    // ---------- websites ----------
    for (const site of sites) {
      const sid = `site:${site.id}`;
      const L = (t) => `${site.domain}: ${t}`;
      try {
        // 1. DNS
        let wwwOk = site.www;
        let ws = site.kind === 'trading' && site.ws ? `ws.${deploy.baseDomain(site.domain)}` : '';
        if (!site.skipDnsCheck) {
          step(`${sid}:dns`, L('domain points to the server'), 'running');
          const r = await local.dnsCheck(site.domain, server.host);
          if (!r.ok) { step(`${sid}:dns`, null, 'failed', r.ips.join(', ') || 'no record'); throw new Error(local.dnsMessage(site.domain, r)); }
          step(`${sid}:dns`, null, 'ok', r.ips.join(', '));
          if (site.www) {
            wwwOk = (await local.dnsCheck(`www.${site.domain}`, server.host)).ok;
            if (!wwwOk) say(`www.${site.domain} does not point to the server: the HTTPS certificate is made for ${site.domain} only.`, 'warn');
          }
          if (ws && !(await local.dnsCheck(ws, server.host)).ok) {
            say(`${ws} (live prices) does not point to the server, so it is skipped. Add an A record ${ws} → ${server.host} and deploy again.`, 'warn');
            ws = '';
          }
        }
        // 2. where the website lives on the server (an existing setup keeps its folder)
        let root = null;
        if (KINDS[site.kind].static) {
          const info = deploy.parseKv(await remote.run(deploy.siteInfoScript(site.domain), { root: true, timeoutMs: 30000 }));
          root = site.root || (info.root && deploy.isRootDir(info.root) ? info.root : null) || `/var/www/${site.domain}/html`;
          if (info.root && info.root !== root) say(`${site.domain} used ${info.root} before; it now uses ${root}.`, 'warn');
          else if (info.root) say(`${site.domain}: keeping its website folder ${root}`);
          // 3. build on this PC
          const dir = path.join(folder, site.folder);
          let dist = local.distOf(dir);
          if (site.build === 'build') {
            step(`${sid}:build`, L(`build ${site.folder} on this PC`), 'running');
            dist = await local.buildSite(dir, { signal, onLine: (l) => say(`[${site.folder}] ${l}`) });
            if (!dist) throw new Error(`${site.folder}: the build finished but there is no dist/index.html.`);
            step(`${sid}:build`, null, 'ok');
          } else if (!dist) throw new Error(`${site.folder} has no dist/index.html. Choose "Build it now" for this website in Edit.`);
          // 4. upload next to the live folder; the server script swaps it in
          await upload(remote, dist, `rm -rf ${rp(root + '.new')} && mkdir -p ${rp(root + '.new')} && tar -xzf - -C ${rp(root + '.new')} --no-same-owner`,
            { exclude: [], say, step, id: `${sid}:upload`, label: L('upload the website'), signal });
        }
        // 5. nginx + HTTPS + check (puts everything back by itself on failure)
        step(`${sid}:nginx`, L('nginx file'), 'running');
        step(`${sid}:ssl`, L('HTTPS'), site.ssl ? 'waiting' : 'skipped');
        step(`${sid}:check`, L('check the website answers'), 'waiting');
        const r = await runScript(remote, deploy.siteScript(cfg, site, { root, staged: !!root, ws, wwwOk, email: cfg.email, stamp }), { say, step, signal, stepPrefix: sid });
        if (r.fail) {
          for (const k of ['nginx', 'ssl', 'check']) step(`${sid}:${k}`, null, 'failed');
          throw new Error(r.fail);
        }
        if (r.warnings.length) problems.push(...r.warnings.map((w) => `${site.domain}: ${w}`));
        urls.push(r.done || `http://${site.domain}`);
        say(`✅ ${r.done || site.domain} is live.`);
      } catch (err) {
        if (err.code === 'ABORTED' || err.code === 'CONNECTION_LOST') throw err;
        failed++;
        problems.push(`${site.domain}: ${err.message}`);
        say(`${site.domain}: ${err.message}`, 'error');
      }
    }
  } finally {
    remote.close();
  }
  const status = !problems.length ? 'ok' : failed && !urls.length && !doDocker ? 'failed' : 'partial';
  return { status, urls, problems };
}

// Rollback of one website (files + nginx file from before the last deploy).
async function runRollback({ folder, siteId, connect, signal, onEvent }) {
  const say = (msg, level = 'info') => onEvent({ type: 'log', level, msg, at: Date.now() });
  const step = (id, label, status, detail) => onEvent({ type: 'item', item: { id, label: label || id, status, detail: detail || '' } });
  const cfg = deploy.load(folder);
  const site = cfg.sites.find((s) => s.id === siteId);
  if (!site) throw new Error('Website not found in snap.json.');
  const remote = await connect();
  try {
    let root = null;
    if (KINDS[site.kind] && KINDS[site.kind].static) {
      const info = deploy.parseKv(await remote.run(deploy.siteInfoScript(site.domain), { root: true, timeoutMs: 30000 }));
      root = site.root || info.root || `/var/www/${site.domain}/html`;
    }
    const r = await runScript(remote, deploy.rollbackScript(cfg, site, root), { say, step: (id, _l, st, d) => step(id, `Put back the previous version of ${site.domain}`, st, d), signal, stepPrefix: 'rb' });
    if (r.fail) throw new Error(r.fail);
    return { status: 'ok' };
  } finally {
    remote.close();
  }
}

module.exports = { runDeploy, runRollback, runScript, stampNow };
