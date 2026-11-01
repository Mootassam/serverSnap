'use strict';
// Runs a deploy for the Activity page: one step per part, live server output in the log.
//   mode: 'all' (Docker + websites) | 'docker' | 'sites'
const path = require('path');
const deploy = require('./deploy');
const local = require('./deploy-local');
const { KINDS } = require('./nginx-templates');
const sync = require('./deploy-sync');
const dataLoad = require('./deploy-data');

const LONG = 60 * 60 * 1000;

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

/**
 * opts: { server (host…), folder, mode, siteIds?, connect(), signal, onEvent,
 *         full (send every file), cleanup (old images, default on), data (a backup to load, see deploy-data.js) }
 * Returns { status: 'ok' | 'partial' | 'failed', urls: [], problems: [] }
 * Order: build on this PC → checks (nothing on the server is changed until they pass) → Docker → websites.
 */
async function runDeploy({ server, folder, mode = 'all', siteIds = null, connect, signal, onEvent, full = false, cleanup = true, data = null }) {
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
  if (data && !doDocker) throw new Error('Loading a backup needs the Docker part of the deploy (Deploy everything or Docker only).');
  const compose = doDocker ? deploy.readCompose(folder) : null;
  if (doDocker && !compose) throw new Error('docker-compose.yml is missing in the project folder.');
  if (data) dataLoad.validate(data, compose);

  // ---------- 1. build the websites on this PC (a broken build stops here, before the server) ----------
  const dists = {};
  for (const site of sites) {
    if (!KINDS[site.kind].static) continue;
    const dir = path.join(folder, site.folder);
    if (site.build === 'build') {
      const id = `site:${site.id}:build`;
      step(id, `${site.domain}: build ${site.folder} on this PC`, 'running');
      try {
        dists[site.id] = await local.buildSite(dir, { signal, onLine: (l) => say(`[${site.folder}] ${l}`) });
      } catch (err) {
        if (err.code === 'ABORTED') throw err;
        step(id, null, 'failed');
        throw new Error(`${site.folder}: the build failed, so nothing was changed on the server. ${err.message}`);
      }
      if (!dists[site.id]) { step(id, null, 'failed'); throw new Error(`${site.folder}: the build finished but there is no dist/index.html. Nothing was changed on the server.`); }
      step(id, null, 'ok');
    } else {
      dists[site.id] = local.distOf(dir);
      if (!dists[site.id]) throw new Error(`${site.folder} has no dist/index.html. Choose "Build it now" for this website in Edit.`);
    }
  }

  step('connect', 'Connect to the server', 'running');
  const remote = await connect();
  try {
    if (remote.priv === 'none') throw new Error('Deploying needs root (or sudo) on the server.');
    const insp = deploy.parseInspect(await remote.run(deploy.inspectScript(), { root: true, timeoutMs: 60000 }));
    step('connect', null, 'ok', server.host);
    say(`Logs on the server: ${deploy.STATE_DIR}/logs/${cfg.project}-${stamp}.log`);

    // ---------- 2. checks: everything that would make the deploy stop halfway ----------
    step('checks', 'Checks before deploy (disk, ports, domains)', 'running');
    const fails = [];
    if (doDocker) {
      if (!insp.tools.docker) fails.push('Docker is not installed on the server. Press "Set up server" on the Deploy tab.');
      else if (!insp.tools.compose) fails.push('Docker Compose is not installed on the server. Press "Set up server" on the Deploy tab.');
      const conflicts = deploy.portConflicts(compose, cfg.project, insp);
      if (conflicts.length) {
        fails.push('These ports are already used on the server: ' + conflicts.map((c) => `${c.port} (${c.service}) by ${c.by}`).join('; ') +
          '. Change the port in docker-compose.yml (the left number in "8082:8082"), then deploy again.');
      }
    }
    const disk = sync.judgeChecks(sync.parseChecks(await remote.run(sync.checksScript(doDocker ? cfg.remoteDir : null), { root: true, timeoutMs: 30000 })), { needDocker: doDocker });
    fails.push(...disk.fails);
    for (const w of disk.warns) { problems.push(w); say(w, 'warn'); }
    const dnsInfo = {};
    for (const site of sites) {
      const info = { wwwOk: site.www, ws: site.kind === 'trading' && site.ws ? `ws.${deploy.baseDomain(site.domain)}` : '' };
      dnsInfo[site.id] = info;
      if (site.skipDnsCheck) continue;
      const r = await local.dnsCheck(site.domain, server.host);
      if (!r.ok) { fails.push(local.dnsMessage(site.domain, r)); continue; }
      if (site.www) {
        info.wwwOk = (await local.dnsCheck(`www.${site.domain}`, server.host)).ok;
        if (!info.wwwOk) say(`www.${site.domain} does not point to the server: the HTTPS certificate is made for ${site.domain} only.`, 'warn');
      }
      if (info.ws && !(await local.dnsCheck(info.ws, server.host)).ok) {
        say(`${info.ws} (live prices) does not point to the server, so it is skipped. Add an A record ${info.ws} → ${server.host} and deploy again.`, 'warn');
        info.ws = '';
      }
    }
    if (fails.length) {
      step('checks', null, 'failed', `${fails.length} problem${fails.length === 1 ? '' : 's'}`);
      for (const f of fails) say(f, 'error');
      throw new Error(`Stopped before changing anything on the server. ${fails.join(' ')}`);
    }
    step('checks', null, 'ok', disk.warns.length ? 'with warnings' : 'all good');

    // ---------- 3. Docker ----------
    if (doDocker) {
      const same = deploy.serverProjects(insp).find((p) => p.name === cfg.project);
      if (same && same.workingDir && same.workingDir !== cfg.remoteDir) {
        say(`Note: project ${cfg.project} is already running from ${same.workingDir} on the server, but this deploy uses ${cfg.remoteDir}.`, 'warn');
      }
      // website folders that are uploaded as dist anyway do not need to go up with the project
      const skip = cfg.sites.filter((s) => s.enabled && s.kind !== 'proxy' && !(compose.services || []).some((x) => x.build && x.build.replace(/^\.\//, '').replace(/\/$/, '') === s.folder)).map((s) => `./${s.folder}`);
      step('upload', full ? 'Upload the project (every file)' : 'Upload the project (only what changed)', 'running');
      const up = await sync.syncDir(remote, folder, cfg.remoteDir, {
        exclude: [...(cfg.exclude || deploy.DEFAULT_EXCLUDE), ...skip], full, say, signal, name: cfg.project,
        onBytes: (b, total) => step('upload', null, 'running', `${Math.round((b / total) * 100)}%`),
      });
      step('upload', null, 'ok', up.sent ? `${up.sent} file${up.sent === 1 ? '' : 's'} · ${(up.bytes / 1048576).toFixed(1)} MB` : 'nothing changed');
      if (data) await dataLoad.loadData(remote, cfg, compose, data, { say, step, signal, stamp });
      if (cleanup) await remote.exec(sync.keepPreviousScript(cfg.project), { root: true, timeoutMs: 60000, signal });
      step('up:docker', 'Build and start the containers (can take a few minutes)', 'running');
      const r = await runScript(remote, deploy.upScript(cfg, stamp), { say, step, signal, stepPrefix: 'up' });
      if (r.fail) { step('up:docker', null, 'failed', r.fail); throw new Error(r.fail); }
      if (r.warnings.length) { problems.push(...r.warnings); step('up:docker', null, 'warning', r.count ? `${r.count} running` : ''); }
      // only after a good start: the previous images stay (tagged), older leftovers go
      if (cleanup && !r.warnings.length) {
        step('cleanup', 'Clean up old Docker images', 'running');
        const c = await remote.exec(sync.cleanupScript(), { root: true, timeoutMs: 10 * 60 * 1000, signal });
        const freed = sync.freedText(c.stdout);
        step('cleanup', null, 'ok', freed ? `${freed} freed` : 'nothing to clean');
      }
    }

    // ---------- 4. websites ----------
    for (const site of sites) {
      const sid = `site:${site.id}`;
      const L = (t) => `${site.domain}: ${t}`;
      const { wwwOk, ws } = dnsInfo[site.id];
      try {
        // where the website lives on the server (an existing setup keeps its folder)
        let root = null;
        if (KINDS[site.kind].static) {
          const info = deploy.parseKv(await remote.run(deploy.siteInfoScript(site.domain), { root: true, timeoutMs: 30000 }));
          root = site.root || (info.root && deploy.isRootDir(info.root) ? info.root : null) || `/var/www/${site.domain}/html`;
          if (info.root && info.root !== root) say(`${site.domain} used ${info.root} before; it now uses ${root}.`, 'warn');
          else if (info.root) say(`${site.domain}: keeping its website folder ${root}`);
          // next to the live folder, starting from a copy of it; the server script swaps it in
          step(`${sid}:upload`, L(full ? 'upload the website (every file)' : 'upload the website (only what changed)'), 'running');
          const up = await sync.syncDir(remote, dists[site.id], root + '.new', {
            mirror: true, liveDir: root, full, say, signal, name: site.id,
            onBytes: (b, total) => step(`${sid}:upload`, null, 'running', `${Math.round((b / total) * 100)}%`),
          });
          step(`${sid}:upload`, null, 'ok', up.sent || up.removed ? `${up.sent} new or changed, ${up.removed} removed · ${(up.bytes / 1048576).toFixed(1)} MB` : 'nothing changed');
        }
        // nginx + HTTPS + check (puts everything back by itself on failure)
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
