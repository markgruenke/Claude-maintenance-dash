/* App shell: sign-in / first-run setup, navigation, and routing between
   views. Each view module exports render<View>(root). */

import {
  $, el, mount, api, toast, state, isSupervisor, reloadBootstrap, setUnauthorizedHandler,
  flushQueue, renderQueueBanner,
} from './core.js';
import { renderToday } from './today.js';
import { renderOrders } from './orders.js';
import { renderParts } from './parts.js';
import { renderReports, applyRouteParams } from './reports.js';
import { renderSchedule } from './schedule.js';
import { renderDashboard } from './dashboard.js';
import { renderTeam } from './team.js';

const VIEWS = [
  { id: 'today', label: 'Today', render: renderToday },
  { id: 'orders', label: 'Work Orders', render: renderOrders },
  { id: 'parts', label: 'Parts', render: renderParts },
  { id: 'reports', label: 'Reports', render: renderReports },
  { id: 'schedule', label: 'Schedule', render: renderSchedule },
  { id: 'dashboard', label: 'Dashboard', render: renderDashboard },
  { id: 'team', label: 'Team', label2: 'Account', render: renderTeam },
];

let currentView = null;
let rendering = false;

// ----------------------------------------------------------------- auth

/** Tablet app first run: no accounts, just ask whose tablet this is. */
function showWelcome() {
  $('#app').hidden = true;
  const box = $('#auth');
  box.hidden = false;
  const name = el('input', { autocomplete: 'name', autocapitalize: 'words', class: 'big' });
  const err = el('p', { class: 'auth-err', role: 'alert' });
  box.replaceChildren(el('form', { class: 'auth-card', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/setup', { method: 'POST', body: { name: name.value.trim() } });
      box.hidden = true;
      await start();
    } catch (ex) { err.textContent = ex.message; }
  } }, [
    el('div', { class: 'brand' }, [el('img', { src: 'icon.svg', alt: '', width: 40, height: 40 }), el('h1', {}, 'Maintenance Log')]),
    el('p', { class: 'desc' }, 'Everything you log stays on this tablet. Nothing is sent anywhere. What’s your name? (It goes on your reports.)'),
    el('label', { class: 'fld' }, [el('span', { class: 'fld-label' }, 'Your name'), name]),
    err,
    el('button', { class: 'primary big', type: 'submit' }, 'Start'),
  ]));
  name.focus();
}

function showAuth(setupNeeded) {
  if (state.local) return showWelcome();
  $('#app').hidden = true;
  const box = $('#auth');
  box.hidden = false;
  const name = el('input', { autocomplete: 'username', autocapitalize: 'words', class: 'big' });
  try { name.value = localStorage.getItem('mt_last_name') || ''; } catch { /* */ }
  const secret = el('input', { type: 'password', autocomplete: setupNeeded ? 'new-password' : 'current-password', class: 'big' });
  const secret2 = setupNeeded ? el('input', { type: 'password', autocomplete: 'new-password', class: 'big' }) : null;
  const err = el('p', { class: 'auth-err', role: 'alert' });
  const btn = el('button', { class: 'primary big', type: 'submit' }, setupNeeded ? 'Create supervisor account' : 'Sign in');

  const form = el('form', { class: 'auth-card', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (setupNeeded && secret.value !== secret2.value) { err.textContent = 'The two passwords don’t match.'; return; }
    btn.disabled = true;
    try {
      await api(setupNeeded ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { name: name.value.trim(), secret: secret.value } });
      try { localStorage.setItem('mt_last_name', name.value.trim()); } catch { /* */ }
      box.hidden = true;
      await start();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  } }, [
    el('div', { class: 'brand' }, [el('img', { src: 'icon.svg', alt: '', width: 40, height: 40 }), el('h1', {}, 'Maintenance Tracker')]),
    setupNeeded
      ? el('p', { class: 'desc' }, 'First-time setup. Create the supervisor account — that’s you for now. You can add technicians (and their PINs) afterwards under Team.')
      : el('p', { class: 'desc' }, 'Sign in with your name and PIN.'),
    el('label', { class: 'fld' }, [el('span', { class: 'fld-label' }, 'Name'), name]),
    el('label', { class: 'fld' }, [el('span', { class: 'fld-label' }, setupNeeded ? 'Password (8+ characters)' : 'PIN / password'), secret]),
    setupNeeded ? el('label', { class: 'fld' }, [el('span', { class: 'fld-label' }, 'Password again'), secret2]) : null,
    err,
    btn,
  ]);
  box.replaceChildren(form);
  (name.value ? secret : name).focus();
}

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* */ }
  state.me = null;
  showAuth(false);
}

// ----------------------------------------------------------------- nav

function renderNav() {
  const nav = $('#nav');
  nav.replaceChildren(...VIEWS.map((v) => el('a', {
    href: '#' + v.id, class: 'nav-link' + (currentView === v.id ? ' on' : ''), 'data-view': v.id,
  }, state.local && v.id === 'team' ? 'Settings' : (isSupervisor() || !v.label2 ? v.label : v.label2))));
  mount($('#who'),
    el('span', { class: 'who-name' }, [state.me.name, el('span', { class: 'muted' }, isSupervisor() && !state.local ? ' · supervisor' : '')]),
    state.local ? null : el('button', { class: 'ghost', onclick: signOut }, 'Sign out'),
  );
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  const [view, query] = raw.split('?');
  return { view: VIEWS.some((v) => v.id === view) ? view : 'today', params: new URLSearchParams(query || '') };
}

async function route() {
  if (!state.me) return;
  const { view, params } = parseHash();
  if (view === 'reports') applyRouteParams(params);
  if (view !== currentView) window.scrollTo(0, 0);
  document.querySelectorAll('.tooltip').forEach((t) => { t.style.display = 'none'; });
  // Machines/people can be added from any device; keep pickers current.
  try { await reloadBootstrap(); } catch (err) { if (err.status === 401) return; }
  currentView = view;
  renderNav();
  const root = $('#view');
  root.dataset.view = view;
  rendering = true;
  try {
    await VIEWS.find((v) => v.id === view).render(root);
  } catch (err) {
    if (err.status !== 401) {
      root.replaceChildren(el('div', { class: 'empty' }, 'Could not load this page: ' + err.message));
      toast(err.message, 4000);
    }
  } finally {
    rendering = false;
  }
}

// Keep shared screens current when several people are working.
function autoRefresh() {
  if (!state.me || document.hidden || rendering) return;
  if (document.querySelector('.modal-back')) return;
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
  route();
}

// ----------------------------------------------------------------- boot

async function start() {
  await reloadBootstrap();
  $('#app').hidden = false;
  renderQueueBanner();
  flushQueue().then((n) => { if (n) route(); });
  await route();
}

export async function boot() {
  setUnauthorizedHandler(() => { if (state.me) { state.me = null; toast('Please sign in again'); showAuth(false); } });
  window.addEventListener('hashchange', route);
  window.addEventListener('mt:refresh', route);
  window.addEventListener('online', () => flushQueue().then(() => route()));
  setInterval(() => flushQueue().then((n) => { if (n) route(); }), 30000);
  if (!state.local) {
    // Others may be changing things on a shared system; keep screens current.
    setInterval(autoRefresh, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) autoRefresh(); });
  }

  try {
    const s = await api('/api/auth/status');
    if (s.user) return start();
    showAuth(s.setupNeeded);
  } catch (err) {
    $('#auth').hidden = false;
    $('#auth').replaceChildren(el('div', { class: 'auth-card' }, [
      el('h1', {}, 'Can’t reach the server'),
      el('p', {}, err.message),
      el('button', { class: 'primary', onclick: () => location.reload() }, 'Try again'),
    ]));
  }
}

// The tablet app (boot-local.js) starts the app itself once its on-tablet
// database is open.
if (!globalThis.__MT_LOCAL__) boot();
