'use strict';
// The PC side of deploying: build a website folder, pack folders for upload, check DNS.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dns = require('dns');
const { spawn } = require('child_process');

// Windows 10/11 ship bsdtar; elsewhere use the tar on PATH.
function tarBin() {
  const win = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return process.platform === 'win32' && fs.existsSync(win) ? win : 'tar';
}

function run(cmd, args, { cwd, onLine, signal, shell = false, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell, windowsHide: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0', ...env } });
    let tail = '';
    const take = (d) => {
      const s = d.toString('utf8');
      tail = (tail + s).slice(-4000);
      if (onLine) for (const l of s.split(/\r?\n/)) if (l.trim()) onLine(l.replace(/\x1b\[[0-9;]*m/g, ''));
    };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    const onAbort = () => { try { p.kill(); } catch (_) { /* gone */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    p.on('error', (e) => { if (signal) signal.removeEventListener('abort', onAbort); reject(e); });
    p.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) { const e = new Error('Stopped by you.'); e.code = 'ABORTED'; return reject(e); }
      if (code === 0) resolve(tail);
      else { const e = new Error(tail.trim().split('\n').slice(-4).join('\n') || `${cmd} exited with ${code}`); e.code = code; reject(e); }
    });
  });
}

// npm run build in a website folder (npm install first when node_modules is missing).
// CI=false: with CI on, react-scripts stops the build on any lint warning.
async function buildSite(dir, { onLine, signal, script = 'build' } = {}) {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    if (onLine) onLine('node_modules is missing: running npm install first (this can take a few minutes)…');
    await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, onLine, signal, shell: true });
  }
  await run('npm', ['run', script], { cwd: dir, onLine, signal, shell: true, env: { CI: 'false' } });
  return distOf(dir);
}

// The folder that holds the finished website: dist/, build/, or the folder itself for plain HTML.
function distOf(dir) {
  for (const d of ['dist', 'build']) if (fs.existsSync(path.join(dir, d, 'index.html'))) return path.join(dir, d);
  if (fs.existsSync(path.join(dir, 'index.html')) && !fs.existsSync(path.join(dir, 'package.json'))) return dir;
  return null;
}

// Packs a folder into a .tar.gz in the temp folder (without the excluded names). Returns its path.
async function pack(dir, { exclude = [], signal, name = 'snap' } = {}) {
  const out = path.join(os.tmpdir(), `serversnap-${name}-${process.pid}-${Date.now()}.tar.gz`);
  const args = ['-czf', out];
  for (const x of exclude) args.push('--exclude', x);
  args.push('-C', dir, '.');
  await run(tarBin(), args, { signal });
  return out;
}

const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

async function ipsOf(name) {
  if (net.isIP(name)) return [name];
  try { return await resolver.resolve4(name); } catch (_) { return []; }
}

// Does the domain point straight at the server? (Public DNS, so the PC's cache cannot fool us.)
async function dnsCheck(domain, serverHost) {
  const [serverIps, ips] = await Promise.all([ipsOf(serverHost), ipsOf(domain)]);
  const ok = ips.length > 0 && ips.every((ip) => serverIps.includes(ip));
  return { ok, ips, serverIps };
}

function dnsMessage(domain, r) {
  if (!r.ips.length) return `${domain} has no DNS record yet. Add an A record for ${domain} → ${r.serverIps[0] || 'the server IP'} at your domain company, wait a few minutes, then deploy again.`;
  return `${domain} points to ${r.ips.join(', ')}, not to this server (${r.serverIps.join(', ')}). ` +
    'At your domain company, set the A record to the server IP. If it is Namecheap, also turn OFF their "HTTPS / SSL" proxy switch for this domain. ' +
    'If the domain is behind Cloudflare on purpose, tick "Behind Cloudflare / proxy" for this website.';
}

module.exports = { buildSite, distOf, pack, dnsCheck, dnsMessage, run, tarBin };
