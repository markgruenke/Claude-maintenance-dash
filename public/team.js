/* Team & settings: accounts (supervisor only), machines list, backups, and
   changing your own PIN. */

import {
  mount, el, api, toast, state, isSupervisor, openModal, field, select, reloadBootstrap, fmtDate,
} from './core.js';

export async function renderTeam(root) {
  const refresh = () => renderTeam(root);
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
    el('div', { class: 'card' }, [
      el('h2', {}, ['Machines', el('span', { class: 'spacer' }), el('button', { onclick: () => openMachineForm({ onDone: refresh }) }, '+ Add machine')]),
      el('p', { class: 'desc' }, 'Machines are also added automatically the first time someone logs work on a new one. Fix names here so they match the company system.'),
      state.machines.length ? el('table', { class: 'data' }, [
        el('thead', {}, el('tr', {}, ['Machine', 'Area', 'Notes', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, [...state.machines].sort((a, b) => a.name.localeCompare(b.name)).map((m) => el('tr', {}, [
          el('td', {}, m.name), el('td', {}, m.area || '—'), el('td', {}, m.notes || ''),
          el('td', {}, isSupervisor() ? el('button', { class: 'ghost', onclick: () => openMachineForm({ machine: m, onDone: refresh }) }, 'Edit') : null),
        ]))),
      ]) : el('div', { class: 'empty' }, 'No machines yet.'),
    ]),
    isSupervisor() ? el('div', { class: 'card' }, [
      el('h2', {}, 'Backups'),
      el('p', { class: 'desc' }, 'The server keeps a copy of everything every day in data/backups (last 30 days). You can also download a copy right now — PINs and passwords are not included.'),
      el('a', { class: 'btn', href: '/api/export', download: '' }, 'Download backup (.json)'),
    ]) : null,
  );
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
