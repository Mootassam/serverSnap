'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, safeStorage, powerSaveBlocker, Notification, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Store } = require('./src/store');
const { Remote } = require('./src/ssh');
const docker = require('./src/docker');
const clients = require('./src/clients');
const sftpUtil = require('./src/sftp');
const { scan } = require('./src/scanner');
const { runBackup, listBackups, applyRetention, fmt } = require('./src/backup');
const { runRestore, planRestore } = require('./src/restore');
const selection = require('./src/selection');
const scheduler = require('./src/scheduler');
const notify = require('./src/notify');

const APP_ID = 'com.serversnap.app';
app.setAppUserModelId(APP_ID);
// Screenshot self-test (tools/smoke.js): separate data folder, captures every page, then quits.
const SMOKE = process.env.SERVERSNAP_SMOKE || null;
if (SMOKE) app.setPath('userData', path.join(SMOKE, 'userData'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let tray = null;
let quitting = false;
let store = null;
const jobs = new Map(); // jobId -> job
let jobSeq = 0;

// ---------- logging ----------
let logFile = null;
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try { fs.appendFileSync(logFile, line); } catch (_) { /* logging must never crash the app */ }
}
process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandled', e));

// ---------- helpers ----------
const crypt = {
  encrypt: (s) => (safeStorage.isEncryptionAvailable() ? 'v1:' + safeStorage.encryptString(s).toString('base64') : 'p0:' + Buffer.from(s, 'utf8').toString('base64')),
  decrypt: (s) => {
    if (!s) return '';
    if (s.startsWith('v1:')) return safeStorage.decryptString(Buffer.from(s.slice(3), 'base64'));
    if (s.startsWith('p0:')) return Buffer.from(s.slice(3), 'base64').toString('utf8');
    return '';
  },
};

function defaultBackupRoot() {
  return path.join(app.getPath('documents'), 'ServerSnap Backups');
}

function backupRootFor(server) {
  return (server && server.backupRoot) || store.data.settings.backupRoot || defaultBackupRoot();
}

function allRoots() {
  const roots = new Set([store.data.settings.backupRoot || defaultBackupRoot()]);
  for (const s of store.data.servers) if (s.backupRoot) roots.add(s.backupRoot);
  return [...roots];
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Connects to a saved server; remembers its key the first time (trust on first use).
async function connectServer(serverId) {
  const s = store.withSecrets(serverId);
  const remote = new Remote(s);
  await remote.connect();
  if (!s.knownHostKey && remote.hostKey) store.patch(serverId, { knownHostKey: remote.hostKey });
  await remote.detectPrivilege();
  return remote;
}

// ---------- live connection (Docker dashboard) ----------
// One SSH connection per server is kept open while the dashboard is used, so clicks are instant.
const live = new Map(); // serverId -> { remote, promise, timer }
const LIVE_IDLE_MS = 3 * 60 * 1000;

function touchLive(serverId, e) {
  clearTimeout(e.timer);
  e.timer = setTimeout(() => dropLive(serverId), LIVE_IDLE_MS);
}

function dropLive(serverId) {
  const e = live.get(serverId);
  if (!e) return;
  live.delete(serverId);
  clearTimeout(e.timer);
  if (e.remote) e.remote.close();
}

function liveRemote(serverId) {
  const e = live.get(serverId);
  if (e && e.remote && e.remote.connected) { touchLive(serverId, e); return Promise.resolve(e.remote); }
  if (e && e.promise) return e.promise;
  if (e) dropLive(serverId);
  const entry = { remote: null, timer: null, promise: null };
  entry.promise = connectServer(serverId).then((r) => {
    entry.remote = r;
    entry.promise = null;
    r.client.on('close', () => { if (live.get(serverId) === entry) { live.delete(serverId); clearTimeout(entry.timer); } });
    touchLive(serverId, entry);
    return r;
  }, (err) => {
    if (live.get(serverId) === entry) live.delete(serverId);
    throw err;
  });
  live.set(serverId, entry);
  return entry.promise;
}

// Runs fn(remote) on the live connection; reconnects once if the connection had dropped.
async function withLive(serverId, fn) {
  try {
    return await fn(await liveRemote(serverId));
  } catch (err) {
    if (err.code !== 'CONNECTION_LOST') throw err;
    dropLive(serverId);
    return fn(await liveRemote(serverId));
  }
}

const dockerUsage = new Map(); // serverId -> last usage (CPU, memory, sizes)

// Screenshot self-test: sample answers instead of a real server.
function smokeFixture(name) {
  const f = SMOKE && path.join(SMOKE, `${name}.json`);
  return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

async function dockerView(serverId, withUsage) {
  const fx = smokeFixture('docker');
  if (fx) return fx;
  return withLive(serverId, async (r) => {
    const [ov, us] = await Promise.all([docker.overview(r), withUsage ? docker.usage(r) : Promise.resolve(null)]);
    if (us) dockerUsage.set(serverId, { ...us, at: Date.now() });
    const view = docker.groupOverview(ov, us || dockerUsage.get(serverId) || null);
    view.usageAt = (dockerUsage.get(serverId) || {}).at || null;
    return view;
  });
}

function serverView(s) {
  const v = store.publicServer(s);
  const n = scheduler.nextRun(s);
  v.nextRun = n ? n.toISOString() : null;
  v.running = [...jobs.values()].some((j) => j.serverId === s.id && j.state === 'running');
  return v;
}

function scanView(server) {
  const sc = server.lastScan;
  if (!sc) return null;
  const sel = selection.resolve(sc, server.selection);
  const extra = (server.selection && server.selection.extraFolders) || [];
  const folders = [...sc.folders];
  for (const p of extra) if (!folders.some((f) => f.path === p)) folders.push({ path: p, reason: 'Added by you', on: true, custom: true, sizeKb: null });
  return { ...sc, folders, selected: sel };
}

// ---------- jobs ----------
function newJob(type, serverId, title) {
  const job = { id: `job${++jobSeq}`, type, serverId, title, state: 'running', startedAt: Date.now(), log: [], items: {}, result: null, controller: new AbortController() };
  jobs.set(job.id, job);
  job.blocker = powerSaveBlocker.start('prevent-app-suspension');
  send('job', publicJob(job));
  return job;
}

function publicJob(j) {
  const { controller, blocker, ...rest } = j;
  return rest;
}

function jobEvent(job, e) {
  if (e.type === 'log') {
    job.log.push(e);
    if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
    log(`[${job.id}] ${e.level}: ${e.msg}`);
  } else if (e.type === 'item') {
    job.items[e.item.id] = { label: e.item.label, status: e.item.status, bytes: e.item.bytes, sizeKb: e.item.sizeKb };
  } else if (e.type === 'progress') {
    const it = job.items[e.id] || (job.items[e.id] = { label: e.id });
    it.bytes = e.bytes;
    if (e.total) it.total = e.total;
  } else if (e.type === 'step') {
    job.items[`step:${Object.keys(job.items).length}`] = { label: e.label, status: e.status, detail: e.detail };
  }
  send('job-event', { jobId: job.id, event: e });
}

function finishJob(job, state, result) {
  job.state = state;
  job.result = result;
  job.finishedAt = Date.now();
  try { powerSaveBlocker.stop(job.blocker); } catch (_) { /* already stopped */ }
  send('job', publicJob(job));
  refreshTray();
}

function serverBusy(serverId) {
  return [...jobs.values()].some((j) => j.serverId === serverId && j.state === 'running');
}

// Full backup run: connect, look again at what is on the server, copy, tidy up, alert.
async function backupJob(serverId, { scheduled = false } = {}) {
  const server = store.get(serverId);
  if (!server) throw new Error('Server not found');
  if (serverBusy(serverId)) throw new Error('A backup or restore of this server is already running.');
  const job = newJob('backup', serverId, `Backup of ${server.name}`);
  const ev = (e) => jobEvent(job, e);
  (async () => {
    let manifest = null;
    try {
      ev({ type: 'log', level: 'info', msg: `Connecting to ${server.host}…`, at: Date.now() });
      const remote = await connectServer(serverId);
      ev({ type: 'log', level: 'info', msg: 'Looking at what is on the server…', at: Date.now() });
      const sc = await scan(remote, { onStep: (s) => ev({ type: 'log', level: 'info', msg: s, at: Date.now() }) });
      remote.close();
      store.patch(serverId, { lastScan: sc });
      const sel = selection.resolve(sc, server.selection);
      const secrets = store.withSecrets(serverId);
      sel.hostDbPassword = secrets.hostDbPassword || '';
      if (!sel.folders.length && !sel.volumes.length && !sel.databases.length) throw new Error('Nothing is selected to back up.');
      const root = backupRootFor(server);
      manifest = await runBackup({
        server: store.get(serverId), scan: sc, selection: sel, destRoot: root,
        connect: () => connectServer(serverId), signal: job.controller.signal, onEvent: ev,
      });
      if (manifest.status !== 'failed') await applyRetention(root, serverId, server.keep, (m) => ev({ type: 'log', level: 'info', msg: m, at: Date.now() }));
      store.patch(serverId, { lastRun: { at: new Date().toISOString(), status: manifest.status, name: manifest.name, bytes: manifest.totalBytes, scheduled } });
      finishJob(job, manifest.stopped ? 'stopped' : manifest.status === 'failed' ? 'failed' : 'done', { status: manifest.status, dir: manifest.dir, totalBytes: manifest.totalBytes });
    } catch (err) {
      log(err);
      ev({ type: 'log', level: 'error', msg: err.message, at: Date.now() });
      store.patch(serverId, { lastRun: { at: new Date().toISOString(), status: 'failed', error: err.message, scheduled } });
      manifest = manifest || { status: 'failed', items: [{ label: 'Backup', status: 'failed', error: err.message }], totalBytes: 0 };
      finishJob(job, err.code === 'ABORTED' ? 'stopped' : 'failed', { status: 'failed', error: err.message });
    }
    send('servers-changed');
    await alert(server, manifest, scheduled);
  })();
  return publicJob(job);
}

async function alert(server, manifest, scheduled) {
  const ok = manifest.status === 'ok';
  if (scheduled && !ok && Notification.isSupported()) {
    new Notification({ title: 'ServerSnap', body: `Backup of ${server.name} ${manifest.status === 'partial' ? 'had problems' : 'failed'}.` }).show();
  }
  try {
    await notify.telegram(store.telegram(), notify.backupMessage(server, manifest, fmt));
  } catch (err) { log('telegram', err); }
}

function restoreJob({ dir, targetServerId, options }) {
  const target = store.get(targetServerId);
  if (!target) throw new Error('Target server not found');
  if (serverBusy(targetServerId)) throw new Error('Something is already running on this server.');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.dir = dir;
  const job = newJob('restore', targetServerId, `Restore ${manifest.server.name} → ${target.name}`);
  const ev = (e) => jobEvent(job, e);
  (async () => {
    try {
      const secrets = store.withSecrets(targetServerId);
      const summary = await runRestore({
        manifest, options: { ...options, hostDbPassword: options.hostDbPassword || secrets.hostDbPassword || '' },
        connect: () => connectServer(targetServerId), signal: job.controller.signal, onEvent: ev,
      });
      finishJob(job, summary.status === 'ok' ? 'done' : 'partial', summary);
    } catch (err) {
      log(err);
      ev({ type: 'log', level: 'error', msg: err.message, at: Date.now() });
      finishJob(job, err.code === 'ABORTED' ? 'stopped' : 'failed', { status: 'failed', error: err.message });
    }
  })();
  return publicJob(job);
}

// ---------- customer download access ----------
function clientList(serverId) {
  return (store.get(serverId).clients || []);
}

function findClient(serverId, clientId) {
  const c = clientList(serverId).find((x) => x.id === clientId);
  if (!c) throw new Error('Customer access not found.');
  return c;
}

function saveClient(serverId, c) {
  const list = clientList(serverId).filter((x) => x.id !== c.id);
  list.push(c);
  list.sort((a, b) => a.project.localeCompare(b.project));
  store.patch(serverId, { clients: list });
}

function accessCode(serverId, c) {
  const s = store.get(serverId);
  return clients.encodeCode({ name: c.name, project: c.project, host: s.host, port: s.port, user: c.user, privateKey: store.crypt.decrypt(c.keyEnc), hostKey: s.knownHostKey });
}

// What the dashboard group offers, with this customer's earlier choices ticked.
async function clientChoices(serverId, project) {
  const view = await dockerView(serverId, true);
  const g = view.groups.find((x) => x.name === project);
  if (!g) throw new Error(`Docker project "${project}" is not on this server.`);
  const existing = clientList(serverId).find((x) => x.project === project);
  const items = clients.itemChoices(g);
  if (existing) for (const i of items) i.on = existing.items.some((e) => e.key === i.key);
  return { project, items, existing: existing ? { id: existing.id, name: existing.name, time: existing.time, keep: existing.keep } : null };
}

// Logs in as the customer (key only, read-only folder) to prove the access really works.
async function testClientLogin(server, user, privateKey) {
  const r = new Remote({ host: server.host, port: server.port, username: user, privateKey, knownHostKey: server.knownHostKey });
  await r.connect();
  try {
    const sftp = await r.sftp();
    await sftpUtil.readdir(sftp, '/backups');
    let escaped = false;
    try { await sftpUtil.readdir(sftp, '/etc'); escaped = true; } catch (_) { /* expected: nothing outside the folder */ }
    if (escaped) throw new Error('The customer login can see outside its own folder. Access was not given.');
  } finally { r.close(); }
}

function clientJob(serverId, input) {
  const server = store.get(serverId);
  if (!server) throw new Error('Server not found');
  if (serverBusy(serverId)) throw new Error('Something is already running on this server. Wait for it to finish.');
  const project = String(input.project || '');
  const user = clients.clientUser(project);
  const items = (input.items || []).filter((i) => ['database', 'volume', 'files'].includes(i.type));
  if (!items.length) throw new Error('Choose at least one thing the customer can download.');
  const job = newJob('client', serverId, `Customer access for ${project}`);
  const ev = (e) => jobEvent(job, e);
  const say = (msg, level = 'info') => ev({ type: 'log', level, msg, at: Date.now() });
  const step = (id, label, status, detail) => ev({ type: 'item', item: { id, label, status, detail } });
  (async () => {
    let remote = null;
    try {
      const old = clientList(serverId).find((x) => x.project === project);
      let keyEnc = old && old.keyEnc;
      let publicKey = old && old.publicKey;
      if (!keyEnc) {
        const kp = clients.makeKeyPair(`serversnap-${user}`);
        keyEnc = store.crypt.encrypt(kp.privateKey);
        publicKey = kp.publicKey;
      }
      const record = {
        id: old ? old.id : crypto.randomUUID(), project, user, name: String(input.name || project).trim() || project,
        items: items.map((i) => ({ key: i.key, type: i.type, kind: i.kind, container: i.container, service: i.service, name: i.name, path: i.path, label: i.label })),
        keep: Math.max(1, Math.min(90, Number(input.keep) || 7)), time: /^\d{1,2}:\d{2}$/.test(input.time || '') ? input.time : '03:30',
        keyEnc, publicKey, createdAt: old ? old.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString(),
      };

      step('connect', 'Connect to the server', 'running');
      say(`Connecting to ${server.host}…`);
      remote = await connectServer(serverId);
      if (remote.priv === 'none') throw new Error('This needs root (or sudo) on the server.');
      step('connect', 'Connect to the server', 'ok');

      step('install', `Create the locked login "${user}" and the nightly job`, 'running');
      const script = clients.exportScript({ project, user, server, items: record.items, keep: record.keep });
      const out = await remote.run(clients.installScript({ user, publicKey, script, cron: clients.cronFile(user, record.time) }), { root: true, timeoutMs: 120000 });
      const sshdChanged = out.includes('SSHD-CHANGED');
      step('install', `Create the locked login "${user}" and the nightly job`, 'ok');
      say(`Login ${user} is ready. It can only read ${clients.BASE}/${user}/backups. Daily backup at ${record.time} (server time), keeping ${record.keep}.`);

      if (sshdChanged) {
        step('sshd', 'Check that you can still log in', 'running');
        say('SSH settings were changed for customer logins. Checking that your own login still works…');
        try {
          const again = await connectServer(serverId);
          again.close();
        } catch (err) {
          say(`Your login stopped working (${err.message}). Putting the SSH settings back…`, 'error');
          await remote.exec(clients.ROLLBACK_SSHD, { root: true, timeoutMs: 60000 });
          throw new Error('SSH settings were put back as they were, because your own login stopped working. Nothing else changed.');
        }
        step('sshd', 'Check that you can still log in', 'ok');
      }

      saveClient(serverId, record);
      send('servers-changed');

      step('test', 'Test the customer login', 'running');
      try {
        await testClientLogin(store.get(serverId), user, store.crypt.decrypt(keyEnc));
        step('test', 'Test the customer login', 'ok');
        say('Customer login works and sees only its own backups.');
      } catch (err) {
        step('test', 'Test the customer login', 'failed', err.message);
        say(`The customer login does not work yet: ${err.message}. ` +
          'If your SSH settings use AllowUsers or AllowGroups, add the group "serversnap-clients" there.', 'error');
        throw new Error(`Customer login test failed: ${err.message}`);
      }

      if (input.runNow !== false) {
        step('first', 'Make the first backup now', 'running');
        say('Making the first backup on the server (databases are copied the safe way)…');
        const r = await remote.exec(`/usr/local/sbin/serversnap-export-${user} 2>&1 | tee -a /var/log/serversnap-${user}.log`, { root: true, timeoutMs: 3 * 3600 * 1000, signal: job.controller.signal });
        for (const line of r.stdout.trim().split('\n').filter(Boolean)) say(line.replace(/^\[[^\]]+\]\s*/, ''), /failed/.test(line) ? 'warn' : 'info');
        step('first', 'Make the first backup now', /Done: .*\(ok,/.test(r.stdout) ? 'ok' : /Done:/.test(r.stdout) ? 'warning' : 'failed');
      }
      finishJob(job, 'done', { status: 'ok', clientId: record.id });
    } catch (err) {
      log(err);
      say(err.message, 'error');
      finishJob(job, err.code === 'ABORTED' ? 'stopped' : 'failed', { status: 'failed', error: err.message });
    } finally {
      if (remote) remote.close();
      send('servers-changed');
    }
  })();
  return publicJob(job);
}

function clientRunJob(serverId, clientId) {
  const c = findClient(serverId, clientId);
  if (serverBusy(serverId)) throw new Error('Something is already running on this server.');
  const job = newJob('client-run', serverId, `Customer backup for ${c.project}`);
  const say = (msg, level = 'info') => jobEvent(job, { type: 'log', level, msg, at: Date.now() });
  (async () => {
    try {
      const r = await withLive(serverId, (remote) => remote.exec(`/usr/local/sbin/serversnap-export-${c.user} 2>&1 | tee -a /var/log/serversnap-${c.user}.log`,
        { root: true, timeoutMs: 3 * 3600 * 1000, signal: job.controller.signal }));
      for (const line of r.stdout.trim().split('\n').filter(Boolean)) say(line.replace(/^\[[^\]]+\]\s*/, ''), /failed/.test(line) ? 'warn' : 'info');
      const ok = /Done: .*\(ok,/.test(r.stdout);
      finishJob(job, ok ? 'done' : /Done:/.test(r.stdout) ? 'partial' : 'failed', { status: ok ? 'ok' : 'failed' });
    } catch (err) {
      log(err);
      say(err.message, 'error');
      finishJob(job, err.code === 'ABORTED' ? 'stopped' : 'failed', { status: 'failed', error: err.message });
    }
  })();
  return publicJob(job);
}

// ---------- scheduler ----------
function tick() {
  for (const s of store.data.servers) {
    if (!serverBusy(s.id) && scheduler.isDue(s)) {
      log(`scheduled backup due for ${s.name}`);
      backupJob(s.id, { scheduled: true }).catch((e) => log('scheduled', e));
    }
  }
}

// ---------- IPC ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (err) {
      log(`ipc ${channel}`, err);
      return { ok: false, error: err.message, code: err.code || null };
    }
  });
}

function registerIpc() {
  handle('servers:list', () => store.data.servers.map(serverView));
  handle('servers:get', (id) => {
    const s = store.get(id);
    if (!s) throw new Error('Server not found');
    return { server: serverView(s), scan: scanView(s) };
  });
  handle('servers:save', (input) => {
    if (input.id && ['host', 'port', 'username', 'authType', 'keyPath', 'password', 'passphrase', 'sudoPassword'].some((k) => input[k] !== undefined)) dropLive(input.id);
    return serverView(store.upsert(input));
  });
  handle('servers:remove', (id) => { if (serverBusy(id)) throw new Error('Stop the running job first.'); dropLive(id); store.remove(id); return true; });
  handle('servers:forgetKey', (id) => { dropLive(id); store.patch(id, { knownHostKey: null }); return true; });
  handle('servers:test', async (id) => {
    const isNew = !store.get(id).knownHostKey;
    const r = await connectServer(id);
    try {
      const info = await r.exec('hostname; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s', { timeoutMs: 20000 });
      const [hostname, os] = info.stdout.trim().split('\n');
      return { hostKey: r.hostKey, firstTime: isNew, priv: r.priv, hostname, os };
    } finally { r.close(); }
  });
  handle('servers:scan', async (id) => {
    if (serverBusy(id)) throw new Error('A job is running on this server. Wait for it to finish.');
    const r = await connectServer(id);
    try {
      const sc = await scan(r, { onStep: (step) => send('scan-step', { id, step }) });
      store.patch(id, { lastScan: sc });
      return scanView(store.get(id));
    } finally { r.close(); }
  });
  handle('selection:set', (id, kind, itemId, value, defaultOn) => {
    const s = store.get(id);
    store.patch(id, { selection: selection.setChoice(s.selection, selection.keyOf(kind, itemId), value, defaultOn) });
    return scanView(store.get(id));
  });
  handle('selection:addFolder', (id, p) => {
    const s = store.get(id);
    store.patch(id, { selection: selection.addFolder(s.selection, p) });
    return scanView(store.get(id));
  });
  handle('selection:removeFolder', (id, p) => {
    const s = store.get(id);
    store.patch(id, { selection: selection.removeFolder(s.selection, p) });
    return scanView(store.get(id));
  });
  handle('selection:excludes', (id, list) => {
    const s = store.get(id);
    const sel = { ...selection.emptySelection(), ...(s.selection || {}), excludes: list.map((x) => String(x).trim()).filter(Boolean) };
    store.patch(id, { selection: sel });
    return scanView(store.get(id));
  });
  handle('backup:start', (id) => backupJob(id));
  handle('jobs:list', () => [...jobs.values()].map(publicJob));
  handle('jobs:stop', (jobId) => { const j = jobs.get(jobId); if (j && j.state === 'running') j.controller.abort(); return true; });
  handle('jobs:clear', () => { for (const [k, j] of jobs) if (j.state !== 'running') jobs.delete(k); return true; });
  handle('backups:list', async () => {
    const lists = await Promise.all(allRoots().map((r) => listBackups(r)));
    return lists.flat().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  });
  handle('backups:open', (dir) => shell.openPath(dir));
  handle('backups:delete', async (dir) => {
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error('Not a ServerSnap backup folder.');
    await fs.promises.rm(dir, { recursive: true, force: true });
    return true;
  });
  handle('backups:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a backup folder (it contains manifest.json)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    const m = JSON.parse(await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8').catch(() => '{}'));
    if (m.app !== 'ServerSnap') throw new Error('This folder is not a ServerSnap backup.');
    m.dir = dir;
    return m;
  });
  handle('restore:plan', (dir, options) => {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    m.dir = dir;
    const p = planRestore(m, options);
    return { files: p.files.map((f) => f.path), volumes: p.volumes.map((v) => ({ name: v.name, fromDump: v.fromDump })), dbs: p.dbs.map((d) => d.label), projects: p.projects.map((x) => x.name), needsDocker: p.needsDocker };
  });
  handle('restore:start', (args) => restoreJob(args));
  handle('settings:get', () => ({ ...store.settings(), defaultBackupRoot: defaultBackupRoot(), version: app.getVersion(), logFile }));
  handle('settings:set', (input) => {
    const out = store.setSettings(input);
    if (input.startWithWindows !== undefined) app.setLoginItemSettings({ openAtLogin: !!input.startWithWindows, args: ['--hidden'] });
    return out;
  });
  handle('settings:testTelegram', () => notify.telegram(store.telegram(), '✅ ServerSnap is connected. Backup alerts will come here.'));
  handle('dialog:folder', async (title) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:keyFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose your SSH private key', properties: ['openFile', 'showHiddenFiles'], defaultPath: path.join(app.getPath('home'), '.ssh') });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('app:openLog', () => shell.openPath(logFile));

  // Docker dashboard
  handle('docker:get', (id, withUsage) => dockerView(id, !!withUsage));
  handle('docker:action', async (id, action, target) => {
    if (!docker.ACTIONS.includes(action)) throw new Error('Unknown action');
    const fresh = await dockerView(id, false);
    const all = fresh.groups.flatMap((g) => g.containers);
    let list;
    if (target && target.container) list = all.filter((c) => c.id === target.container);
    else if (target && target.project) list = (fresh.groups.find((g) => g.name === target.project) || { containers: [] }).containers;
    else throw new Error('Nothing chosen.');
    if (!list.length) throw new Error('That container is no longer on the server. Press Refresh.');
    log(`docker ${action} on ${store.get(id).name}: ${list.map((c) => c.name).join(', ')}`);
    await withLive(id, (r) => r.run(docker.actionCommand(action, list), { root: r.priv !== 'none', timeoutMs: 5 * 60 * 1000 }));
    return dockerView(id, false);
  });
  // Delete containers: some of them ({ containers: [ids] }) or a whole project ({ project }).
  // withVolumes also deletes the named volumes only those containers use (their data).
  handle('docker:removeContainers', async (id, target, withVolumes) => {
    const fresh = await dockerView(id, false);
    const all = fresh.groups.flatMap((g) => g.containers);
    let list;
    let project = null;
    if (target && target.project) {
      const g = fresh.groups.find((x) => x.name === target.project);
      if (!g) throw new Error(`Project "${target.project}" is no longer on the server. Press Refresh.`);
      list = g.containers;
      project = g.name;
    } else {
      const want = new Set((target && target.containers) || []);
      list = all.filter((c) => want.has(c.id));
    }
    if (!list.length) throw new Error('Those containers are no longer on the server. Press Refresh.');
    const volumes = withVolumes ? docker.volumesOnlyUsedBy(list, all) : [];
    log(`docker DELETE on ${store.get(id).name}: ${list.map((c) => c.name).join(', ')}${volumes.length ? ` + volumes ${volumes.join(', ')}` : ''}`);
    const failed = [];
    await withLive(id, async (r) => {
      const root = r.priv !== 'none';
      await r.run(docker.removeContainersCommand(list, { project }), { root, timeoutMs: 5 * 60 * 1000 });
      for (const v of volumes) {
        const res = await r.exec(docker.removeVolumeCommand(v), { root, timeoutMs: 120000 });
        if (res.code !== 0) failed.push({ name: v, error: (res.stderr || '').trim().split('\n').pop() });
      }
    });
    return { view: await dockerView(id, true), removed: list.length, volumes: volumes.length - failed.length, failed };
  });
  // Delete images / volumes one by one; Docker itself refuses anything still in use.
  handle('docker:removeImages', async (id, imageIds) => {
    const fresh = await dockerView(id, false);
    const want = new Set(imageIds || []);
    const images = fresh.images.filter((i) => want.has(i.id));
    const failed = [];
    let removed = 0;
    await withLive(id, async (r) => {
      for (const img of images) {
        const name = img.tags[0] || img.shortId;
        if (img.usedBy.length) { failed.push({ name, error: `used by ${img.usedBy.join(', ')}` }); continue; }
        const res = await r.exec(docker.removeImageCommand(img), { root: r.priv !== 'none', timeoutMs: 120000 });
        if (res.code === 0) removed++; else failed.push({ name, error: (res.stderr || '').trim().split('\n').pop() });
      }
    });
    log(`docker image delete on ${store.get(id).name}: ${removed} removed, ${failed.length} refused`);
    return { view: await dockerView(id, false), removed, failed };
  });
  handle('docker:removeVolumes', async (id, names) => {
    const fresh = await dockerView(id, false);
    const inUse = new Set(fresh.groups.flatMap((g) => g.volumes).filter((v) => v.usedBy.length).map((v) => v.name));
    const failed = [];
    let removed = 0;
    await withLive(id, async (r) => {
      for (const n of names || []) {
        if (inUse.has(n)) { failed.push({ name: n, error: 'a container still uses it' }); continue; }
        const res = await r.exec(docker.removeVolumeCommand(n), { root: r.priv !== 'none', timeoutMs: 120000 });
        if (res.code === 0) removed++; else failed.push({ name: n, error: (res.stderr || '').trim().split('\n').pop() });
      }
    });
    log(`docker volume delete on ${store.get(id).name}: ${removed} removed, ${failed.length} refused`);
    return { view: await dockerView(id, true), removed, failed };
  });
  handle('docker:logs', (id, containerId, lines) => withLive(id, (r) => r.run(docker.logsCommand(containerId, lines), { root: r.priv !== 'none', timeoutMs: 60000 })));

  // Customer download access
  handle('clients:choices', (id, project) => clientChoices(id, project));
  handle('clients:save', (id, input) => clientJob(id, input));
  handle('clients:run', (id, clientId) => clientRunJob(id, clientId));
  handle('clients:status', async (id, clientId) => {
    const c = findClient(id, clientId);
    if (smokeFixture('status')) return smokeFixture('status');
    const out = await withLive(id, (r) => r.exec(clients.statusScript(c.user), { root: true, timeoutMs: 60000 }));
    return clients.parseStatus(out.stdout);
  });
  handle('clients:copyCode', (id, clientId) => { clipboard.writeText(accessCode(id, findClient(id, clientId))); return true; });
  handle('clients:saveCode', async (id, clientId) => {
    const c = findClient(id, clientId);
    const r = await dialog.showSaveDialog(win, { title: 'Save the access code for your customer', defaultPath: path.join(app.getPath('documents'), `${clients.clientUser(c.project)}.snapkey`), filters: [{ name: 'ServerSnap access code', extensions: ['snapkey'] }] });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, accessCode(id, c) + '\n');
    return r.filePath;
  });
  handle('clients:newCode', async (id, clientId) => {
    const c = findClient(id, clientId);
    const kp = clients.makeKeyPair(`serversnap-${c.user}`);
    await withLive(id, (r) => r.run(clients.rekeyScript(c.user, kp.publicKey), { root: true, timeoutMs: 60000 }));
    saveClient(id, { ...c, keyEnc: store.crypt.encrypt(kp.privateKey), publicKey: kp.publicKey, updatedAt: new Date().toISOString() });
    clipboard.writeText(accessCode(id, findClient(id, clientId)));
    return true;
  });
  handle('clients:remove', async (id, clientId, keepFiles) => {
    const c = findClient(id, clientId);
    await withLive(id, (r) => r.run(clients.removeScript(c.user, { keepFiles: !!keepFiles }), { root: true, timeoutMs: 60000 }));
    store.patch(id, { clients: clientList(id).filter((x) => x.id !== clientId) });
    send('servers-changed');
    return true;
  });
}

// ---------- window & tray ----------
function iconPath() {
  return path.join(__dirname, 'assets', 'icon.png');
}

function createWindow(show = true) {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 900, minHeight: 600, show: false,
    title: 'ServerSnap', icon: iconPath(), backgroundColor: '#0f1420', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => { if (show) win.show(); if (SMOKE) runSmoke(); });
  if (SMOKE) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) fs.appendFileSync(path.join(SMOKE, 'console.txt'), `${message} (${source}:${line})\n`);
    });
  }
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (!quitting && store.data.settings.closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
}

async function runSmoke() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const steps = JSON.parse(fs.readFileSync(path.join(SMOKE, 'steps.json'), 'utf8'));
  await wait(1500);
  for (const [name, js] of steps) {
    try { if (js) await win.webContents.executeJavaScript(js); } catch (e) { fs.appendFileSync(path.join(SMOKE, 'console.txt'), `step ${name}: ${e.message}\n`); }
    await wait(900);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SMOKE, `${name}.png`), img.toPNG());
  }
  quitting = true;
  app.exit(0);
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else { win.show(); if (win.isMinimized()) win.restore(); win.focus(); }
}

function refreshTray() {
  if (!tray) return;
  const running = [...jobs.values()].filter((j) => j.state === 'running');
  tray.setToolTip(running.length ? `ServerSnap — ${running[0].title}…` : 'ServerSnap — backups are watched');
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ServerSnap', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
  refreshTray();
}

app.on('second-instance', showWindow);
app.on('before-quit', (e) => {
  const running = [...jobs.values()].filter((j) => j.state === 'running');
  if (running.length && !app.forceQuit) {
    const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : null, {
      type: 'warning', buttons: ['Keep running', 'Quit anyway'], defaultId: 0, cancelId: 0,
      title: 'ServerSnap', message: `${running[0].title} is still running. Quitting now will stop it.`,
    });
    if (choice === 0) { e.preventDefault(); quitting = false; return; }
    app.forceQuit = true;
    for (const j of running) j.controller.abort();
  }
  quitting = true;
});
app.on('window-all-closed', () => { /* stay in the tray */ });

app.whenReady().then(() => {
  logFile = path.join(app.getPath('userData'), 'serversnap.log');
  try { if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, logFile + '.old'); } catch (_) { /* no log yet */ }
  log(`start v${app.getVersion()}`);
  store = new Store(path.join(app.getPath('userData'), 'serversnap.json'), crypt);
  registerIpc();
  createWindow(!process.argv.includes('--hidden'));
  createTray();
  setInterval(tick, 30000);
  setTimeout(tick, 15000);
});
