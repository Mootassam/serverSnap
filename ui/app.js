'use strict';
/* global api, h, $, fill, fmtBytes, fmtKb, fmtDate, ago, since, toast, safe, openModal, closeModal, confirmBox */

// ---------- state ----------
const state = {
  servers: [],
  page: { name: 'home' },
  jobs: new Map(),
  scanStep: null,
};

async function loadServers() {
  state.servers = (await safe(() => api.call('servers:list'))) || [];
  renderSide();
}

function go(page) {
  state.page = page;
  renderSide();
  render();
}

// ---------- sidebar ----------
function serverStatus(s) {
  if (s.running) return 'running';
  return s.lastRun ? s.lastRun.status : '';
}

function renderSide() {
  const list = $('#serverList');
  fill(list, ...state.servers.map((s) => h('a', {
    class: state.page.name === 'server' && state.page.id === s.id ? 'active' : '',
    onclick: () => go({ name: 'server', id: s.id, tab: state.page.id === s.id ? state.page.tab : 'what' }),
  }, h('span', { class: `dot ${serverStatus(s)}` }),
  h('div', { class: 'name' }, s.name, h('div', { class: 'sub' }, s.lastRun ? `Backup ${ago(s.lastRun.at)}` : 'No backup yet')))));
  for (const a of document.querySelectorAll('.side-nav a')) a.classList.toggle('active', a.dataset.page === state.page.name);
  const running = [...state.jobs.values()].filter((j) => j.state === 'running').length;
  const badge = $('#activityBadge');
  badge.textContent = running;
  badge.classList.toggle('hidden', !running);
}

// ---------- pages ----------
function render() {
  const main = $('#main');
  const p = state.page;
  if (p.name === 'server') return renderServer(main, p.id);
  if (p.name === 'backups') return renderBackups(main);
  if (p.name === 'activity') return renderActivity(main);
  if (p.name === 'settings') return renderSettings(main);
  return renderHome(main);
}

function renderHome(main) {
  if (state.servers.length) return go({ name: 'server', id: state.servers[0].id, tab: 'what' });
  fill(main, h('div', { class: 'empty' },
    h('img', { src: '../assets/icon.png', width: 72, height: 72, alt: '' }),
    h('h1', {}, 'Never lose your server data again'),
    h('p', {}, 'Add your VPS. ServerSnap finds your websites, Docker projects and databases, copies them to this PC, and can put everything back on any new server.'),
    h('button', { class: 'btn primary', onclick: () => serverModal() }, '+ Add your first server')));
}

// ----- server page -----
async function renderServer(main, id) {
  const data = await safe(() => api.call('servers:get', id));
  if (!data) return go({ name: 'home' });
  if (state.page.name !== 'server' || state.page.id !== id) return;
  const { server: s, scan } = data;
  const tab = state.page.tab || 'what';
  const last = s.lastRun;
  fill(main, 
    h('div', { class: 'head' },
      h('div', { class: 'grow' }, h('h1', {}, s.name),
        h('div', { class: 'meta' }, `${s.username}@${s.host}:${s.port}`,
          last ? h('span', { class: `pill ${last.status}` }, `last backup ${ago(last.at)} · ${last.status}`) : h('span', { class: 'pill' }, 'no backup yet'),
          s.nextRun ? h('span', { class: 'pill' }, `next: ${fmtDate(s.nextRun)}`) : null)),
      h('button', { class: 'btn', onclick: () => testServer(s.id) }, 'Test connection'),
      h('button', { class: 'btn', onclick: () => serverModal(s) }, 'Edit'),
      h('button', { class: 'btn primary', disabled: s.running, onclick: () => startBackup(s.id) }, s.running ? 'Running…' : 'Back up now')),
    last && last.status === 'failed' && last.error ? h('div', { class: 'note bad' }, `Last backup failed: ${last.error}`) : null,
    h('div', { class: 'tabs' },
      ...[['what', 'What to back up'], ['docker', 'Docker'], ['clients', `Customers${(s.clients || []).length ? ` (${s.clients.length})` : ''}`], ['schedule', 'Schedule & storage']]
        .map(([k, label]) => h('a', { class: tab === k ? 'active' : '', onclick: () => { state.page.tab = k; render(); } }, label))),
    tab === 'what' ? whatTab(s, scan) : tab === 'docker' ? dockerTab(s) : tab === 'clients' ? clientsTab(s) : scheduleTab(s));
}

function whatTab(s, scan) {
  if (state.scanStep && state.scanStep.id === s.id) {
    return h('div', { class: 'card' }, h('h2', {}, 'Looking at your server…'), h('div', { class: 'muted' }, state.scanStep.step), h('div', { class: 'bar indeterminate' }, h('i')));
  }
  if (!scan) {
    return h('div', { class: 'card empty' }, h('h1', {}, 'Scan this server'),
      h('p', {}, 'ServerSnap will look for Docker projects, volumes, databases and website folders. Nothing is changed on the server.'),
      h('button', { class: 'btn primary', onclick: () => runScan(s.id) }, 'Scan now'));
  }
  const sel = scan.selected;
  const setChoice = (kind, itemId, defaultOn) => async (e) => {
    const v = await safe(() => api.call('selection:set', s.id, kind, itemId, e.target.checked, defaultOn));
    if (v) render();
  };
  const estimate = scan.folders.filter((f) => sel.folders.includes(f.path) && !f.coveredBy).reduce((a, f) => a + (f.sizeKb || 0), 0) +
    scan.volumes.filter((v) => sel.volumes.includes(v.name)).reduce((a, v) => a + (v.sizeKb || 0), 0);
  const dk = scan.docker;

  const dbRows = scan.databases.map((d) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: sel.databases.includes(d.id), onchange: setChoice('db', d.id, d.on) }),
    h('div', { class: 't' }, h('b', {}, d.label), d.running ? null : h('span', { class: 'pill warn' }, 'stopped'),
      h('div', { class: 'muted small' }, d.where === 'docker' ? `Safe database copy (dump)${d.project ? ` · project ${d.project}` : ''}` : 'Installed directly on the server · safe database copy (dump)'))));
  // Volumes grouped per Docker project, so each customer's data sits together.
  const projectOf = new Map(scan.projects.flatMap((p) => p.services.map((x) => [x.container, p.name])));
  const volGroups = new Map();
  for (const v of scan.volumes) {
    const k = v.project || (v.db && v.db.project) || v.usedBy.map((c) => projectOf.get(c)).find(Boolean) || '';
    if (!volGroups.has(k)) volGroups.set(k, []);
    volGroups.get(k).push(v);
  }
  const volRows = [...volGroups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b)).flatMap((k) => [
    h('div', { class: 'group-head' }, k || 'Not in a project',
      h('span', { class: 'muted small' }, ` · ${fmtKb(volGroups.get(k).reduce((a, v) => a + (v.sizeKb || 0), 0))}`)),
    ...volGroups.get(k).map(volRow)]);
  function volRow(v) { return h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: sel.volumes.includes(v.name), onchange: setChoice('volume', v.name, v.on) }),
    h('div', { class: 't' }, h('b', {}, v.anonymous ? `unnamed volume ${v.name.slice(0, 12)}` : v.name),
      h('div', { class: 'muted small' },
        v.db ? 'Database files. The database copy above is the safe version; this raw copy is a spare.' :
          v.usedBy.length ? `Used by ${v.usedBy.join(', ')}` : 'Not used by any container right now')),
    h('span', { class: 'size' }, fmtKb(v.sizeKb))); }
  const folderRows = scan.folders.map((f) => h('div', { class: 'check' },
    h('input', { type: 'checkbox', checked: sel.folders.includes(f.path), onchange: setChoice('folder', f.path, f.on) }),
    h('div', { class: 't' }, h('b', { class: 'mono' }, f.path),
      h('div', { class: 'muted small' }, f.reason, f.coveredBy ? ` · already included in ${f.coveredBy}` : '')),
    h('span', { class: 'size' }, fmtKb(f.sizeKb)),
    f.custom ? h('button', { class: 'btn small ghost', onclick: async () => { if (await safe(() => api.call('selection:removeFolder', s.id, f.path))) render(); } }, 'Remove') : null));

  const addInput = h('input', { type: 'text', placeholder: '/path/on/server, e.g. /home/app/uploads' });
  const addFolder = async () => {
    const p = addInput.value.trim();
    if (!p) return;
    if (await safe(() => api.call('selection:addFolder', s.id, p))) render();
  };
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addFolder(); });
  const excludes = h('textarea', { placeholder: 'node_modules\n*.log\ncache' }, (scan.selected.excludes || []).join('\n'));
  excludes.addEventListener('change', () => safe(() => api.call('selection:excludes', s.id, excludes.value.split('\n')), 'Saved'));

  return h('div', {},
    h('div', { class: 'card' }, h('div', { class: 'row' },
      h('div', { class: 'stat', style: 'flex:1' },
        h('div', {}, h('b', {}, scan.host.os || '—'), h('span', {}, scan.host.hostname)),
        h('div', {}, h('b', {}, dk.version ? `Docker ${dk.version}` : dk.installed ? 'Docker (no access)' : 'No Docker'), h('span', {}, dk.compose ? `Compose ${dk.compose}` : '')),
        h('div', {}, h('b', {}, scan.host.diskFreeKb ? fmtKb(scan.host.diskFreeKb) : '—'), h('span', {}, 'free on server')),
        h('div', {}, h('b', {}, estimate ? `~${fmtKb(estimate)}` : '—'), h('span', {}, 'selected (before compression)'))),
      h('div', {}, h('div', { class: 'muted small' }, `Scanned ${ago(scan.scannedAt)}`),
        h('button', { class: 'btn small', onclick: () => runScan(s.id) }, 'Scan again'))),
      scan.warnings.map((w) => h('div', { class: 'note' }, w)),
      h('div', { class: 'note info' }, 'Anything new that appears on the server later (a new project, volume or database) is included automatically.')),
    h('div', { class: 'card' }, h('h2', {}, `Databases (${scan.databases.length})`),
      dbRows.length ? dbRows : h('div', { class: 'muted' }, 'No databases found.')),
    dk.version ? h('div', { class: 'card' }, h('h2', {}, `Docker volumes (${scan.volumes.length})`),
      volRows.length ? volRows : h('div', { class: 'muted' }, 'No volumes found.')) : null,
    h('div', { class: 'card' }, h('h2', {}, 'Folders and files'), folderRows,
      h('div', { class: 'row', style: 'margin-top:12px' }, h('div', { style: 'flex:1' }, addInput), h('button', { class: 'btn', onclick: addFolder }, 'Add folder'))),
    h('div', { class: 'card' }, h('h2', {}, 'Skip these files'),
      h('div', { class: 'muted small', style: 'margin-bottom:8px' }, 'One name or pattern per line. They are left out of every folder. Saved when you click outside the box.'),
      excludes));
}

function scheduleTab(s) {
  const sch = s.schedule || {};
  const enabled = h('input', { type: 'checkbox', checked: sch.enabled });
  const every = h('select', {}, ...[['hourly', 'Every hour'], ['every6h', 'Every 6 hours'], ['every12h', 'Every 12 hours'], ['daily', 'Every day'], ['weekly', 'Every week']]
    .map(([v, l]) => h('option', { value: v, selected: (sch.every || 'daily') === v }, l)));
  const time = h('input', { type: 'time', value: sch.time || '03:00' });
  const weekday = h('select', {}, ...['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    .map((d, i) => h('option', { value: i, selected: (sch.weekday ?? 1) === i }, d)));
  const keep = h('input', { type: 'number', min: 1, max: 365, value: s.keep || 7, style: 'width:90px' });
  const dest = h('input', { type: 'text', value: s.backupRoot || '', placeholder: 'Default folder (see Settings)' });
  const timeField = h('label', { class: 'field' }, 'At', time);
  const dayField = h('label', { class: 'field' }, 'On', weekday);
  const sync = () => {
    timeField.classList.toggle('hidden', !['daily', 'weekly'].includes(every.value));
    dayField.classList.toggle('hidden', every.value !== 'weekly');
  };
  every.addEventListener('change', sync);
  sync();
  const save = async () => {
    const v = await safe(() => api.call('servers:save', {
      id: s.id, keep: Number(keep.value), backupRoot: dest.value.trim() || null,
      schedule: { enabled: enabled.checked, every: every.value, time: time.value || '03:00', weekday: Number(weekday.value) },
    }), 'Saved');
    if (v) { await loadServers(); render(); }
  };
  return h('div', {},
    h('div', { class: 'card' }, h('h2', {}, 'Automatic backups'),
      h('label', { class: 'check' }, enabled, h('div', { class: 't' }, h('b', {}, 'Back up automatically'),
        h('div', { class: 'muted small' }, 'Runs while ServerSnap is open or in the tray (bottom-right of the taskbar). If the PC was off, it runs as soon as it is back on.'))),
      h('div', { class: 'grid2', style: 'margin-top:12px' }, h('label', { class: 'field' }, 'How often', every), timeField, dayField),
      s.nextRun ? h('div', { class: 'muted small', style: 'margin-top:10px' }, `Next backup: ${fmtDate(s.nextRun)}`) : null),
    h('div', { class: 'card' }, h('h2', {}, 'Where backups are kept'),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, 'Keep the newest', h('div', { class: 'row' }, keep, h('span', { class: 'muted' }, 'backups (older ones are deleted)'))),
        h('label', { class: 'field' }, 'Backup folder on this PC', h('div', { class: 'row' }, h('div', { style: 'flex:1' }, dest),
          h('button', { class: 'btn', onclick: async () => { const p = await safe(() => api.call('dialog:folder', 'Where to keep backups')); if (p) dest.value = p; } }, 'Choose…')))),
      h('div', { class: 'note info' }, 'Tip: choose a folder on another drive, or one synced to Google Drive / OneDrive / Dropbox, so a copy is also kept off this PC.')),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, 'Save')));
}

// ----- Docker dashboard -----
// state.docker = { serverId, data, sel, loading, error, busy }
let dockerTimer = null;

function dockerTab(s) {
  const box = h('div', { id: 'dockerBox' });
  const d = state.docker;
  if (!d || d.serverId !== s.id) {
    state.docker = { serverId: s.id, data: null, sel: null, loading: false, error: null, busy: null, pick: { containers: new Set(), images: new Set(), volumes: new Set() } };
  }
  drawDocker(box);
  loadDocker(s.id, !state.docker.data || !state.docker.data.usageAt);
  return box;
}

async function loadDocker(serverId, withUsage) {
  const d = state.docker;
  if (!d || d.serverId !== serverId || d.loading) return;
  d.loading = true;
  redrawDocker();
  try {
    d.data = await api.call('docker:get', serverId, false);
    d.error = null;
    redrawDocker();
    if (withUsage) {
      const full = await api.call('docker:get', serverId, true);
      if (state.docker === d) d.data = full;
    }
  } catch (err) {
    d.error = err.message;
  } finally {
    d.loading = false;
    redrawDocker();
  }
}

function redrawDocker() {
  const box = document.getElementById('dockerBox');
  if (box && state.page.name === 'server' && state.page.tab === 'docker') drawDocker(box);
}

// Refresh every 20 s while the Docker tab is on screen.
function startDockerTimer() {
  clearInterval(dockerTimer);
  dockerTimer = setInterval(() => {
    const d = state.docker;
    if (!document.hidden && d && !d.busy && state.page.name === 'server' && state.page.tab === 'docker' && state.page.id === d.serverId) loadDocker(d.serverId, true);
  }, 20000);
}

function healthDot(g) {
  if (!g.total) return '';
  return g.running === g.total ? 'ok' : g.running ? 'partial' : 'failed';
}

function summaryText(g) {
  return g.summary.map((x) => (x.role === 'cache' || x.sizeKb == null ? x.label : `${x.label} (${fmtKb(x.sizeKb)})`)).join(' · ') || 'no volumes';
}

function drawDocker(box) {
  const d = state.docker;
  const v = d.data;
  if (!v) {
    fill(box, d.error ? h('div', { class: 'card' }, h('div', { class: 'note bad' }, d.error), h('button', { class: 'btn', onclick: () => loadDocker(d.serverId, true) }, 'Try again'))
      : h('div', { class: 'card' }, h('h2', {}, 'Reading Docker on the server…'), h('div', { class: 'bar indeterminate' }, h('i'))));
    return;
  }
  if (!v.docker.installed) { fill(box, h('div', { class: 'card empty' }, h('h1', {}, 'Docker is not installed'), h('p', {}, 'This server has no Docker. Restore a backup with "Install Docker" ticked to set it up.'))); return; }
  if (!v.docker.access) { fill(box, h('div', { class: 'card' }, h('div', { class: 'note bad' }, 'Docker is installed but this login cannot use it. Log in as root or a sudo user.'))); return; }

  const groups = v.groups;
  const keys = [...groups.map((g) => g.name ?? ''), '#images', ...(v.unusedVolumes.length ? ['#volumes'] : [])];
  if (d.sel == null || !keys.includes(d.sel)) d.sel = keys[0];
  const all = groups.flatMap((g) => g.containers);
  const running = all.filter((c) => c.running).length;
  const hs = v.host;

  const top = h('div', { class: 'card' }, h('div', { class: 'row' },
    h('div', { class: 'stat', style: 'flex:1' },
      h('div', {}, h('b', {}, `Docker ${v.docker.version || ''}`), h('span', {}, `${groups.filter((g) => g.name).length} project(s)`)),
      h('div', {}, h('b', {}, `${running} / ${all.length}`), h('span', {}, 'containers running')),
      hs && hs.load && hs.load.length ? h('div', {}, h('b', {}, hs.load.map((x) => x.toFixed(2)).join('  ')), h('span', {}, `load${hs.cpus ? ` (${hs.cpus} CPU)` : ''}`)) : null,
      hs && hs.memTotalKb ? h('div', {}, h('b', {}, `${fmtKb(hs.memUsedKb)} / ${fmtKb(hs.memTotalKb)}`), h('span', {}, 'memory used')) : null,
      hs && hs.diskFreeKb ? h('div', {}, h('b', {}, fmtKb(hs.diskFreeKb)), h('span', {}, 'disk free')) : null),
    h('div', { class: 'row' },
      h('span', { class: 'muted small' }, d.loading ? 'Updating…' : v.usageAt ? `Updated ${ago(new Date(v.usageAt).toISOString())}` : ''),
      h('button', { class: 'btn small', disabled: d.loading, onclick: () => loadDocker(d.serverId, true) }, 'Refresh'))),
  d.error ? h('div', { class: 'note bad' }, d.error) : null);

  const item = (key, title, sub, dot, count) => h('a', { class: d.sel === key ? 'active' : '', onclick: () => { d.sel = key; drawDocker(box); } },
    h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, dot != null ? h('span', { class: `dot ${dot}` }) : null, h('b', { class: 'grow-1' }, title), count ? h('span', { class: 'muted small' }, count) : null),
    sub ? h('div', { class: 'small sub' }, sub) : null);
  const list = h('nav', { class: 'dk-list' },
    groups.map((g) => item(g.name ?? '', g.title, summaryText(g), healthDot(g), `${g.running}/${g.total}`)),
    item('#images', 'All images', `${v.images.length} image(s) · ${fmtBytes(v.images.reduce((a, i) => a + i.size, 0))}`, null),
    v.unusedVolumes.length ? item('#volumes', 'Unused volumes', `${v.unusedVolumes.length} volume(s) not used by any container`, null) : null);

  // Forget ticks for things that are gone (after a delete or a refresh).
  const keep = (set, ids) => { const live = new Set(ids); for (const x of [...set]) if (!live.has(x)) set.delete(x); };
  keep(d.pick.containers, all.map((c) => c.id));
  keep(d.pick.images, v.images.map((i) => i.id));
  keep(d.pick.volumes, v.unusedVolumes.map((x) => x.name));

  let detail;
  if (d.sel === '#images') detail = imagesPanel(v.images);
  else if (d.sel === '#volumes') detail = unusedVolumesPanel(v.unusedVolumes);
  else detail = groupPanel(groups.find((g) => (g.name ?? '') === d.sel));
  fill(box, top, h('div', { class: 'dk' }, list, h('div', { class: 'dk-detail' }, detail)));
  startDockerTimer();
}

function stateText(c) {
  if (c.state === 'running') return `Up ${since(c.startedAt)}${c.health ? ` (${c.health})` : ''}`;
  if (c.state === 'exited') return `Exited (${c.exitCode}) ${c.finishedAt ? `${since(c.finishedAt)} ago` : ''}`;
  if (c.state === 'restarting') return `Restarting (${c.restartCount} times)`;
  return c.state;
}

function statePill(c) {
  if (c.state === 'running') return c.health === 'unhealthy' ? 'warn' : 'ok';
  if (c.state === 'restarting' || c.state === 'paused') return 'warn';
  return 'bad';
}

function groupPanel(g) {
  const d = state.docker;
  const busy = d.busy;
  const s = state.servers.find((x) => x.id === d.serverId) || {};
  const client = g.name ? (s.clients || []).find((c) => c.project === g.name) : null;
  const picked = g.containers.filter((c) => d.pick.containers.has(c.id));
  const allBox = h('input', { type: 'checkbox', checked: picked.length && picked.length === g.containers.length, title: 'Select all',
    onchange: (e) => { for (const c of g.containers) if (e.target.checked) d.pick.containers.add(c.id); else d.pick.containers.delete(c.id); redrawDocker(); } });
  const rows = g.containers.map((c) => h('tr', { class: d.pick.containers.has(c.id) ? 'picked' : '' },
    h('td', { class: 'pick' }, pickBox(d.pick.containers, c.id)),
    h('td', {}, h('b', {}, c.name), h('div', { class: 'muted small' }, h('span', { class: 'mono', title: `Created ${since(c.createdAt)} ago` }, c.shortId), c.service ? ` · ${c.service}` : '')),
    h('td', {}, h('span', { class: 'mono', title: c.command }, c.image), c.dbKind ? h('span', { class: 'pill' }, 'database') : null),
    h('td', { class: 'nowrap' }, h('span', { class: `pill ${statePill(c)}`, style: 'margin-left:0' }, c.state), h('div', { class: 'muted small' }, stateText(c)),
      c.restartCount ? h('div', { class: 'muted small' }, `restarted ${c.restartCount}×`) : null,
      c.usage ? h('div', { class: 'muted small' }, `CPU ${c.usage.cpu} · ${String(c.usage.mem || '').split(' / ')[0]}`) : null),
    h('td', { class: 'mono small' }, c.ports.length ? c.ports.map((p) => h('div', {}, p)) : '—'),
    h('td', { class: 'actions' }, h('div', { class: 'acts' },
      h('button', { class: 'btn small', onclick: () => logsModal(c) }, 'Logs'),
      c.running ? h('button', { class: 'btn small', disabled: !!busy, onclick: () => dockerAction('restart', { container: c.id }, c.name) }, 'Restart')
        : h('button', { class: 'btn small primary', disabled: !!busy, onclick: () => dockerAction('start', { container: c.id }, c.name) }, 'Start'),
      c.running ? h('button', { class: 'btn small danger', disabled: !!busy, onclick: () => dockerAction('stop', { container: c.id }, c.name) }, 'Stop') : h('span'),
      h('button', { class: 'btn small danger', disabled: !!busy, title: 'Delete this container', onclick: () => deleteContainersModal(g, [c], false) }, 'Delete')))));
  return h('div', {},
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('div', { style: 'flex:1;min-width:200px' }, h('h2', { style: 'margin:0' }, g.title,
          h('span', { class: `pill ${healthDot(g) === 'ok' ? 'ok' : healthDot(g) === 'partial' ? 'warn' : 'bad'}` }, `${g.running} of ${g.total} running`)),
        g.workingDir ? h('div', { class: 'muted small mono', style: 'margin-top:4px' }, g.workingDir) : null),
        g.name ? [
          h('button', { class: 'btn small', disabled: !!busy, onclick: () => dockerAction('start', { project: g.name }, `all of ${g.name}`) }, 'Start all'),
          h('button', { class: 'btn small', disabled: !!busy, onclick: () => dockerAction('restart', { project: g.name }, `all of ${g.name}`) }, 'Restart all'),
          h('button', { class: 'btn small danger', disabled: !!busy, onclick: () => dockerAction('stop', { project: g.name }, `all of ${g.name}`) }, 'Stop all'),
          h('button', { class: 'btn small danger-fill', disabled: !!busy, onclick: () => deleteContainersModal(g, g.containers, true) }, 'Delete customer…')] : null),
      h('div', { class: 'chips' }, g.summary.length ? g.summary.map((x) => h('span', { class: `chip ${x.role}` }, x.label, x.sizeKb != null && x.role !== 'cache' ? h('i', {}, fmtKb(x.sizeKb)) : null)) : h('span', { class: 'muted small' }, 'No volumes')),
      busy ? h('div', { class: 'note info' }, busy) : null,
      g.name ? h('div', { class: 'row', style: 'margin-top:12px' },
        client ? h('span', { class: 'small' }, '👤 Customer access: ', h('b', {}, client.name), h('span', { class: 'muted' }, ` · daily at ${client.time}`)) : h('span', { class: 'muted small' }, 'No customer access yet.'),
        h('button', { class: 'btn small', onclick: () => clientModal(s, g.name) }, client ? 'Change customer access' : 'Give this customer a download app')) : null),
    h('div', { class: 'card' }, h('div', { class: 'row', style: 'margin-bottom:6px' }, h('h2', { style: 'margin:0;flex:1' }, `Containers (${g.containers.length})`),
      picked.length ? h('button', { class: 'btn small danger-fill', disabled: !!busy, onclick: () => deleteContainersModal(g, picked, false) }, `Delete selected (${picked.length})`) : null),
      h('div', { class: 'table-wrap' }, h('table', { class: 'dk-table' }, h('thead', {}, h('tr', {}, h('th', { class: 'pick' }, allBox), ...['Name / ID', 'Image', 'Status', 'Ports', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows)))),
    g.volumes.length ? h('div', { class: 'card' }, h('h2', {}, `Volumes (${g.volumes.length})`), volumesTable(g.volumes)) : null,
    g.images.length ? h('div', { class: 'card' }, h('h2', {}, `Images (${g.images.length})`), imagesTable(g.images, false)) : null);
}

function volumesTable(vols, pick) {
  const what = { database: 'Database files', data: 'Data', cache: 'Cache', anonymous: 'Unnamed volume' };
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, pick ? h('th', { class: 'pick' }) : null, ...['Volume', 'What', 'Size', 'Used by'].map((x) => h('th', {}, x)))),
    h('tbody', {}, vols.map((v) => h('tr', { class: pick && pick.has(v.name) ? 'picked' : '' },
      pick ? h('td', { class: 'pick' }, pickBox(pick, v.name)) : null,
      h('td', { class: 'mono' }, v.role === 'anonymous' ? v.name.slice(0, 12) : v.name),
      h('td', {}, what[v.role] || v.role, v.role === 'data' && v.label !== v.name ? h('span', { class: 'muted small' }, ` (${v.label})`) : null),
      h('td', { class: 'nowrap' }, v.sizeKb == null ? h('span', { class: 'muted' }, '…') : fmtKb(v.sizeKb)),
      h('td', { class: 'small' }, v.usedBy.length ? v.usedBy.map((u, i) => h('div', {}, u, h('span', { class: 'muted mono' }, ` → ${v.mountedAt[i]}`))) : h('span', { class: 'muted' }, 'nothing')))))));
}

// A tick box that adds / removes `key` in `set`.
function pickBox(set, key, disabled, title) {
  return h('input', { type: 'checkbox', checked: set.has(key), disabled: !!disabled, title,
    onchange: (e) => { if (e.target.checked) set.add(key); else set.delete(key); redrawDocker(); } });
}

function reportDelete(res, what) {
  const f = res.failed || [];
  if (!f.length) return toast(`Deleted ${res.removed} ${what}.`);
  toast(`Deleted ${res.removed} ${what}. ${f.length} not deleted: ${f.slice(0, 3).map((x) => `${x.name} (${x.error})`).join('; ')}`, true);
}

function imagesTable(images, showUse) {
  const pick = showUse ? state.docker.pick.images : null;
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, pick ? h('th', { class: 'pick' }) : null, ...['Image', 'ID', 'Size', 'Created', ...(showUse ? ['Used by'] : [])].map((x) => h('th', {}, x)))),
    h('tbody', {}, images.map((i) => h('tr', { class: pick && pick.has(i.id) ? 'picked' : '' },
      pick ? h('td', { class: 'pick' }, pickBox(pick, i.id, i.usedBy.length, i.usedBy.length ? 'In use: delete its containers first' : 'Select')) : null,
      h('td', { class: 'mono' }, i.tags.length ? i.tags.join(', ') : h('span', { class: 'muted' }, '<none>')),
      h('td', { class: 'mono' }, i.shortId),
      h('td', { class: 'nowrap' }, fmtBytes(i.size)),
      h('td', { class: 'nowrap muted small' }, i.createdAt ? `${since(i.createdAt)} ago` : ''),
      showUse ? h('td', { class: 'small' }, i.usedBy.length ? i.usedBy.join(', ') : h('span', { class: 'pill warn', style: 'margin-left:0' }, 'not used')) : null)))));
}

function imagesPanel(images) {
  const d = state.docker;
  const unused = images.filter((i) => !i.usedBy.length);
  const picked = images.filter((i) => d.pick.images.has(i.id));
  const del = async () => {
    const size = fmtBytes(picked.reduce((a, i) => a + i.size, 0));
    if (!(await confirmBox(`Delete ${picked.length} image(s)?`, `${picked.map((i) => i.tags[0] || i.shortId).join(', ')} (${size}). This frees disk space. If a project needs one later, Docker downloads it again (your own built images are rebuilt from the project folder).`, 'Delete', true))) return;
    await deleteThings('docker:removeImages', picked.map((i) => i.id), 'image(s)');
  };
  return h('div', { class: 'card' },
    h('div', { class: 'row', style: 'margin-bottom:8px' }, h('h2', { style: 'margin:0;flex:1' }, `All images (${images.length})`),
      unused.length ? h('button', { class: 'btn small', onclick: () => { for (const i of unused) d.pick.images.add(i.id); redrawDocker(); } }, `Select all unused (${unused.length})`) : null,
      picked.length ? h('button', { class: 'btn small danger-fill', disabled: !!d.busy, onclick: del }, `Delete selected (${picked.length})`) : null),
    unused.length ? h('div', { class: 'note info' }, `${unused.length} image(s) are not used by any container (${fmtBytes(unused.reduce((a, i) => a + i.size, 0))}). Images in use cannot be ticked: delete their containers first.`) : null,
    d.busy ? h('div', { class: 'note info' }, d.busy) : null,
    imagesTable(images, true));
}

function unusedVolumesPanel(vols) {
  const d = state.docker;
  const picked = vols.filter((v) => d.pick.volumes.has(v.name));
  const del = async () => {
    const size = fmtKb(picked.reduce((a, v) => a + (v.sizeKb || 0), 0)) || 'unknown size';
    if (!(await confirmBox(`Delete ${picked.length} volume(s)?`, `${size} of data. No container uses them, but whatever is inside is gone forever. Make a backup first if you are not sure.`, 'Delete forever', true))) return;
    await deleteThings('docker:removeVolumes', picked.map((v) => v.name), 'volume(s)');
  };
  return h('div', { class: 'card' },
    h('div', { class: 'row', style: 'margin-bottom:8px' }, h('h2', { style: 'margin:0;flex:1' }, 'Volumes not used by any container'),
      h('button', { class: 'btn small', onclick: () => { for (const v of vols) d.pick.volumes.add(v.name); redrawDocker(); } }, `Select all (${vols.length})`),
      picked.length ? h('button', { class: 'btn small danger-fill', disabled: !!d.busy, onclick: del }, `Delete selected (${picked.length})`) : null),
    h('div', { class: 'muted small', style: 'margin-bottom:8px' }, 'Usually leftovers from old or rebuilt containers. "Unnamed" ones of 4 KB are empty.'),
    d.busy ? h('div', { class: 'note info' }, d.busy) : null,
    volumesTable(vols, d.pick.volumes));
}

async function deleteThings(channel, ids, what) {
  const d = state.docker;
  d.busy = `Deleting ${ids.length} ${what}…`;
  redrawDocker();
  try {
    const res = await api.call(channel, d.serverId, ids);
    d.data = res.view;
    reportDelete(res, what);
  } catch (err) {
    toast(err.message, true);
  } finally {
    d.busy = null;
    redrawDocker();
  }
}

// Delete some containers, or a whole customer (project). Data volumes only when ticked.
function deleteContainersModal(g, list, whole) {
  const d = state.docker;
  const names = new Set(list.map((c) => c.name));
  const dataVols = g.volumes.filter((v) => v.usedBy.length && v.usedBy.every((u) => names.has(u)));
  const s = state.servers.find((x) => x.id === d.serverId) || {};
  const client = whole && (s.clients || []).find((c) => c.project === g.name);
  const running = list.filter((c) => c.running).length;
  const withData = h('input', { type: 'checkbox' });
  const typed = h('input', { type: 'text', placeholder: g.name || '' });
  const okBtn = h('button', { class: 'btn primary danger-fill', disabled: whole }, whole ? `Delete ${g.name}` : `Delete ${list.length} container(s)`);
  const sync = () => {
    okBtn.disabled = whole && typed.value.trim() !== g.name;
    okBtn.textContent = (whole ? `Delete ${g.name}` : `Delete ${list.length} container(s)`) + (withData.checked ? ' + data' : '');
  };
  typed.addEventListener('input', sync);
  withData.addEventListener('change', sync);
  okBtn.addEventListener('click', async () => {
    if (okBtn.disabled) return;
    const target = whole ? { project: g.name } : { containers: list.map((c) => c.id) };
    const alsoData = withData.checked;
    closeModal();
    d.busy = `Deleting ${whole ? g.name : `${list.length} container(s)`}${alsoData ? ' and its data' : ''}…`;
    redrawDocker();
    try {
      const res = await api.call('docker:removeContainers', d.serverId, target, alsoData);
      d.data = res.view;
      for (const c of list) d.pick.containers.delete(c.id);
      const extra = alsoData ? ` and ${res.volumes} volume(s)` : '';
      if (res.failed.length) toast(`Deleted ${res.removed} container(s)${extra}. Not deleted: ${res.failed.map((x) => `${x.name} (${x.error})`).join('; ')}`, true);
      else toast(`Deleted ${res.removed} container(s)${extra}.`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      d.busy = null;
      redrawDocker();
    }
  });
  openModal(
    h('h1', {}, whole ? `Delete customer "${g.name}"?` : `Delete ${list.length === 1 ? list[0].name : `${list.length} containers`}?`),
    h('div', { class: 'card' }, h('h2', {}, `Containers to delete (${list.length})`),
      list.map((c) => h('div', { class: 'small', style: 'padding:2px 0' }, h('b', {}, c.name), h('span', { class: 'muted' }, ` · ${c.image} · ${c.state}`)))),
    running ? h('div', { class: 'note' }, `${running} of them are running and will be stopped. If this is a live website, it goes offline.`) : null,
    dataVols.length ? h('label', { class: 'check' }, withData, h('div', { class: 't' },
      h('b', {}, 'Also delete their data (cannot be undone)'),
      h('div', { class: 'muted small' }, dataVols.map((v) => `${v.role === 'anonymous' ? 'unnamed volume' : v.name}${v.sizeKb != null ? ` (${fmtKb(v.sizeKb)})` : ''}`).join(', ')),
      h('div', { class: 'muted small' }, 'Leave this unticked to keep the database and uploads: starting the project again brings everything back.'))) : null,
    h('div', { class: 'note info' },
      g.workingDir && whole ? `The project folder ${g.workingDir} (docker-compose.yml, .env, code) is not deleted. ` : '',
      'Not sure? Close this and press "Back up now" first.',
      client ? ` The customer download access of ${client.name} stays: remove it in the Customers tab.` : ''),
    whole ? h('label', { class: 'field', style: 'margin-top:12px' }, `Type ${g.name} to confirm`, typed) : null,
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), okBtn));
  if (whole) typed.focus();
}

async function dockerAction(action, target, what) {
  const d = state.docker;
  const words = {
    stop: [`Stop ${what}?`, 'It stops answering until you start it again. If this is a live website, visitors will see an error.', 'Stop'],
    restart: [`Restart ${what}?`, 'It will be down for a few seconds while it restarts.', 'Restart'],
  };
  if (words[action] && !(await confirmBox(words[action][0], words[action][1], words[action][2], action === 'stop'))) return;
  const label = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' }[action];
  d.busy = `${label} ${what}…`;
  redrawDocker();
  try {
    d.data = await api.call('docker:action', d.serverId, action, target);
    toast(`${what}: ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    d.busy = null;
    redrawDocker();
  }
}

function logsModal(c) {
  const d = state.docker;
  const pre = h('div', { class: 'log tall' }, 'Loading…');
  const lines = h('select', { style: 'width:auto' }, ...[100, 300, 1000, 3000].map((n) => h('option', { value: n, selected: n === 300 }, `last ${n} lines`)));
  const load = async () => {
    pre.textContent = 'Loading…';
    try {
      const text = await api.call('docker:logs', d.serverId, c.id, Number(lines.value));
      pre.textContent = text.trim() || '(no log lines)';
      pre.scrollTop = pre.scrollHeight;
    } catch (err) { pre.textContent = err.message; }
  };
  lines.addEventListener('change', load);
  openModal(h('h1', {}, `Logs: ${c.name}`),
    h('div', { class: 'row', style: 'margin-bottom:10px' }, lines, h('button', { class: 'btn small', onclick: load }, 'Refresh'),
      h('span', { class: 'muted small' }, `${c.image} · ${c.shortId}`)),
    pre,
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Close')));
  $('#modalCard').classList.add('wide');
  load();
}

// ----- customers (download access) -----
function clientsTab(s) {
  const list = s.clients || [];
  const box = h('div', {},
    h('div', { class: 'card' }, h('div', { class: 'row' },
      h('div', { style: 'flex:1;min-width:260px' }, h('h2', { style: 'margin:0 0 4px' }, 'Customer download apps'),
        h('div', { class: 'muted small' }, 'Give a customer an access code for the free "ServerSnap Client" app. Every day the server prepares a copy of only their website (database, uploads, …). They can download it, but cannot see your server, the code or other customers.')),
      h('button', { class: 'btn primary', onclick: () => clientModal(s) }, '+ Give a customer access'))),
    list.length ? list.map((c) => clientCard(s, c)) : h('div', { class: 'card empty' }, h('h1', {}, 'No customers yet'), h('p', {}, 'Open the Docker tab to see each project, or press "+ Give a customer access".')));
  return box;
}

function clientCard(s, c) {
  const status = h('div', { class: 'small muted' }, 'Checking the server…');
  const card = h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('div', { style: 'flex:1;min-width:220px' }, h('h2', { style: 'margin:0' }, c.name, h('span', { class: 'pill' }, c.project)),
        h('div', { class: 'muted small' }, `Login ${c.user} · every day at ${c.time} (server time) · keeps ${c.keep}`)),
      h('button', { class: 'btn small primary', onclick: () => safe(() => api.call('clients:copyCode', s.id, c.id), 'Access code copied. Paste it to your customer (WhatsApp, Telegram, email).') }, 'Copy access code'),
      h('button', { class: 'btn small', onclick: () => safe(async () => { const p = await api.call('clients:saveCode', s.id, c.id); if (p) toast(`Saved ${p}`); }) }, 'Save as file'),
      h('button', { class: 'btn small', onclick: async () => { const j = await safe(() => api.call('clients:run', s.id, c.id)); if (j) { state.jobs.set(j.id, j); go({ name: 'activity' }); } } }, 'Back up now'),
      h('button', { class: 'btn small', onclick: () => clientModal(s, c.project) }, 'Change')),
    h('div', { class: 'chips' }, c.items.map((i) => h('span', { class: `chip ${i.type === 'database' ? 'database' : 'data'}` }, i.label))),
    status,
    h('details', {}, h('summary', {}, 'More'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: async () => {
          if (!(await confirmBox('Make a new access code?', `The old code of ${c.name} stops working right away. The new code is copied for you to send.`, 'Make new code'))) return;
          await safe(() => api.call('clients:newCode', s.id, c.id), 'New access code copied. The old one no longer works.');
        } }, 'New code (cancel the old one)'),
        h('button', { class: 'btn small danger', onclick: () => removeClient(s, c) }, 'Remove access'))));
  safe(() => api.call('clients:status', s.id, c.id)).then((st) => {
    if (!st) { status.textContent = 'Could not check the server.'; return; }
    if (!st.exists) { fill(status, h('div', { class: 'note bad' }, 'This access is missing on the server. Press "Change" and save to set it up again.')); return; }
    const last = st.backups[0];
    fill(status,
      last ? h('div', {}, 'Last backup: ', h('b', {}, fmtDate(last.createdAt)), h('span', { class: `pill ${last.status}` }, last.status === 'ok' ? 'complete' : last.status),
        ` · ${fmtBytes(last.totalBytes)} · ${st.backups.length} kept on the server`) : h('div', {}, 'No backup yet. The first one runs at the set time, or press "Back up now".'),
      st.log ? h('details', {}, h('summary', {}, 'Server log'), h('div', { class: 'log' }, st.log)) : null);
  });
  return card;
}

async function removeClient(s, c) {
  if (!(await confirmBox(`Remove ${c.name}'s access?`, 'Their code stops working, the daily job stops, and their backup copies on the server are deleted. Your own website and data are not touched.', 'Remove', true))) return;
  if (await safe(() => api.call('clients:remove', s.id, c.id, false), 'Access removed')) { await loadServers(); render(); }
}

async function clientModal(s, project) {
  const body = h('div', {}, h('div', { class: 'muted' }, 'Reading the projects on the server…'), h('div', { class: 'bar indeterminate' }, h('i')));
  openModal(h('h1', {}, 'Customer download access'), body);
  let groups = state.docker && state.docker.serverId === s.id && state.docker.data ? state.docker.data.groups : null;
  if (!groups) {
    const v = await safe(() => api.call('docker:get', s.id, false));
    if (!v) return closeModal();
    groups = v.groups;
  }
  const named = groups.filter((g) => g.name);
  if (!named.length) { fill(body, h('div', { class: 'note' }, 'There are no Docker Compose projects on this server, so there is no customer website to share yet.')); return; }
  const pick = h('select', {}, ...named.map((g) => h('option', { value: g.name, selected: g.name === project }, `${g.title} — ${summaryText(g)}`)));
  const name = h('input', { type: 'text', placeholder: 'Customer or website name' });
  const time = h('input', { type: 'time', value: '03:30' });
  const keep = h('input', { type: 'number', min: 1, max: 90, value: 7, style: 'width:90px' });
  const itemsBox = h('div', {});
  const err = h('div', { class: 'note bad hidden' });
  const saveBtn = h('button', { class: 'btn primary', disabled: true }, 'Save & set up');
  let choices = null;
  const load = async () => {
    saveBtn.disabled = true;
    fill(itemsBox, h('div', { class: 'muted small' }, 'Measuring…'));
    choices = await safe(() => api.call('clients:choices', s.id, pick.value));
    if (!choices) { fill(itemsBox, h('div', { class: 'note bad' }, 'Could not read this project.')); return; }
    if (choices.existing) { name.value = choices.existing.name; time.value = choices.existing.time; keep.value = choices.existing.keep; } else if (!name.value || named.some((g) => g.name === name.value)) name.value = pick.value;
    saveBtn.textContent = choices.existing ? 'Save changes' : 'Save & set up';
    fill(itemsBox, choices.items.length ? choices.items.map((i) => {
      const cb = h('input', { type: 'checkbox', checked: i.on, onchange: (e) => { i.on = e.target.checked; } });
      const hint = i.type === 'database' ? 'Safe copy (dump), the same as a normal backup' : i.type === 'files' ? 'A folder on the server. It may contain code: only tick it if the customer should get it.' : i.key.includes('volume:') && /Raw database/.test(i.label) ? 'Not needed: the database copy above is the safe version.' : '';
      return h('label', { class: 'check' }, cb, h('div', { class: 't' }, h('b', {}, i.label), hint ? h('div', { class: 'muted small' }, hint) : null), h('span', { class: 'size' }, fmtKb(i.sizeKb)));
    }) : h('div', { class: 'muted' }, 'This project has no databases or volumes.'));
    saveBtn.disabled = false;
  };
  pick.addEventListener('change', load);
  saveBtn.addEventListener('click', async () => {
    err.classList.add('hidden');
    const items = (choices ? choices.items : []).filter((i) => i.on);
    if (!items.length) { err.textContent = 'Tick at least one thing the customer can download.'; err.classList.remove('hidden'); return; }
    saveBtn.disabled = true;
    const j = await safe(() => api.call('clients:save', s.id, { project: pick.value, name: name.value, items, time: time.value, keep: Number(keep.value) }));
    if (!j) { saveBtn.disabled = false; return; }
    closeModal();
    state.jobs.set(j.id, j);
    toast('Setting up the customer access. Follow it here.');
    go({ name: 'activity' });
  });
  fill(body,
    h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Docker project (website)', pick), h('label', { class: 'field' }, 'Customer name (shown in their app)', name)),
    h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, 'What the customer can download'), itemsBox),
    h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Daily backup time (server clock)', time),
      h('label', { class: 'field' }, 'Keep on the server', h('div', { class: 'row' }, keep, h('span', { class: 'muted' }, 'days')))),
    h('div', { class: 'note info' }, 'The server makes this copy itself every day, even when your PC is off. The customer gets a locked login that can only read this copy: no shell, no code, no other websites.'),
    err,
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), saveBtn));
  load();
}

async function runScan(id) {
  state.scanStep = { id, step: 'Connecting…' };
  render();
  const v = await safe(() => api.call('servers:scan', id));
  state.scanStep = null;
  if (v) toast('Scan finished');
  render();
}

async function testServer(id) {
  toast('Connecting…');
  const r = await safe(() => api.call('servers:test', id));
  if (!r) return;
  const privText = { root: 'logged in as root', sudo: 'admin rights through sudo', 'sudo-pass': 'admin rights through sudo (password)', none: 'NO admin rights: backups will be incomplete' }[r.priv];
  toast(`Connected to ${r.hostname} (${r.os}) — ${privText}`, r.priv === 'none');
}

async function startBackup(id) {
  const j = await safe(() => api.call('backup:start', id));
  if (j) { state.jobs.set(j.id, j); await loadServers(); go({ name: 'activity' }); }
}

// ----- add / edit server -----
function serverModal(existing) {
  const s = existing || { port: 22, username: 'root', authType: 'password', has: {} };
  const f = {
    name: h('input', { type: 'text', value: s.name || '', placeholder: 'My website server' }),
    host: h('input', { type: 'text', value: s.host || '', placeholder: '203.0.113.10 or server.example.com' }),
    port: h('input', { type: 'number', value: s.port || 22 }),
    username: h('input', { type: 'text', value: s.username || 'root' }),
    password: h('input', { type: 'password', placeholder: s.has.password ? '•••••• (saved — leave empty to keep)' : '' }),
    keyPath: h('input', { type: 'text', value: s.keyPath || '', placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519' }),
    passphrase: h('input', { type: 'password', placeholder: s.has.passphrase ? '•••••• (saved)' : 'Only if the key has one' }),
    sudoPassword: h('input', { type: 'password', placeholder: s.has.sudoPassword ? '•••••• (saved)' : 'Only if not root and different from the login password' }),
    hostDbPassword: h('input', { type: 'password', placeholder: s.has.hostDbPassword ? '•••••• (saved)' : 'Only if MySQL on the server asks for one' }),
  };
  let auth = s.authType || 'password';
  const pwBox = h('div', {}, h('label', { class: 'field' }, 'Password', f.password));
  const keyBox = h('div', { class: 'grid2' },
    h('label', { class: 'field' }, 'SSH key file', h('div', { class: 'row' }, h('div', { style: 'flex:1' }, f.keyPath),
      h('button', { class: 'btn', onclick: async () => { const p = await safe(() => api.call('dialog:keyFile')); if (p) f.keyPath.value = p; } }, 'Browse'))),
    h('label', { class: 'field' }, 'Key passphrase', f.passphrase));
  const syncAuth = () => { pwBox.classList.toggle('hidden', auth !== 'password'); keyBox.classList.toggle('hidden', auth !== 'key'); };
  const radio = h('div', { class: 'radio' }, ...[['password', 'Password'], ['key', 'SSH key']].map(([v, l]) =>
    h('label', {}, h('input', { type: 'radio', name: 'auth', value: v, checked: auth === v, onchange: () => { auth = v; syncAuth(); } }), l)));
  syncAuth();
  const err = h('div', { class: 'note bad hidden' });
  const saveBtn = h('button', { class: 'btn primary' }, existing ? 'Save' : 'Save & connect');

  saveBtn.addEventListener('click', async () => {
    err.classList.add('hidden');
    if (!f.host.value.trim()) { err.textContent = 'Enter the server address.'; err.classList.remove('hidden'); return; }
    const input = {
      id: s.id, name: f.name.value, host: f.host.value, port: Number(f.port.value) || 22, username: f.username.value,
      authType: auth, keyPath: auth === 'key' ? f.keyPath.value.trim() : null,
    };
    for (const k of ['password', 'passphrase', 'sudoPassword', 'hostDbPassword']) if (f[k].value) input[k] = f[k].value;
    if (!existing && auth === 'password' && !input.password) { err.textContent = 'Enter the password.'; err.classList.remove('hidden'); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Connecting…';
    try {
      const saved = await api.call('servers:save', input);
      const changedLogin = !existing || existing.host !== saved.host || existing.port !== saved.port;
      if (changedLogin && existing) await api.call('servers:forgetKey', saved.id);
      if (!existing || changedLogin || input.password || input.keyPath !== existing.keyPath) {
        const t = await api.call('servers:test', saved.id);
        if (t.priv === 'none') toast('Connected, but this login has no admin rights. Use root or a sudo user for full backups.', true);
        else toast(`Connected to ${t.hostname}`);
      }
      closeModal();
      await loadServers();
      go({ name: 'server', id: saved.id, tab: 'what' });
      if (!existing) runScan(saved.id);
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = existing ? 'Save' : 'Save & connect';
    }
  });

  openModal(
    h('h1', {}, existing ? 'Edit server' : 'Add a server'),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, 'Name', f.name),
      h('label', { class: 'field' }, 'Address (IP or domain)', f.host),
      h('label', { class: 'field' }, 'Username', f.username),
      h('label', { class: 'field' }, 'SSH port', f.port)),
    h('div', { style: 'margin:14px 0 8px' }, radio),
    pwBox, keyBox,
    h('details', {}, h('summary', {}, 'Advanced'),
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'sudo password', f.sudoPassword), h('label', { class: 'field' }, 'MySQL root password (server-installed MySQL)', f.hostDbPassword)),
      existing && existing.knownHostKey ? h('div', { class: 'small muted', style: 'margin-top:10px' }, 'Server key: ', h('span', { class: 'mono' }, existing.knownHostKey), ' ',
        h('button', { class: 'btn small', onclick: async () => { if (await safe(() => api.call('servers:forgetKey', existing.id), 'Server key forgotten. It will be learned on the next connection.')) loadServers(); } }, 'Forget server key')) : null),
    h('div', { class: 'muted small', style: 'margin-top:10px' }, 'Passwords are encrypted with your Windows account and never leave this PC.'),
    err,
    h('div', { class: 'modal-foot' },
      existing ? h('button', { class: 'btn danger', style: 'margin-right:auto', onclick: () => deleteServer(existing) }, 'Delete server') : null,
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), saveBtn));
  (existing ? f.name : f.host).focus();
}

function deleteServer(s) {
  openModal(h('h1', {}, `Delete ${s.name}?`),
    h('p', {}, 'The server is removed from ServerSnap. Your backup files stay on this PC and can still be restored.'),
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (await safe(() => api.call('servers:remove', s.id), 'Server deleted')) { closeModal(); await loadServers(); go({ name: 'home' }); }
      } }, 'Delete')));
}

// ----- backups -----
async function renderBackups(main) {
  fill(main, h('div', { class: 'head' }, h('div', { class: 'grow' }, h('h1', {}, 'Backups')), h('div', { class: 'muted' }, 'Loading…')));
  const list = (await safe(() => api.call('backups:list'))) || [];
  if (state.page.name !== 'backups') return;
  const importBtn = h('button', { class: 'btn', onclick: async () => {
    const m = await safe(() => api.call('backups:import'));
    if (m) restoreWizard(m);
  } }, 'Restore from a folder…');
  if (!list.length) {
    fill(main, h('div', { class: 'head' }, h('div', { class: 'grow' }, h('h1', {}, 'Backups')), importBtn),
      h('div', { class: 'card empty' }, h('h1', {}, 'No backups yet'), h('p', {}, 'Open a server and press "Back up now".')));
    return;
  }
  const rows = list.map((b) => h('tr', {},
    h('td', {}, h('b', {}, b.server.name), h('div', { class: 'muted small' }, b.server.host)),
    h('td', { class: 'nowrap' }, fmtDate(b.createdAt)),
    h('td', {}, h('span', { class: `pill ${b.status}` }, b.status === 'ok' ? 'complete' : b.status)),
    h('td', { class: 'nowrap' }, fmtBytes(b.totalBytes)),
    h('td', { class: 'muted small' }, summaryOf(b)),
    h('td', { class: 'actions' },
      h('button', { class: 'btn small primary', onclick: () => restoreWizard(b) }, 'Restore…'), ' ',
      h('button', { class: 'btn small', onclick: () => api.call('backups:open', b.dir) }, 'Open folder'), ' ',
      h('button', { class: 'btn small danger', onclick: () => confirmDeleteBackup(b) }, 'Delete'))));
  fill(main, 
    h('div', { class: 'head' }, h('div', { class: 'grow' }, h('h1', {}, 'Backups'), h('div', { class: 'meta' }, `${list.length} backup(s)`)), importBtn),
    h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ...['Server', 'Date', 'Status', 'Size', 'Contains', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows))));
}

function summaryOf(b) {
  const c = { database: 0, volume: 0, files: 0 };
  for (const i of b.items) if (i.status === 'ok' || i.status === 'warning') c[i.type]++;
  return [c.database && `${c.database} database(s)`, c.volume && `${c.volume} volume(s)`, c.files && `${c.files} folder(s)`].filter(Boolean).join(', ') || '—';
}

function confirmDeleteBackup(b) {
  openModal(h('h1', {}, 'Delete this backup?'), h('p', {}, `${b.server.name} — ${fmtDate(b.createdAt)} (${fmtBytes(b.totalBytes)}). This cannot be undone.`),
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (await safe(() => api.call('backups:delete', b.dir), 'Backup deleted')) { closeModal(); render(); }
      } }, 'Delete')));
}

// ----- restore wizard -----
function restoreWizard(b) {
  const usable = b.items.filter((i) => i.status === 'ok' || i.status === 'warning');
  const checks = new Map(usable.map((i) => [i.id, h('input', { type: 'checkbox', checked: true })]));
  const target = h('select', {}, h('option', { value: '' }, '— choose a server —'),
    ...state.servers.map((s) => h('option', { value: s.id, selected: b.server && s.id === b.server.id }, `${s.name} (${s.host})`)));
  const installDocker = h('input', { type: 'checkbox', checked: true });
  const startProjects = h('input', { type: 'checkbox', checked: true });
  const useDumps = h('input', { type: 'checkbox', checked: true });
  const agree = h('input', { type: 'checkbox' });
  const planBox = h('div', { class: 'small' });
  const startBtn = h('button', { class: 'btn primary', disabled: true }, 'Start restore');
  const typeLabel = { database: 'Database', volume: 'Docker volume', files: 'Folder' };

  const opts = () => ({ items: [...checks].filter(([, c]) => c.checked).map(([id]) => id), installDocker: installDocker.checked, startProjects: startProjects.checked, useDumps: useDumps.checked });
  const refresh = async () => {
    startBtn.disabled = !(target.value && agree.checked && opts().items.length);
    const p = await safe(() => api.call('restore:plan', b.dir, opts()));
    if (!p) return;
    const t = state.servers.find((s) => s.id === target.value);
    fill(planBox, 
      h('b', {}, 'What will happen:'),
      h('ol', { style: 'margin:6px 0 0; padding-left:20px' },
        p.needsDocker ? h('li', {}, installDocker.checked ? 'Check Docker (install it if missing)' : 'Check Docker is installed') : null,
        p.files.length ? h('li', {}, `Put back ${p.files.length} folder(s): `, h('span', { class: 'mono' }, p.files.join(', '))) : null,
        p.volumes.length ? h('li', {}, `Refill ${p.volumes.length} Docker volume(s)`) : null,
        p.projects.length ? h('li', {}, `Start Docker project(s): ${p.projects.join(', ')}`) : null,
        p.dbs.length ? h('li', {}, `Load ${p.dbs.length} database copy(ies)`) : null),
      t && b.server && t.host !== b.server.host ? h('div', { class: 'note info' }, `Moving to a new server: when it is done, point your domain's DNS to ${t.host}.`) : null);
  };
  for (const c of [...checks.values(), installDocker, startProjects, useDumps, agree]) c.addEventListener('change', refresh);
  target.addEventListener('change', refresh);

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    const j = await safe(() => api.call('restore:start', { dir: b.dir, targetServerId: target.value, options: opts() }));
    if (j) { closeModal(); state.jobs.set(j.id, j); go({ name: 'activity' }); } else startBtn.disabled = false;
  });

  openModal(
    h('h1', {}, 'Restore a backup'),
    h('div', { class: 'muted' }, `${b.server.name} — ${fmtDate(b.createdAt)} — ${fmtBytes(b.totalBytes)}`),
    h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, '1. What to put back'),
      usable.map((i) => h('label', { class: 'check' }, checks.get(i.id), h('div', { class: 't' }, h('b', {}, i.label), h('div', { class: 'muted small' }, typeLabel[i.type])), h('span', { class: 'size' }, fmtBytes(i.bytes))))),
    h('div', { class: 'card' }, h('h2', {}, '2. Onto which server'), target,
      h('div', { class: 'muted small', style: 'margin-top:6px' }, 'Moving host? Add the new server first (left menu → "+ Add server"), then pick it here.'),
      h('label', { class: 'check' }, installDocker, h('div', { class: 't' }, 'Install Docker if it is missing')),
      h('label', { class: 'check' }, startProjects, h('div', { class: 't' }, 'Start the Docker projects after restoring')),
      h('label', { class: 'check' }, useDumps, h('div', { class: 't' }, 'Use the safe database copies (recommended)', h('div', { class: 'muted small' }, 'Untick to use the raw database files instead.')))),
    h('div', { class: 'card' }, planBox),
    h('label', { class: 'check' }, agree, h('div', { class: 't' }, 'I understand that files, volumes and databases with the same names on that server will be replaced.')),
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), startBtn));
  refresh();
}

// ----- activity -----
let activityTimer = null;
function scheduleActivityRender() {
  if (state.page.name !== 'activity' || activityTimer) return;
  activityTimer = setTimeout(() => { activityTimer = null; if (state.page.name === 'activity') renderActivity($('#main')); }, 400);
}

function renderActivity(main) {
  const jobs = [...state.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  const stateLabel = { running: 'running', done: 'finished', partial: 'finished with problems', failed: 'failed', stopped: 'stopped' };
  const statePill = { running: 'running', done: 'ok', partial: 'warn', failed: 'bad', stopped: 'warn' };
  const logEls = [];
  const cards = jobs.map((j) => {
    const items = Object.entries(j.items || {});
    const logEl = h('div', { class: 'log' }, (j.log || []).slice(-300).map((l) => h('div', { class: l.level }, `${new Date(l.at).toLocaleTimeString()}  ${l.msg}`)));
    logEls.push(logEl);
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { style: 'flex:1;margin:0' }, j.title, h('span', { class: `pill ${statePill[j.state]}` }, stateLabel[j.state] || j.state)),
        h('span', { class: 'muted small' }, new Date(j.startedAt).toLocaleString()),
        j.state === 'running' ? h('button', { class: 'btn small danger', onclick: () => api.call('jobs:stop', j.id) }, 'Stop') : null,
        j.result && j.result.dir ? h('button', { class: 'btn small', onclick: () => api.call('backups:open', j.result.dir) }, 'Open folder') : null),
      j.state === 'running' && !items.length ? h('div', { class: 'bar indeterminate' }, h('i')) : null,
      items.length ? h('div', { class: 'items' }, items.map(([, it]) => {
        const total = it.total || (it.sizeKb ? it.sizeKb * 1024 : 0);
        const pct = it.status === 'ok' || it.status === 'warning' ? 100 : total && it.bytes ? Math.min(99, (it.bytes / total) * 100) : 0;
        return h('div', {},
          h('div', { class: 'it' }, h('span', { class: 'l' }, it.label), it.detail ? h('span', { class: 'muted small' }, it.detail) : null,
            h('span', { class: 'muted small' }, it.bytes ? fmtBytes(it.bytes) : ''), it.status ? h('span', { class: `pill ${it.status === 'running' ? 'running' : it.status}` }, it.status) : null),
          it.status === 'running' ? h('div', { class: `bar ${total ? '' : 'indeterminate'}` }, h('i', { style: total ? `width:${pct}%` : '' })) : null);
      })) : null,
      j.result && j.result.error ? h('div', { class: 'note bad' }, j.result.error) : null,
      logEl);
  });
  fill(main, 
    h('div', { class: 'head' }, h('div', { class: 'grow' }, h('h1', {}, 'Activity')),
      jobs.some((j) => j.state !== 'running') ? h('button', { class: 'btn', onclick: async () => { await api.call('jobs:clear'); await loadJobs(); render(); } }, 'Clear finished') : null),
    cards.length ? cards : h('div', { class: 'card empty' }, h('h1', {}, 'Nothing running'), h('p', {}, 'Backups and restores show their progress here.')));
  for (const el of logEls) el.scrollTop = el.scrollHeight;
}

async function loadJobs() {
  const list = (await safe(() => api.call('jobs:list'))) || [];
  state.jobs = new Map(list.map((j) => [j.id, j]));
  renderSide();
}

// ----- settings -----
async function renderSettings(main) {
  const st = await safe(() => api.call('settings:get'));
  if (!st || state.page.name !== 'settings') return;
  const root = h('input', { type: 'text', value: st.backupRoot || '', placeholder: st.defaultBackupRoot });
  const token = h('input', { type: 'password', placeholder: st.telegram.hasToken ? '•••••• (saved)' : '123456:ABC-DEF…' });
  const chat = h('input', { type: 'text', value: st.telegram.chatId, placeholder: 'e.g. 123456789' });
  const tray = h('input', { type: 'checkbox', checked: st.closeToTray });
  const boot = h('input', { type: 'checkbox', checked: st.startWithWindows });
  const save = async (quiet) => {
    const input = { backupRoot: root.value.trim() || null, closeToTray: tray.checked, startWithWindows: boot.checked, telegram: { chatId: chat.value } };
    if (token.value) input.telegram.token = token.value;
    return safe(() => api.call('settings:set', input), quiet ? null : 'Saved');
  };
  fill(main, 
    h('div', { class: 'head' }, h('div', { class: 'grow' }, h('h1', {}, 'Settings'), h('div', { class: 'meta' }, `ServerSnap ${st.version}`))),
    h('div', { class: 'card' }, h('h2', {}, 'Backup folder'),
      h('label', { class: 'field' }, 'Where backups are kept (each server can also have its own)',
        h('div', { class: 'row' }, h('div', { style: 'flex:1' }, root),
          h('button', { class: 'btn', onclick: async () => { const p = await safe(() => api.call('dialog:folder', 'Where to keep backups')); if (p) root.value = p; } }, 'Choose…')))),
    h('div', { class: 'card' }, h('h2', {}, 'Telegram alerts'),
      h('div', { class: 'muted small', style: 'margin-bottom:10px' },
        '1) In Telegram, open @BotFather, send /newbot and copy the token. 2) Send any message to your new bot. 3) Open @userinfobot to see your chat ID.'),
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Bot token', token), h('label', { class: 'field' }, 'Chat ID', chat)),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn', onclick: async () => {
        if (await save(true)) await safe(() => api.call('settings:testTelegram'), 'Test message sent — check Telegram');
      } }, 'Send test message'))),
    h('div', { class: 'card' }, h('h2', {}, 'App'),
      h('label', { class: 'check' }, tray, h('div', { class: 't' }, h('b', {}, 'Keep running in the tray when the window is closed'), h('div', { class: 'muted small' }, 'Needed for automatic backups.'))),
      h('label', { class: 'check' }, boot, h('div', { class: 't' }, h('b', {}, 'Start with Windows'), h('div', { class: 'muted small' }, 'Starts hidden in the tray.')))),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => save(false) }, 'Save'),
      h('button', { class: 'btn ghost', onclick: () => api.call('app:openLog') }, 'Open log file')));
}

// ---------- wiring ----------
$('#addServer').addEventListener('click', () => serverModal());
for (const a of document.querySelectorAll('.side-nav a')) a.addEventListener('click', () => go({ name: a.dataset.page }));

api.onJob((j) => {
  const old = state.jobs.get(j.id);
  state.jobs.set(j.id, { ...old, ...j });
  if (j.state !== 'running') {
    const ok = j.state === 'done';
    toast(`${j.title}: ${ok ? 'finished' : j.state}`, !ok);
    loadServers().then(() => { if (state.page.name === 'server') render(); });
  }
  renderSide();
  scheduleActivityRender();
});
api.onJobEvent(({ jobId, event: e }) => {
  const j = state.jobs.get(jobId);
  if (!j) return;
  j.items = j.items || {};
  j.log = j.log || [];
  if (e.type === 'log') j.log.push(e);
  else if (e.type === 'item') j.items[e.item.id] = { label: e.item.label, status: e.item.status, bytes: e.item.bytes, sizeKb: e.item.sizeKb };
  else if (e.type === 'progress') { const it = j.items[e.id] || (j.items[e.id] = { label: e.id }); it.bytes = e.bytes; if (e.total) it.total = e.total; }
  else if (e.type === 'step') j.items[`step:${Object.keys(j.items).length}`] = { label: e.label, status: e.status, detail: e.detail };
  scheduleActivityRender();
});
api.onScanStep(({ id, step }) => {
  if (state.scanStep && state.scanStep.id === id) {
    state.scanStep.step = step;
    if (state.page.name === 'server' && state.page.id === id) render();
  }
});
api.onServersChanged(() => loadServers());
setInterval(() => { if (state.page.name !== 'activity') renderSide(); }, 60000);

(async () => {
  await loadServers();
  await loadJobs();
  render();
})();
