/* Shared helpers: DOM building, API calls (with an offline queue for work
   entries), formatting, modals, and the app-wide state every view reads. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const state = {
  local: false,        // true in the tablet app (data on this device, one person)
  me: null,
  machines: [],
  technicians: [],
  users: [],
  statuses: [],
  partStatuses: [],
  priorities: [],
};

export const isSupervisor = () => state.me && state.me.role === 'supervisor';
/** Several people share this system (server mode), as opposed to one person's tablet. */
export const isShared = () => !state.local;
export const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();

// ------------------------------------------------------------------ DOM

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = !!v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Replace a container's contents, skipping null/false placeholders. */
export function mount(root, ...nodes) {
  root.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
}

export function toast(msg, ms = 2600, action = null) {
  const t = $('#toast');
  t.replaceChildren(document.createTextNode(msg));
  if (action) {
    t.append(el('button', { class: 'toast-action', onclick: () => { t.style.display = 'none'; action.fn(); } }, action.label));
  }
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = 'none'; }, ms);
}

// --------------------------------------------------------------- format

export function fmtHours(minutes) {
  minutes = Number(minutes) || 0;
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

export function fmtElapsed(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`;
}

export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return localDate(d);
}

export function fmtDay(dateStr, opts = {}) {
  if (!dateStr) return '';
  const d = new Date(dateStr.length === 10 ? dateStr + 'T12:00:00' : dateStr);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...opts });
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function fmtWhen(iso) {
  if (!iso) return '';
  return `${fmtDate(iso)} ${fmtTime(iso)}`;
}

export function daysAgo(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
}

export const statusText = (s) => String(s || '').replace('_', ' ');

export function machineName(id) {
  const m = state.machines.find((x) => x.id === id);
  return m ? m.name : '';
}

/** Plex WO# if known, else the order's own NO_WO#### number (same rule as lib/store.js). */
export function woLabel(wo) {
  if (!wo) return '';
  if (wo.orderNumber) return `WO#${wo.orderNumber}`;
  if (wo.nn) return `NO_WO#${String(wo.nn).padStart(3, '0')}`;
  return `M-${wo.ref}`;
}

export function badge(kind, text) {
  return el('span', { class: 'badge ' + kind }, [el('span', { class: 'dot' }), text ?? statusText(kind)]);
}

/** "belt, 2x bearing, filter x3" -> [{name:'belt',quantity:1}, {name:'bearing',quantity:2}, ...] */
export function parsePartList(text) {
  return String(text || '').split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
    let quantity = 1;
    let name = s;
    let m = s.match(/^(\d+)\s*[x×]?\s+(.+)$/i) || s.match(/^(\d+)[x×](.+)$/i);
    if (m) { quantity = Number(m[1]); name = m[2]; }
    else if ((m = s.match(/^(.+?)\s*[x×]\s*(\d+)$/i))) { quantity = Number(m[2]); name = m[1]; }
    return { name: name.trim(), quantity: quantity || 1 };
  });
}

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Plain-http pages on a LAN can't use the clipboard API; fall back.
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied — paste it wherever you need it');
}

// ------------------------------------------------------------------- API

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let onUnauthorized = () => {};
let transport = null;
/** Tablet app: answer API calls in-process instead of over the network. */
export function setTransport(fn) { transport = fn; }
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(path, opts = {}) {
  if (transport) {
    const out = await transport(opts.method || 'GET', path, opts.body || {});
    if (out.status >= 400) throw new ApiError(out.status, (out.data && out.data.error) || 'Error ' + out.status);
    return out.data;
  }
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : (opts.method && opts.method !== 'GET' ? '{}' : undefined),
    });
  } catch (err) {
    if (opts.queue) {
      enqueue(path, opts);
      return { queued: true };
    }
    throw new ApiError(0, 'Can’t reach the server — check the Wi-Fi');
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
  return data;
}

// ---- offline queue: work entries made with no connection are kept on the
// tablet and sent when it's back. The server ignores duplicates (clientId).

const QUEUE_KEY = 'mt_queue';
function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function writeQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* storage full/blocked */ }
  renderQueueBanner();
}
function enqueue(path, opts) {
  const q = readQueue();
  q.push({ path, method: opts.method || 'POST', body: opts.body, at: Date.now() });
  writeQueue(q);
  toast('No connection — saved on this tablet, will send when back online', 4000);
}

let flushing = false;
export async function flushQueue() {
  if (flushing) return 0;
  const q = readQueue();
  if (!q.length) return 0;
  flushing = true;
  let sent = 0;
  try {
    while (q.length) {
      const item = q[0];
      try {
        await api(item.path, { method: item.method, body: item.body });
      } catch (err) {
        if (err.status === 0 || err.status === 401) break; // still offline / signed out: try later
        // Server rejected it (e.g. a deleted work order): drop it, but say so.
        toast('A saved entry could not be sent: ' + err.message, 5000);
      }
      q.shift();
      writeQueue(q);
      sent++;
    }
  } finally {
    flushing = false;
  }
  if (sent) toast(`Sent ${sent} saved entr${sent === 1 ? 'y' : 'ies'}`);
  return sent;
}

export function renderQueueBanner() {
  const box = $('#queue-banner');
  if (!box) return;
  const n = readQueue().length;
  box.style.display = n ? 'flex' : 'none';
  box.replaceChildren(
    el('span', {}, `${n} entr${n === 1 ? 'y' : 'ies'} saved on this device, waiting for a connection.`),
    el('button', { onclick: () => flushQueue().then(() => window.dispatchEvent(new Event('mt:refresh'))) }, 'Send now'),
  );
}

// --------------------------------------------------------------- modals

/**
 * Open a modal. `build(close)` returns the content node. Returns close().
 */
export function openModal(title, build, { wide = false } = {}) {
  const back = el('div', { class: 'modal-back open' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const box = el('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'modal-head' }, [
      el('h3', {}, title),
      el('button', { class: 'ghost icon', 'aria-label': 'Close', onclick: close }, '✕'),
    ]),
    build(close),
  ]);
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  $('#modals').append(back);
  const first = box.querySelector('input:not([type=hidden]):not([type=checkbox]), textarea, select');
  if (first && window.matchMedia('(pointer: fine)').matches) first.focus();
  return close;
}

export function field(label, input, hint) {
  return el('label', { class: 'fld' }, [el('span', { class: 'fld-label' }, label), input, hint ? el('span', { class: 'fld-hint' }, hint) : null]);
}

export function select(options, value, attrs = {}) {
  const s = el('select', attrs, options.map((o) => {
    const [v, t] = Array.isArray(o) ? o : [o, statusText(o)];
    return el('option', { value: v }, t);
  }));
  s.value = value ?? '';
  return s;
}

/** Segmented choice: returns {node, get value()} */
export function segmented(options, value, onchange) {
  let current = value;
  const node = el('div', { class: 'seg big', role: 'group' });
  const draw = () => {
    node.replaceChildren(...options.map(([v, label]) => el('button', {
      type: 'button', class: v === current ? 'on' : '',
      'aria-pressed': v === current ? 'true' : 'false',
      onclick: () => { current = v; draw(); onchange && onchange(v); },
    }, label)));
  };
  draw();
  return { node, get value() { return current; }, set value(v) { current = v; draw(); } };
}

export function confirmDialog(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    openModal('Are you sure?', (close) => el('div', {}, [
      el('p', {}, message),
      el('div', { class: 'row-end' }, [
        el('button', { class: 'ghost', onclick: () => { close(); resolve(false); } }, 'Cancel'),
        el('button', { class: 'danger', onclick: () => { close(); resolve(true); } }, okLabel),
      ]),
    ]));
  });
}

export async function reloadBootstrap() {
  const b = await api('/api/bootstrap');
  Object.assign(state, b);
  const dl = $('#machine-list');
  if (dl) dl.replaceChildren(...state.machines.map((m) => el('option', { value: m.name })));
  const tl = $('#tech-list');
  if (tl) tl.replaceChildren(...state.technicians.map((n) => el('option', { value: n })));
  return b;
}
