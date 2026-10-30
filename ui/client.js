'use strict';
/* global api, h, $, fill, fmtBytes, fmtDate, ago, toast, safe, openModal, closeModal, confirmBox */

const state = {
  sites: [],
  page: { name: 'home' },
  jobs: new Map(),
  backups: new Map(), // siteId -> { list, error, loading }
};

async function loadSites() {
  state.sites = (await safe(() => api.call('access:list'))) || [];
  renderSide();
}

function go(page) {
  state.page = page;
  renderSide();
  render();
}

function runningJob(siteId) {
  return [...state.jobs.values()].find((j) => j.accessId === siteId && j.state === 'running') || null;
}

function renderSide() {
  fill($('#siteList'), ...state.sites.map((s) => h('a', {
    class: state.page.name === 'site' && state.page.id === s.id ? 'active' : '',
    onclick: () => go({ name: 'site', id: s.id }),
  }, h('span', { class: `dot ${runningJob(s.id) ? 'running' : s.lastDownload ? 'ok' : ''}` }),
  h('div', { class: 'name' }, s.name, h('div', { class: 'sub' }, s.lastDownload ? `Downloaded ${ago(s.lastDownload.at)}` : 'Nothing downloaded yet')))));
  for (const a of document.querySelectorAll('.side-nav a')) a.classList.toggle('active', a.dataset.page === state.page.name);
}

function render() {
  const main = $('#main');
  if (state.page.name === 'site') return renderSite(main, state.page.id);
  if (state.page.name === 'settings') return renderSettings(main);
  return renderHome(main);
}

function renderHome(main) {
  if (state.sites.length) return go({ name: 'site', id: state.sites[0].id });
  fill(main, h('div', { class: 'empty' },
    h('img', { src: '../assets/icon.png', width: 72, height: 72, alt: '' }),
    h('h1', {}, 'Your website backups, on your PC'),
    h('p', {}, 'Your web host gave you an access code (it starts with SNAP1-). Add it, and ServerSnap Client downloads your daily backup: your database, uploads and files.'),
    h('button', { class: 'btn primary', onclick: addModal }, '+ Add access code')));
}

async function loadBackups(id) {
  const b = state.backups.get(id) || {};
  b.loading = true;
  state.backups.set(id, b);
  if (state.page.name === 'site' && state.page.id === id) render();
  try {
    b.list = await api.call('access:backups', id);
    b.error = null;
  } catch (err) {
    b.error = err.message;
  }
  b.loading = false;
  if (state.page.name === 'site' && state.page.id === id) render();
}

function contains(b) {
  const ok = b.items.filter((i) => i.status === 'ok' || i.status === 'warning');
  return ok.map((i) => i.label).join(', ') || '—';
}

function renderSite(main, id) {
  const s = state.sites.find((x) => x.id === id);
  if (!s) return go({ name: 'home' });
  const b = state.backups.get(id);
  if (!b) { loadBackups(id); }
  const job = runningJob(id);
  const list = (b && b.list) || [];
  const rows = list.map((x) => {
    const mine = job && job.name === x.name;
    let action;
    if (mine) {
      const pct = job.total ? Math.min(100, (job.bytes / job.total) * 100) : 0;
      action = h('div', { style: 'min-width:200px' }, h('div', { class: 'small' }, `${fmtBytes(job.bytes)} of ${fmtBytes(job.total)} · ${job.file || ''}`),
        h('div', { class: `bar ${job.total ? '' : 'indeterminate'}` }, h('i', { style: `width:${pct.toFixed(1)}%` })),
        h('button', { class: 'btn small danger', style: 'margin-top:6px', onclick: () => api.call('jobs:stop', job.id) }, 'Stop'));
    } else if (x.local) {
      action = [h('span', { class: 'pill ok', style: 'margin:0 8px 0 0' }, '✓ on this PC'), h('button', { class: 'btn small', onclick: () => api.call('backups:open', x.local) }, 'Open folder')];
    } else {
      action = h('button', { class: 'btn small primary', disabled: !!job, onclick: () => startDownload(id, x.name) }, 'Download');
    }
    return h('tr', {},
      h('td', { class: 'nowrap' }, h('b', {}, fmtDate(x.createdAt)), h('div', { class: 'muted small' }, ago(x.createdAt))),
      h('td', {}, h('span', { class: `pill ${x.status}`, style: 'margin:0' }, x.status === 'ok' ? 'complete' : x.status)),
      h('td', { class: 'nowrap' }, fmtBytes(x.totalBytes)),
      h('td', { class: 'small' }, contains(x)),
      h('td', { class: 'actions' }, action));
  });
  fill(main,
    h('div', { class: 'head' },
      h('div', { class: 'grow' }, h('h1', {}, s.name), h('div', { class: 'meta' }, `Website "${s.project}"`,
        s.lastCheck ? h('span', { class: 'pill' }, `checked ${ago(s.lastCheck)}`) : null)),
      h('button', { class: 'btn', disabled: b && b.loading, onclick: () => loadBackups(id) }, b && b.loading ? 'Checking…' : 'Check for new backups'),
      h('button', { class: 'btn', onclick: () => api.call('access:openFolder', id) }, 'Open my backups folder')),
    b && b.error ? h('div', { class: 'note bad' }, b.error) : null,
    h('div', { class: 'card' },
      h('h2', {}, 'Backups ready on the server'),
      !b || (b.loading && !b.list) ? h('div', {}, h('div', { class: 'muted' }, 'Connecting…'), h('div', { class: 'bar indeterminate' }, h('i'))) :
        rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ...['Date', 'Status', 'Size', 'Contains', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows)) :
          h('div', { class: 'muted' }, 'No backup is ready yet. The server makes one every day.')),
    job && !list.some((x) => x.name === job.name) ? h('div', { class: 'note info' }, `Downloading ${job.title}…`) : null,
    h('div', { class: 'card' }, h('h2', {}, 'Good to know'),
      h('div', { class: 'small muted' }, 'Files are saved in ', h('span', { class: 'mono' }, s.folder), '. Each backup has a ', h('span', { class: 'mono' }, 'databases'), ' folder (database copy) and ',
        h('span', { class: 'mono' }, 'volumes'), ' / ', h('span', { class: 'mono' }, 'files'), ' (your uploads as .tar.gz, open them with 7-Zip or WinRAR). Every file is checked after download, so a damaged download is never kept.'),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn small ghost', onclick: () => renameModal(s) }, 'Rename'),
        h('button', { class: 'btn small danger', onclick: () => removeSite(s) }, 'Remove this website'))));
}

async function startDownload(id, name) {
  const j = await safe(() => api.call('access:download', id, name));
  if (j) { state.jobs.set(j.id, j); render(); }
}

function addModal() {
  const code = h('textarea', { placeholder: 'SNAP1-…', style: 'min-height:120px' });
  const err = h('div', { class: 'note bad hidden' });
  const add = h('button', { class: 'btn primary' }, 'Add');
  add.addEventListener('click', async () => {
    err.classList.add('hidden');
    if (!code.value.trim()) { err.textContent = 'Paste the access code first.'; err.classList.remove('hidden'); return; }
    add.disabled = true;
    add.textContent = 'Checking the code…';
    try {
      const s = await api.call('access:add', code.value);
      closeModal();
      await loadSites();
      state.backups.delete(s.id);
      go({ name: 'site', id: s.id });
      toast(`Added ${s.name}`);
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    } finally {
      add.disabled = false;
      add.textContent = 'Add';
    }
  });
  openModal(h('h1', {}, 'Add an access code'),
    h('p', { class: 'muted' }, 'Paste the code you received (it starts with SNAP1-), or open the .snapkey file.'),
    code,
    h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn small', onclick: async () => { const t = await safe(() => api.call('codeFile:open')); if (t) code.value = t.trim(); } }, 'Open code file…')),
    h('div', { class: 'muted small', style: 'margin-top:10px' }, 'Keep the code private, like a password: anyone with it can download your backups. The code is stored encrypted on this PC.'),
    err,
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), add));
  code.focus();
}

function renameModal(s) {
  const name = h('input', { type: 'text', value: s.name });
  openModal(h('h1', {}, 'Rename'), h('label', { class: 'field' }, 'Name', name),
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => { if (await safe(() => api.call('access:rename', s.id, name.value))) { closeModal(); await loadSites(); render(); } } }, 'Save')));
  name.focus();
}

async function removeSite(s) {
  if (!(await confirmBox(`Remove ${s.name}?`, 'The access code is removed from this PC. Backups you already downloaded stay in your folder.', 'Remove', true))) return;
  if (await safe(() => api.call('access:remove', s.id), 'Removed')) { await loadSites(); go({ name: 'home' }); }
}

async function renderSettings(main) {
  const st = await safe(() => api.call('settings:get'));
  if (!st || state.page.name !== 'settings') return;
  const root = h('input', { type: 'text', value: st.downloadRoot || '', placeholder: st.defaultDownloadRoot });
  const auto = h('input', { type: 'checkbox', checked: st.autoDownload });
  const keep = h('input', { type: 'number', min: 1, max: 365, value: st.keep, style: 'width:90px' });
  const tray = h('input', { type: 'checkbox', checked: st.closeToTray });
  const boot = h('input', { type: 'checkbox', checked: st.startWithWindows });
  fill(main,
    h('div', { class: 'head' }, h('div', { class: 'grow' }, h('h1', {}, 'Settings'), h('div', { class: 'meta' }, `ServerSnap Client ${st.version}`))),
    h('div', { class: 'card' }, h('h2', {}, 'Downloads'),
      h('label', { class: 'check' }, auto, h('div', { class: 't' }, h('b', {}, 'Download new backups automatically'), h('div', { class: 'muted small' }, 'Checks every 30 minutes while the app is open or in the tray.'))),
      h('div', { class: 'grid2', style: 'margin-top:12px' },
        h('label', { class: 'field' }, 'Download folder', h('div', { class: 'row' }, h('div', { style: 'flex:1' }, root),
          h('button', { class: 'btn', onclick: async () => { const p = await safe(() => api.call('dialog:folder', 'Where to save backups')); if (p) root.value = p; } }, 'Choose…'))),
        h('label', { class: 'field' }, 'Keep on this PC', h('div', { class: 'row' }, keep, h('span', { class: 'muted' }, 'newest backups per website'))))),
    h('div', { class: 'card' }, h('h2', {}, 'App'),
      h('label', { class: 'check' }, tray, h('div', { class: 't' }, h('b', {}, 'Keep running in the tray when the window is closed'))),
      h('label', { class: 'check' }, boot, h('div', { class: 't' }, h('b', {}, 'Start with Windows'), h('div', { class: 'muted small' }, 'Starts hidden in the tray.')))),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => safe(() => api.call('settings:set', { downloadRoot: root.value.trim() || null, autoDownload: auto.checked, keep: Number(keep.value), closeToTray: tray.checked, startWithWindows: boot.checked }), 'Saved') }, 'Save'),
      h('button', { class: 'btn ghost', onclick: () => api.call('app:openLog') }, 'Open log file')));
}

// ---------- wiring ----------
$('#addSite').addEventListener('click', addModal);
for (const a of document.querySelectorAll('.side-nav a')) a.addEventListener('click', () => go({ name: a.dataset.page }));

let drawTimer = null;
api.onJob((j) => {
  state.jobs.set(j.id, j);
  if (j.state !== 'running') {
    if (j.state === 'done') toast(`${j.title}: downloaded`);
    else toast(`${j.title}: ${j.error || j.state}`, j.state === 'failed');
    loadSites().then(() => loadBackups(j.accessId));
    return;
  }
  if (!drawTimer) drawTimer = setTimeout(() => { drawTimer = null; renderSide(); if (state.page.name === 'site') render(); }, 300);
});
api.onAccessesChanged(() => loadSites().then(() => { if (state.page.name === 'site') loadBackups(state.page.id); }));

(async () => {
  await loadSites();
  const list = (await safe(() => api.call('jobs:list'))) || [];
  for (const j of list) state.jobs.set(j.id, j);
  render();
})();
