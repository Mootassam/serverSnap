'use strict';
/* global api, h, $, fill, fmtBytes, fmtDate, ago, toast, safe, openModal, closeModal, confirmBox, state, go, render, loadServers */
// Admin tools around Deploy: server setup, auto-repair watchdog, .env editor, change domain,
// and the Database tab. Loaded after app.js (uses its state, go and render).

function startJob(j) { if (j) { state.jobs.set(j.id, j); go({ name: 'activity' }); } }
const wide = () => $('#modalCard').classList.add('wide');
const loading = (title, text) => { openModal(h('h1', {}, title), h('div', { class: 'muted' }, text), h('div', { class: 'bar indeterminate' }, h('i'))); };

// "Type DELETE to confirm" for the things that cannot be undone.
function typeConfirm(title, text, word, okLabel) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', placeholder: word, autocomplete: 'off' });
    const ok = h('button', { class: 'btn primary danger-fill', disabled: true }, okLabel);
    const done = (v) => { closeModal(); resolve(v); };
    input.addEventListener('input', () => { ok.disabled = input.value.trim() !== word; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) done(true); });
    ok.addEventListener('click', () => done(true));
    openModal(h('h1', {}, title), h('p', {}, text),
      h('label', { class: 'field' }, h('span', {}, 'Type ', h('b', { class: 'mono' }, word), ' to confirm'), input),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'), ok));
    setTimeout(() => input.focus(), 30);
  });
}

// ---------- tiles on the Deploy tab ----------
function serverToolsCard(s) {
  const wdText = h('div', { class: 'muted small' }, 'Checking…');
  const tile = (icon, title, text, extra, onclick) => h('button', { class: 'tile', onclick },
    h('div', { class: 'tile-icon' }, icon), h('div', { class: 'tile-body' }, h('b', {}, title), h('div', { class: 'muted small' }, text), extra));
  (async () => {
    const st = await api.call('watchdog:status', s.id).catch(() => null);
    if (!st) { wdText.textContent = 'Status unknown (server not reachable).'; return; }
    const fixes = st.events.filter((e) => e.kind === 'fixed');
    fill(wdText, h('span', { class: `pill ${st.on ? 'ok' : ''}`, style: 'margin-left:0' }, st.on ? 'On' : 'Off'),
      st.on ? h('span', {}, fixes.length ? `  last repair ${ago(fixes[0].at.replace(' ', 'T'))}` : '  nothing needed fixing yet') : null);
  })();
  return h('div', { class: 'tiles' },
    tile('⚙', 'Set up server', 'Docker, nginx, HTTPS, firewall, swap… on a fresh VPS in one click.', null, () => setupModal(s)),
    tile('♻', 'Auto-repair', 'Restarts crashed containers and sites by itself, even when this PC is off.', wdText, () => watchdogModal(s)));
}

// ---------- set up a fresh server ----------
const SETUP_HAVE = { base: 'git', docker: 'docker', nginx: 'nginx', certbot: 'certbot', node: 'node', fail2ban: 'fail2ban', updates: 'updates', firewall: 'ufw', timezone: 'tz' };
const SETUP_PARTS = [
  ['base', 'Basic tools', 'git, curl, unzip, htop'],
  ['docker', 'Docker + Docker Compose', 'with log size limits, so container logs never fill the disk'],
  ['nginx', 'nginx', 'the web server in front of your sites'],
  ['certbot', 'certbot', 'free HTTPS certificates that renew by themselves'],
  ['node', 'Node.js 20 + npm', 'only needed if you build websites on the server'],
  ['swap', 'Swap memory', 'extra memory on the disk: small servers stop crashing during builds'],
  ['firewall', 'Firewall', 'only SSH, 80 and 443 open (your SSH port is opened first)'],
  ['fail2ban', 'fail2ban', 'blocks robots that guess SSH passwords'],
  ['updates', 'Automatic security updates', 'Ubuntu installs security fixes by itself, no reboot'],
  ['timezone', 'Time zone', 'so logs and backups show your local time'],
];

async function setupModal(s) {
  loading(`Set up ${s.name}`, 'Looking at what is installed…');
  const c = await safe(() => api.call('setup:check', s.id));
  if (!c) return closeModal();
  const installed = (id) => {
    const v = c[SETUP_HAVE[id]];
    if (id === 'swap') return c.swap > 0 ? `${Math.round(c.swap / 1024)} MB` : null;
    if (id === 'firewall') return c.ufw === 'active' ? 'active' : null;
    if (id === 'fail2ban') return c.fail2ban === 'active' ? 'running' : null;
    if (id === 'timezone') return null;
    if (id === 'docker' && v && v !== '-' && (!c.compose || c.compose === '-')) return null;
    return v && v !== '-' ? v.replace(/^(git version|Docker version|nginx version: nginx\/|certbot) ?/i, '').split(',')[0] : null;
  };
  const memGb = c.mem / 1048576;
  const swapGb = h('select', {}, [1, 2, 4, 8].map((n) => h('option', { value: n, selected: n === (memGb <= 2 ? 2 : memGb <= 8 ? 2 : 4) }, `${n} GB`)));
  const tz = h('input', { type: 'text', value: c.tz && c.tz !== '-' ? c.tz : 'Asia/Kolkata', list: 'tzList', placeholder: 'Asia/Kolkata' });
  const tzList = h('datalist', { id: 'tzList' }, ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Singapore', 'Africa/Casablanca', 'Africa/Tunis', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'UTC'].map((z) => h('option', { value: z })));
  const boxes = {};
  const rows = SETUP_PARTS.map(([id, label, text]) => {
    const have = installed(id);
    const def = { node: false, timezone: false }[id] === false ? false : !have;
    const box = h('input', { type: 'checkbox', checked: def });
    boxes[id] = box;
    const extra = id === 'swap' ? h('label', { class: 'inline' }, 'Size', swapGb) : id === 'timezone' ? h('label', { class: 'inline' }, 'Zone', tz, tzList) : null;
    return h('label', { class: 'check' }, box, h('div', { class: 't' }, h('b', {}, label), h('div', { class: 'muted small' }, text), extra),
      have ? h('span', { class: 'pill ok' }, `✓ ${have}`) : h('span', { class: 'pill' }, 'not yet'));
  });
  const run = h('button', { class: 'btn primary' }, 'Set up now');
  run.addEventListener('click', async () => {
    const parts = Object.entries(boxes).filter(([, b]) => b.checked).map(([id]) => id);
    if (!parts.length) return toast('Tick at least one thing.', true);
    closeModal();
    startJob(await safe(() => api.call('setup:run', s.id, { parts, swapGb: Number(swapGb.value), sshPort: Number(c.sshport) || s.port || 22, timezone: tz.value.trim() })));
  });
  fill($('#modalCard'),
    h('h1', {}, `Set up ${s.name}`),
    h('div', { class: 'muted small', style: 'margin:-8px 0 14px' }, `${c.os} · ${fmtBytes(c.mem * 1024)} memory · ${fmtBytes(c.disk * 1024)} free disk`),
    c.apt !== '1' ? h('div', { class: 'note bad' }, 'This server has no apt-get. Set up works on Ubuntu and Debian only.') : null,
    h('div', { class: 'list-card' }, rows),
    h('div', { class: 'note info' }, 'Safe to press again: anything already there is skipped. Takes 2 to 10 minutes on a fresh server. Your SSH port stays open, so you are never locked out.'),
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), run));
  run.disabled = c.apt !== '1';
}

// ---------- auto-repair ----------
const WD_KIND = { fixed: ['ok', 'Fixed'], failed: ['bad', 'Failed'], gave_up: ['bad', 'Gave up'], down: ['warn', 'Down'], back: ['ok', 'Back'], on: ['', 'On'], off: ['', 'Off'] };

async function watchdogModal(s) {
  loading('Auto-repair', 'Reading the watchdog on the server…');
  const st = await safe(() => api.call('watchdog:status', s.id));
  if (!st) return closeModal();
  wide();
  const cfg = st.config || { projects: [], sites: [], containers: true, nginx: true, disk: true };
  const sitesAll = [...st.suggest.sites];
  for (const x of cfg.sites) if (!sitesAll.some((y) => y.url === x.url)) sitesAll.push(x);
  const projAll = [...new Set([...st.suggest.projects, ...cfg.projects])];
  const tick = (on) => h('input', { type: 'checkbox', checked: on });
  const containers = tick(cfg.containers);
  const nginx = tick(cfg.nginx);
  const disk = tick(cfg.disk);
  const allProj = tick(!cfg.projects.length);
  const projBoxes = projAll.map((p) => ({ p, box: tick(!cfg.projects.length || cfg.projects.includes(p)) }));
  const siteBoxes = sitesAll.map((x) => ({ x, box: tick(st.on ? cfg.sites.some((y) => y.url === x.url) : true) }));
  const projList = h('div', { class: 'chips' }, projBoxes.map(({ p, box }) => h('label', { class: 'chip pick' }, box, p)));
  const syncProj = () => projList.classList.toggle('hidden', allProj.checked);
  allProj.addEventListener('change', syncProj); syncProj();

  const save = async (on) => {
    const conf = on ? {
      containers: containers.checked, nginx: nginx.checked, disk: disk.checked,
      projects: allProj.checked ? [] : projBoxes.filter((x) => x.box.checked).map((x) => x.p),
      sites: siteBoxes.filter((x) => x.box.checked).map((x) => ({ url: x.x.url, port: x.x.port })),
    } : null;
    if (on && !allProj.checked && !conf.projects.length && containers.checked) return toast('Tick at least one project, or "All projects".', true);
    const r = await safe(() => api.call('watchdog:save', s.id, conf), on ? 'Auto-repair is on' : 'Auto-repair is off');
    if (r) { closeModal(); render(); }
  };
  const events = st.events.filter((e) => e.kind !== 'on' && e.kind !== 'off').slice(0, 25);
  fill($('#modalCard'),
    h('div', { class: 'row', style: 'margin-bottom:14px' }, h('h1', { style: 'margin:0;flex:1' }, 'Auto-repair'),
      h('span', { class: `pill ${st.on ? 'ok' : ''}` }, st.on ? 'On' : 'Off')),
    h('p', { class: 'muted', style: 'margin-top:0' }, `A small job on ${s.name} checks everything every minute and repairs what broke, even when this PC is off. It never repairs the same thing more than 3 times an hour: then it stops and writes "Gave up", so a broken container does not restart forever.`),
    h('div', { class: 'grid2 cols-2' },
      h('div', { class: 'section' }, h('h2', {}, 'What it checks'),
        h('label', { class: 'check' }, containers, h('div', { class: 't' }, h('b', {}, 'Crashed containers'), h('div', { class: 'muted small' }, 'Started again. A container you stopped yourself is left alone.'))),
        h('div', { class: containers.checked ? 'sub-opts' : 'sub-opts' }, h('label', { class: 'check' }, allProj, h('div', { class: 't' }, 'All projects')), projList),
        h('label', { class: 'check' }, nginx, h('div', { class: 't' }, h('b', {}, 'nginx'), h('div', { class: 'muted small' }, 'Started again when it stopped.'))),
        h('label', { class: 'check' }, disk, h('div', { class: 't' }, h('b', {}, 'Disk 90 % full'), h('div', { class: 'muted small' }, 'Old Docker leftovers and system logs are cleaned.')))),
      h('div', { class: 'section' }, h('h2', {}, 'Websites'),
        h('div', { class: 'muted small' }, 'When a site answers 502 / 503 / 504 (or nothing) 3 minutes in a row, its container is restarted.'),
        siteBoxes.length ? siteBoxes.map(({ x, box }) => h('label', { class: 'check' }, box, h('div', { class: 't' }, h('b', { class: 'mono' }, x.url), h('div', { class: 'muted small' }, `container on port ${x.port}`))))
          : h('div', { class: 'empty-line' }, 'No websites yet: deploy a trading or container-port site first.'))),
    h('div', { class: 'section' }, h('h2', {}, 'Recent repairs'),
      events.length ? h('div', { class: 'timeline' }, events.map((e) => {
        const [cls, label] = WD_KIND[e.kind] || ['', e.kind];
        return h('div', { class: 'tl-row' }, h('span', { class: 'muted small mono' }, e.at), h('span', { class: `pill ${cls}` }, label), h('span', { class: 'grow-1' }, e.text.replace(/ -> /g, ' → ')));
      })) : h('div', { class: 'empty-line' }, st.on ? 'Nothing needed fixing yet.' : 'Turn it on to start watching.')),
    h('div', { class: 'modal-foot' },
      st.on ? h('button', { class: 'btn danger', onclick: () => save(false) }, 'Turn off') : null,
      h('span', { class: 'grow-1' }),
      h('button', { class: 'btn', onclick: closeModal }, 'Close'),
      h('button', { class: 'btn primary', onclick: () => save(true) }, st.on ? 'Save' : 'Turn on')));
}

// ---------- .env on the server ----------
async function envModal(s, d) {
  const name = d.config.project;
  loading(`Settings of ${name}`, 'Looking for .env files on the server…');
  const list = await safe(() => api.call('env:list', s.id, d.folder));
  if (!list) return closeModal();
  wide();
  if (!list.length) {
    return fill($('#modalCard'), h('h1', {}, `Settings of ${name}`), h('div', { class: 'card empty' }, h('h1', {}, 'No .env file'), h('p', {}, `There is no .env file in ${d.config.remoteDir} on the server.`)),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Close')));
  }
  const side = h('div', { class: 'env-files' });
  const body = h('div', { class: 'env-body' });
  const open = async (rel) => {
    for (const a of side.children) a.classList.toggle('active', a.dataset.rel === rel);
    fill(body, h('div', { class: 'muted' }, `Reading ${rel}…`), h('div', { class: 'bar indeterminate' }, h('i')));
    const f = await safe(() => api.call('env:read', s.id, d.folder, rel));
    if (f) drawEnv(s, d, f, body);
  };
  fill(side, list.map((f) => h('a', { 'data-rel': f.rel, onclick: () => open(f.rel) }, h('b', { class: 'mono' }, f.rel), h('div', { class: 'muted small' }, `${fmtBytes(f.size)} · changed ${ago(f.mtime)}`))));
  fill($('#modalCard'), h('h1', {}, `Settings of ${name}`), h('div', { class: 'muted small mono', style: 'margin:-8px 0 14px' }, `${s.name}: ${d.config.remoteDir}`),
    h('div', { class: 'env' }, side, body));
  open((list.find((f) => f.rel === '.env') || list.find((f) => /server|backend|api/.test(f.rel)) || list[0]).rel);
}

function drawEnv(s, d, f, body) {
  const rows = [];
  const table = h('div', { class: 'kv' });
  const filter = h('input', { type: 'text', placeholder: 'Find a setting…' });
  const addRow = (key, value, secret, isNew) => {
    const k = h('input', { type: 'text', value: key, class: 'mono', placeholder: 'NAME', readonly: !isNew });
    const v = h('input', { type: secret ? 'password' : 'text', value, class: 'mono', placeholder: 'value' });
    const eye = secret ? h('button', { class: 'btn small ghost', title: 'Show / hide', onclick: () => { v.type = v.type === 'password' ? 'text' : 'password'; } }, '👁') : h('span');
    const r = { k, v, removed: false, orig: value, isNew };
    const del = h('button', { class: 'btn small ghost danger', title: 'Remove this setting', onclick: () => { r.removed = !r.removed; el.classList.toggle('removed', r.removed); } }, '✕');
    const el = h('div', { class: 'kv-row' }, k, v, eye, del);
    v.addEventListener('input', () => el.classList.toggle('changed', v.value !== r.orig));
    r.el = el;
    rows.push(r);
    table.append(el);
    if (isNew) k.focus();
  };
  for (const e of f.entries) addRow(e.key, e.value, e.secret, false);
  filter.addEventListener('input', () => { const t = filter.value.trim().toLowerCase(); for (const r of rows) r.el.classList.toggle('hidden', !!t && !r.k.value.toLowerCase().includes(t) && !r.v.value.toLowerCase().includes(t)); });

  const suggested = new Set(f.affected.map((a) => a.service));
  const svcBoxes = f.services.map((n) => ({ n, box: h('input', { type: 'checkbox', checked: suggested.has(n) }) }));
  const rebuild = h('input', { type: 'checkbox', checked: f.affected.some((a) => a.rebuild) });
  const alsoLocal = h('input', { type: 'checkbox', checked: f.local !== 'missing' });
  const save = h('button', { class: 'btn primary' }, 'Save');
  save.addEventListener('click', async () => {
    const out = rows.filter((r) => !r.removed && r.k.value.trim()).map((r) => ({ key: r.k.value.trim(), value: r.v.value }));
    const services = svcBoxes.filter((x) => x.box.checked).map((x) => x.n);
    save.disabled = true;
    const r = await safe(() => api.call('env:save', s.id, d.folder, f.rel, out, { alsoLocal: alsoLocal.checked, apply: services.length ? { services, rebuild: rebuild.checked } : null }));
    save.disabled = false;
    if (!r) return;
    if (!r.changed) return toast('Nothing changed.');
    closeModal();
    if (r.job) startJob(r.job); else toast(`${f.rel} saved. Restart the containers that read it to use the new values.`);
  });
  fill(body,
    h('div', { class: 'row' }, h('h2', { style: 'margin:0;flex:1' }, f.rel), filter),
    f.local === 'different' ? h('div', { class: 'note' }, `The ${f.rel} in your project folder on this PC is different from the one on the server. Saving with "Also save on this PC" makes them the same.`) : null,
    h('div', { class: 'kv-head' }, h('span', {}, 'Name'), h('span', {}, 'Value')),
    table,
    h('button', { class: 'btn small', style: 'margin-top:8px', onclick: () => addRow('', '', false, true) }, '+ Add a setting'),
    h('div', { class: 'section' }, h('h2', {}, 'After saving'),
      h('div', { class: 'muted small' }, f.affected.length ? `Suggested: ${f.affected.map((a) => `${a.service} (${a.why})`).join('; ')}.` : 'ServerSnap could not tell which container reads this file: tick the ones that use it.'),
      h('div', { class: 'chips' }, svcBoxes.map(({ n, box }) => h('label', { class: 'chip pick' }, box, n))),
      h('label', { class: 'check' }, rebuild, h('div', { class: 't' }, h('b', {}, 'Rebuild them (slower)'), h('div', { class: 'muted small' }, 'Needed when the file is copied into the image at build time (a .env inside a build folder). Otherwise a restart is enough.'))),
      h('label', { class: 'check' }, alsoLocal, h('div', { class: 't' }, h('b', {}, 'Also save it in the project folder on this PC'), h('div', { class: 'muted small' }, 'Recommended: otherwise the next deploy sends the old values back. The old file is kept in .serversnap-backup.')))),
    h('div', { class: 'note info' }, 'The old file stays on the server next to it (.env.serversnap-<date>, the last 5). Comments and the order of the lines are kept.'),
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), save));
}

// ---------- change domain ----------
async function domainModal(s, d) {
  const c = d.config;
  const sites = c.sites.filter((x) => x.enabled);
  if (!sites.length) return toast('This project has no website switched on.', true);
  wide();
  const main = h('input', { type: 'text', placeholder: 'newdomain.com', value: '' });
  const redirect = h('input', { type: 'checkbox', checked: true });
  const inputs = {};
  const auto = {};
  const siteRows = sites.map((x) => {
    const i = h('input', { type: 'text', placeholder: 'new domain' });
    inputs[x.id] = i;
    i.addEventListener('input', () => { auto[x.id] = false; replan(); });
    return h('div', { class: 'dom-row' }, h('span', { class: 'mono old' }, x.domain), h('span', { class: 'arrow' }, '→'), i,
      h('span', { class: 'muted small' }, x.folder));
  });
  const files = h('div', {});
  const err = h('div', { class: 'note bad hidden' });
  const startBtn = h('button', { class: 'btn primary', disabled: true }, 'Change domain');
  let plan = null;
  let timer = null;
  const boxes = new Map();
  const replan = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const map = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim().toLowerCase()]).filter(([, v]) => v));
      err.classList.add('hidden');
      if (!Object.keys(map).length) { fill(files); startBtn.disabled = true; return; }
      fill(files, h('div', { class: 'muted small' }, 'Looking for the old domain in the project files…'));
      try { plan = await api.call('domain:plan', s.id, d.folder, map, main.value.trim().toLowerCase()); } catch (e) { plan = null; err.textContent = e.message; err.classList.remove('hidden'); fill(files); startBtn.disabled = true; return; }
      boxes.clear();
      fill(files, plan.files.length ? [
        h('div', { class: 'muted small' }, `${plan.files.length} file${plan.files.length === 1 ? '' : 's'} name the old domain. Ticked ones get the new one (old copies are kept):`),
        h('div', { class: 'list-card scroll' }, plan.files.map((f) => {
          const b = h('input', { type: 'checkbox', checked: true });
          boxes.set(f.rel, b);
          return h('label', { class: 'check' }, b, h('div', { class: 't mono' }, f.rel), h('span', { class: 'pill' }, `${f.count}×`), f.inSite ? h('span', { class: 'pill' }, 'website') : h('span', { class: 'pill warn' }, 'backend'));
        })),
        plan.files.some((f) => !f.inSite) && plan.docker ? h('div', { class: 'muted small' }, 'Backend files change too, so the containers are rebuilt during the deploy.') : null,
      ] : h('div', { class: 'muted small' }, 'No file in the project names the old domain: only the nginx side changes.'));
      startBtn.disabled = false;
    }, 350);
  };
  main.addEventListener('input', () => {
    const m = main.value.trim().toLowerCase();
    for (const x of sites) {
      if (auto[x.id] === false) continue;
      inputs[x.id].value = m && c.mainDomain && x.domain.endsWith(c.mainDomain) ? x.domain.slice(0, -c.mainDomain.length) + m : m && !c.mainDomain ? m : inputs[x.id].value;
    }
    replan();
  });
  startBtn.addEventListener('click', async () => {
    const map = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim().toLowerCase()]).filter(([, v]) => v));
    const list = [...boxes].filter(([, b]) => b.checked).map(([rel]) => rel);
    closeModal();
    if (!(await confirmBox('Change the domain now?', `${Object.entries(map).map(([k, v]) => `${sites.find((x) => x.id === k).domain} → ${v}`).join(', ')}. ${list.length} file${list.length === 1 ? '' : 's'} change on this PC, then the project is deployed with the new domain${redirect.checked ? ' and the old one sends visitors to it' : ''}.`, 'Change domain'))) return;
    startJob(await safe(() => api.call('domain:run', s.id, d.folder, { map, newMain: main.value.trim().toLowerCase(), files: list, redirect: redirect.checked })));
  });
  openModal(h('h1', {}, `Change the domain of ${c.project}`),
    h('div', { class: 'steps' },
      h('div', {}, h('b', {}, '1'), h('span', {}, 'Point the new domain to ', h('span', { class: 'mono' }, s.host), ' at your domain company (A record, also for www / pc / admin…). ServerSnap checks it first and changes nothing if it does not point here yet.')),
      h('div', {}, h('b', {}, '2'), h('span', {}, 'The new domain is written into the project files (API address, CORS…), the websites are built and deployed with HTTPS.')),
      h('div', {}, h('b', {}, '3'), h('span', {}, 'The old domain sends visitors to the new one, so old links and the app keep working.'))),
    h('label', { class: 'field', style: 'margin-top:14px' }, `New main domain${c.mainDomain ? ` (now ${c.mainDomain})` : ''}`, main),
    h('div', { class: 'section' }, h('h2', {}, 'Websites'), siteRows),
    h('div', { class: 'section' }, h('h2', {}, 'Project files'), files),
    h('label', { class: 'check' }, redirect, h('div', { class: 't' }, h('b', {}, 'Old domain → new domain (301 redirect)'), h('div', { class: 'muted small' }, 'Keeps old links working. Its HTTPS certificate is kept as long as it is valid.'))),
    err,
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), startBtn));
  setTimeout(() => main.focus(), 30);
}

// ---------- the Database tab ----------
const dbState = new Map(); // serverId -> { container, db, coll, search, page, sel }

function dbTab(s) {
  const st = dbState.get(s.id) || { page: 0, search: {}, sel: new Set() };
  dbState.set(s.id, st);
  const box = h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Looking for databases…'), h('div', { class: 'bar indeterminate' }, h('i')));
  (async () => {
    const list = await safe(() => api.call('db:containers', s.id));
    if (state.page.name !== 'server' || state.page.id !== s.id || state.page.tab !== 'db') return;
    if (!list) return fill(box, h('div', { class: 'note bad' }, 'Could not read the containers on this server.'));
    const mongo = list.filter((c) => c.kind === 'mongo');
    if (!mongo.length) {
      return fill(box, h('div', { class: 'empty' }, h('h1', {}, 'No MongoDB here'),
        h('p', {}, list.length ? `This server runs ${list.map((c) => `${c.name} (${c.kind})`).join(', ')}. The viewer works with MongoDB containers for now.` : 'No database container runs on this server.')));
    }
    if (!st.container || !mongo.some((c) => c.id === st.container)) { st.container = mongo[0].id; st.db = null; st.coll = null; }
    const view = h('div', { class: 'dk' });
    box.replaceWith(view);
    drawDb(s, st, mongo, view);
  })();
  return box;
}

async function drawDb(s, st, mongo, view) {
  const side = h('div', { class: 'dk-list db-side' });
  const detail = h('div', { class: 'dk-detail' });
  fill(view, side, detail);
  const c = mongo.find((x) => x.id === st.container);
  const pick = h('select', {}, mongo.map((x) => h('option', { value: x.id, selected: x.id === st.container }, `${x.project ? x.project + ' · ' : ''}${x.name}${x.running ? '' : ' (stopped)'}`)));
  pick.addEventListener('change', () => { st.container = pick.value; st.db = null; st.coll = null; drawDb(s, st, mongo, view); });
  fill(side, h('label', { class: 'field' }, 'Database container', pick), h('div', { class: 'muted small' }, 'Loading…'));
  if (!c.running) return fill(detail, h('div', { class: 'card note bad' }, `${c.name} is stopped. Start it in the Docker tab.`));
  const dbs = await safe(() => api.call('db:call', s.id, c.id, 'admin', 'databases'));
  if (!dbs) return fill(side, h('label', { class: 'field' }, 'Database container', pick));
  const user = dbs.filter((x) => !['admin', 'local', 'config'].includes(x.name));
  if (!st.db || !dbs.some((x) => x.name === st.db)) st.db = (user[0] || dbs[0] || {}).name || null;
  const dbSel = h('select', {}, dbs.map((x) => h('option', { value: x.name, selected: x.name === st.db }, `${x.name}  (${fmtBytes(x.size)})`)));
  dbSel.addEventListener('change', () => { st.db = dbSel.value; st.coll = null; drawDb(s, st, mongo, view); });
  const colls = st.db ? await safe(() => api.call('db:call', s.id, c.id, st.db, 'collections')) : [];
  if (colls && (!st.coll || !colls.some((x) => x.name === st.coll))) st.coll = (colls.find((x) => /user|member|account|customer/i.test(x.name)) || colls[0] || {}).name || null;
  const collList = h('div', { class: 'coll-list' }, (colls || []).map((x) => h('a', { class: x.name === st.coll ? 'active' : '', onclick: () => { st.coll = x.name; st.page = 0; st.search = {}; st.sel = new Set(); drawDb(s, st, mongo, view); } },
    h('span', { class: 'grow-1' }, x.name), h('span', { class: 'muted small' }, x.count.toLocaleString()))));
  fill(side,
    h('label', { class: 'field' }, 'Database container', pick),
    h('label', { class: 'field' }, 'Database', dbSel),
    h('div', { class: 'side-label', style: 'padding:10px 2px 4px' }, `Collections (${(colls || []).length})`),
    collList,
    st.db && !['admin', 'local', 'config'].includes(st.db) ? h('button', { class: 'btn small ghost danger', style: 'margin-top:10px', onclick: async () => {
      if (!(await typeConfirm(`Delete the database ${st.db}?`, `Every collection and document in ${st.db} on ${c.name} is deleted for good. Make a backup first if you are not sure (Back up now).`, st.db, 'Delete the database'))) return;
      if (await safe(() => api.call('db:call', s.id, c.id, st.db, 'dropDatabase'), `${st.db} deleted`)) { st.db = null; st.coll = null; drawDb(s, st, mongo, view); }
    } }, 'Delete this database…') : null);
  if (!st.coll) return fill(detail, h('div', { class: 'card empty' }, h('h1', {}, 'No collections'), h('p', {}, `${st.db || 'This database'} is empty.`)));
  drawColl(s, st, c, detail, () => drawDb(s, st, mongo, view));
}

// One value in a table cell: short and readable.
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.$oid) return v.$oid;
    if (v.$date) return fmtDate(v.$date);
    if (v.$numberLong) return v.$numberLong;
    if (v.$numberDecimal) return v.$numberDecimal;
    if (Array.isArray(v)) return `[${v.length}]`;
    return '{…}';
  }
  const t = String(v);
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}

async function drawColl(s, st, c, detail, redrawAll) {
  const coll = st.coll;
  const call = (action, args = {}) => api.call('db:call', s.id, c.id, st.db, action, { coll, ...args });
  const field = h('select', {}, h('option', { value: '' }, 'Any usual field'));
  const text = h('input', { type: 'text', placeholder: 'Search: email, phone, name, id…', value: st.search.text || '' });
  const json = h('textarea', { placeholder: '{ "balance": { "$gt": 1000 } }', class: 'mono', style: 'min-height:54px' }, st.search.json || '');
  const adv = h('details', { open: !!st.search.json }, h('summary', {}, 'Advanced filter (MongoDB JSON)'), json);
  const results = h('div', {}, h('div', { class: 'bar indeterminate' }, h('i')));
  const searchNow = () => { st.search = { field: field.value, text: text.value, json: adv.open ? json.value : '' }; st.page = 0; st.sel = new Set(); load(); };
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchNow(); });
  const searching = () => !!(st.search.text || st.search.json);

  const load = async () => {
    fill(results, h('div', { class: 'bar indeterminate' }, h('i')));
    let r;
    try { r = await call('find', { search: { ...st.search, keys: st.keys || [] }, skip: st.page * 20, limit: 20 }); } catch (e) { fill(results, h('div', { class: 'note bad' }, e.message)); return; }
    st.keys = r.keys;
    if (field.options.length === 1) for (const k of r.keys) field.append(h('option', { value: k, selected: k === st.search.field }, k));
    const cols = r.keys.filter((k) => k !== '__v').sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0)).slice(0, 7);
    const all = h('input', { type: 'checkbox' });
    const rowsEls = r.docs.map((doc) => {
      const id = doc._id;
      const key = JSON.stringify(id);
      const b = h('input', { type: 'checkbox', checked: st.sel.has(key) });
      b.addEventListener('change', () => { if (b.checked) st.sel.add(key); else st.sel.delete(key); bar(); });
      return h('tr', { class: 'click', onclick: (e) => { if (e.target.tagName !== 'INPUT') docModal(s, st, c, doc, load); } },
        h('td', { class: 'pick' }, b), cols.map((k) => k === '_id'
          ? h('td', { class: 'mono muted', title: cellText(doc[k]) }, cellText(doc[k]).length > 12 ? '…' + cellText(doc[k]).slice(-8) : cellText(doc[k]))
          : h('td', {}, cellText(doc[k]))));
    });
    all.addEventListener('change', () => { for (const doc of r.docs) { const k = JSON.stringify(doc._id); if (all.checked) st.sel.add(k); else st.sel.delete(k); } load(); });
    const selBar = h('div', { class: 'sel-bar hidden' });
    const bar = () => {
      selBar.classList.toggle('hidden', !st.sel.size);
      fill(selBar, h('span', {}, `${st.sel.size} selected`), h('span', { class: 'grow-1' }),
        h('button', { class: 'btn small', onclick: () => { st.sel = new Set(); load(); } }, 'Clear'),
        h('button', { class: 'btn small danger-fill', onclick: async () => {
          if (!(await confirmBox(`Delete ${st.sel.size} document${st.sel.size === 1 ? '' : 's'}?`, `They are removed from ${coll} for good.`, 'Delete', true))) return;
          const res = await safe(() => call('deleteMany', { ids: [...st.sel].map((x) => JSON.parse(x)) }));
          if (res) { toast(`${res.deleted} deleted`); st.sel = new Set(); load(); }
        } }, 'Delete selected'));
    };
    bar();
    const from = r.total ? st.page * 20 + 1 : 0;
    const to = st.page * 20 + r.docs.length;
    fill(results,
      selBar,
      r.docs.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'dk-table db-table' },
        h('tr', {}, h('th', { class: 'pick' }, all), cols.map((k) => h('th', {}, k))), rowsEls))
        : h('div', { class: 'empty-line' }, searching() ? 'Nothing matches this search.' : 'This collection is empty.'),
      h('div', { class: 'row pager' },
        h('span', { class: 'muted small grow-1' }, r.total ? `${from}–${to} of ${r.more ? 'more than 5 000' : r.total.toLocaleString()}${searching() ? ' found' : ''}` : ''),
        searching() && r.total ? h('button', { class: 'btn small ghost danger', onclick: async () => {
          if (!(await typeConfirm(`Delete all ${r.more ? '5 000+' : r.total} results?`, `Every document in ${coll} that matches this search is deleted for good.`, 'DELETE', 'Delete them'))) return;
          const res = await safe(() => call('deleteFilter', { search: st.search }));
          if (res) { toast(`${res.deleted} deleted`); load(); }
        } }, 'Delete these results…') : null,
        h('button', { class: 'btn small', disabled: st.page === 0, onclick: () => { st.page--; load(); } }, '‹ Previous'),
        h('button', { class: 'btn small', disabled: to >= r.total, onclick: () => { st.page++; load(); } }, 'Next ›')));
  };

  const more = h('details', { class: 'menu' }, h('summary', { class: 'btn small' }, 'More ▾'),
    h('div', { class: 'menu-list' },
      h('button', { onclick: () => exportColl('csv') }, 'Export to Excel (CSV)'),
      h('button', { onclick: () => exportColl('json') }, 'Export to JSON'),
      h('hr'),
      h('button', { class: 'danger', onclick: async () => {
        if (!(await typeConfirm(`Empty ${coll}?`, `Every document in ${coll} is deleted. The collection itself and its indexes stay.`, coll, 'Empty it'))) return;
        const r = await safe(() => call('empty'));
        if (r) { toast(`${r.deleted} documents deleted`); redrawAll(); }
      } }, 'Empty this collection…'),
      h('button', { class: 'danger', onclick: async () => {
        if (!(await typeConfirm(`Delete the collection ${coll}?`, `${coll} and all its documents are deleted for good.`, coll, 'Delete it'))) return;
        if (await safe(() => call('drop'), `${coll} deleted`)) { st.coll = null; redrawAll(); }
      } }, 'Delete this collection…')));
  const exportColl = async (format) => {
    more.open = false;
    toast('Preparing the export…');
    const r = await safe(() => api.call('db:export', s.id, c.id, st.db, coll, st.search, format));
    if (r) toast(`${r.count.toLocaleString()} documents saved to ${r.file}`);
  };
  fill(detail,
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0;flex:1' }, coll, h('span', { class: 'muted small' }, `  ${st.db} · ${c.name}`)),
        h('button', { class: 'btn small', onclick: () => docModal(s, st, c, null, load) }, '+ Add document'), more),
      h('div', { class: 'search-row' }, field, text, h('button', { class: 'btn primary', onclick: searchNow }, 'Search'),
        searching() ? h('button', { class: 'btn ghost', onclick: () => { text.value = ''; json.value = ''; adv.open = false; searchNow(); } }, 'Clear') : null),
      adv,
      results));
  load();
}

// See / edit / delete one document (or add a new one when doc is null).
function docModal(s, st, c, doc, reload) {
  const isNew = !doc;
  const area = h('textarea', { class: 'mono doc-edit', spellcheck: 'false' }, isNew ? '{\n  "email": "",\n  "createdAt": { "$date": "' + new Date().toISOString() + '" }\n}' : JSON.stringify(doc, null, 2));
  const err = h('div', { class: 'note bad hidden' });
  const call = (action, args) => api.call('db:call', s.id, c.id, st.db, action, { coll: st.coll, ...args });
  const save = h('button', { class: 'btn primary' }, isNew ? 'Add' : 'Save');
  save.addEventListener('click', async () => {
    err.classList.add('hidden');
    let v;
    try { v = JSON.parse(area.value); } catch (e) { err.textContent = `Not valid JSON: ${e.message}`; err.classList.remove('hidden'); return; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { err.textContent = 'A document is one JSON object { … }.'; err.classList.remove('hidden'); return; }
    save.disabled = true;
    try {
      if (isNew) await call('insert', { doc: v });
      else await call('replace', { id: doc._id, doc: v });
    } catch (e) { save.disabled = false; err.textContent = e.message; err.classList.remove('hidden'); return; }
    closeModal();
    toast(isNew ? 'Document added' : 'Saved');
    reload();
  });
  const del = isNew ? null : h('button', { class: 'btn danger', onclick: async () => {
    closeModal();
    if (!(await confirmBox('Delete this document?', `It is removed from ${st.coll} for good.`, 'Delete', true))) return;
    const r = await safe(() => call('deleteMany', { ids: [doc._id] }));
    if (r) { toast('Deleted'); reload(); }
  } }, 'Delete');
  openModal(h('h1', {}, isNew ? `Add to ${st.coll}` : `${st.coll} · ${cellText(doc._id)}`),
    h('div', { class: 'muted small', style: 'margin:-8px 0 10px' }, 'Ids and dates are written as {"$oid": "…"} and {"$date": "…"}: keep that form so they stay ids and dates.'),
    area, err,
    h('div', { class: 'modal-foot' }, del, h('span', { class: 'grow-1' }), h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), save));
  wide();
  setTimeout(() => area.focus(), 30);
}
