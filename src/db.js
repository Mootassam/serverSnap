'use strict';
// Database knowledge: how to spot a database container and how to dump / load / ping it.
// All passwords are read from the container's own environment *inside* the container,
// so ServerSnap never sees or stores them.
const { q } = require('./shell');

const KINDS = {
  postgres: { label: 'PostgreSQL', ext: 'sql.gz', dataDir: '/var/lib/postgresql' },
  mysql: { label: 'MySQL / MariaDB', ext: 'sql.gz', dataDir: '/var/lib/mysql' },
  mongo: { label: 'MongoDB', ext: 'archive.gz', dataDir: '/data/db' },
};

// Image name -> database kind (or null).
function kindFromImage(image) {
  const name = String(image || '').toLowerCase().split('@')[0].replace(/:[^/]*$/, '');
  const last = name.split('/').pop();
  if (/exporter|admin|express|backup|proxy|bouncer|pgpool|router|operator|compass|ui$/.test(last)) return null;
  if (/^(postgres|postgis|timescaledb(-ha)?|pgvector|supabase-postgres)$/.test(last) || /postgres/.test(last)) return 'postgres';
  if (/^(mysql|mariadb|percona(-server)?|mysql-server)$/.test(last) || /mariadb|mysql/.test(last)) return 'mysql';
  if (/^mongo(db)?(-community-server)?$/.test(last) || /^mongo/.test(last)) return 'mongo';
  return null;
}

// Reads a secret from VAR or VAR_FILE (the Docker secrets convention).
const SECRET_FN = 'sec() { eval "v=\\${$1:-}"; eval "f=\\${$1_FILE:-}"; if [ -z "$v" ] && [ -n "$f" ] && [ -r "$f" ]; then v=$(cat "$f"); fi; printf %s "$v"; }';

// Sets $AUTH_ARGS / MYSQL_PWD and $BIN for the mysql client tools inside the container.
const MYSQL_PREP = [
  SECRET_FN,
  'RP=$(sec MYSQL_ROOT_PASSWORD); [ -z "$RP" ] && RP=$(sec MARIADB_ROOT_PASSWORD)',
  'U=$(sec MYSQL_USER); [ -z "$U" ] && U=$(sec MARIADB_USER)',
  'UP=$(sec MYSQL_PASSWORD); [ -z "$UP" ] && UP=$(sec MARIADB_PASSWORD)',
  'DB=$(sec MYSQL_DATABASE); [ -z "$DB" ] && DB=$(sec MARIADB_DATABASE)',
  'EMPTY="${MYSQL_ALLOW_EMPTY_PASSWORD:-}${MARIADB_ALLOW_EMPTY_ROOT_PASSWORD:-}"',
  'if [ -n "$RP" ] || [ -n "$EMPTY" ] || [ -z "$U" ]; then LOGIN=root; export MYSQL_PWD="$RP"; else LOGIN="$U"; export MYSQL_PWD="$UP"; fi',
  'pick() { for b in "$@"; do command -v "$b" >/dev/null 2>&1 && { echo "$b"; return; }; done; echo "$1"; }',
].join('\n');

const PG_PREP = [SECRET_FN, 'PU=$(sec POSTGRES_USER); [ -z "$PU" ] && PU=postgres'].join('\n');

const MONGO_PREP = [
  SECRET_FN,
  'MU=$(sec MONGO_INITDB_ROOT_USERNAME); MP=$(sec MONGO_INITDB_ROOT_PASSWORD)',
  'if [ -n "$MU" ]; then set -- --username "$MU" --password "$MP" --authenticationDatabase admin; else set --; fi',
].join('\n');

function inContainer(container, script, interactive) {
  return `docker exec ${interactive ? '-i ' : ''}${q(container)} sh -c ${q(script)}`;
}

// Script (run inside the container) whose stdout is the raw, uncompressed dump.
function dumpScript(kind) {
  switch (kind) {
    case 'postgres':
      return `${PG_PREP}\nexec pg_dumpall -U "$PU"`;
    case 'mysql':
      return `${MYSQL_PREP}
D=$(pick mariadb-dump mysqldump)
COMMON="--single-transaction --quick --routines --events --triggers --hex-blob"
if [ "$LOGIN" = root ]; then exec "$D" -uroot $COMMON --all-databases
else exec "$D" -u"$LOGIN" $COMMON --no-tablespaces --databases "$DB"; fi`;
    case 'mongo':
      return `${MONGO_PREP}
D=mongodump; command -v mongodump >/dev/null 2>&1 || { echo "mongodump is not in this image" >&2; exit 127; }
exec "$D" "$@" --archive`;
    default:
      throw new Error(`Unknown database kind: ${kind}`);
  }
}

// Command whose stdout is the raw (uncompressed) dump. ServerSnap gzips it locally.
function dumpCommand(kind, container) {
  return inContainer(container, dumpScript(kind));
}

// Command that reads a raw dump on stdin and loads it.
function loadCommand(kind, container) {
  switch (kind) {
    case 'postgres':
      // Errors such as "role postgres already exists" are expected and harmless.
      return inContainer(container, `${PG_PREP}\nexec psql -U "$PU" -d postgres -q -v ON_ERROR_STOP=0`, true);
    case 'mysql':
      return inContainer(container, `${MYSQL_PREP}
C=$(pick mariadb mysql)
if [ "$LOGIN" = root ]; then exec "$C" -uroot; else exec "$C" -u"$LOGIN" "$DB"; fi`, true);
    case 'mongo':
      return inContainer(container, `${MONGO_PREP}\nexec mongorestore "$@" --archive --drop`, true);
    default:
      throw new Error(`Unknown database kind: ${kind}`);
  }
}

// Exit 0 only when the *real* server is up (not the temporary one the official images
// run while they initialise a new database).
function readyCommand(kind, container) {
  switch (kind) {
    case 'postgres':
      return inContainer(container, `${PG_PREP}
pg_isready -U "$PU" -q || exit 1
L=$(psql -U "$PU" -d postgres -tAc "SHOW listen_addresses" 2>/dev/null) || exit 1
[ -n "$L" ]`);
    case 'mysql':
      return inContainer(container, `${MYSQL_PREP}
C=$(pick mariadb mysql)
if [ "$LOGIN" = root ]; then S=$("$C" -uroot -N -B -e "SELECT @@skip_networking" 2>/dev/null) || exit 1
else S=$("$C" -u"$LOGIN" -N -B -e "SELECT @@skip_networking" 2>/dev/null) || exit 1; fi
[ "$S" = 0 ]`);
    case 'mongo':
      return inContainer(container, `${MONGO_PREP}
S=$(command -v mongosh || command -v mongo) || exit 1
"$S" --quiet "$@" --eval "db.adminCommand('ping').ok" 2>/dev/null | grep -q 1`);
    default:
      throw new Error(`Unknown database kind: ${kind}`);
  }
}

// Databases installed directly on the server (not in Docker).
const HOST = {
  mysql: {
    label: 'MySQL / MariaDB (on the server)',
    detect: 'for s in mysql mariadb mysqld; do systemctl is-active --quiet "$s" 2>/dev/null && { echo yes; exit 0; }; done; echo no',
    // Root on Debian/Ubuntu logs in through the socket; an optional password comes on stdin.
    dump: 'IFS= read -r P || true; [ -n "$P" ] && export MYSQL_PWD="$P"; ' +
      'D=mysqldump; command -v mariadb-dump >/dev/null 2>&1 && D=mariadb-dump; ' +
      'exec "$D" -uroot --single-transaction --quick --routines --events --triggers --hex-blob --all-databases',
    load: 'IFS= read -r P || true; [ -n "$P" ] && export MYSQL_PWD="$P"; ' +
      'C=mysql; command -v mariadb >/dev/null 2>&1 && C=mariadb; exec "$C" -uroot',
    has: 'command -v mysql >/dev/null 2>&1 || command -v mariadb >/dev/null 2>&1',
  },
  postgres: {
    label: 'PostgreSQL (on the server)',
    detect: 'systemctl list-units --type=service --state=active --no-legend "postgresql*" 2>/dev/null | grep -q . && echo yes || echo no',
    dump: 'cd / && exec su -s /bin/sh postgres -c pg_dumpall',
    load: 'cd / && exec su -s /bin/sh postgres -c "psql -q -d postgres -v ON_ERROR_STOP=0"',
    has: 'id postgres >/dev/null 2>&1 && command -v psql >/dev/null 2>&1',
  },
};

module.exports = { KINDS, HOST, kindFromImage, dumpScript, dumpCommand, loadCommand, readyCommand };
