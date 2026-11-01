'use strict';
// "Set up server": makes a fresh VPS ready for deploys in one go.
// Debian / Ubuntu (apt). Every part checks first and skips what is already there,
// so pressing it again on a ready server changes nothing.
const { q } = require('./shell');

// What can be set up, in the order it runs. `def` = ticked by default.
const PARTS = [
  { id: 'base', label: 'Basic tools (git, curl, unzip, htop)', def: true },
  { id: 'docker', label: 'Docker + Docker Compose', def: true },
  { id: 'nginx', label: 'nginx (web server)', def: true },
  { id: 'certbot', label: 'certbot (free HTTPS certificates)', def: true },
  { id: 'node', label: 'Node.js 20 + npm (only if you build on the server)', def: false },
  { id: 'swap', label: 'Swap memory (stops small servers from crashing)', def: true },
  { id: 'firewall', label: 'Firewall: only SSH, 80 and 443 open', def: true },
  { id: 'fail2ban', label: 'fail2ban (blocks password guessing on SSH)', def: true },
  { id: 'updates', label: 'Automatic security updates', def: true },
  { id: 'timezone', label: 'Time zone', def: false },
];

// Read-only: what is installed already (shown before anything runs).
function checkScript() {
  return `v() { command -v "$1" >/dev/null 2>&1 && { "$@" 2>&1 | head -n 1 | tr -d '\\r'; } || echo -; }
echo "os=$(. /etc/os-release 2>/dev/null; echo "\${PRETTY_NAME:-unknown}")"
echo "apt=$(command -v apt-get >/dev/null 2>&1 && echo 1 || echo 0)"
echo "git=$(v git --version)"
echo "docker=$(v docker --version)"
c=$(docker compose version 2>/dev/null | head -n 1); echo "compose=\${c:--}"
echo "nginx=$(command -v nginx >/dev/null 2>&1 && nginx -v 2>&1 | head -n 1 || echo -)"
echo "certbot=$(v certbot --version)"
echo "node=$(v node --version)"
echo "swap=$(awk 'NR>1 {s+=$3} END {print s+0}' /proc/swaps 2>/dev/null)"
echo "mem=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)"
echo "disk=$(df -Pk / 2>/dev/null | awk 'NR==2 {print $4}')"
echo "ufw=$(command -v ufw >/dev/null 2>&1 && (ufw status 2>/dev/null | head -n 1 | awk '{print $2}') || echo -)"
echo "fail2ban=$(systemctl is-active fail2ban 2>/dev/null || echo -)"
echo "updates=$(dpkg -s unattended-upgrades >/dev/null 2>&1 && echo installed || echo -)"
echo "tz=$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo -)"
echo "sshport=$(sshd -T 2>/dev/null | awk '/^port / {print $2; exit}')"
`;
}

function parseCheck(text) {
  const out = {};
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  for (const k of ['swap', 'mem', 'disk']) out[k] = Number(out[k]) || 0;
  return out;
}

const TZ_RE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

// opts: { parts: ['docker', …], swapGb, sshPort, timezone }
function setupScript(opts) {
  const on = new Set(opts.parts || []);
  const swapGb = Math.min(16, Math.max(1, Math.round(Number(opts.swapGb) || 2)));
  const sshPort = Number(opts.sshPort) > 0 && Number(opts.sshPort) < 65536 ? Number(opts.sshPort) : 22;
  if (on.has('timezone') && !TZ_RE.test(opts.timezone || '')) throw new Error('Choose a time zone like Asia/Kolkata or Europe/Paris.');
  const parts = [];
  // each part runs in a subshell: a failed part is marked and the next one still runs
  const add = (id, body) => { if (on.has(id)) parts.push(`# ---- ${id}\nPART=${id}\n(\n${body}\n) || FAILED=$((FAILED + 1))`); };

  add('base', `step base running "Basic tools"
apt_install git curl ca-certificates unzip htop || fail "Could not install the basic tools."
step base ok "$(git --version)"`);

  add('docker', `step docker running "Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh >/tmp/serversnap-docker.log 2>&1 || { tail -n 5 /tmp/serversnap-docker.log; fail "Docker could not be installed."; }
fi
systemctl enable --now docker >/dev/null 2>&1 || true
if ! docker compose version >/dev/null 2>&1; then apt_install docker-compose-plugin || warn "Docker Compose could not be installed."; fi
# keep container logs from filling the disk
if [ ! -s /etc/docker/daemon.json ]; then
  mkdir -p /etc/docker
  printf '{\\n  "log-driver": "json-file",\\n  "log-opts": { "max-size": "20m", "max-file": "3" }\\n}\\n' > /etc/docker/daemon.json
  systemctl restart docker >/dev/null 2>&1 || true
fi
docker info >/dev/null 2>&1 || fail "Docker is installed but does not run."
step docker ok "$(docker --version | cut -d, -f1) · $(docker compose version 2>/dev/null | head -n 1)"`);

  add('nginx', `step nginx running "nginx"
command -v nginx >/dev/null 2>&1 || apt_install nginx || fail "nginx could not be installed."
systemctl enable --now nginx >/dev/null 2>&1 || true
step nginx ok "$(nginx -v 2>&1)"`);

  add('certbot', `step certbot running "certbot"
command -v certbot >/dev/null 2>&1 || apt_install certbot python3-certbot-nginx || fail "certbot could not be installed."
step certbot ok "$(certbot --version 2>&1)"`);

  add('node', `step node running "Node.js"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | tr -d v | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/tmp/serversnap-node.log 2>&1 && apt_install nodejs || fail "Node.js could not be installed."
fi
step node ok "node $(node -v) · npm $(npm -v)"`);

  add('swap', `step swap running "Swap memory"
have=$(awk 'NR>1 {s+=$3} END {print s+0}' /proc/swaps)
if [ "$have" -gt 0 ]; then step swap ok "already $((have / 1024)) MB"
else
  free_kb=$(df -Pk / | awk 'NR==2 {print $4}')
  if [ "$free_kb" -lt $(( (${swapGb} + 2) * 1048576 )) ]; then warn "Not enough free disk for ${swapGb} GB of swap."; step swap warning "skipped: disk too full"
  else
    (fallocate -l ${swapGb}G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=$((${swapGb} * 1024)) status=none) &&
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile || fail "The swap file could not be made."
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sysctl -q vm.swappiness=10; grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
    step swap ok "${swapGb} GB"
  fi
fi`);

  add('firewall', `step firewall running "Firewall"
command -v ufw >/dev/null 2>&1 || apt_install ufw || fail "ufw could not be installed."
# the SSH port first, so this login never gets locked out
ufw allow ${sshPort}/tcp >/dev/null
[ "${sshPort}" = 22 ] || ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null || fail "The firewall could not be switched on."
step firewall ok "open: ${sshPort === 22 ? '22' : `${sshPort}, 22`}, 80, 443 (Docker ports: use 127.0.0.1 in docker-compose.yml, see the Security tab)"`);

  add('fail2ban', `step fail2ban running "fail2ban"
command -v fail2ban-server >/dev/null 2>&1 || apt_install fail2ban || fail "fail2ban could not be installed."
if [ ! -f /etc/fail2ban/jail.d/serversnap.conf ]; then
  printf '[sshd]\\nenabled = true\\nport = ${sshPort}\\nmaxretry = 6\\nbantime = 1h\\n' > /etc/fail2ban/jail.d/serversnap.conf
fi
systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban >/dev/null 2>&1 || warn "fail2ban did not start."
step fail2ban ok "SSH: 6 wrong tries = blocked 1 hour"`);

  add('updates', `step updates running "Automatic security updates"
apt_install unattended-upgrades || fail "unattended-upgrades could not be installed."
printf 'APT::Periodic::Update-Package-Lists "1";\\nAPT::Periodic::Unattended-Upgrade "1";\\n' > /etc/apt/apt.conf.d/20auto-upgrades
step updates ok "security updates install by themselves (no automatic reboot)"`);

  add('timezone', `step timezone running "Time zone"
timedatectl set-timezone ${q(opts.timezone || 'UTC')} 2>/dev/null || ln -sf /usr/share/zoneinfo/${q(opts.timezone || 'UTC')} /etc/localtime || fail "Unknown time zone."
step timezone ok ${q(opts.timezone || 'UTC')}`);

  if (!parts.length) throw new Error('Tick at least one thing to set up.');
  return `set -u
export DEBIAN_FRONTEND=noninteractive
step() { echo "@@STEP $1|$2|\${3:-}"; }
warn() { echo "@@WARN $*"; }
fail() { echo "@@STEP $PART|failed|$*"; echo "@@WARN $*"; exit 1; }
command -v apt-get >/dev/null 2>&1 || { echo "@@FAIL This server has no apt-get. Set up works on Ubuntu and Debian."; exit 1; }
PART=
FAILED=0
rm -f /tmp/serversnap-apt-updated
apt_install() {
  [ -f /tmp/serversnap-apt-updated ] || { apt-get update -qq >/dev/null 2>&1; touch /tmp/serversnap-apt-updated; }
  # another apt (e.g. the daily update) may hold the lock for a while
  for i in 1 2 3 4 5 6 7 8 9 10; do
    apt-get install -y -qq --no-install-recommends "$@" >/tmp/serversnap-apt.log 2>&1 && return 0
    grep -q "Could not get lock\\|dpkg was interrupted" /tmp/serversnap-apt.log || { tail -n 3 /tmp/serversnap-apt.log; return 1; }
    sleep 15
  done
  return 1
}
${parts.join('\n')}
[ "$FAILED" -eq 0 ] && echo "@@DONE ready" || echo "@@DONE $FAILED failed"
`;
}

module.exports = { PARTS, checkScript, parseCheck, setupScript, TZ_RE };
