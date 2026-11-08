/* Team & settings: accounts (supervisor only), machines list, backups, and
   changing your own PIN. On the tablet app: your name, backup/restore and
   storage status instead of accounts. */

import {
  mount, el, api, toast, state, isSupervisor, openModal, field, select, reloadBootstrap, fmtDate, localDate,
  confirmDialog, daysAgo,
} from './core.js';

// ---------------------------------------------------------------- backups

const LAST_BACKUP_KEY = 'mt_last_backup';

export function lastBackupAt() {
  try { return localStorage.getItem(LAST_BACKUP_KEY) || ''; } catch { return ''; }
}

/** Download (or share) a backup file of everything. */
export async function backupNow({ share = false } = {}) {
  if (state.engine) await state.engine.flush();
  const data = await api('/api/export');
  const json = JSON.stringify(data, null, 2);
  const filename = `maintenance-backup-${localDate()}.json`;
  const file = new File([json], filename, { type: 'application/json' });
  if (share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Maintenance log backup' });
    } catch (err) {
      if (err.name === 'AbortError') return false; // they closed the share sheet
      throw err;
    }
  } else {
    const url = URL.createObjectURL(file);
    const a = el('a', { href: url, download: filename, style: 'display:none' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  try { localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString()); } catch { /* */ }
  toast(share ? 'Backup shared' : 'Backup saved to your Downloads');
  return true;
}

function restoreFromFile(onDone) {
  const input = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    input.remove();
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { toast('That file isn’t a backup (not readable)', 4000); return; }
    const n = (data.workLogs || []).length;
    if (!(await confirmDialog(`Replace everything here with this backup (${n} entries, ${(data.workOrders || []).length} jobs)? What’s here now will be gone, so save a backup first if you need it.`, 'Restore'))) return;
    try {
      const out = await api('/api/import', { method: 'POST', body: { data } });
      await reloadBootstrap();
      toast(`Restored ${out.counts.workLogs} entries and ${out.counts.workOrders} jobs`, 4000);
      onDone && onDone();
    } catch (err) { toast(err.message, 5000); }
  });
  document.body.append(input);
  input.click();
}

function backupCard(refresh) {
  const last = lastBackupAt();
  const local = state.local;
  return el('div', { class: 'card' }, [
    el('h2', {}, 'Backup & restore'),
    el('p', { class: 'desc' }, local
      ? 'Your log lives only on this tablet. Save a backup file now and then (or send it to yourself), so a lost or reset tablet doesn’t lose your history. The same file can later be loaded into the shared system.'
      : 'The server keeps a copy every day in data/backups (last 30 days). You can also save a copy now (PINs and passwords aren’t included), or load a backup, for example one from a tablet.'),
    el('p', {}, last ? `Last backup from this device: ${daysAgo(last)} (${fmtDate(last)}).` : el('strong', {}, 'No backup saved from this device yet.')),
    el('div', { class: 'row-end left' }, [
      el('button', { class: 'primary', onclick: () => backupNow().then(refresh).catch((e) => toast(e.message)) }, 'Save backup file'),
      navigator.canShare ? el('button', { onclick: () => backupNow({ share: true }).then(refresh).catch((e) => toast(e.message)) }, 'Send backup (email, Drive…)') : null,
      isSupervisor() ? el('button', { class: 'ghost', onclick: () => restoreFromFile(refresh) }, 'Restore from a backup…') : null,
    ]),
  ]);
}

async function storageCard() {
  let persisted = null;
  let usage = '';
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch { /* */ }
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      if (e.usage != null) usage = `${(e.usage / 1048576).toFixed(1)} MB used`;
    }
  } catch { /* */ }
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const err = state.engine ? state.engine.storageError() : '';
  return el('div', { class: 'card' }, [
    el('h2', {}, 'Storage on this tablet'),
    err ? el('p', { class: 'overdue' }, 'Saving problem: ' + err + '. Save a backup file now.') : null,
    el('ul', { class: 'rlist' }, [
      el('li', {}, standalone ? 'Opened from the home screen ✓' : ['Not opened from the home screen yet. ', el('strong', {}, 'Add it to your home screen'), ' (browser menu → “Add to Home screen”, or Share → “Add to Home Screen” on iPad) and open it from there. That also protects your data from being cleared.']),
      el('li', {}, persisted === true ? 'Protected from automatic clearing ✓'
        : persisted === false ? 'Not yet protected from automatic clearing (the browser decides; it usually allows it once the app is on the home screen). Keep backups.'
          : 'This browser doesn’t say whether storage is protected. Keep backups.'),
      usage ? el('li', {}, usage) : null,
      el('li', {}, 'Don’t use “Clear browsing data / site data” for this site: that erases the log.'),
    ]),
  ]);
}

function nameCard(refresh) {
  return el('div', { class: 'card' }, [
    el('h2', {}, 'Your name'),
    el('p', { class: 'desc' }, `Shown on your reports: ${state.me.name}.`),
    el('button', { onclick: () => openModal('Your name', (close) => {
      const name = el('input', { value: state.me.name, autocapitalize: 'words' });
      return el('div', {}, [
        field('Name', name),
        el('div', { class: 'row-end' }, [el('button', { class: 'ghost', onclick: close }, 'Cancel'), el('button', { class: 'primary', onclick: async () => {
          if (!name.value.trim()) return toast('Enter a name');
          await api('/api/me', { method: 'PATCH', body: { name: name.value.trim() } });
          await reloadBootstrap();
          close(); refresh();
        } }, 'Save')]),
      ]);
    }) }, 'Change'),
  ]);
}

export async function renderTeam(root) {
  const refresh = () => renderTeam(root);
  if (state.local) {
    mount(root,
      el('div', { class: 'view-head' }, [el('h2', {}, 'Settings')]),
      backupCard(refresh),
      await storageCard(),
      nameCard(refresh),
      machinesCard(refresh),
    );
    return;
  }
  const users = isSupervisor() ? await api('/api/users') : [];

  mount(root, 
    el('div', { class: 'view-head' }, [el('h2', {}, isSupervisor() ? 'Team & settings' : 'My account')]),
    el('div', { class: 'card' }, [
      el('h2', {}, 'My account'),
      el('p', { class: 'desc' }, `Signed in as ${state.me.name} (${state.me.role}).`),
      el('button', { onclick: openChangeSecret }, state.me.role === 'supervisor' ? 'Change my password' : 'Change my PIN'),
    ]),
    isSupervisor() ? el('div', { class: 'card' }, [
      el('h2', {}, ['People', el('span', { class: 'spacer' }), el('button', { class: 'primary', onclick: () => openUserForm({ onDone: refresh }) }, '+ Add person')]),
      el('p', { class: 'desc' }, 'Everyone who logs work gets an account. Technicians sign in with a PIN on their tablet; supervisors can edit everything and log work on anyone’s behalf.'),
      el('table', { class: 'data' }, [
        el('thead', {}, el('tr', {}, ['Name', 'Role', 'Status', 'Since', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, users.map((u) => el('tr', { class: u.active ? '' : 'inactive' }, [
          el('td', {}, u.name + (u.id === state.me.id ? ' (you)' : '')),
          el('td', {}, u.role === 'supervisor' ? 'Supervisor' : 'Technician'),
          el('td', {}, u.active ? 'active' : 'deactivated'),
          el('td', {}, fmtDate(u.createdAt)),
          el('td', {}, el('button', { class: 'ghost', onclick: () => openUserForm({ user: u, onDone: refresh }) }, 'Edit')),
        ]))),
      ]),
    ]) : null,
    machinesCard(refresh),
    isSupervisor() ? backupCard(refresh) : null,
  );
}

function machinesCard(refresh) {
  return el('div', { class: 'card' }, [
    el('h2', {}, ['Machines', el('span', { class: 'spacer' }), el('button', { onclick: () => openMachineForm({ onDone: refresh }) }, '+ Add machine')]),
    el('p', { class: 'desc' }, 'Machines are also added automatically the first time someone logs work on a new one. Fix names here so they match Plex.'),
    state.machines.length ? el('table', { class: 'data' }, [
      el('thead', {}, el('tr', {}, ['Machine', 'Area', 'Notes', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, [...state.machines].sort((a, b) => a.name.localeCompare(b.name)).map((m) => el('tr', {}, [
        el('td', {}, m.name), el('td', {}, m.area || '—'), el('td', {}, m.notes || ''),
        el('td', {}, isSupervisor() ? el('button', { class: 'ghost', onclick: () => openMachineForm({ machine: m, onDone: refresh }) }, 'Edit') : null),
      ]))),
    ]) : el('div', { class: 'empty' }, 'No machines yet.'),
  ]);
}

function openChangeSecret() {
  const isSup = state.me.role === 'supervisor';
  openModal(isSup ? 'Change password' : 'Change PIN', (close) => {
    const current = el('input', { type: 'password', autocomplete: 'current-password' });
    const next = el('input', { type: 'password', autocomplete: 'new-password', inputmode: isSup ? undefined : 'numeric' });
    const again = el('input', { type: 'password', autocomplete: 'new-password', inputmode: isSup ? undefined : 'numeric' });
    return el('div', {}, [
      field('Current', current), field('New', next, isSup ? 'At least 8 characters' : 'At least 4 characters'), field('New again', again),
      el('div', { class: 'row-end' }, [el('button', { class: 'ghost', onclick: close }, 'Cancel'), el('button', { class: 'primary', onclick: async () => {
        if (next.value !== again.value) return toast('The two new ones don’t match');
        try {
          await api('/api/me/secret', { method: 'POST', body: { current: current.value, next: next.value } });
          toast('Changed'); close();
        } catch (err) { toast(err.message); }
      } }, 'Save')]),
    ]);
  });
}

function openUserForm({ user = null, onDone } = {}) {
  openModal(user ? `Edit ${user.name}` : 'Add person', (close) => {
    const name = el('input', { value: user ? user.name : '', autocomplete: 'off' });
    const role = select([['tech', 'Technician'], ['supervisor', 'Supervisor']], user ? user.role : 'tech');
    const secret = el('input', { type: 'text', autocomplete: 'off', placeholder: user ? 'leave blank to keep current' : '' });
    const active = select([['yes', 'Active'], ['no', 'Deactivated (can’t sign in)']], user && !user.active ? 'no' : 'yes');
    const hint = el('span', { class: 'fld-hint' });
    const drawHint = () => { hint.textContent = role.value === 'supervisor' ? 'Supervisor password: 8+ characters' : 'Technician PIN: 4+ digits (longer is safer once this is online)'; };
    role.addEventListener('change', drawHint);
    drawHint();
    return el('div', {}, [
      field('Name', name, 'What they type to sign in'),
      field('Role', role),
      el('label', { class: 'fld' }, [el('span', { class: 'fld-label' }, user ? 'Reset PIN / password' : 'PIN / password'), secret, hint]),
      user ? field('Status', active) : null,
      el('div', { class: 'row-end' }, [el('button', { class: 'ghost', onclick: close }, 'Cancel'), el('button', { class: 'primary', onclick: async () => {
        try {
          if (user) {
            const body = { name: name.value.trim(), role: role.value, active: active.value === 'yes' };
            if (secret.value) body.secret = secret.value;
            await api('/api/users/' + user.id, { method: 'PATCH', body });
          } else {
            await api('/api/users', { method: 'POST', body: { name: name.value.trim(), role: role.value, secret: secret.value } });
          }
          await reloadBootstrap();
          toast('Saved'); close(); onDone && onDone();
        } catch (err) { toast(err.message, 4000); }
      } }, 'Save')]),
    ]);
  });
}

function openMachineForm({ machine = null, onDone } = {}) {
  openModal(machine ? 'Edit machine' : 'Add machine', (close) => {
    const name = el('input', { value: machine ? machine.name : '' });
    const area = el('input', { value: machine ? machine.area : '', placeholder: 'e.g. Machining, Stamping' });
    const notes = el('input', { value: machine ? machine.notes : '', placeholder: 'model, serial, quirks' });
    return el('div', {}, [
      field('Name', name), field('Area', area), field('Notes', notes),
      el('div', { class: 'row-end' }, [el('button', { class: 'ghost', onclick: close }, 'Cancel'), el('button', { class: 'primary', onclick: async () => {
        if (!name.value.trim()) return toast('Name is required');
        try {
          const body = { name: name.value.trim(), area: area.value.trim(), notes: notes.value.trim() };
          if (machine) await api('/api/machines/' + machine.id, { method: 'PATCH', body });
          else await api('/api/machines', { method: 'POST', body });
          await reloadBootstrap();
          toast('Saved'); close(); onDone && onDone();
        } catch (err) { toast(err.message); }
      } }, 'Save')]),
    ]);
  });
}
