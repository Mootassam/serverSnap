'use strict';
// Reads the parts of a docker-compose.yml that deploying needs: services, what they build,
// their image and published ports. Commented-out services (# web1: …) are ignored.
// Not a full YAML parser: it understands the plain block style compose files use.

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

const unquote = (s) => String(s).trim().replace(/^(['"])(.*)\1$/, '$2');

// "8082:8082", "127.0.0.1:2757:27017", "3000", "80/tcp", "8000-8001:8000-8001" -> { ip, host, container }
function parsePort(spec) {
  const s = unquote(spec).replace(/\/(tcp|udp)$/, '');
  const parts = s.split(':');
  let ip = null; let host = null; let container;
  if (parts.length >= 3) { ip = parts.slice(0, -2).join(':').replace(/^\[|\]$/g, ''); host = parts[parts.length - 2]; container = parts[parts.length - 1]; }
  else if (parts.length === 2) { host = parts[0]; container = parts[1]; }
  else container = parts[0];
  const num = (v) => (v && /^\d+$/.test(v) ? Number(v) : v || null);
  return { ip: ip || null, host: num(host), container: num(container) };
}

// KEY=value lines of a .env file.
function parseEnv(text) {
  const env = {};
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = unquote(m[2].replace(/\s+#.*$/, ''));
  }
  return env;
}

// ${VAR}, ${VAR:-default}, ${VAR-default} and $VAR, like compose does with the .env file.
function interpolate(text, env = {}) {
  return String(text)
    .replace(/\$\$/g, '\u0000')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}/g, (_m, k, op, def) => {
      const v = env[k];
      if (op === ':-') return v ? v : def;
      if (op === '-') return v != null ? v : def;
      return v != null ? v : '';
    })
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, k) => (env[k] != null ? env[k] : ''))
    .replace(/\u0000/g, '$');
}

function parseCompose(text, env) {
  const services = {};
  const lines = interpolate(text, env).replace(/\r/g, '').split('\n');
  let inServices = false;
  let svcIndent = null;
  let svc = null;     // current service object
  let key = null;     // current key inside the service (ports, build, …)
  let keyIndent = null;
  let longPort = null; // long-syntax port item being read
  for (const raw of lines) {
    const line = stripComment(raw).replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (indent === 0) {
      inServices = /^services\s*:/.test(t);
      svc = null; key = null; svcIndent = null;
      continue;
    }
    if (!inServices) continue;
    if (svcIndent == null) svcIndent = indent;
    if (indent <= svcIndent) {
      const m = indent === svcIndent && t.match(/^([A-Za-z0-9._-]+)\s*:\s*$/);
      svc = m ? (services[m[1]] = { name: m[1], build: null, image: null, ports: [] }) : null;
      key = null; keyIndent = null;
      continue;
    }
    if (!svc) continue;
    if (keyIndent == null) keyIndent = indent;
    if (indent <= keyIndent) {
      key = null;
      longPort = null;
      const m = t.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      key = m[1];
      const value = m[2].trim();
      if (key === 'build' && value) svc.build = unquote(value);
      else if (key === 'image' && value) svc.image = unquote(value);
      else if (key === 'ports' && value.startsWith('[')) {
        for (const p of value.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean)) svc.ports.push(parsePort(p));
      }
      continue;
    }
    // nested under the current key
    if (key === 'build') {
      const m = t.match(/^context\s*:\s*(.+)$/);
      if (m) svc.build = unquote(m[1]);
    } else if (key === 'ports') {
      if (t.startsWith('-')) {
        const item = t.replace(/^-\s*/, '');
        const lm = item.match(/^(target|published|host_ip)\s*:\s*(.+)$/);
        if (lm) { longPort = { ip: null, host: null, container: null }; svc.ports.push(longPort); setLong(longPort, lm[1], lm[2]); }
        else { longPort = null; svc.ports.push(parsePort(item)); }
      } else if (longPort) {
        const lm = t.match(/^(target|published|host_ip)\s*:\s*(.+)$/);
        if (lm) setLong(longPort, lm[1], lm[2]);
      }
    }
  }
  return { services: Object.values(services) };
}

function setLong(p, k, v) {
  const val = unquote(v);
  if (k === 'target') p.container = /^\d+$/.test(val) ? Number(val) : val;
  else if (k === 'published') p.host = /^\d+$/.test(val) ? Number(val) : val;
  else p.ip = val;
}

const DB_PORTS = { 27017: 'MongoDB', 6379: 'Redis', 3306: 'MySQL', 5432: 'PostgreSQL' };

// Database ports published to the whole internet (no 127.0.0.1 in front).
function exposedDatabases(compose) {
  const out = [];
  for (const s of compose.services) {
    for (const p of s.ports) {
      const name = DB_PORTS[p.container];
      if (name && p.host && (!p.ip || p.ip === '0.0.0.0')) out.push({ service: s.name, name, host: p.host, container: p.container });
    }
  }
  return out;
}

module.exports = { parseCompose, parseEnv, interpolate, parsePort, exposedDatabases, DB_PORTS };
