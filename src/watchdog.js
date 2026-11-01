'use strict';
// Auto-repair watchdog: a small job on the server that runs every minute, even when this PC is off.
//   - a container that crashed (or is "unhealthy") is started / restarted
//   - a website that keeps answering 502 / 503 / 504 / nothing gets its container restarted
//   - nginx that stopped is started again
//   - a disk that is 90 % full gets old Docker leftovers and logs cleaned
// Every repair is written to a log that the app shows. At most 3 repairs per thing per hour,
// so a container that crashes on start does not restart forever.
const { q } = require('./shell');

const BIN = '/usr/local/sbin/serversnap-watchdog';
const CRON = '/etc/cron.d/serversnap-watchdog';
const LOG = '/var/log/serversnap-watchdog.log';
const STATE = '/var/lib/serversnap-watchdog';
const rp = (p) => '"${SNAP_ROOT:-}"' + q(p);

const URL_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/i;

// cfg: { projects: [] (empty = every Docker project), sites: [{ url, port }], nginx: bool, disk: bool }
function normalize(cfg = {}) {
  const projects = [...new Set((cfg.projects || []).map(String).filter((p) => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(p)))];
  const sites = (cfg.sites || []).filter((s) => URL_RE.test(s.url || '')).map((s) => ({ url: s.url.replace(/\/?$/, '/'), port: Number(s.port) > 0 && Number(s.port) < 65536 ? Number(s.port) : 0 }));
  return { projects, sites, nginx: cfg.nginx !== false, disk: cfg.disk !== false, containers: cfg.containers !== false };
}

// The watchdog itself (bash). SNAP_ROOT lets the tests run it in a scratch folder.
function watchdogScript(cfgIn) {
  const cfg = normalize(cfgIn);
  const sites = cfg.sites.map((s) => `${s.url}|${s.port}`).join(' ');
  return `#!/bin/bash
# ServerSnap watchdog — made by the ServerSnap app. Runs every minute from ${CRON}.
R="\${SNAP_ROOT:-}"
LOG="$R"${q(LOG)}
ST="$R"${q(STATE)}
PROJECTS=${q(cfg.projects.join(' '))}
SITES=${q(sites)}
CHECK_CONTAINERS=${cfg.containers ? 1 : 0}
CHECK_NGINX=${cfg.nginx ? 1 : 0}
CHECK_DISK=${cfg.disk ? 1 : 0}
mkdir -p "$ST"
exec 9>"$ST/lock"; command -v flock >/dev/null 2>&1 && { flock -n 9 || exit 0; }
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
# at most 3 repairs of the same thing per hour
allowed() {
  local f="$ST/$(printf %s "$1" | tr -c 'A-Za-z0-9_-' _).hist" now
  now=$(date +%s); touch "$f"
  awk -v n="$now" '$1 > n - 3600' "$f" > "$f.t" && mv "$f.t" "$f"
  if [ "$(wc -l < "$f")" -lt 3 ]; then echo "$now" >> "$f"; return 0; fi
  [ -f "$f.told" ] || { log "GAVE UP $1: repaired 3 times in the last hour, needs a look"; touch "$f.told"; }
  return 1
}
calm() { rm -f "$ST/$(printf %s "$1" | tr -c 'A-Za-z0-9_-' _).hist.told"; }
watched() { [ -z "$PROJECTS" ] || case " $PROJECTS " in *" $1 "*) return 0;; *) return 1;; esac; }

# 1. containers that crashed (a stop by hand exits with 0 / 143 / 137 and is left alone)
if [ "$CHECK_CONTAINERS" = 1 ] && command -v docker >/dev/null 2>&1; then
  for c in $(docker ps -aq --filter label=com.docker.compose.project 2>/dev/null); do
    info=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}|{{.Name}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null) || continue
    IFS='|' read -r p name status code oom health <<< "$info"
    name=\${name#/}
    watched "$p" || continue
    action=
    if [ "$status" = exited ] || [ "$status" = dead ]; then
      if [ "$oom" = true ]; then action=start; why="ran out of memory"
      else case "$code" in 0|130|137|143) ;; *) action=start; why="crashed (exit code $code)";; esac; fi
    elif [ "$health" = unhealthy ]; then action=restart; why="unhealthy"
    fi
    if [ -n "$action" ]; then
      if allowed "c-$name"; then
        if docker "$action" "$c" >/dev/null 2>&1; then log "FIXED $name $why -> $action"; else log "FAILED $name $why -> $action did not work"; fi
      fi
    else calm "c-$name"
    fi
  done
fi

# 2. nginx
if [ "$CHECK_NGINX" = 1 ] && command -v nginx >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
  if ! systemctl is-active --quiet nginx; then
    if allowed nginx; then
      if systemctl restart nginx >/dev/null 2>&1; then log "FIXED nginx was stopped -> restarted"; else log "FAILED nginx does not start: $(nginx -t 2>&1 | tail -n 1)"; fi
    fi
  else calm nginx
  fi
fi

# 3. websites: 3 bad answers in a row -> restart the container behind them
for s in $SITES; do
  url=\${s%|*}; port=\${s##*|}
  host=$(printf %s "$url" | sed -E 's#^https?://([^/:]+).*#\\1#')
  case "$url" in https:*) hp=443;; *) hp=80;; esac
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 --resolve "$host:$hp:127.0.0.1" "$url" 2>/dev/null)
  key="$ST/site-$(printf %s "$host" | tr -c 'A-Za-z0-9_-' _)"
  case "$code" in 000|502|503|504)
      n=$(( $(cat "$key" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$key"
      if [ "$n" -ge 3 ] && [ "$port" != 0 ]; then
        c=$(docker ps -aq --filter "publish=$port" 2>/dev/null | head -n 1)
        if [ -n "$c" ] && allowed "s-$host"; then
          name=$(docker inspect -f '{{.Name}}' "$c" 2>/dev/null); name=\${name#/}
          docker restart "$c" >/dev/null 2>&1 && log "FIXED $host answered $code 3 times -> restarted $name" || log "FAILED $host answered $code -> restart of $name did not work"
          echo 0 > "$key"
        fi
      elif [ "$n" = 3 ]; then log "DOWN $host answers $code"
      fi;;
    *) [ "$(cat "$key" 2>/dev/null || echo 0)" -ge 3 ] && log "BACK $host answers $code again"; echo 0 > "$key"; calm "s-$host";;
  esac
done

# 4. disk almost full: clean Docker leftovers and old logs (at most every 6 hours)
if [ "$CHECK_DISK" = 1 ]; then
  used=$(df -P "$R/" 2>/dev/null | awk 'NR==2 {gsub("%", "", $5); print $5}')
  if [ -n "$used" ] && [ "$used" -ge 90 ] && [ -z "$(find "$ST/disk" -mmin -360 2>/dev/null)" ]; then
    touch "$ST/disk"
    command -v docker >/dev/null 2>&1 && { docker image prune -f >/dev/null 2>&1; docker builder prune -f >/dev/null 2>&1; }
    command -v journalctl >/dev/null 2>&1 && journalctl --vacuum-size=200M >/dev/null 2>&1
    log "FIXED disk was $used% full -> cleaned, now $(df -P "$R/" | awk 'NR==2 {print $5}')"
  fi
fi

# keep the log short
[ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 2000 ] && { tail -n 1000 "$LOG" > "$LOG.t" && mv "$LOG.t" "$LOG"; }
exit 0
`;
}

function installScript(cfg) {
  const body = Buffer.from(watchdogScript(cfg), 'utf8').toString('base64');
  return `set -e
mkdir -p "$(dirname ${rp(BIN)})" "$(dirname ${rp(CRON)})" "$(dirname ${rp(LOG)})" ${rp(STATE)}
echo ${q(body)} | base64 -d > ${rp(BIN)}.new
bash -n ${rp(BIN)}.new
chmod 755 ${rp(BIN)}.new && mv ${rp(BIN)}.new ${rp(BIN)}
printf '%s\\n' 'SHELL=/bin/bash' 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' '* * * * * root ${BIN} >/dev/null 2>&1' > ${rp(CRON)}
chmod 644 ${rp(CRON)}
touch ${rp(LOG)}
echo "$(date '+%Y-%m-%d %H:%M:%S') ON watchdog switched on by ServerSnap" >> ${rp(LOG)}
echo installed`;
}

function removeScript() {
  return `rm -f ${rp(CRON)} ${rp(BIN)}; echo "$(date '+%Y-%m-%d %H:%M:%S') OFF watchdog switched off by ServerSnap" >> ${rp(LOG)} 2>/dev/null; echo removed`;
}

function statusScript() {
  return `if [ -f ${rp(CRON)} ] && [ -x ${rp(BIN)} ]; then echo "@@ON 1"; else echo "@@ON 0"; fi
echo "@@CONFIG"
grep -E '^(PROJECTS|SITES|CHECK_[A-Z]+)=' ${rp(BIN)} 2>/dev/null
echo "@@LOG"
tail -n 60 ${rp(LOG)} 2>/dev/null
true`;
}

// -> { on, config: { projects, sites, nginx, disk, containers }, events: [{ at, kind, text }] } (newest first)
function parseStatus(text) {
  const out = { on: false, config: null, events: [] };
  let sec = null;
  const raw = {};
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    if (line.startsWith('@@ON ')) { out.on = line.trim().endsWith('1'); continue; }
    if (line.startsWith('@@')) { sec = line.slice(2).trim(); continue; }
    if (sec === 'CONFIG') {
      const m = /^([A-Z_]+)='?(.*?)'?$/.exec(line.trim());
      if (m) raw[m[1]] = m[2];
    } else if (sec === 'LOG') {
      const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (FIXED|FAILED|GAVE UP|DOWN|BACK|ON|OFF) (.*)$/.exec(line.trim());
      if (m) out.events.push({ at: m[1], kind: m[2].replace(' ', '_').toLowerCase(), text: m[3] });
    }
  }
  if (Object.keys(raw).length) {
    out.config = {
      projects: (raw.PROJECTS || '').split(' ').filter(Boolean),
      sites: (raw.SITES || '').split(' ').filter(Boolean).map((s) => { const i = s.lastIndexOf('|'); return { url: s.slice(0, i), port: Number(s.slice(i + 1)) || 0 }; }),
      containers: raw.CHECK_CONTAINERS !== '0', nginx: raw.CHECK_NGINX !== '0', disk: raw.CHECK_DISK !== '0',
    };
  }
  out.events.reverse();
  return out;
}

module.exports = { watchdogScript, installScript, removeScript, statusScript, parseStatus, normalize, BIN, CRON, LOG };
