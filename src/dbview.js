'use strict';
// Database viewer for MongoDB containers: databases, collections, documents, search
// (e.g. by email), edit / add / delete a document, empty or delete a collection, delete a database.
// Everything runs with the mongo shell inside the container (mongosh or the old "mongo"),
// logged in with the container's own root user when it has one. Values travel as
// Extended JSON ({"$oid": …}, {"$date": …}) so ids and dates survive an edit.
const { q } = require('./shell');
const db = require('./db');

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,119}$/;
const SYSTEM_DBS = ['admin', 'local', 'config'];

function checkName(n, what) {
  if (!NAME_RE.test(String(n || '')) || String(n).startsWith('system.')) throw new Error(`"${n}" is not a valid ${what} name.`);
  return n;
}

// Helpers loaded before every command: Extended JSON both ways, for mongosh and the legacy shell.
const PRELUDE = `
function isA(v, C) { try { return typeof C === 'function' && v instanceof C; } catch (e) { return false; } }
function snapOut(v) {
  if (v === null || v === undefined) return v === null ? null : undefined;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Date) return { $date: v.toISOString() };
  var t = v._bsontype;
  if (t === 'ObjectId' || t === 'ObjectID' || (typeof ObjectId !== 'undefined' && isA(v, ObjectId))) return { $oid: v.str || v.toHexString() };
  if (t === 'Long' || (typeof NumberLong !== 'undefined' && isA(v, NumberLong))) return { $numberLong: String(v.toString()).replace(/^NumberLong\\("?|"?\\)$/g, '') };
  if (t === 'Decimal128' || (typeof NumberDecimal !== 'undefined' && isA(v, NumberDecimal))) return { $numberDecimal: String(v.toString()).replace(/^NumberDecimal\\("?|"?\\)$/g, '') };
  if (t === 'Int32' || (typeof NumberInt !== 'undefined' && isA(v, NumberInt))) return Number(v.valueOf ? v.valueOf() : v);
  if (t === 'Binary' || (typeof BinData !== 'undefined' && isA(v, BinData))) return { $binary: '(binary data)' };
  if (Array.isArray(v)) return v.map(snapOut);
  if (typeof v === 'object') { var o = {}; for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k) && typeof v[k] !== 'function') o[k] = snapOut(v[k]); } return o; }
  return String(v);
}
function snapIn(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(snapIn);
  var keys = Object.keys(v);
  if (keys.length === 1) {
    if (keys[0] === '$oid') return ObjectId(v.$oid);
    if (keys[0] === '$date') return new Date(v.$date);
    if (keys[0] === '$numberLong') return NumberLong(v.$numberLong);
    if (keys[0] === '$numberDecimal') return NumberDecimal(v.$numberDecimal);
  }
  var o = {}; for (var i = 0; i < keys.length; i++) o[keys[i]] = snapIn(v[keys[i]]); return o;
}
function snapSend(x) { print('@@JSON ' + JSON.stringify(snapOut(x))); }
var A = snapIn(JSON.parse(SNAP_ARGS));
`;

// The command: runs the given JS in the database `dbName` inside the container.
// The JS reads its input from A (already turned back into ObjectId / Date) and answers with snapSend(…).
function command(container, dbName, js, args = {}) {
  const prog = `var SNAP_ARGS = ${JSON.stringify(JSON.stringify(args))};\n${PRELUDE}\n${js}`;
  const inner = `${mongoPrep()}
S=$(command -v mongosh || command -v mongo) || { echo "No mongo shell in this container" >&2; exit 127; }
exec "$S" --quiet "$@" ${q(dbName)} --eval "$(cat)"`;
  return { cmd: db.inContainer(container, inner, true), stdin: prog };
}

function mongoPrep() {
  // same login as the backups use (root user from the container's environment, when set)
  return [
    'sec() { eval "v=\\${$1:-}"; eval "f=\\${$1_FILE:-}"; if [ -z "$v" ] && [ -n "$f" ] && [ -r "$f" ]; then v=$(cat "$f"); fi; printf %s "$v"; }',
    'MU=$(sec MONGO_INITDB_ROOT_USERNAME); MP=$(sec MONGO_INITDB_ROOT_PASSWORD)',
    'if [ -n "$MU" ]; then set -- --username "$MU" --password "$MP" --authenticationDatabase admin; else set --; fi',
  ].join('\n');
}

// Output -> the value sent with snapSend (or an error with the shell's own words).
function parse(r) {
  const out = String(r.stdout || '');
  const line = out.split('\n').reverse().find((l) => l.startsWith('@@JSON '));
  if (line) return JSON.parse(line.slice(7));
  const msg = (r.stderr || out).trim().split('\n').filter((l) => !/^\s*at /.test(l)).slice(-3).join(' ');
  throw new Error(msg || `The mongo shell stopped with exit code ${r.code}.`);
}

// ---------- the actions ----------
const JS = {
  databases: `var l = db.adminCommand({ listDatabases: 1 }).databases || [];
snapSend(l.map(function (d) { return { name: d.name, size: d.sizeOnDisk || 0, empty: !!d.empty }; }));`,

  collections: `var names = db.getCollectionNames().filter(function (n) { return n.indexOf('system.') !== 0; }).sort();
snapSend(names.map(function (n) {
  var c = db.getCollection(n), count = 0, size = 0;
  try { count = c.estimatedDocumentCount ? c.estimatedDocumentCount() : c.count(); } catch (e) { count = c.count(); }
  try { var s = c.stats(); size = s.size || 0; } catch (e) {}
  return { name: n, count: count, size: size };
}));`,

  // A: { coll, filter, sort, skip, limit }
  find: `var c = db.getCollection(A.coll);
var cur = c.find(A.filter || {}).sort(A.sort || { _id: -1 }).skip(A.skip || 0).limit(A.limit || 20);
var docs = cur.toArray();
var total = c.find(A.filter || {}).limit(5001).count(true);
var keys = {}; docs.forEach(function (d) { Object.keys(d).forEach(function (k) { keys[k] = 1; }); });
if (!docs.length) c.find().limit(5).toArray().forEach(function (d) { Object.keys(d).forEach(function (k) { keys[k] = 1; }); });
snapSend({ docs: docs, total: total, more: total > 5000, keys: Object.keys(keys) });`,

  // A: { coll, id, doc } — the whole document is replaced (its _id stays)
  replace: `var doc = A.doc; delete doc._id;
var r = db.getCollection(A.coll).replaceOne({ _id: A.id }, doc);
snapSend({ matched: r.matchedCount, modified: r.modifiedCount });`,

  // A: { coll, doc }
  insert: `var r = db.getCollection(A.coll).insertOne(A.doc);
snapSend({ id: r.insertedId });`,

  // A: { coll, ids: [] }
  deleteMany: `var r = db.getCollection(A.coll).deleteMany({ _id: { $in: A.ids } });
snapSend({ deleted: r.deletedCount });`,

  // A: { coll, filter } — every document that matches (the "delete these results" button)
  deleteFilter: `var r = db.getCollection(A.coll).deleteMany(A.filter);
snapSend({ deleted: r.deletedCount });`,

  // A: { coll, set: { field: value }, ids } — the same change on many documents
  setField: `var r = db.getCollection(A.coll).updateMany({ _id: { $in: A.ids } }, { $set: A.set });
snapSend({ modified: r.modifiedCount });`,

  // A: { coll }
  empty: `var r = db.getCollection(A.coll).deleteMany({});
snapSend({ deleted: r.deletedCount });`,

  drop: `snapSend({ dropped: db.getCollection(A.coll).drop() });`,

  dropDatabase: `var r = db.dropDatabase(); snapSend({ ok: r.ok });`,

  // A: { coll, filter } — every document of the search, for the export (max 20 000)
  exportAll: `snapSend(db.getCollection(A.coll).find(A.filter || {}).limit(20000).toArray());`,
};

// ---------- search ----------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What the search box means:
//   field + text   -> that field contains the text (any case), or equals the number / id
//   text only      -> any of the usual fields (email, phone, username, name…) contains it
//   { … } (JSON)   -> a real MongoDB filter, for the experts
function buildFilter({ field, text, json, keys = [] }) {
  if (json && json.trim()) {
    let f;
    try { f = JSON.parse(json); } catch (e) { throw new Error(`The filter is not valid JSON: ${e.message}`); }
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('The filter must be a JSON object, like {"email": "a@b.com"}.');
    if (JSON.stringify(f).includes('"$where"') || JSON.stringify(f).includes('"$function"')) throw new Error('$where and $function are not allowed here.');
    return f;
  }
  const t = String(text || '').trim();
  if (!t) return {};
  const like = (k) => ({ [k]: { $regex: escapeRe(t), $options: 'i' } });
  const exact = (k) => {
    if (/^[0-9a-f]{24}$/i.test(t)) return { [k]: { $oid: t } };
    if (/^-?\d+(\.\d+)?$/.test(t) && t.length < 16) return { $or: [{ [k]: Number(t) }, like(k)] };
    if (t === 'true' || t === 'false') return { [k]: t === 'true' };
    return null;
  };
  if (field) {
    if (field === '_id') return /^[0-9a-f]{24}$/i.test(t) ? { _id: { $oid: t } } : { _id: t };
    return exact(field) || like(field);
  }
  if (/^[0-9a-f]{24}$/i.test(t)) return { _id: { $oid: t } };
  const usual = keys.filter((k) => /mail|phone|mobile|user|name|login|account|invite|code|ref/i.test(k)).slice(0, 8);
  const fields = usual.length ? usual : keys.filter((k) => k !== '_id').slice(0, 6);
  if (!fields.length) return {};
  return { $or: fields.map(like) };
}

// Plain text table (CSV) of documents for Excel; nested values become JSON.
function toCsv(docs) {
  const keys = [];
  for (const d of docs) for (const k of Object.keys(d)) if (!keys.includes(k)) keys.push(k);
  const cell = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') {
      if (v.$oid) v = v.$oid; else if (v.$date) v = v.$date; else if (v.$numberLong) v = v.$numberLong; else if (v.$numberDecimal) v = v.$numberDecimal; else v = JSON.stringify(v);
    }
    const s = String(v);
    return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [keys.map(cell).join(','), ...docs.map((d) => keys.map((k) => cell(d[k])).join(','))].join('\r\n') + '\r\n';
}

module.exports = { JS, command, parse, buildFilter, toCsv, checkName, SYSTEM_DBS, PRELUDE };
