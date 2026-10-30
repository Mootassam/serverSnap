'use strict';
// Puts a backup onto a server (the same one, or a brand-new one when moving host):
// files back in place, Docker volumes refilled, projects started, databases loaded.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { q, isInside } = require('./shell');
const db = require('./db');
const { sleep, fmt } = require('./backup');

function sha256File(file, onBytes) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let n = 0;
    fs.createReadStream(file)
      .on('data', (d) => { h.update(d); n += d.length; if (onBytes) onBytes(n); })
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

// Decides what will happen, without touching anything (also shown to the user first).
function planRestore(manifest, options) {
  const chosen = new Set(options.items);
  const items = manifest.items.filter((i) => chosen.has(i.id) && (i.status === 'ok' || i.status === 'warning'));
  const files = items.filter((i) => i.type === 'files');
  const volumes = items.filter((i) => i.type === 'volume');
  const dbs = items.filter((i) => i.type === 'database');
  const useDumps = options.useDumps !== false;
  const dumpFor = (container) => useDumps && dbs.some((d) => d.where === 'docker' && d.container === container);
  const projects = options.startProjects === false ? [] :
    (manifest.projects || []).filter((p) => files.some((f) => isInside(p.workingDir, f.path)));
  const needsDocker = volumes.length > 0 || projects.length > 0 || dbs.some((d) => d.where === 'docker');
  return {
    files,
    // A database volume is refilled from its dump instead of raw files, when a dump was taken.
    volumes: volumes.map((v) => ({ ...v, fromDump: !!(v.db && dumpFor(v.db.container)) })),
    dbs,
    projects,
    needsDocker,
    useDumps,
  };
}

function volumeRestoreCommand(item) {
  const name = q(item.name);
  const labels = Object.entries(item.labels || {}).map(([k, v]) => `--label ${q(`${k}=${v}`)}`).join(' ');
  return [
    `docker ps -q --filter volume=${name} | xargs -r docker stop >/dev/null`,
    `docker volume inspect ${name} >/dev/null 2>&1 || docker volume create ${labels} ${name} >/dev/null || exit 1`,
    `MP=$(docker volume inspect -f '{{.Mountpoint}}' ${name})`,
    `if [ -n "$MP" ] && [ -d "$MP" ]; then find "$MP" -mindepth 1 -delete && cd "$MP" && exec tar -xzf -; ` +
      `else exec docker run --rm -i -v ${q(item.name + ':/v')} alpine:3 sh -c 'find /v -mindepth 1 -delete; tar -xzf - -C /v'; fi`,
  ].join('\n');
}

// Empties a database volume so the database starts fresh and the dump can be loaded cleanly.
function volumeResetCommand(item) {
  const name = q(item.name);
  return `docker ps -aq --filter volume=${name} | xargs -r docker rm -f >/dev/null; docker volume rm ${name} >/dev/null 2>&1; true`;
}

function composeBase(project, composeCmd) {
  const files = (project.configFiles || []).map((f) => `-f ${q(f)}`).join(' ');
  return `cd ${q(project.workingDir)} && ${composeCmd} -p ${q(project.name)} ${files}`;
}

function serviceContainerCommand(project, service) {
  return `docker ps -q --filter label=com.docker.compose.project=${q(project)} --filter label=com.docker.compose.service=${q(service)} | head -n 1`;
}

/**
 * opts: { manifest, connect: async () => Remote, options: { items, installDocker, startProjects, useDumps, hostDbPassword },
 *         signal, onEvent }
 */
async function runRestore(opts) {
  const { manifest, connect, signal } = opts;
  const options = opts.options || {};
  const emit = (e) => { try { opts.onEvent && opts.onEvent(e); } catch (_) { /* never stop for the UI */ } };
  const log = (msg, level = 'info') => emit({ type: 'log', level, msg, at: Date.now() });
  const results = [];
  const note = (label, status, detail) => {
    results.push({ label, status, detail: detail || null });
    emit({ type: 'step', label, status, detail });
    if (status === 'failed') log(`${label}: FAILED — ${detail}`, 'error');
    else if (status === 'warning') log(`${label}: ${detail}`, 'warn');
    else log(`${label}: done${detail ? ' — ' + detail : ''}`);
  };
  const plan = planRestore(manifest, options);

  // 1. Make sure the backup files are complete and unchanged.
  log('Checking the backup files are not damaged…');
  for (const item of [...plan.files, ...plan.volumes, ...plan.dbs]) {
    const file = path.join(manifest.dir, item.file);
    if (!fs.existsSync(file)) throw new Error(`Backup file missing: ${item.file}`);
    if (item.sha256) {
      const got = await sha256File(file);
      if (got !== item.sha256) throw new Error(`Backup file is damaged: ${item.file}. Use another backup.`);
    }
  }
  log('Backup files OK.');

  const remote = await connect();
  try {
    if (remote.priv === 'none') throw new Error('Restoring needs administrator (root) rights on the target server. Log in as root or a sudo user.');
    const sh = (cmd, timeoutMs = 120000) => remote.exec(cmd, { root: true, timeoutMs, signal });

    // 2. Docker
    let composeCmd = null;
    if (plan.needsDocker) {
      let d = await sh('docker info --format "{{.ServerVersion}}" >/dev/null 2>&1 && echo ok || echo missing');
      if (d.stdout.trim() !== 'ok') {
        if (!options.installDocker) throw new Error('Docker is not installed on the target server. Tick "Install Docker if missing" and try again.');
        log('Installing Docker on the server (a few minutes)…');
        const inst = await sh('(command -v curl >/dev/null 2>&1 && curl -fsSL https://get.docker.com || wget -qO- https://get.docker.com) | sh && ' +
          '(systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true)', 20 * 60000);
        if (inst.code !== 0) throw new Error('Docker install failed: ' + inst.stderr.trim().split('\n').slice(-2).join(' '));
        d = await sh('docker info --format "{{.ServerVersion}}" >/dev/null 2>&1 && echo ok || echo missing');
        if (d.stdout.trim() !== 'ok') throw new Error('Docker was installed but does not start.');
        note('Install Docker', 'ok');
      }
      const c = await sh('docker compose version >/dev/null 2>&1 && echo v2 || (command -v docker-compose >/dev/null 2>&1 && echo v1) || echo none');
      composeCmd = { v2: 'docker compose', v1: 'docker-compose' }[c.stdout.trim()] || null;
      if (!composeCmd && plan.projects.length) log('Docker Compose is missing, so projects cannot be started. Install the "docker-compose-plugin" package.', 'warn');
    }

    // 3. Stop the projects being restored if they already run here (same-server restore).
    for (const p of plan.projects) {
      await sh(`docker ps -q --filter label=com.docker.compose.project=${q(p.name)} | xargs -r docker stop >/dev/null; true`, 300000);
    }

    // 4. Files
    for (const item of plan.files) {
      try {
        log(`Putting back ${item.path}…`);
        await remote.upload('cd / && tar -xzf -', path.join(manifest.dir, item.file), {
          root: true, signal, onBytes: (b) => emit({ type: 'progress', id: item.id, bytes: b, total: item.bytes }),
        });
        note(item.label, 'ok', fmt(item.bytes));
      } catch (err) {
        if (err.code === 'ABORTED') throw err;
        note(item.label, 'failed', err.message);
      }
    }

    // 5. Volumes
    for (const v of plan.volumes) {
      try {
        if (v.fromDump) {
          await sh(volumeResetCommand(v));
          note(v.label, 'ok', 'will be filled from the database copy');
          continue;
        }
        log(`Refilling Docker volume ${v.name}…`);
        await remote.upload(volumeRestoreCommand(v), path.join(manifest.dir, v.file), {
          root: true, signal, onBytes: (b) => emit({ type: 'progress', id: v.id, bytes: b, total: v.bytes }),
        });
        note(v.label, 'ok', fmt(v.bytes));
      } catch (err) {
        if (err.code === 'ABORTED') throw err;
        note(v.label, 'failed', err.message);
      }
    }

    const loadDump = async (item, container) => {
      log(`Loading ${item.label}…`);
      const r = await remote.upload(db.loadCommand(item.kind, container), path.join(manifest.dir, item.file), {
        root: true, gunzip: true, signal, onBytes: (b) => emit({ type: 'progress', id: item.id, bytes: b, total: item.bytes }),
      });
      const errors = (r.stderr.match(/ERROR/g) || []).length;
      note(item.label, errors ? 'warning' : 'ok', errors ? `loaded, with ${errors} message(s) (often harmless, e.g. "already exists")` : 'loaded');
    };

    const waitReady = async (kind, container) => {
      let okRuns = 0;
      for (let t = 0; t < 90; t++) {
        const r = await sh(db.readyCommand(kind, container), 30000).catch(() => ({ code: 1 }));
        okRuns = r.code === 0 ? okRuns + 1 : 0;
        if (okRuns >= 2) return;
        await sleep(3000, signal);
      }
      throw new Error('The database did not become ready within 4–5 minutes.');
    };

    // 6. Projects (database first, then load its dump, then everything else)
    const loaded = new Set();
    for (const p of plan.projects) {
      if (!composeCmd) { note(`Start project ${p.name}`, 'failed', 'Docker Compose is not installed'); continue; }
      const base = composeBase(p, composeCmd);
      const dumps = plan.dbs.filter((d) => plan.useDumps && d.where === 'docker' && d.project === p.name && d.service);
      try {
        for (const d of dumps) {
          log(`Starting database "${d.service}" of ${p.name}…`);
          const up = await sh(`${base} up -d ${q(d.service)}`, 30 * 60000);
          if (up.code !== 0) throw new Error(up.stderr.trim().split('\n').slice(-3).join(' '));
          const id = (await sh(serviceContainerCommand(p.name, d.service))).stdout.trim();
          if (!id) throw new Error(`Container for "${d.service}" did not start`);
          await waitReady(d.kind, id);
          try { await loadDump(d, id); } catch (err) { if (err.code === 'ABORTED') throw err; note(d.label, 'failed', err.message); }
          loaded.add(d.id);
        }
        log(`Starting project ${p.name} (images may need to download)…`);
        const up = await sh(`${base} up -d`, 30 * 60000);
        if (up.code !== 0) throw new Error(up.stderr.trim().split('\n').slice(-3).join(' '));
        note(`Start project ${p.name}`, 'ok');
      } catch (err) {
        if (err.code === 'ABORTED') throw err;
        note(`Start project ${p.name}`, 'failed', err.message);
      }
    }

    // 7. Remaining databases: containers outside the restored projects, and databases on the server itself.
    for (const d of plan.dbs) {
      if (loaded.has(d.id)) continue;
      try {
        if (d.where === 'host') {
          const has = await sh(db.HOST[d.kind].has);
          if (has.code !== 0) { note(d.label, 'failed', `${db.KINDS[d.kind].label} is not installed on this server. Install it, then restore only this database.`); continue; }
          log(`Loading ${d.label}…`);
          const r = await remote.upload(db.HOST[d.kind].load, path.join(manifest.dir, d.file), {
            root: true, gunzip: true, signal,
            prefixLine: d.kind === 'mysql' ? (options.hostDbPassword || '') : null,
            onBytes: (b) => emit({ type: 'progress', id: d.id, bytes: b, total: d.bytes }),
          });
          const errors = (r.stderr.match(/ERROR/g) || []).length;
          note(d.label, errors ? 'warning' : 'ok', errors ? `loaded, with ${errors} message(s)` : 'loaded');
          continue;
        }
        if (!plan.useDumps) continue;
        const running = (await sh(`docker ps -q --filter ${q(`name=^/${d.container}$`)}`)).stdout.trim();
        if (!running) {
          note(d.label, 'warning', `container "${d.container}" is not running here, so the database copy was not loaded. Start it and restore only this database.`);
          continue;
        }
        await waitReady(d.kind, running);
        await loadDump(d, running);
      } catch (err) {
        if (err.code === 'ABORTED') throw err;
        note(d.label, 'failed', err.message);
      }
    }

    // 8. Projects whose database was loaded get a restart so apps reconnect cleanly.
    for (const p of plan.projects) {
      if (composeCmd && plan.dbs.some((d) => loaded.has(d.id) && d.project === p.name)) {
        await sh(`${composeBase(p, composeCmd)} restart`, 10 * 60000).catch(() => null);
      }
    }

    const ip = remote.server.host;
    const failed = results.filter((r) => r.status === 'failed').length;
    log(failed ? `Finished with ${failed} problem(s). See the list above.` : 'Restore finished.', failed ? 'warn' : 'info');
    if ((manifest.loose || []).length) {
      log(`Reminder: start these containers yourself (they were not made with Docker Compose): ${manifest.loose.map((l) => l.container).join(', ')}`, 'warn');
    }
    if (manifest.server && manifest.server.host !== ip) {
      log(`Last step: point your domain's DNS "A" record to ${ip}.`, 'info');
    }
    const summary = { status: failed ? 'partial' : 'ok', results, target: ip };
    emit({ type: 'done', summary });
    return summary;
  } finally {
    remote.close();
  }
}

module.exports = { runRestore, planRestore, volumeRestoreCommand, volumeResetCommand, composeBase, sha256File };
