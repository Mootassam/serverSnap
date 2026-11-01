'use strict';
// Attack Shield: read-only look at who is trying to break into the server (SSH password
// guessing and nginx scanning for /wp-admin, .env, …), who fail2ban already banned, and the
// IPs you blocked by hand. Plus one-click block / unblock.
//
// Every path is read under "${SNAP_ROOT:-}" so the tests can point it at a scratch folder
// with fake log files and fake fail2ban-client / ufw / geoiplookup in PATH.
const { q } = require('./shell');

const MARK = 'serversnap-blocked'; // comment put on the ufw rules we add, so we know they are ours
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// A real, public IPv4. We refuse to block private / loopback / your own kind of address,
// because that could lock you (or the whole server) out.
function validIp(ip) {
  const m = IPV4.exec(String(ip || '').trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  const [a, b] = p;
  if (a === 0 || a === 127 || a === 10 || a === 255) return null; // this host, loopback, private, broadcast
  if (a === 192 && b === 168) return null;
  if (a === 172 && b >= 16 && b <= 31) return null;
  if (a === 169 && b === 254) return null; // link-local
  if (a >= 224) return null; // multicast / reserved
  return p.join('.');
}

// Bad paths bots scan for (used by the nginx part of the scan). No "/" so it stays a valid
// awk /…/ regex; these tokens are distinctive enough on their own.
const BAD_PATHS = 'wp-admin|wp-login|xmlrpc|\\.env|\\.git|phpmyadmin|adminer|boaform|hnap|eval-stdin|cgi-bin|\\.aws|actuator';

// Read-only. Collects SSH attempts, nginx scans, fail2ban bans, our own ufw blocks, and
// (if geoiplookup is on the server) a rough country per IP.
function statusScript({ days = 7, min = 5 } = {}) {
  const d = Math.min(90, Math.max(1, Math.round(Number(days) || 7)));
  const m = Math.min(1000, Math.max(1, Math.round(Number(min) || 5)));
  return `R="\${SNAP_ROOT:-}"
# ---- SSH: failed logins grouped by IP (count, last line's time, usernames tried) ----
SSHLOG=$({ journalctl _COMM=sshd -o short-iso --since "${d} days ago" --no-pager 2>/dev/null; cat "$R"/var/log/auth.log "$R"/var/log/auth.log.1 "$R"/var/log/secure "$R"/var/log/secure.1 2>/dev/null; } |
  grep -aE 'Failed password|Invalid user|authentication failure|Connection (closed|reset) by (authenticating|invalid) user|Disconnected from authenticating user|Did not receive identification' 2>/dev/null |
  awk '{
    ip=""; for(i=1;i<=NF;i++){ if($i ~ /^([0-9]{1,3}\\.){3}[0-9]{1,3}$/){ ip=$i; break } }
    if(ip==""){ next }
    c[ip]++; when[ip]=$1
    for(i=1;i<NF;i++){ if($i=="user"){ u=$(i+1); if(u!="" && index(uu[ip],"|"u"|")==0 && n[ip]<6){ uu[ip]=uu[ip]"|"u"|"; users[ip]=users[ip](users[ip]==""?"":",")u; n[ip]++ } } }
  } END { for(ip in c) printf "%s\\t%d\\t%s\\t%s\\n", ip, c[ip], when[ip], users[ip] }' |
  awk -F'\\t' '$2 >= ${m}' | sort -t"$(printf '\\t')" -k2 -nr | head -n 80)
echo @@SSH
printf '%s\\n' "$SSHLOG"
# ---- nginx: bad status codes and scans for known paths ----
WEBLOG=$(cat "$R"/var/log/nginx/access.log "$R"/var/log/nginx/access.log.1 2>/dev/null |
  awk '$9 ~ /^(400|401|403|404|405|444)$/ || $7 ~ /(${BAD_PATHS})/ { ip=$1; c[ip]++; when[ip]=$4; if($9 ~ /^[0-9]+$/ && index(ss[ip],"|"$9"|")==0 && m[ip]<4){ ss[ip]=ss[ip]"|"$9"|"; codes[ip]=codes[ip](codes[ip]==""?"":",")$9; m[ip]++ } }
  END { for(ip in c) printf "%s\\t%d\\t%s\\t%s\\n", ip, c[ip], when[ip], codes[ip] }' |
  awk -F'\\t' '$2 >= ${m}' | sort -t"$(printf '\\t')" -k2 -nr | head -n 80)
echo @@WEB
printf '%s\\n' "$WEBLOG"
# ---- fail2ban: who is banned right now ----
echo @@BANNED
if command -v fail2ban-client >/dev/null 2>&1; then
  for j in $(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do
    ips=$(fail2ban-client status "$j" 2>/dev/null | sed -n 's/.*Banned IP list:[[:space:]]*//p')
    for ip in $ips; do printf '%s\\t%s\\n' "$ip" "$j"; done
  done
fi
# ---- ufw: the IPs we blocked by hand (tagged ${MARK}) and other deny rules ----
echo @@UFW
if command -v ufw >/dev/null 2>&1; then ufw status 2>/dev/null | grep -iE 'deny|reject'; fi
# ---- country (best effort; only if geoiplookup is installed) ----
echo @@GEO
if command -v geoiplookup >/dev/null 2>&1; then
  { printf '%s\\n' "$SSHLOG" "$WEBLOG" | cut -f1; ufw status 2>/dev/null | grep -iE 'deny|reject' | grep -oE '([0-9]{1,3}\\.){3}[0-9]{1,3}'; } |
    grep -E '^([0-9]{1,3}\\.){3}[0-9]{1,3}$' | sort -u | head -n 120 |
    while read -r ip; do printf '%s\\t%s\\n' "$ip" "$(geoiplookup "$ip" 2>/dev/null | sed -n '1s/.*: //p' | cut -d, -f2- | sed 's/^ //')"; done
fi
echo @@END
`;
}

// Pulls one IPv4 out of a ufw rule line like "Anywhere  DENY IN  203.0.113.4" or
// "203.0.113.4  REJECT  Anywhere".
function ipFromUfw(line) {
  const m = String(line).match(/([0-9]{1,3}\.){3}[0-9]{1,3}/);
  return m ? m[0] : null;
}

function parseStatus(text) {
  const out = { ssh: [], web: [], banned: [], blocked: [], geo: {}, hasGeo: false };
  let sec = null;
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^@@(SSH|WEB|BANNED|UFW|GEO|END)$/);
    if (h) { sec = h[1]; if (sec === 'GEO') out.hasGeo = false; continue; }
    if (!line.trim()) continue;
    const p = line.split('\t');
    if (sec === 'SSH') {
      const ip = (p[0] || '').trim();
      if (IPV4.test(ip)) out.ssh.push({ ip, count: Number(p[1]) || 0, last: p[2] || '', users: (p[3] || '').split(',').filter(Boolean) });
    } else if (sec === 'WEB') {
      const ip = (p[0] || '').trim();
      if (IPV4.test(ip)) out.web.push({ ip, count: Number(p[1]) || 0, last: (p[2] || '').replace(/^\[/, ''), codes: (p[3] || '').split(',').filter(Boolean) });
    } else if (sec === 'BANNED') {
      const ip = (p[0] || '').trim();
      if (IPV4.test(ip)) out.banned.push({ ip, jail: (p[1] || '').trim() });
    } else if (sec === 'UFW') {
      const ip = ipFromUfw(line);
      if (ip && !out.blocked.includes(ip)) out.blocked.push(ip);
    } else if (sec === 'GEO') {
      const ip = (p[0] || '').trim();
      if (IPV4.test(ip)) { out.hasGeo = true; if (p[1] && p[1].trim()) out.geo[ip] = p[1].trim(); }
    }
  }
  return out;
}

// One list for the screen: every attacking IP with where it was seen, its worst behaviour,
// and whether it is already blocked / banned. Sorted by total tries.
function attackers(st) {
  const by = new Map();
  const get = (ip) => by.get(ip) || (by.set(ip, { ip, ssh: 0, web: 0, users: [], codes: [], last: '', banned: null, blocked: false }), by.get(ip));
  for (const s of st.ssh) { const a = get(s.ip); a.ssh = s.count; a.users = s.users; a.last = s.last || a.last; }
  for (const w of st.web) { const a = get(w.ip); a.web = w.count; a.codes = w.codes; a.last = a.last || w.last; }
  for (const b of st.banned) { const a = get(b.ip); a.banned = b.jail; }
  for (const ip of st.blocked) { const a = get(ip); a.blocked = true; }
  for (const a of by.values()) { a.total = a.ssh + a.web; a.country = st.geo[a.ip] || null; }
  return [...by.values()].sort((x, y) => (y.banned || y.blocked ? -1 : 0) - (x.banned || x.blocked ? -1 : 0) || y.total - x.total);
}

// Block an IP: a ufw deny rule (tagged so we recognise it) and a fail2ban ban on every jail.
// ufw rules survive a reboot. Echoes @@OK or @@ERR.
function blockScript(ipIn) {
  const ip = validIp(ipIn);
  if (!ip) throw new Error('That is not a public IP address I can block. (Private, loopback and your own network are refused on purpose.)');
  return `set -u
IP=${q(ip)}
done=0
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active; then
  ufw status 2>/dev/null | grep -q "$IP" || ufw insert 1 deny from "$IP" to any comment ${q(MARK)} >/dev/null 2>&1 || ufw insert 1 deny from "$IP" >/dev/null 2>&1
  done=1
fi
if command -v fail2ban-client >/dev/null 2>&1; then
  for j in $(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do
    fail2ban-client set "$j" banip "$IP" >/dev/null 2>&1 && done=1
  done
fi
if [ "$done" = 0 ]; then
  if command -v iptables >/dev/null 2>&1; then
    iptables -C INPUT -s "$IP" -j DROP 2>/dev/null || iptables -I INPUT -s "$IP" -j DROP && done=1
  fi
fi
[ "$done" = 1 ] && echo "@@OK $IP" || echo "@@ERR No firewall (ufw / fail2ban / iptables) is available to block with."
`;
}

// Undo a block: remove our ufw deny rules for the IP and unban it everywhere.
function unblockScript(ipIn) {
  const ip = validIp(ipIn);
  if (!ip) throw new Error('That is not a valid IP address.');
  return `set -u
IP=${q(ip)}
if command -v ufw >/dev/null 2>&1; then
  # delete every deny/reject rule for this IP (numbered, from the bottom up so numbers stay valid)
  for n in $(ufw status numbered 2>/dev/null | grep "$IP" | grep -iE 'deny|reject' | grep -oE '^\\[[ ]*[0-9]+\\]' | grep -oE '[0-9]+' | sort -rn); do
    yes | ufw delete "$n" >/dev/null 2>&1
  done
fi
if command -v fail2ban-client >/dev/null 2>&1; then
  for j in $(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do
    fail2ban-client set "$j" unbanip "$IP" >/dev/null 2>&1
  done
fi
command -v iptables >/dev/null 2>&1 && iptables -D INPUT -s "$IP" -j DROP 2>/dev/null
echo "@@OK $IP"
`;
}

// Reads the @@OK / @@ERR line from a block / unblock run.
function parseResult(text) {
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const ok = line.match(/^@@OK (.+)$/);
    if (ok) return { ok: true, ip: ok[1].trim() };
    const err = line.match(/^@@ERR (.+)$/);
    if (err) return { ok: false, error: err[1].trim() };
  }
  return { ok: false, error: 'The server gave no answer.' };
}

module.exports = { validIp, statusScript, parseStatus, attackers, blockScript, unblockScript, parseResult, ipFromUfw, MARK, BAD_PATHS };
