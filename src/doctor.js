'use strict';
// Site Doctor: "why is my website down?" One check of everything between the visitor and the
// app — DNS, the internet side, nginx, the nginx file, website files, backend / container,
// HTTPS certificate, disk and memory — then a plain answer and a fix button where one exists.
const https = require('https');
const http = require('http');
const { q } = require('./shell');
const { isDomain } = require('./deploy');

// Read-only, as root on the server.
function doctorScript(domain) {
  return `R="\${SNAP_ROOT:-}"
D=${q(domain)}
out() { printf '%s\\t%s\\n' "$1" "$2"; }
command -v nginx >/dev/null 2>&1 && out nginx 1 || out nginx 0
if command -v systemctl >/dev/null 2>&1 && systemctl cat nginx >/dev/null 2>&1; then out active "$(systemctl is-active nginx 2>/dev/null)"; fi
if command -v nginx >/dev/null 2>&1; then
  t=$(nginx -t 2>&1); out testrc $?
  printf '%s\\n' "$t" | tail -n 3 | while IFS= read -r l; do out testline "$l"; done
fi
F=""
for f in "$R"/etc/nginx/sites-enabled/* "$R"/etc/nginx/conf.d/*.conf; do
  [ -f "$f" ] || continue
  if grep -qE "server_name[^;]*[[:space:]]$D([[:space:];]|$)" "$f"; then F="$f"; break; fi
done
if [ -n "$F" ]; then
  out file "$F"
  r=$(grep -m1 -E '^[[:space:]]*root[[:space:]]' "$F" | sed -E 's/^[[:space:]]*root[[:space:]]+([^;]+);.*/\\1/')
  [ -n "$r" ] && { out root "$r"; [ -f "$R$r/index.html" ] && out index 1 || out index 0; }
  grep -oE 'proxy_pass[[:space:]]+https?://[^;/]+' "$F" | sed -E 's#.*://##' | sort -u | while read -r hp; do out upstream "$hp"; done
  c=$(grep -m1 -E '^[[:space:]]*ssl_certificate[[:space:]]' "$F" | sed -E 's/^[[:space:]]*ssl_certificate[[:space:]]+([^;]+);.*/\\1/')
  if [ -n "$c" ]; then
    out certfile "$c"
    if [ -f "$R$c" ]; then
      out certend "$(openssl x509 -enddate -noout -in "$R$c" 2>/dev/null | cut -d= -f2)"
      out certnames "$(openssl x509 -noout -ext subjectAltName -in "$R$c" 2>/dev/null | grep -oE 'DNS:[^,[:space:]]+' | sed 's/DNS://' | tr '\\n' ' ')"
    else out certmissing 1; fi
  fi
fi
for hp in $( [ -n "$F" ] && grep -oE 'proxy_pass[[:space:]]+https?://[^;/]+' "$F" | sed -E 's#.*://##' | sort -u ); do
  port=\${hp##*:}
  case "$port" in ''|*[!0-9]*) continue;; esac
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE ":$port$"; then out listen "$port 1"; else out listen "$port 0"; fi
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null); out upcode "$port $code"
  if command -v docker >/dev/null 2>&1; then
    docker ps -a --filter "publish=$port" --format '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}' 2>/dev/null | head -n 1 | while IFS="$(printf '\\t')" read -r id n st sts; do
      rc=$(docker inspect --format '{{.RestartCount}}' "$id" 2>/dev/null)
      out container "$port|$id|$n|$st|$sts|$rc"
      if [ "$st" != running ] || [ "\${rc:-0}" -gt 0 ]; then
        docker logs --tail 15 "$id" 2>&1 | cut -c1-300 | while IFS= read -r l; do out log "$id|$l"; done
      fi
    done
  fi
done
if command -v curl >/dev/null 2>&1; then
  out local443 "$(curl -sk -o /dev/null -m 10 -w '%{http_code}' --resolve "$D:443:127.0.0.1" "https://$D/" 2>/dev/null)"
  out local80 "$(curl -s -o /dev/null -m 10 -w '%{http_code}' --resolve "$D:80:127.0.0.1" "http://$D/" 2>/dev/null)"
fi
out disk "$(df -P / 2>/dev/null | tail -n 1 | awk '{print $5" "$4}')"
out mem "$(free -m 2>/dev/null | awk '/^Mem:/ {print $2" "$7}')"
EL="$R/var/log/nginx/error.log"
[ -f "$EL" ] && grep -E "$D|upstream" "$EL" 2>/dev/null | tail -n 6 | cut -c1-300 | while IFS= read -r l; do out errlog "$l"; done
true
`;
}

function parseDoctor(text) {
  const o = { testLines: [], upstreams: [], listen: {}, upcode: {}, containers: {}, logs: {}, errlog: [] };
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const i = line.indexOf('\t');
    if (i < 0) continue;
    const k = line.slice(0, i);
    const v = line.slice(i + 1);
    if (k === 'nginx') o.nginx = v === '1';
    else if (k === 'active') o.active = v;
    else if (k === 'testrc') o.testOk = v === '0';
    else if (k === 'testline') o.testLines.push(v);
    else if (k === 'file') o.file = v;
    else if (k === 'root') o.root = v;
    else if (k === 'index') o.index = v === '1';
    else if (k === 'upstream') o.upstreams.push(v);
    else if (k === 'certfile') o.certFile = v;
    else if (k === 'certmissing') o.certMissing = true;
    else if (k === 'certend') o.certEnd = v ? new Date(v).toISOString() : null;
    else if (k === 'certnames') o.certNames = v.trim().split(/\s+/).filter(Boolean);
    else if (k === 'listen') { const [p, x] = v.split(' '); o.listen[p] = x === '1'; }
    else if (k === 'upcode') { const [p, c] = v.split(' '); o.upcode[p] = Number(c) || 0; }
    else if (k === 'container') {
      const [port, id, name, st, status, rc] = v.split('|');
      o.containers[port] = { id, name, state: st, status, restarts: Number(rc) || 0 };
    } else if (k === 'log') { const j = v.indexOf('|'); const id = v.slice(0, j); (o.logs[id] = o.logs[id] || []).push(v.slice(j + 1)); }
    else if (k === 'local443') o.local443 = Number(v) || 0;
    else if (k === 'local80') o.local80 = Number(v) || 0;
    else if (k === 'disk') { const [pct, free] = v.split(' '); o.diskPct = parseInt(pct, 10); o.diskFreeKb = Number(free) || null; }
    else if (k === 'mem') { const [total, avail] = v.split(' '); o.memTotal = Number(total) || null; o.memAvail = Number(avail) || null; }
    else if (k === 'errlog') o.errlog.push(v);
  }
  return o;
}

// The website as a visitor sees it, from this PC. { code, server, error, ms }
function outsideCheck(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'ServerSnap-SiteDoctor' } }, (res) => {
      res.resume();
      resolve({ code: res.statusCode, server: String(res.headers.server || ''), location: res.headers.location || null, ms: Date.now() - t0 });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('no answer (timeout)'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => resolve({ code: 0, error: e.code || e.message, ms: Date.now() - t0 }));
  });
}

const ERR_TEXT = {
  ETIMEDOUT: 'no answer (timeout)', ECONNREFUSED: 'connection refused', ECONNRESET: 'connection cut', ENOTFOUND: 'domain not found',
  CERT_HAS_EXPIRED: 'the HTTPS certificate has expired', ERR_TLS_CERT_ALTNAME_INVALID: 'the HTTPS certificate is for another domain',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'the HTTPS certificate is not trusted (self-signed)', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the HTTPS certificate is not trusted',
  SELF_SIGNED_CERT_IN_CHAIN: 'the HTTPS certificate is not trusted', EPROTO: 'HTTPS is not set up on the server',
};
const errText = (e) => ERR_TEXT[e] || e;
const okCode = (c) => c >= 200 && c < 400;

// Turns everything into findings: { level: ok|warn|fail, title, text, fix?, logs? }, worst first.
function diagnose({ domain, dns, outside, server: s, behindProxy }) {
  const f = [];
  const add = (level, title, text, extra = {}) => f.push({ level, title, text, ...extra });
  const cdn = /cloudflare/i.test((outside && outside.server) || '') || behindProxy;

  // DNS
  if (!dns.ips.length) add('fail', 'DNS', `${domain} has no DNS record. At your domain company add an A record: ${domain} → ${dns.serverIps[0] || 'the server IP'}.`);
  else if (!dns.ok && cdn) add('ok', 'DNS', `${domain} goes through Cloudflare (${dns.ips.join(', ')}). That is fine if you set it up that way.`);
  else if (!dns.ok) add('fail', 'DNS', `${domain} points to ${dns.ips.join(', ')}, not to this server (${dns.serverIps.join(', ')}). Set the A record to the server IP. If it is Namecheap, also turn OFF their "HTTPS / SSL" proxy switch for this domain.`);
  else add('ok', 'DNS', `${domain} points to this server (${dns.ips.join(', ')}).`);

  // nginx
  if (!s.nginx) add('fail', 'nginx', 'nginx is not installed on the server, so no website can be served. Deploy a website once and ServerSnap installs it.');
  else if (s.active && s.active !== 'active') add('fail', 'nginx', `nginx is not running (${s.active}).`, { fix: { action: 'start-nginx', label: 'Start nginx' } });
  else if (s.testOk === false) add('fail', 'nginx', `nginx has an error in its files: ${s.testLines.filter((l) => /emerg|error|failed/i.test(l)).join(' ') || s.testLines.join(' ')}`);
  else add('ok', 'nginx', 'nginx is running and its files are fine.');

  if (s.nginx && !s.file) add('fail', 'nginx file', `No switched-on nginx file serves ${domain}. Add it in the Deploy tab ("Websites + domains only").`);
  else if (s.file) add('ok', 'nginx file', s.file);

  if (s.root) {
    if (s.index === false) add('fail', 'Website files', `${s.root}/index.html is missing: the website folder is empty or the build was not copied. Deploy the website again.`);
    else add('ok', 'Website files', `${s.root} has index.html.`);
  }

  // backends / containers behind nginx
  for (const up of s.upstreams) {
    const port = String(up).split(':').pop();
    const c = s.containers[port];
    const logs = c && s.logs[c.id];
    if (s.listen[port] === false) {
      if (c && c.state !== 'running') add('fail', `Port ${port}`, `Nothing answers on port ${port}: the container ${c.name} is ${c.state} (${c.status}).`, { fix: { action: 'start-container', id: c.id, label: `Start ${c.name}` }, logs });
      else if (c) add('fail', `Port ${port}`, `Nothing answers on port ${port} although ${c.name} is ${c.state}. The app inside may still be starting or has crashed.`, { fix: { action: 'restart-container', id: c.id, label: `Restart ${c.name}` }, logs });
      else add('fail', `Port ${port}`, `nginx sends visitors to ${up}, but nothing runs on port ${port} (no container publishes it). This gives "502 Bad Gateway". Start the project in the Docker tab.`);
      continue;
    }
    if (c && c.state === 'restarting') add('fail', `Port ${port}`, `${c.name} keeps crashing and restarting (${c.restarts} restarts). See its last lines below.`, { fix: { action: 'restart-container', id: c.id, label: `Restart ${c.name}` }, logs });
    else if (s.upcode[port] >= 500) add('warn', `Port ${port}`, `${c ? c.name : up} answers with error ${s.upcode[port]}.`, { logs, fix: c ? { action: 'restart-container', id: c.id, label: `Restart ${c.name}` } : null });
    else if (c && c.restarts > 3) add('warn', `Port ${port}`, `${c.name} runs, but restarted ${c.restarts} times. It may crash now and then.`, { logs });
    else add('ok', `Port ${port}`, `${c ? c.name : 'The app'} answers on port ${port}${s.upcode[port] ? ` (${s.upcode[port]})` : ''}.`);
  }

  // HTTPS certificate
  if (s.certFile) {
    const name = (s.certFile.match(/\/live\/([^/]+)\//) || [])[1];
    const renew = name ? { action: 'renew-cert', name, label: 'Renew the certificate' } : null;
    const days = s.certEnd ? Math.floor((new Date(s.certEnd) - Date.now()) / 86400000) : null;
    if (s.certMissing) add('fail', 'HTTPS', `The nginx file uses ${s.certFile}, but that file is missing. Deploy the website again to get a new certificate.`);
    else if (s.certNames && s.certNames.length && !s.certNames.some((n) => n === domain || (n.startsWith('*.') && domain.endsWith(n.slice(1))))) add('fail', 'HTTPS', `The certificate is for ${s.certNames.join(', ')}, not for ${domain}. Browsers will show a warning.`, { fix: renew });
    else if (days != null && days < 0) add('fail', 'HTTPS', `The certificate expired ${-days} days ago. Visitors see a security warning.`, { fix: renew });
    else if (days != null && days < 15) add('warn', 'HTTPS', `The certificate ends in ${days} days. It should renew by itself; if not, renew it now.`, { fix: renew });
    else add('ok', 'HTTPS', `Certificate valid until ${s.certEnd ? new Date(s.certEnd).toDateString() : '?'}${days != null ? ` (${days} days)` : ''}.`);
  } else if (s.file) add('warn', 'HTTPS', `${domain} has no HTTPS. Switch on HTTPS for it in the Deploy tab.`);

  // the site from the server itself, and from the internet
  const local = s.certFile ? s.local443 : s.local80;
  if (s.file && local) {
    if (okCode(local)) add('ok', 'On the server', `The website answers ${local} on the server itself.`);
    else add('fail', 'On the server', `The website answers ${local} on the server itself${local === 502 ? ' (502 = nginx cannot reach the app behind it)' : local === 404 ? ' (404 = page not found)' : ''}.`);
  }
  if (outside) {
    if (outside.code && okCode(outside.code)) add('ok', 'From the internet', `Visitors get ${outside.code} in ${outside.ms} ms.`);
    else if (outside.code) add('fail', 'From the internet', `Visitors get error ${outside.code}${outside.server ? ` from "${outside.server}"` : ''}.${okCode(local) && !dns.ok ? ' The server itself is fine: the problem is between the visitors and the server (DNS or the domain company\'s proxy).' : ''}`);
    else add('fail', 'From the internet', `Visitors cannot open it: ${errText(outside.error)}.${okCode(local) ? ' The server itself is fine: check DNS, a firewall, or the domain company\'s proxy.' : ''}`);
  }

  // the machine
  if (s.diskPct >= 95) add('fail', 'Disk', `The disk is ${s.diskPct}% full. Databases and uploads stop working when it is full. Delete old Docker images in the Docker tab.`);
  else if (s.diskPct >= 85) add('warn', 'Disk', `The disk is ${s.diskPct}% full.`);
  else if (s.diskPct) add('ok', 'Disk', `${s.diskPct}% used.`);
  if (s.memAvail != null && s.memAvail < 150) add('warn', 'Memory', `Only ${s.memAvail} MB of ${s.memTotal} MB memory free. Apps can crash when memory runs out.`);
  else if (s.memAvail != null) add('ok', 'Memory', `${s.memAvail} MB of ${s.memTotal} MB free.`);

  const order = { fail: 0, warn: 1, ok: 2 };
  const sorted = f.map((x, i) => ({ ...x, i })).sort((a, b) => order[a.level] - order[b.level] || a.i - b.i).map(({ i, ...x }) => x);
  const worst = sorted[0];
  const verdict = !worst || worst.level === 'ok' ? `${domain} works. Everything checked is fine.`
    : `${worst.level === 'fail' ? 'Problem' : 'Worth a look'}: ${worst.text}`;
  return { domain, verdict, level: worst ? worst.level : 'ok', findings: sorted, errlog: s.errlog || [] };
}

// Commands for the fix buttons (validated, run as root).
const CERT_NAME_RE = /^[a-z0-9.-]{1,253}$/;
function fixCommand(fix) {
  if (fix.action === 'start-nginx') return 'systemctl restart nginx 2>&1 || nginx 2>&1';
  if (fix.action === 'renew-cert') {
    if (!CERT_NAME_RE.test(String(fix.name || ''))) throw new Error('Bad certificate name.');
    return `certbot renew --cert-name ${q(fix.name)} --non-interactive 2>&1 && (systemctl reload nginx 2>/dev/null || nginx -s reload)`;
  }
  throw new Error('Unknown fix.');
}

function checkDomain(d) {
  const domain = String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  if (!isDomain(domain)) throw new Error('Enter a domain like example.com');
  return domain;
}

module.exports = { doctorScript, parseDoctor, outsideCheck, diagnose, fixCommand, checkDomain, errText };
