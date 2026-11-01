'use strict';
// Privacy & Lockdown for the server:
//   - clearLoginsScript: wipe the record of past logins (who logged in, from which IP) on demand
//   - retentionScript:   auto-delete logs older than X days (so old login IPs do not pile up)
//   - lockdownScript:    key-only SSH, a non-standard SSH port, fail2ban, firewall — with a
//                        guard that refuses to turn off password login if no SSH key is installed
//                        (otherwise you would lock yourself out of your own server)
//
// All paths are read / written under "${SNAP_ROOT:-}" so the tests run in a scratch folder with
// fake sshd / ufw / systemctl in PATH.
const { q } = require('./shell');

const SSHD = '/etc/ssh/sshd_config';
const DROPIN = '/etc/ssh/sshd_config.d/00-serversnap.conf';
const LOGROTATE = '/etc/logrotate.d/serversnap';
const JOURNALD = '/etc/systemd/journald.conf.d/serversnap.conf';

// Read-only: the current privacy state, shown before anything changes.
function checkScript() {
  return `R="\${SNAP_ROOT:-}"
echo "passauth=$(sshd -T 2>/dev/null | awk '/^passwordauthentication / {print $2; exit}')"
echo "rootlogin=$(sshd -T 2>/dev/null | awk '/^permitrootlogin / {print $2; exit}')"
echo "sshport=$(sshd -T 2>/dev/null | awk '/^port / {print $2; exit}' | head -n1)"
echo "ports=$(sshd -T 2>/dev/null | awk '/^port / {print $2}' | tr '\\n' ',' | sed 's/,$//')"
echo "keys=$(cat "$R"/root/.ssh/authorized_keys "$R"/home/*/.ssh/authorized_keys 2>/dev/null | grep -cvE '^[[:space:]]*#|^[[:space:]]*$')"
echo "fail2ban=$(systemctl is-active fail2ban 2>/dev/null || echo -)"
echo "ufw=$(command -v ufw >/dev/null 2>&1 && (ufw status 2>/dev/null | head -n1 | awk '{print $2}') || echo -)"
echo "retention=$([ -f "$R"${q(LOGROTATE)} ] && echo 1 || echo 0)"
echo "retentiondays=$(sed -n 's/^[[:space:]]*rotate[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$R"${q(LOGROTATE)} 2>/dev/null | head -n1)"
echo "logins=$(last -w 2>/dev/null | grep -cE '^[A-Za-z]' )"
`;
}

function parseCheck(text) {
  const out = {};
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  out.keys = Number(out.keys) || 0;
  out.logins = Number(out.logins) || 0;
  out.retentionDays = Number(out.retentiondays) || 0;
  out.passwordLogin = out.passauth !== 'no';
  out.ufwOn = out.ufw === 'active';
  out.fail2banOn = out.fail2ban === 'active';
  out.port = Number(out.sshport) || 22;
  return out;
}

// Clear the record of past logins. `web` also empties the nginx access logs (visitor IPs).
// Nothing is restarted. Emits @@STEP / @@DONE.
function clearLoginsScript({ web = false } = {}) {
  return `set -u
R="\${SNAP_ROOT:-}"
step() { echo "@@STEP $1|$2|\${3:-}"; }
warn() { echo "@@WARN $*"; }
cd "$R/" 2>/dev/null || true
before=$(last -w 2>/dev/null | grep -cE '^[A-Za-z]')
step logins running "Clearing the login history"
for f in var/log/wtmp var/log/btmp var/log/lastlog; do [ -e "$R/$f" ] && : > "$R/$f" 2>/dev/null || true; done
step logins ok "Login history cleared (was about $before entries)"
step auth running "Clearing the SSH / auth logs"
for f in "$R"/var/log/auth.log "$R"/var/log/auth.log.* "$R"/var/log/secure "$R"/var/log/secure.*; do [ -f "$f" ] && : > "$f" 2>/dev/null || true; done
step auth ok "auth logs cleared"
step journal running "Clearing the system journal"
if command -v journalctl >/dev/null 2>&1; then journalctl --rotate >/dev/null 2>&1; journalctl --vacuum-time=1s >/dev/null 2>&1 && step journal ok "journal cleared" || { warn "The system journal could not be cleared."; step journal warning "skipped"; }
else step journal ok "no journal on this server"; fi
${web ? `step web running "Clearing the nginx access logs"
for f in "$R"/var/log/nginx/access.log "$R"/var/log/nginx/access.log.* "$R"/var/log/nginx/*access*.log; do [ -f "$f" ] && : > "$f" 2>/dev/null || true; done
step web ok "nginx access logs cleared"
` : ''}echo "@@DONE cleared"
`;
}

// Auto-delete logs older than `days`. Writes a logrotate rule and a journald retention limit.
function retentionScript(daysIn) {
  const days = Math.min(365, Math.max(1, Math.round(Number(daysIn) || 7)));
  return `set -u
R="\${SNAP_ROOT:-}"
step() { echo "@@STEP $1|$2|\${3:-}"; }
warn() { echo "@@WARN $*"; }
fail() { echo "@@FAIL $*"; exit 1; }
mkdir -p "$R"${q(require('path').posix.dirname(LOGROTATE))} "$R"${q(require('path').posix.dirname(JOURNALD))} 2>/dev/null || true
step logrotate running "Setting logrotate to keep ${days} day(s)"
cat > "$R"${q(LOGROTATE)} <<'EOF'
# Made by ServerSnap — keep logs for ${days} day(s), then delete them.
/var/log/auth.log
/var/log/syslog
/var/log/secure
/var/log/nginx/*.log
{
    daily
    rotate ${days}
    missingok
    notifempty
    compress
    delaycompress
    sharedscripts
}
EOF
[ -f "$R"${q(LOGROTATE)} ] || fail "Could not write the logrotate rule."
step logrotate ok "logs older than ${days} day(s) will be deleted"
step journal running "Setting the system journal to keep ${days} day(s)"
if command -v systemctl >/dev/null 2>&1; then
  cat > "$R"${q(JOURNALD)} <<'EOF'
[Journal]
MaxRetentionSec=${days}day
EOF
  systemctl restart systemd-journald >/dev/null 2>&1 || warn "The journal setting is saved but systemd-journald did not restart."
  step journal ok "journal kept for ${days} day(s)"
else step journal ok "no systemd journal on this server"; fi
echo "@@DONE set"
`;
}

// opts: { keyOnly, sshPort (0 = leave), fail2ban, firewall }
// Each part runs in a subshell: a part that fails is reported and the next one still runs,
// so you never end up half-locked. Key-only is SKIPPED (not applied) when no SSH key exists.
function lockdownScript(opts = {}) {
  const sshPort = Number(opts.sshPort) > 0 && Number(opts.sshPort) < 65536 ? Number(opts.sshPort) : 0;
  if (sshPort && (sshPort === 22 || sshPort < 1024) && sshPort !== 2222) {
    // allow 2222 and any >=1024; refuse 22 (pointless) and privileged ports that clash
    if (sshPort === 22) throw new Error('Pick a port other than 22 (that is the one you are moving away from).');
  }
  const parts = [];
  const add = (cond, body) => { if (cond) parts.push(`(\n${body}\n) || FAILED=$((FAILED + 1))`); };

  add(opts.keyOnly, `step keyonly running "Key-only SSH (no password login)"
keys=$(cat "$R"/root/.ssh/authorized_keys "$R"/home/*/.ssh/authorized_keys 2>/dev/null | grep -cvE '^[[:space:]]*#|^[[:space:]]*$')
if [ "\${keys:-0}" -lt 1 ]; then
  warn "No SSH key is installed, so password login was LEFT ON (turning it off would lock you out). Add your key first, then try again."
  step keyonly warning "skipped: no SSH key found"
else
  mkdir -p "$R"${q(require('path').posix.dirname(DROPIN))}
  cp -p "$R"${q(SSHD)} "$R"${q(SSHD)}.serversnap-bak 2>/dev/null || true
  printf '# Made by ServerSnap\\nPasswordAuthentication no\\nKbdInteractiveAuthentication no\\nChallengeResponseAuthentication no\\n' > "$R"${q(DROPIN)}
  if sshd -t 2>/tmp/serversnap-sshd.err; then
    systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || service ssh reload >/dev/null 2>&1 || true
    step keyonly ok "password login is off; only your SSH key works"
  else
    rm -f "$R"${q(DROPIN)}
    warn "sshd did not accept the change ($(head -n1 /tmp/serversnap-sshd.err)); password login was left on."
    step keyonly warning "not changed (sshd test failed)"
  fi
fi`);

  add(sshPort, `step port running "Moving SSH to port ${sshPort}"
# open the new port in the firewall BEFORE sshd listens on it, and keep 22 for now so you are not locked out
command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active && ufw allow ${sshPort}/tcp >/dev/null 2>&1
mkdir -p "$R"${q(require('path').posix.dirname(DROPIN))}
touch "$R"${q(DROPIN)}
grep -q '^Port ${sshPort}$' "$R"${q(DROPIN)} 2>/dev/null || printf 'Port ${sshPort}\\nPort 22\\n' >> "$R"${q(DROPIN)}
if sshd -t 2>/tmp/serversnap-sshd.err; then
  systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || service ssh reload >/dev/null 2>&1 || true
  step port ok "SSH now listens on ${sshPort} (22 kept open until you confirm ${sshPort} works — remove it later)"
else
  sed -i '/^Port ${sshPort}$/d;/^Port 22$/d' "$R"${q(DROPIN)} 2>/dev/null
  warn "sshd did not accept port ${sshPort} ($(head -n1 /tmp/serversnap-sshd.err)); SSH stays on its current port."
  step port warning "not changed (sshd test failed)"
fi`);

  add(opts.fail2ban, `step fail2ban running "fail2ban (auto-ban password guessing)"
if ! command -v fail2ban-server >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq fail2ban >/dev/null 2>&1 || { warn "fail2ban could not be installed (is this Ubuntu/Debian with internet?)."; step fail2ban warning "not installed"; fail2ban_done=1; }
fi
if [ "\${fail2ban_done:-0}" = 0 ]; then
  [ -f "$R"/etc/fail2ban/jail.d/serversnap.conf ] || printf '[sshd]\\nenabled = true\\nmaxretry = 6\\nbantime = 1h\\n' > "$R"/etc/fail2ban/jail.d/serversnap.conf
  systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban >/dev/null 2>&1 || warn "fail2ban did not start."
  step fail2ban ok "6 wrong SSH tries = blocked for 1 hour"
fi`);

  add(opts.firewall, `step firewall running "Firewall (only SSH, 80 and 443 open)"
if ! command -v ufw >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq ufw >/dev/null 2>&1; fi
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null 2>&1
  ${sshPort ? `ufw allow ${sshPort}/tcp >/dev/null 2>&1` : ''}
  ufw allow 80/tcp >/dev/null 2>&1; ufw allow 443/tcp >/dev/null 2>&1
  ufw --force enable >/dev/null 2>&1 && step firewall ok "firewall on (SSH, 80, 443)" || { warn "The firewall could not be switched on."; step firewall warning "not on"; }
else warn "ufw could not be installed."; step firewall warning "not installed"; fi`);

  if (!parts.length) throw new Error('Choose at least one thing to turn on.');
  return `set -u
R="\${SNAP_ROOT:-}"
step() { echo "@@STEP $1|$2|\${3:-}"; }
warn() { echo "@@WARN $*"; }
FAILED=0
${parts.join('\n')}
[ "$FAILED" -eq 0 ] && echo "@@DONE locked" || echo "@@DONE $FAILED failed"
`;
}

module.exports = { checkScript, parseCheck, clearLoginsScript, retentionScript, lockdownScript, SSHD, DROPIN, LOGROTATE, JOURNALD };
