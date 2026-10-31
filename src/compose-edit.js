'use strict';
// Changes published ports in a docker-compose.yml without touching anything else in the file
// (comments, order and quotes stay). Used to close databases to the internet (127.0.0.1 in front)
// and to give a copied project new ports. Short syntax only ("8082:8082", "${DB_PORT:-2747}:27017").
const { interpolate, DB_PORTS } = require('./compose');

// "a:b:c" split on ":" but not inside ${...} (which may hold ":-").
function splitPort(s) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '$' && s[i + 1] === '{') { depth++; cur += '${'; i++; continue; }
    if (c === '}' && depth) { depth--; cur += c; continue; }
    if (c === ':' && !depth) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const num = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

// Walks the port items of every service. fn({ service, ip, host, container, hostRaw, long }) returns
// null (leave it) or { ip?, host? } to write. Returns { text, changes: [{service, from, to}], skipped }.
function editPorts(text, env, fn) {
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = String(text).split(/\r?\n/);
  const changes = [];
  const skipped = [];
  let inServices = false;
  let svcIndent = null;
  let svc = null;
  let keyIndent = null;
  let inPorts = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) { inServices = /^services\s*:/.test(t); svc = null; svcIndent = null; inPorts = false; continue; }
    if (!inServices) continue;
    if (svcIndent == null) svcIndent = indent;
    if (indent <= svcIndent) {
      const m = indent === svcIndent && t.match(/^([A-Za-z0-9._-]+)\s*:\s*$/);
      svc = m ? m[1] : null; keyIndent = null; inPorts = false;
      continue;
    }
    if (!svc) continue;
    if (keyIndent == null) keyIndent = indent;
    if (indent <= keyIndent && !t.startsWith('-')) {
      inPorts = /^ports\s*:\s*$/.test(t);
      if (/^ports\s*:\s*\[/.test(t)) skipped.push({ service: svc, line: t, why: 'ports written as [ … ]' });
      continue;
    }
    if (!inPorts || !t.startsWith('-')) continue;
    const m = raw.match(/^(\s*-\s*)(["']?)([^"'#]*?)\2(\s*(#.*)?)$/);
    if (!m || /^(target|published|host_ip|mode|protocol)\s*:/.test(m[3])) {
      skipped.push({ service: svc, line: t, why: 'long port syntax' });
      continue;
    }
    const spec = m[3].trim();
    const proto = (spec.match(/\/(tcp|udp)$/) || [''])[0];
    const parts = splitPort(spec.replace(/\/(tcp|udp)$/, ''));
    if (parts.length < 2) continue; // "3000": only a container port, nothing published to a fixed host port
    const ipRaw = parts.length >= 3 ? parts.slice(0, -2).join(':') : '';
    const hostRaw = parts[parts.length - 2];
    const contRaw = parts[parts.length - 1];
    const cur = { service: svc, ip: interpolate(ipRaw, env) || null, host: num(interpolate(hostRaw, env)), container: num(interpolate(contRaw, env)), hostRaw };
    const want = fn(cur);
    if (!want) continue;
    const ip = want.ip !== undefined ? want.ip : ipRaw;
    const host = want.host !== undefined ? String(want.host) : hostRaw;
    const next = `${ip ? ip + ':' : ''}${host}:${contRaw}${proto}`;
    if (next === spec) continue;
    const q = m[2] || (/[${}]/.test(next) ? '"' : '');
    lines[i] = `${m[1]}${q}${next}${q}${m[4] || ''}`;
    changes.push({ service: svc, from: spec, to: next, container: cur.container, host: num(host) != null ? num(host) : cur.host });
  }
  return { text: lines.join(nl), changes, skipped };
}

const isPublic = (ip) => !ip || ip === '0.0.0.0' || ip === '::' || ip === '[::]';

// Puts 127.0.0.1 in front of every database port (only for the given services, or all).
function lockDatabases(text, env, services = null) {
  return editPorts(text, env, (p) => {
    if (!DB_PORTS[p.container] || !isPublic(p.ip)) return null;
    if (services && !services.includes(p.service)) return null;
    return { ip: '127.0.0.1' };
  });
}

// New host ports: map is { "service:oldHost": newHost }.
function remapPorts(text, env, map) {
  return editPorts(text, env, (p) => {
    const to = map[`${p.service}:${p.host}`];
    return to && to !== p.host ? { host: to } : null;
  });
}

module.exports = { editPorts, lockDatabases, remapPorts, splitPort, isPublic };
