'use strict';
// ServerSnap Client: the customer's app. It holds one or more access codes and downloads
// the daily backups the server prepares for that customer. It cannot change anything.
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, safeStorage, powerSaveBlocker, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Remote } = require('./src/ssh');
const { decodeCode } = require('./src/clients');
const sftpUtil = require('./src/sftp');
const { slug } = require('./src/shell');

app.setName('ServerSnap Client');
app.setAppUserModelId('com.serversnap.client');
const SMOKE = process.env.SERVERSNAP_SMOKE || null;
app.setPath('userData', SMOKE ? path.join(SMOKE, 'clientData') : path.join(app.getPath('appData'), 'ServerSnap Client'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let tray = null;
let quitting = false;
let logFile = null;
let data = null;
let dataFile = null;
const jobs = new Map();
let jobSeq = 0;

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try { fs.appendFileSync(logFile, line); } catch (_) { /* never crash on logging */ }
}
process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandled', e));

const crypt = {
  encrypt: (s) => (safeStorage.isEncryptionAvailable() ? 'v1:' + safeStorage.encryptString(s).toString('base64') : 'p0:' + Buffer.from(s, 'utf8').toString('base64')),
  decrypt: (s) => {
    if (!s) return '';
    if (s.startsWith('v1:')) return safeStorage.decryptString(Buffer.from(s.slice(3), 'base64'));
    if (s.startsWith('p0:')) return Buffer.from(s.slice(3), 'base64').toString('utf8');
    return '';
  },
};

// ---------- saved data ----------
function defaults() {
  return { version: 1, settings: { downloadRoot: null, autoDownload: true, keep: 14, closeToTray: true, startWithWindows: false }, accesses: [] };
}

function load() {
  const d = defaults();
  for (const f of [dataFile, dataFile + '.bak']) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      return { ...d, ...j, settings: { ...d.settings, ...(j.settings || {}) } };
    } catch (_) { /* try the next copy */ }
  }
  return d;
}

function save() {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile + '.tmp', JSON.stringify(data, null, 2));
  if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, dataFile + '.bak');
  fs.renameSync(dataFile + '.tmp', dataFile);
}

const downloadRoot = () => data.settings.downloadRoot || path.join(app.getPath('documents'), 'ServerSnap Client');
const accessDir = (a) => path.join(downloadRoot(), slug(a.name || a.project));

function getAccess(id) {
  const a = data.accesses.find((x) => x.id === id);
  if (!a) throw new Error('Website not found.');
  return a;
}

function view(a) {
  const { keyEnc, ...rest } = a;
  return { ...rest, folder: accessDir(a), running: [...jobs.values()].some((j) => j.accessId === a.id && j.state === 'running') };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- server access ----------
async function connect(a) {
  const r = new Remote({ host: a.host, port: a.port, username: a.user, privateKey: crypt.decrypt(a.keyEnc), knownHostKey: a.hostKey || null });
  try {
    await r.connect();
  } catch (err) {
    if (/Wrong username, password or key/.test(err.message)) {
      throw new Error('The server did not accept this access code. It may have been cancelled or replaced: ask for a new code.');
    }
    throw err;
  }
  if (!a.hostKey && r.hostKey) { a.hostKey = r.hostKey; save(); }
  return r;
}

const { isBackupName } = sftpUtil;

function localState(a, name) {
  const dir = path.join(accessDir(a), name);
  return fs.existsSync(path.join(dir, 'manifest.json')) ? dir : null;
}

async function listRemote(a) {
  const fx = SMOKE && path.join(SMOKE, 'client-backups.json');
  if (fx && fs.existsSync(fx)) return JSON.parse(fs.readFileSync(fx, 'utf8')).map((b) => ({ ...b, local: localState(a, b.name) }));
  const r = await connect(a);
  try {
    const sftp = await r.sftp();
    const names = (await sftpUtil.readdir(sftp, '/backups')).map((e) => e.filename).filter(isBackupName).sort().reverse();
    const out = [];
    for (const name of names) {
      let m = null;
      try { m = JSON.parse((await sftpUtil.readFile(sftp, `/backups/${name}/manifest.json`)).toString('utf8')); } catch (_) { /* being written */ }
      if (!m) continue;
      out.push({ name, status: m.status, createdAt: m.createdAt, totalBytes: m.totalBytes, items: (m.items || []).map((i) => ({ label: i.label, type: i.type, status: i.status, bytes: i.bytes })), local: localState(a, name) });
    }
    a.lastCheck = new Date().toISOString();
    save();
    return out;
  } finally { r.close(); }
}

// Keeps the newest N downloads on this PC.
async function tidy(a) {
  const root = accessDir(a);
  const keep = Math.max(1, Number(data.settings.keep) || 14);
  const names = (await fs.promises.readdir(root).catch(() => [])).filter((n) => isBackupName(n) && fs.existsSync(path.join(root, n, 'manifest.json'))).sort().reverse();
  for (const n of names.slice(keep)) await fs.promises.rm(path.join(root, n), { recursive: true, force: true });
}

function newJob(a, title) {
  const job = { id: `job${++jobSeq}`, accessId: a.id, title, state: 'running', startedAt: Date.now(), bytes: 0, total: 0, file: '', error: null, controller: new AbortController() };
  jobs.set(job.id, job);
  job.blocker = powerSaveBlocker.start('prevent-app-suspension');
  emit(job);
  return job;
}

function publicJob(j) {
  const { controller, blocker, ...rest } = j;
  return rest;
}

let emitTimer = null;
const dirty = new Set();
function emit(job, now = true) {
  dirty.add(job);
  if (now) { flush(); return; }
  if (!emitTimer) emitTimer = setTimeout(flush, 250);
}
function flush() {
  clearTimeout(emitTimer);
  emitTimer = null;
  for (const j of dirty) send('job', publicJob(j));
  dirty.clear();
}

function downloadJob(accessId, name, { auto = false } = {}) {
  const a = getAccess(accessId);
  if ([...jobs.values()].some((j) => j.accessId === a.id && j.state === 'running')) throw new Error('A download for this website is already running.');
  const job = newJob(a, `${a.name}: backup of ${name.slice(0, 10)}`);
  job.name = name;
  (async () => {
    let r = null;
    try {
      r = await connect(a);
      const sftp = await r.sftp();
      const m = JSON.parse((await sftpUtil.readFile(sftp, `/backups/${name}/manifest.json`)).toString('utf8'));
      const items = (m.items || []).filter((i) => i.status === 'ok' || i.status === 'warning');
      job.total = items.reduce((s, i) => s + (i.bytes || 0), 0);
      const dir = path.join(accessDir(a), name);
      let done = 0;
      for (const it of items) {
        if (!/^(databases|volumes|files)\/[A-Za-z0-9._-]+$/.test(it.file)) throw new Error(`Unexpected file name in the backup: ${it.file}`);
        const local = path.join(dir, ...it.file.split('/'));
        await fs.promises.mkdir(path.dirname(local), { recursive: true });
        job.file = it.label;
        const have = fs.existsSync(local) && (await sftpUtil.sha256File(local)) === it.sha256;
        if (!have) {
          await sftpUtil.download(sftp, `/backups/${name}/${it.file}`, local, {
            sha256: it.sha256, signal: job.controller.signal,
            onBytes: (b) => { job.bytes = done + b; emit(job, false); },
          });
        }
        done += it.bytes || 0;
        job.bytes = done;
        emit(job, false);
      }
      m.downloadedAt = new Date().toISOString();
      await fs.promises.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
      a.lastDownload = { name, at: m.downloadedAt };
      save();
      await tidy(a);
      job.state = 'done';
      job.dir = dir;
      if (auto && Notification.isSupported()) new Notification({ title: 'ServerSnap Client', body: `New backup of ${a.name} downloaded.` }).show();
    } catch (err) {
      log(err);
      job.state = err.code === 'ABORTED' ? 'stopped' : 'failed';
      job.error = err.message;
      if (auto && Notification.isSupported()) new Notification({ title: 'ServerSnap Client', body: `Could not download the backup of ${a.name}: ${err.message}` }).show();
    } finally {
      if (r) r.close();
      job.finishedAt = Date.now();
      try { powerSaveBlocker.stop(job.blocker); } catch (_) { /* already stopped */ }
      emit(job);
    }
  })();
  return publicJob(job);
}

// "Make a backup now": ask the server, wait for the new backup, then download it.
function backupNowJob(accessId) {
  const a = getAccess(accessId);
  if ([...jobs.values()].some((j) => j.accessId === a.id && j.state === 'running')) throw new Error('Something is already running for this website.');
  const job = newJob(a, `${a.name}: new backup`);
  job.kind = 'backup-now';
  job.phase = 'asking';
  (async () => {
    let r = null;
    let name = null;
    try {
      r = await connect(a);
      const sftp = await r.sftp();
      name = await sftpUtil.requestBackup(sftp, { signal: job.controller.signal, onState: (p) => { job.phase = p; emit(job); } });
      log(`backup now for ${a.name}: ${name}`);
      job.state = 'done';
      job.name = name;
    } catch (err) {
      log(err);
      job.state = err.code === 'ABORTED' ? 'stopped' : 'failed';
      job.error = err.message;
    } finally {
      if (r) r.close();
      job.finishedAt = Date.now();
      try { powerSaveBlocker.stop(job.blocker); } catch (_) { /* already stopped */ }
      emit(job);
    }
    if (name) {
      try { downloadJob(a.id, name); } catch (err) { log(err); }
    }
  })();
  return publicJob(job);
}

// Automatic: download the newest backup of every website if it is not on this PC yet.
let ticking = false;
async function tick() {
  if (ticking || !data.settings.autoDownload) return;
  ticking = true;
  try {
    for (const a of data.accesses) {
      if ([...jobs.values()].some((j) => j.accessId === a.id && j.state === 'running')) continue;
      try {
        const list = await listRemote(a);
        const newest = list.find((b) => b.status === 'ok' || b.status === 'partial');
        if (newest && !newest.local) { log(`auto download ${a.name} ${newest.name}`); downloadJob(a.id, newest.name, { auto: true }); }
        send('accesses-changed');
      } catch (err) { log(`auto check ${a.name}`, err); }
    }
  } finally { ticking = false; }
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
  handle('app:mode', () => 'client');
  handle('access:list', () => data.accesses.map(view));
  handle('access:add', async (code) => {
    const c = decodeCode(code);
    const existing = data.accesses.find((x) => x.host === c.host && x.user === c.user);
    const a = existing || { id: crypto.randomUUID(), addedAt: new Date().toISOString() };
    Object.assign(a, { name: c.name, project: c.project, host: c.host, port: c.port, user: c.user, hostKey: c.hostKey, keyEnc: crypt.encrypt(c.privateKey) });
    const r = await connect(a); // proves the code works before saving it
    try { await sftpUtil.readdir(await r.sftp(), '/backups'); } finally { r.close(); }
    if (!existing) data.accesses.push(a);
    save();
    return view(a);
  });
  handle('access:rename', (id, name) => { const a = getAccess(id); a.name = String(name || '').trim() || a.project; save(); return view(a); });
  handle('access:remove', (id) => { data.accesses = data.accesses.filter((x) => x.id !== id); save(); return true; });
  handle('access:backups', async (id) => listRemote(getAccess(id)));
  handle('access:download', (id, name) => downloadJob(id, name));
  handle('access:backupNow', (id) => backupNowJob(id));
  handle('access:openFolder', async (id) => {
    const dir = accessDir(getAccess(id));
    await fs.promises.mkdir(dir, { recursive: true });
    return shell.openPath(dir);
  });
  handle('codeFile:open', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open the access code file', properties: ['openFile'], filters: [{ name: 'ServerSnap access code', extensions: ['snapkey', 'txt'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return (await fs.promises.readFile(r.filePaths[0], 'utf8')).slice(0, 20000);
  });
  handle('jobs:list', () => [...jobs.values()].map(publicJob));
  handle('jobs:stop', (jobId) => { const j = jobs.get(jobId); if (j && j.state === 'running') j.controller.abort(); return true; });
  handle('backups:open', (dir) => shell.openPath(dir));
  handle('settings:get', () => ({ ...data.settings, defaultDownloadRoot: path.join(app.getPath('documents'), 'ServerSnap Client'), version: app.getVersion(), logFile }));
  handle('settings:set', (input) => {
    for (const k of ['downloadRoot', 'autoDownload', 'keep', 'closeToTray', 'startWithWindows']) if (input[k] !== undefined) data.settings[k] = input[k];
    data.settings.keep = Math.max(1, Math.min(365, Number(data.settings.keep) || 14));
    save();
    // electron.exe needs the app folder as its first argument (installed and dev alike)
    if (input.startWithWindows !== undefined) app.setLoginItemSettings({ openAtLogin: !!input.startWithWindows, args: [app.getAppPath(), '--client', '--hidden'] });
    return data.settings;
  });
  handle('dialog:folder', async (title) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('app:openLog', () => shell.openPath(logFile));
}

// ---------- window & tray ----------
const iconPath = () => path.join(__dirname, 'assets', 'icon.png');

function createWindow(show = true) {
  win = new BrowserWindow({
    width: 1000, height: 700, minWidth: 780, minHeight: 520, show: false,
    title: 'ServerSnap Client', icon: iconPath(), backgroundColor: '#0f1420', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'client.html'));
  win.once('ready-to-show', () => { if (show) win.show(); if (SMOKE) runSmoke(); });
  if (SMOKE) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) fs.appendFileSync(path.join(SMOKE, 'console.txt'), `[client] ${message} (${source}:${line})\n`);
    });
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => { if (!quitting && data.settings.closeToTray) { e.preventDefault(); win.hide(); } });
}

async function runSmoke() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const steps = JSON.parse(fs.readFileSync(path.join(SMOKE, 'client-steps.json'), 'utf8'));
  await wait(1500);
  for (const [name, js] of steps) {
    try { if (js) await win.webContents.executeJavaScript(js); } catch (e) { fs.appendFileSync(path.join(SMOKE, 'console.txt'), `client step ${name}: ${e.message}\n`); }
    await wait(900);
    fs.writeFileSync(path.join(SMOKE, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  quitting = true;
  app.exit(0);
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else { win.show(); if (win.isMinimized()) win.restore(); win.focus(); }
}

app.on('second-instance', showWindow);
app.on('before-quit', (e) => {
  const running = [...jobs.values()].filter((j) => j.state === 'running');
  if (running.length && !app.forceQuit) {
    const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : null, {
      type: 'warning', buttons: ['Keep downloading', 'Quit anyway'], defaultId: 0, cancelId: 0,
      title: 'ServerSnap Client', message: 'A download is still running. Quitting now will stop it.',
    });
    if (choice === 0) { e.preventDefault(); quitting = false; return; }
    app.forceQuit = true;
    for (const j of running) j.controller.abort();
  }
  quitting = true;
});
app.on('window-all-closed', () => { /* stay in the tray */ });

app.whenReady().then(() => {
  logFile = path.join(app.getPath('userData'), 'serversnap-client.log');
  try { if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, logFile + '.old'); } catch (_) { /* no log yet */ }
  dataFile = path.join(app.getPath('userData'), 'serversnap-client.json');
  data = load();
  log(`client start v${app.getVersion()}`);
  registerIpc();
  createWindow(!process.argv.includes('--hidden'));
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  tray.setToolTip('ServerSnap Client');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open ServerSnap Client', click: showWindow }, { type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } }]));
  tray.on('click', showWindow);
  if (!SMOKE) {
    setTimeout(tick, 20000);
    setInterval(tick, 30 * 60 * 1000);
  }
});
