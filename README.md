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

## Test

```
npm test                 # 53 tests: unit, database scripts, Docker grouping, the nightly customer job
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
| `src/sftp.js` | Parallel SFTP download with checksum check |
| `src/ssh.js` | SSH connection, run as root (root / sudo / sudo + password), stream files in and out |
| `src/scanner.js` | Finds what is on the server |
| `src/db.js` | Dump / load / ready-check commands per database |
| `src/backup.js` | Runs a backup, lists backups, retention |
| `src/restore.js` | Restore and migrate |
| `src/selection.js` | Remembers ticks; new items are included automatically |
| `src/scheduler.js`, `src/notify.js`, `src/store.js` | Schedule maths, Telegram, saved settings |
| `ui/` | The windows (plain HTML/CSS/JS): `index.html`/`app.js` admin, `client.html`/`client.js` customer, `common.js` shared |

## Not yet (version 2 ideas)

- Encrypted backups (password), and sending them to Google Drive / S3 / another VPS
- Smart backups that only send changed files
- A "test restore" into a throw-away server
- Saving Docker images (images are pulled again on restore; locally built ones are rebuilt from the project folder)
- Windows installer (`.exe`)
