'use strict';
// Shared by the admin window (app.js) and the customer window (client.js).

// ---------- tiny DOM helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM, allowed by the page's CSP
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
// replaceChildren that skips null/false (conditional parts of a page)
function fill(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false)); }

function fmtBytes(b) {
  if (b == null || isNaN(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = Number(b);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
const fmtKb = (kb) => (kb == null ? '' : fmtBytes(kb * 1024));
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
// "Up 9 hours" style, from an ISO start time.
function since(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s} seconds`;
  if (s < 3600) return `${Math.round(s / 60)} minutes`;
  if (s < 172800) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 86400)} days`;
}

let toastTimer = null;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), bad ? 7000 : 3500);
}

async function safe(fn, okMsg) {
  try {
    const v = await fn();
    if (okMsg) toast(okMsg);
    return v;
  } catch (err) {
    toast(err.message, true);
    return undefined;
  }
}

function openModal(...content) {
  const card = $('#modalCard');
  fill(card, ...content);
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalCard').classList.remove('wide'); }

// In-app "are you sure?" (no browser dialogs). Resolves true / false.
function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const done = (v) => { closeModal(); resolve(v); };
    openModal(h('h1', {}, title), h('p', {}, text),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: `btn primary${danger ? ' danger-fill' : ''}`, onclick: () => done(true) }, okLabel)));
  });
}

$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
