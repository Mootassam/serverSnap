'use strict';
// Uninstaller, run as: electron.exe "<install>\app" --uninstall [--quiet]
// It runs through the official electron.exe, which Windows Smart App Control trusts.
// (Inno Setup's own unins000.exe is unsigned and made at install time, so Smart App Control
// blocks it; the installer points Windows "Apps > Uninstall" here instead.)
const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

const client = fs.existsSync(path.join(__dirname, 'client.flag'));
const NAME = client ? 'ServerSnap Client' : 'ServerSnap';
// Electron's "Start with Windows" entry is named after the app id (see app.setAppUserModelId).
const RUN_NAMES = client ? ['com.serversnap.client', NAME] : ['com.serversnap.app', NAME];
// Our own Electron keeps files open in its data folder: use a throw-away one, so the real one can be deleted.
app.setPath('userData', path.join(app.getPath('temp'), `serversnap-uninstall-${process.pid}`));
const quiet = process.argv.includes('--quiet');
const appDir = __dirname;                       // <install>\app
const installDir = path.dirname(appDir);        // <install>
const marker = path.join(installDir, 'serversnap-install.json');

function readMarker() {
  try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (_) { return null; }
}

function sys(exe) { return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe); }

// Other copies of this app (from this install folder) hold files open: stop them.
function stopRunningCopies() {
  const ps = sys('WindowsPowerShell\\v1.0\\powershell.exe');
  const dir = installDir.toLowerCase().replace(/'/g, "''");
  const cmd = `Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${process.pid} -and $_.Path -and $_.Path.ToLower().StartsWith('${dir}') } | Stop-Process -Force -ErrorAction SilentlyContinue`;
  try { execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 20000 }); } catch (_) { /* nothing running */ }
}

function removeShortcuts() {
  const places = [path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'), app.getPath('desktop')];
  for (const dir of places) for (const name of [`${NAME}.lnk`, `Uninstall ${NAME}.lnk`]) fs.rmSync(path.join(dir, name), { force: true });
}

function removeRegistry(info) {
  try { execFileSync(sys('reg.exe'), ['delete', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${info.uninstallKey}`, '/f'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* already gone */ }
  // "Start with Windows"
  for (const name of RUN_NAMES) {
    try { execFileSync(sys('reg.exe'), ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', name, '/f'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* was not set */ }
  }
}

// The install folder is deleted by cmd.exe a moment after this process exits (files in use now).
function removeInstallFolderAfterExit() {
  // verbatim: Node's own quoting (\") is not understood by cmd.exe; /s strips the outer quotes
  const script = `ping -n 4 127.0.0.1 >nul & rmdir /s /q "${installDir}"`;
  spawn(sys('cmd.exe'), [`/d /s /c "${script}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, cwd: path.dirname(installDir) }).unref();
}

async function run() {
  const info = readMarker();
  if (!info) {
    if (!quiet) dialog.showErrorBox(NAME, 'This copy of the app was not installed with the installer, so there is nothing to uninstall.');
    return app.exit(1);
  }
  let deleteData = false;
  if (!quiet) {
    const r = await dialog.showMessageBox({
      type: 'question', title: `Uninstall ${NAME}`, buttons: ['Uninstall', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
      message: `Uninstall ${NAME}?`,
      detail: client ? 'Backups you downloaded stay in your Documents folder.' : 'Backup files in your backup folder (Documents\\ServerSnap Backups) are kept. Nothing on your servers is changed.',
      checkboxLabel: client ? 'Also delete my access codes and settings' : 'Also delete my saved servers and settings', checkboxChecked: false,
    });
    if (r.response !== 0) return app.exit(0);
    deleteData = r.checkboxChecked;
  }
  stopRunningCopies();
  removeShortcuts();
  removeRegistry(info);
  if (deleteData) {
    const data = client ? path.join(app.getPath('appData'), 'ServerSnap Client') : path.join(app.getPath('appData'), 'ServerSnap');
    try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (_) { /* a file still in use; the rest is gone */ }
  }
  removeInstallFolderAfterExit();
  if (!quiet) await dialog.showMessageBox({ type: 'info', title: NAME, message: `${NAME} was uninstalled.`, buttons: ['OK'] });
  try { fs.rmSync(app.getPath('userData'), { recursive: true, force: true }); } catch (_) { /* a temp folder; Windows cleans it */ }
  app.exit(0);
}

app.whenReady().then(run);
