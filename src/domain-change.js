'use strict';
// "Change domain": the project moves to a new domain in one go.
//   1. every text file in the project folder that names the old domain gets the new one
//      (API address in the websites, CORS lists in the backend…); the old files are kept
//   2. snap.json gets the new domains, then a normal deploy builds, uploads and gets HTTPS
//   3. the old domain sends visitors to the new one (301), keeping its certificate
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { q } = require('./shell');
const deploy = require('./deploy');
const template = require('./template');

const BACKUP_DIR = '.serversnap-backup';
const MAX_TEXT = 4 * 1024 * 1024;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Old → new for every website, plus the main domain (so api.old.com → api.new.com too).
// sites: [{ id, domain }], map: { siteId: newDomain }, oldMain/newMain: the main domains.
function pairsFor(sites, map, oldMain, newMain) {
  const pairs = [];
  for (const s of sites) {
    const to = String(map[s.id] || '').trim().toLowerCase();
    if (to && to !== s.domain) pairs.push({ from: s.domain, to });
  }
  if (oldMain && newMain && oldMain !== newMain) pairs.push({ from: oldMain, to: newMain });
  // longest first, so "pc.old.com" is not half-replaced by "old.com"
  const seen = new Set();
  return pairs.filter((p) => !seen.has(p.from) && seen.add(p.from)).sort((a, b) => b.from.length - a.from.length);
}

// A domain only where it stands alone (a dot before it is fine: that is a subdomain).
function replaceAll(text, pairs) {
  let out = text;
  let count = 0;
  for (const p of pairs) {
    const re = new RegExp(`(?<![A-Za-z0-9-])${escapeRe(p.from)}(?![A-Za-z0-9-])`, 'gi');
    out = out.replace(re, () => { count++; return p.to; });
  }
  return { text: out, count };
}

async function readText(abs, size) {
  if (size > MAX_TEXT) return null;
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

// Files that name an old domain -> [{ rel, count, inSite }] (nothing is changed yet).
async function findUsages(folder, cfg, pairs) {
  const { files } = await template.walk(folder);
  const siteFolders = cfg.sites.map((s) => s.folder);
  const out = [];
  for (const f of files) {
    if (f.keep || f.rel === deploy.CONFIG_FILE || f.rel.startsWith(BACKUP_DIR + '/')) continue;
    const text = await readText(f.abs, f.size).catch(() => null);
    if (text == null) continue;
    const r = replaceAll(text, pairs);
    if (r.count) out.push({ rel: f.rel, count: r.count, inSite: siteFolders.some((d) => f.rel === d || f.rel.startsWith(d + '/')) });
  }
  return out;
}

// Writes the new text into the chosen files. The old ones go to .serversnap-backup/<stamp>/.
async function applyFiles(folder, rels, pairs, stamp) {
  let changed = 0;
  for (const rel of rels) {
    if (rel.split('/').includes('..')) continue;
    const abs = path.join(folder, ...rel.split('/'));
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) continue;
    const text = await readText(abs, st.size);
    if (text == null) continue;
    const r = replaceAll(text, pairs);
    if (!r.count) continue;
    const keep = path.join(folder, BACKUP_DIR, `domain-${stamp}`, ...rel.split('/'));
    await fsp.mkdir(path.dirname(keep), { recursive: true });
    await fsp.copyFile(abs, keep);
    await fsp.writeFile(abs, r.text);
    changed++;
  }
  return changed;
}

// snap.json with the new domains.
function newConfig(cfg, map, newMain) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (newMain) out.mainDomain = newMain;
  for (const s of out.sites) if (map[s.id]) { s.domain = String(map[s.id]).trim().toLowerCase(); delete s.root; }
  return out;
}

// nginx on the server: the old names answer with a 301 to the new domain (HTTPS kept when it has a certificate).
function redirectScript(project, oldDomain, newDomain, { www = true, stamp } = {}) {
  for (const d of [oldDomain, newDomain]) if (!deploy.isDomain(d)) throw new Error(`"${d}" is not a domain name.`);
  const names = www && !/^www\./.test(oldDomain) ? `${oldDomain} www.${oldDomain}` : oldDomain;
  return deploy.preamble(project, `${project}-redirect-${stamp}.log`) + `
OLD=${q(oldDomain)}
NEW=${q(newDomain)}
NAMES=${q(names)}
AV="$R/etc/nginx/sites-available"; EN="$R/etc/nginx/sites-enabled"
FILE="$AV/$OLD"
step redirect running "$OLD → $NEW"
# another nginx file that also serves the old domain: leave it alone
for f in "$EN"/*; do
  [ -e "$f" ] || continue
  [ "$(basename "$f")" = "$OLD" ] && continue   # our own file for the old domain: it gets replaced
  real=$(readlink -f "$f" 2>/dev/null || echo "$f")
  [ "$real" = "$(readlink -f "$FILE" 2>/dev/null || echo "$FILE")" ] && continue
  if grep -Eq "server_name[^;]*[[:space:]]$(printf %s "$OLD" | sed 's/\\./\\\\./g')([[:space:]]|;)" "$f" 2>/dev/null; then
    warn "$OLD is also in $f, so no redirect was made. Point it to https://$NEW yourself or remove that file."
    step redirect warning "skipped: $f serves $OLD"
    echo "@@DONE skipped"; exit 0
  fi
done
CERT="$R/etc/letsencrypt/live/$OLD"
[ -f "$FILE" ] && cp -p "$FILE" "$STATE/backups/$OLD.nginx.$(date +%s)"
{
  echo "# ServerSnap: $OLD moved to $NEW"
  echo "server {"
  echo "    listen 80;"
  echo "    listen [::]:80;"
  echo "    server_name $NAMES;"
  echo "    return 301 https://$NEW\\$request_uri;"
  echo "}"
  if [ -f "$CERT/fullchain.pem" ] && [ -f "$CERT/privkey.pem" ]; then
    echo "server {"
    echo "    listen 443 ssl;"
    echo "    listen [::]:443 ssl;"
    echo "    server_name $NAMES;"
    echo "    ssl_certificate /etc/letsencrypt/live/$OLD/fullchain.pem;"
    echo "    ssl_certificate_key /etc/letsencrypt/live/$OLD/privkey.pem;"
    echo "    return 301 https://$NEW\\$request_uri;"
    echo "}"
  fi
} > "$FILE.new"
mv "$FILE.new" "$FILE"
ln -sf "$FILE" "$EN/$OLD"
if ! nginx -t >/dev/null 2>&1; then
  last=$(ls -1t "$STATE/backups/$OLD.nginx."* 2>/dev/null | head -n 1)
  if [ -n "$last" ]; then cp -p "$last" "$FILE"; else rm -f "$FILE" "$EN/$OLD"; fi
  fail "nginx did not accept the redirect for $OLD, so the old file was put back."
fi
reload_nginx
step redirect ok "$OLD now sends visitors to $NEW"
echo "@@DONE ok"
`;
}

module.exports = { pairsFor, replaceAll, findUsages, applyFiles, newConfig, redirectScript, BACKUP_DIR };
