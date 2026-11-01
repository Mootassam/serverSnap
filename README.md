# ServerSnap

Back up a whole VPS to your PC: website files, Docker Compose projects, Docker volumes and databases.
Restore it later on the same server, or on a brand-new one when you move to another host.

## What it does

- **Add a server** (IP, user, password or SSH key). Passwords are encrypted with the Windows account
  (Electron `safeStorage`). The server's key is remembered on first connect, and a changed key is refused.
- **Scan**: finds Docker Compose projects (their folder, `docker-compose.yml`, `.env`), Docker volumes,
  database containers (PostgreSQL, MySQL/MariaDB, MongoDB), MySQL/PostgreSQL installed on the server,
  and common folders (`/var/www`, `/etc/nginx`, `/etc/letsencrypt`, cron…), with sizes.
- **Back up**: each database is dumped safely (`pg_dumpall`, `mysqldump`/`mariadb-dump`, `mongodump`)
  using the container's own passwords, so ServerSnap never sees them. Each volume and folder is
  streamed as `.tar.gz` over SSH, with SHA-256 checksums. A dropped connection retries the item
  (3 tries). If one item fails, the rest still run (status `partial`).
- **Schedule**: hourly / every 6 h / 12 h / daily / weekly. Runs from the tray, and a run missed while
  the PC was off happens when it is back. Keeps the newest N backups (the newest complete one is never deleted).
- **Alerts**: Telegram bot message after every backup. Windows notification when a scheduled one fails.
- **Restore / migrate**: checks the checksums first, installs Docker if missing, puts folders back,
  refills volumes (keeping compose labels), starts each project's database, waits until it is really
  ready, loads the dump, then starts the rest of the project. It ends with the DNS reminder.

- **Docker dashboard** (server → Docker tab): every container, volume and image, **grouped per
  Compose project** (one project = one customer/website), e.g.
  `king → database (308 MB) · upload (3.9 MB) · redis`. Status, ports, CPU / memory, logs, and
  Start / Stop / Restart per container or per whole project (databases start first and stop last).
  Lists images (and which container uses them) and volumes no container uses. One SSH connection is
  kept open while you use it and closed after 3 idle minutes.
- **Customer download apps** (server → Customers tab): give a customer an access code for
  **ServerSnap Client**. They download only their own website's data (database copy, uploads…).
- **Deploy** (server → Deploy tab, admin app only): put a project folder from this PC on the server.
  See below.

## Deploy: project folder → server

Add a project folder (e.g. `D:\Milan`). ServerSnap reads its `docker-compose.yml` (+ `.env`) and its
website folders (`graborders`, `PC`, `web2`… = folders with `index.html`, `dist/` or a build script),
suggests everything, and saves the answers in the folder as **`snap.json`**. Then one button:

| Button | Does |
|---|---|
| **Deploy everything** | Docker step, then every website |
| **Docker only** | Upload the project (no `node_modules`, `.git`, or website folders that go up as `dist`) to the server folder, `docker compose -p <project> up -d --build`, count running containers. Stops first if a port is taken by another project. |
| **Websites + domains only** | The "already hosted" case: the containers are not touched; each website gets its domain + HTTPS |

Each website, in order: DNS check (public DNS; the domain must point straight at the server; a
Namecheap HTTPS proxy is reported), build on this PC (`npm run build`) or use the `dist` as it is,
upload next to the live folder (`/var/www/<domain>/html.new`; an existing setup keeps its folder),
nginx file in `sites-available` + link in `sites-enabled`, `nginx -t`, swap the new files in,
`certbot --nginx` (redirect to HTTPS, renews itself), then `curl` the site on the server.

nginx files (`src/nginx-templates.js`):
- **Website + API** (the default for a site with a backend): website + `/api/` → `127.0.0.1:<backend port>`,
  SPA `try_files`, asset caching, `index.html` never cached. Two optional per-site toggles:
  **live updates (socket.io)** and **APK download**.
- **trading**: the King / SHUBH file from `king/nginx-site.sh` (website, `/api/` + `/socket.io/` →
  `127.0.0.1:<backend port>`, APK, TradingView, `ws.<domain>` for live prices, `$fwd_proto`)
- **static website**: a plain site, no backend (`try_files … /index.html`, asset caching)
- **container port**: the website runs in Docker; nginx only adds the domain and HTTPS

Safety: old nginx files are kept in `/root/serversnap-deploy/backups/`. Another enabled file that
served only this domain is switched off (kept there too); a file that also serves other domains is
never touched (the deploy stops and says so). If `nginx -t` or the final check fails, everything is
put back (old nginx file, old website files, switched-off files). **Roll back** swaps the previous
website files and nginx file back (press again to switch forward). Logs on the server:
`/root/serversnap-deploy/logs/`. Open database ports (`2757:27017`) are flagged in red.

### Before, during and after a deploy

- **Checks first.** The websites are built on this PC, then the server is checked: Docker and
  Compose installed, ports free, disk space (stops under 1 GB free, warns under 3 GB), memory, and
  every domain points to the server. Nothing on the server changes until all of it passes.
- **Only what changed travels.** ServerSnap hashes the project files (sha1) and asks the server for
  its copy's hashes; only new or changed files go up. Files that live only on the server (uploads,
  data) are never removed. A website starts from a copy of the live folder (so the APK and images do
  not travel again) and ends as an exact copy of `dist`. "Send every file again" forces a full upload.
- **Cleanup.** After every container started fine, old Docker leftovers are deleted (`image prune`,
  build cache older than a week). The images of the version that was running before stay, tagged
  `:serversnap-prev`.
- **Deploy with a backup.** Pick the customer's backup (a ServerSnap / Client backup folder, a
  MongoDB dump: `.archive`, `.gz` or a dump folder, a `.sql` / `.sql.gz`, or a `.zip` /
  `.tar.gz` of files). After the upload, the backend is stopped, only the database container starts,
  a safety copy of its current data is saved in `/root/serversnap-deploy/backups/`, the backup is
  loaded (Mongo databases can be renamed, e.g. `trade` → `grap`), files go into a project folder or
  a volume, and then the whole project starts. If loading fails, the safety copy is put back.

### Tools on the Deploy tab

| Tool | Does |
|---|---|
| **Set up server** | Fresh Ubuntu / Debian VPS: git + tools, Docker + Compose (log size limits), nginx, certbot, Node.js (optional), swap file, firewall (SSH port first, then 80 / 443), fail2ban, automatic security updates, time zone. Shows what is installed first; anything already there is skipped; a failed part does not stop the others. |
| **Auto-repair** | A cron job on the server (`/usr/local/sbin/serversnap-watchdog`, every minute): starts crashed containers (not ones stopped by hand), restarts unhealthy ones, restarts the container behind a site that answers 502 / 503 / 504 three minutes in a row, starts nginx, cleans the disk at 90 %. At most 3 repairs per thing per hour, then "Gave up". Log: `/var/log/serversnap-watchdog.log`, shown in the app. |
| **Settings (.env)** | Edit the project's `.env` files on the server. The old file is kept next to it (last 5), comments and order stay, secrets are hidden until clicked. Suggests which containers read the file (root `.env` → all, `env_file:`, build folder → rebuild) and restarts / rebuilds them. Can write the same file in the folder on this PC, so the next deploy does not bring the old values back. |
| **Change domain** | Checks the new domains point to the server (changes nothing otherwise), writes the new domain into the project files that name the old one (old copies in `.serversnap-backup/`), saves `snap.json`, deploys (the containers too when backend files changed), then the old domain answers with a 301 to the new one, keeping its certificate. |

## Database tab

MongoDB containers on the server (mongosh or the old `mongo` shell inside the container, logged in
with the container's root user when it has one). Databases, collections with counts, documents 20
per page. Search any usual field (email, phone, username…), one field, or a MongoDB JSON filter.
Open a document to edit it as JSON (ids and dates stay `{"$oid"}` / `{"$date"}`), add, delete,
delete selected, delete all search results, export to CSV (Excel) or JSON, empty or delete a
collection, delete a database. Destructive actions ask you to type the name first.

## New client from a template

Deploy tab → **New client from a template**: copy a project you already have (King, SHUBH…) to a new
folder as a separate client. You give the new domain (and brand name); the preview shows every change:

- **ports**: each published port gets the next free one (looks at the server and the other project folders)
- **text in the copied files**: old domain → new domain, old brand → new brand (also UPPER / Capitalised),
  `old server IP:old port` → `this server's IP:new port`, old server IP → this server's IP (only IPs used
  with a port are ticked; public DNS like 1.1.1.1 is ignored), new random Redis / JWT passwords
- **database closed** (`127.0.0.1:` in front), files named after the domain renamed, a new `snap.json`
  with the new domains and ports (websites set to "build", because `dist`/`build` folders are not copied)

Not copied: `node_modules`, `.git`, `dist`/`build` next to a `package.json`. Binary files are copied as
they are. The template folder is never changed. Logo, colours and texts are left for you.

## Security: open databases

Security tab → **Check now** (read-only): every port open to the internet, with Docker containers,
plus which apps connect to a database through its public IP:port. Databases (MongoDB, Redis, MySQL,
PostgreSQL) open to everyone are red. **Close it**: the compose file on the server gets `127.0.0.1:`
in front of the port (copy kept in `/root/serversnap-deploy/backups/`), only the database service is
recreated (`up -d --no-deps`; data stays in the volume), then ServerSnap checks the port is closed and
the database runs. Anything wrong → the old file comes back. Refused when another app reaches the
database through the public port, or the file changed since the check. Optional: the same change in
the linked project folder on this PC, so the next deploy keeps it closed. Docker ports skip ufw, so
ufw alone would not help. App ports (8082, admin) are only listed: admin panels often call them directly.

## Attack Shield: who is trying to break in

Security tab → **See who is attacking** (read-only). Reads the SSH logs (failed passwords, invalid
users — with the usernames tried) and the nginx logs (scans for `/wp-admin`, `.env`, phpmyadmin…),
groups them per IP with a count, shows who fail2ban already banned and the IPs you blocked by hand,
and a rough country when `geoiplookup` is on the server. **Block** adds a ufw deny rule (and a
fail2ban ban); **Unblock** removes them. Private / loopback / your own kind of address are refused,
so you cannot lock yourself out.

## Privacy & Lockdown

Security tab → **Privacy & Lockdown** → **Check** shows the state: password login on/off, whether an
SSH key is installed, the SSH port, firewall, fail2ban, and how long logs are kept.

- **Lock it down**: key-only SSH (**skipped with a warning if no SSH key is installed**, so you are not
  locked out), move SSH off port 22 (keeps 22 open until you confirm the new port), fail2ban, firewall.
  `sshd -t` is checked and the change rolled back if it fails. Test a **new** SSH login before closing
  the old one.
- **Clear old login history**: empties `wtmp` / `btmp` / `lastlog`, the SSH auth logs and the journal
  (optionally the nginx access logs), so an old office IP is not stored on the server.
- **Auto-delete logs older than X days**: a logrotate rule plus a journald retention limit.

To truly hide your location, connect through a VPN or a small jump server so your own IP never reaches
the server in the first place.

## Site Doctor: why is my website down?

Site Doctor tab → domain → **Check**. Read-only, about 10 seconds: DNS (public resolvers), the site
from this PC (status, certificate errors), nginx running / `nginx -t`, the nginx file for the domain,
`index.html` in its root, each `proxy_pass` port (listening? which container? state, restarts, last
log lines), the certificate (end date, names), the site on the server itself (`curl --resolve`), disk
and memory, the nginx error log. The worst finding becomes the answer. Fix buttons: start / restart
the container, start nginx, `certbot renew` for the domain.

## Customer access: how it is locked down

For project `king` ServerSnap creates, on the server (as root, one script, safe to re-run):

| What | Where |
|---|---|
| Login `snap_king`, no password, no shell, group `serversnap-clients` | `/etc/passwd` |
| Its key (only key login; `restrict`) | `/etc/serversnap/keys/snap_king` |
| Nightly job that copies the chosen databases / volumes / folders | `/usr/local/sbin/serversnap-export-snap_king`, `/etc/cron.d/serversnap-snap_king` |
| The copies (root-owned, readable by that login only), newest N kept | `/srv/serversnap/snap_king/backups/<date>/` |
| The only folder the login can write to: a note asking for a backup now | `/srv/serversnap/snap_king/requests/` (emptied every minute) |
| One SSH rule for the whole group, added at the **end** of `sshd_config` | `Match Group serversnap-clients` → `ChrootDirectory /srv/serversnap/%u`, `ForceCommand internal-sftp`, keys only, no forwarding/TTY |

**Make a backup now** (customer app): the app writes `requests/now`; a cron line checks every
minute (`serversnap-export-snap_king --if-requested`), empties the folder, and makes a backup unless
the last one is under 10 minutes old. While it runs, `backups/.running` exists; the app waits for the
new backup and downloads it. Writes anywhere else are refused by folder permissions, and the setup
check proves it (it tries to write in `/` and `/backups` as the customer and stops if that works).

Safety: `sshd_config` is backed up first (`sshd_config.serversnap-backup`), checked with `sshd -t`
(put back if refused), then after the reload ServerSnap logs in again with **your** login; if that
fails the old file is put back at once. Then it logs in **as the customer** to prove the login works
and cannot see anything outside its folder. "New code" swaps the key (the old code stops at once);
"Remove access" deletes the login, key, job and the customer copies.

The access code (`SNAP1-…`) holds the server address, the login, its private key and the server's
fingerprint (so the Client refuses a fake server). It works like a password: send it privately.

## Run

```
npm install
npm start          (or double-click Start.bat)           ServerSnap (you, full control)
npm run client     (or double-click Start-Client.bat)    ServerSnap Client (your customer)
```

A copy of the app with a file named `client.flag` next to `main.js` always opens as the Client
(for a customer installer).

## Windows installers

```
npm run dist        (= powershell -ExecutionPolicy Bypass -File build.ps1)
```

Makes `installer_output\ServerSnap-Setup-<version>.exe` and `ServerSnap-Client-Setup-<version>.exe`
(Inno Setup 6). Per-user install in `%LOCALAPPDATA%\Programs\<app>`, no administrator prompt.
Built for Windows **Smart App Control**: after installing, only the official, unmodified
`electron.exe` (plus Windows' own cmd / reg / powershell) ever runs. Shortcuts start
`electron.exe "<install>\app"`; uninstall is `electron.exe "<install>\app" --uninstall` (`uninstall.js`),
because Inno's `unins000.exe` is unsigned and would be blocked. ssh2's unused `pagent.exe` is left out.
The installer `.exe` files themselves are not signed: Windows SmartScreen may show "unknown publisher"
the first times they are downloaded, until a code-signing certificate is added.

## Test

```
npm test                 # 103 tests: unit, database scripts, Docker grouping, the nightly customer job
                         # run in bash, real SSH backup → restore, customer SFTP download / stop / damage
npm run smoke            # opens both apps with sample data and screenshots every page
```

The SSH tests start a local SSH server (ssh2) that runs commands in Git Bash, so on Windows
Git for Windows must be installed.

## Backup format

```
<backup folder>/<server name>/<YYYY-MM-DD_HH-mm-ss>/
  manifest.json           what was copied, checksums, projects, source server
  databases/<container>.sql.gz | .archive.gz
  volumes/<volume>.tar.gz
  files/<path>.tar.gz     (paths relative to /, so they unpack in place)
```

Every file can also be used by hand: `tar -xzf files/var_www.tar.gz -C /`,
`gunzip -c databases/x.sql.gz | psql …`.

## Code

| File | Job |
|---|---|
| `main.js` | Opens the admin app or, with `--client`, the customer app |
| `admin-main.js` | Admin: window, tray, IPC, jobs, scheduler, Docker dashboard, customer access |
| `client-main.js` | Customer app: access codes, list / download backups, auto-download |
| `src/docker.js` | Dashboard: read containers / volumes / images, group per project, actions, logs |
| `src/clients.js` | Customer logins, access codes, the nightly server job, sshd rule |
| `src/deploy.js` | Deploy: reads a project folder, `snap.json`, the server scripts (docker up, website, rollback, list) |
| `src/deploy-job.js`, `src/deploy-local.js` | Deploy steps for the Activity page; build / pack / DNS check on this PC |
| `src/compose.js`, `src/nginx-templates.js` | Reads docker-compose.yml (+ .env); the nginx files |
| `src/compose-edit.js` | Changes published ports in a compose file in place (close databases, new ports) |
| `src/security.js` | Security check script, report, the "close the database" script |
| `src/doctor.js` | Site Doctor: server check script, check from this PC, findings and fix commands |
| `src/template.js` | New client from a template: preview and copy with replacements |
| `src/deploy-sync.js` | Upload only what changed, checks before deploy, Docker cleanup |
| `src/deploy-data.js` | Deploy with a backup: read backups and dumps, load them before the backend starts |
| `src/server-setup.js` | Set up server: check script and the install script |
| `src/watchdog.js` | Auto-repair: the watchdog script, install / remove / status |
| `src/env-edit.js` | .env editor: list, read, write with backup, keep comments, which containers to restart |
| `src/domain-change.js` | Change domain: find and replace in the project, the 301 redirect on the server |
| `src/dbview.js` | Database tab: mongo shell commands, Extended JSON both ways, search filters, CSV |
| `src/attack-shield.js` | Attack Shield: read SSH / nginx attack logs, fail2ban bans, block / unblock an IP |
| `src/privacy.js` | Privacy & Lockdown: check, clear old logins, log retention, key-only SSH / port / firewall |
| `src/sftp.js` | Parallel SFTP download with checksum check |
| `src/ssh.js` | SSH connection, run as root (root / sudo / sudo + password), stream files in and out |
| `src/scanner.js` | Finds what is on the server |
| `src/db.js` | Dump / load / ready-check commands per database |
| `src/backup.js` | Runs a backup, lists backups, retention |
| `src/restore.js` | Restore and migrate |
| `src/selection.js` | Remembers ticks; new items are included automatically |
| `src/scheduler.js`, `src/notify.js`, `src/store.js` | Schedule maths, Telegram, saved settings |
| `ui/` | The windows (plain HTML/CSS/JS): `index.html`/`app.js` admin, `client.html`/`client.js` customer, `common.js` shared, `tools.js` the Deploy tools and the Database tab |

## Not yet (version 2 ideas)

- Encrypted backups (password), and sending them to Google Drive / S3 / another VPS
- Smart backups that only send changed files (deploys already do)
- A "test restore" into a throw-away server
- Saving Docker images (images are pulled again on restore; locally built ones are rebuilt from the project folder)
- Windows installer (`.exe`)
