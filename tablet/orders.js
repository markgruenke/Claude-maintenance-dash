/* Work orders: the control-center list, the detail/edit view, and the
   new-order form (manual or pasted email). */

import {
  mount, el, api, toast, state, isSupervisor, openModal, field, select, confirmDialog, reloadBootstrap,
  fmtHours, fmtDay, fmtWhen, daysAgo, machineName, woLabel, badge, statusText, localDate,
} from './core.js';
import { openLogForm } from './logform.js';
import { openPartForm } from './parts.js';

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
// 'recent' (default): anything touched in the last 7 days, open or done, so
// what you just logged on Today is always right here.
const filters = { status: 'recent', q: '', machineId: '', assignedTo: '', priority: '' };

export async function renderOrders(root) {
  // Arriving from the Schedule page's workload table pre-filters by person.
  const fromSchedule = sessionStorage.getItem('mt_assigned_filter');
  if (fromSchedule) {
    sessionStorage.removeItem('mt_assigned_filter');
    filters.assignedTo = fromSchedule === '— unassigned —' ? '__none' : fromSchedule;
    filters.status = 'active';
  }
  const [orders, logs, parts] = await Promise.all([
    api('/api/work-orders'), api('/api/work-logs'), api('/api/parts'),
  ]);
  const refresh = () => renderOrders(root);
  const minutesBy = new Map();
  for (const l of logs) if (l.workOrderId) minutesBy.set(l.workOrderId, (minutesBy.get(l.workOrderId) || 0) + l.minutes);
  const partsBy = new Map();
  for (const p of parts) {
    if (!p.workOrderId || p.status === 'installed') continue;
    partsBy.set(p.workOrderId, (partsBy.get(p.workOrderId) || 0) + 1);
  }

  const today = localDate();
  // Latest activity per order: its own changes or any entry logged on it.
  const lastActivity = new Map(orders.map((w) => [w.id, w.updatedAt || w.createdAt]));
  for (const l of logs) {
    if (l.workOrderId && lastActivity.has(l.workOrderId) && l.createdAt > lastActivity.get(l.workOrderId)) lastActivity.set(l.workOrderId, l.createdAt);
  }
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const match = (w) => {
    if (filters.status === 'recent' && lastActivity.get(w.id) < weekAgo) return false;
    if (filters.status === 'active' && ['completed', 'cancelled'].includes(w.status)) return false;
    if (filters.status === 'overdue' && (!w.dueDate || w.dueDate >= today || ['completed', 'cancelled'].includes(w.status))) return false;
    if (!['recent', 'active', 'all', 'overdue'].includes(filters.status) && w.status !== filters.status) return false;
    if (filters.machineId && w.machineId !== filters.machineId) return false;
    if (filters.assignedTo === '__none' ? w.assignedTo : (filters.assignedTo && w.assignedTo !== filters.assignedTo)) return false;
    if (filters.priority && w.priority !== filters.priority) return false;
    if (filters.q) {
      const hay = [w.title, w.description, w.orderNumber, woLabel(w), machineName(w.machineId), w.assignedTo].join(' ').toLowerCase();
      if (!filters.q.toLowerCase().split(/\s+/).every((t) => hay.includes(t))) return false;
    }
    return true;
  };
  const list = orders.filter(match).sort((a, b) => {
    if (filters.status === 'recent') return lastActivity.get(b.id).localeCompare(lastActivity.get(a.id));
    const closedA = ['completed', 'cancelled'].includes(a.status), closedB = ['completed', 'cancelled'].includes(b.status);
    if (closedA !== closedB) return closedA ? 1 : -1;
    if (closedA) return String(b.completedAt || b.updatedAt).localeCompare(String(a.completedAt || a.updatedAt));
    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'))
      || a.createdAt.localeCompare(b.createdAt);
  });

  const counts = {
    recent: orders.filter((w) => lastActivity.get(w.id) >= weekAgo).length,
    active: orders.filter((w) => !['completed', 'cancelled'].includes(w.status)).length,
    open: orders.filter((w) => w.status === 'open').length,
    in_progress: orders.filter((w) => w.status === 'in_progress').length,
    waiting_parts: orders.filter((w) => w.status === 'waiting_parts').length,
    overdue: orders.filter((w) => w.dueDate && w.dueDate < today && !['completed', 'cancelled'].includes(w.status)).length,
  };
  const statusTabs = [
    ['recent', `Recent (${counts.recent})`], ['active', `All open (${counts.active})`], ['open', `Not started (${counts.open})`],
    ['in_progress', `In progress (${counts.in_progress})`], ['waiting_parts', `Waiting parts (${counts.waiting_parts})`],
    ['overdue', `Overdue (${counts.overdue})`], ['completed', 'Completed'], ['all', 'Everything'],
  ];

  const search = el('input', { type: 'search', placeholder: 'Search title, WO#, machine…', value: filters.q, class: 'search' });
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { filters.q = search.value; refresh().then(() => { const s = root.querySelector('.search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }); }, 250);
  });
  const techs = [...new Set([state.me.name, ...state.users.map((u) => u.name), ...state.technicians])];

  const table = list.length ? el('table', { class: 'data orders' }, [
    el('thead', {}, el('tr', {}, ['WO #', 'Machine', 'Job', 'Priority', 'Status', 'Assigned', 'Due', 'Opened', 'Time', 'Parts']
      .map((h, i) => el('th', { class: [i === 8 || i === 9 ? 'num' : '', i === 7 || i === 9 ? 'hide-sm' : ''].join(' ') }, h)))),
    el('tbody', {}, list.map((w) => el('tr', { class: 'clickable', onclick: () => openWorkOrder(w.id, refresh) }, [
      el('td', { class: 'nowrap' }, woLabel(w)),
      el('td', {}, machineName(w.machineId) || '—'),
      el('td', {}, [w.title, w.source === 'pm' ? el('span', { class: 'tag' }, 'PM') : null]),
      el('td', {}, badge(w.priority, w.priority)),
      el('td', {}, badge(w.status)),
      el('td', {}, w.assignedTo || el('span', { class: 'muted' }, 'unassigned')),
      el('td', { class: 'nowrap' + (w.dueDate && w.dueDate < today && !['completed', 'cancelled'].includes(w.status) ? ' overdue' : '') }, w.dueDate ? fmtDay(w.dueDate) : '—'),
      el('td', { class: 'nowrap hide-sm' }, daysAgo(w.createdAt)),
      el('td', { class: 'num' }, minutesBy.get(w.id) ? fmtHours(minutesBy.get(w.id)) : '—'),
      el('td', { class: 'num hide-sm' }, partsBy.get(w.id) ? String(partsBy.get(w.id)) : '—'),
    ]))),
  ]) : el('div', { class: 'empty' }, 'No work orders match.');

  mount(root, 
    el('div', { class: 'view-head' }, [
      el('h2', {}, 'Work orders'),
      el('span', { class: 'spacer' }),
      el('button', { onclick: () => openEmailForm(refresh) }, 'Paste email'),
      el('button', { class: 'primary', onclick: () => openNewOrder({ onDone: refresh }) }, '+ New work order'),
    ]),
    el('div', { class: 'tabs-row' }, statusTabs.map(([v, label]) => el('button', {
      class: 'tab' + (filters.status === v ? ' on' : ''), onclick: () => { filters.status = v; refresh(); },
    }, label))),
    el('div', { class: 'filters' }, [
      search,
      select([['', 'All machines'], ...state.machines.map((m) => [m.id, m.name])], filters.machineId, { onchange: (e) => { filters.machineId = e.target.value; refresh(); } }),
      select([['', 'Anyone'], ['__none', 'Unassigned'], ...techs.map((t) => [t, t])], filters.assignedTo, { onchange: (e) => { filters.assignedTo = e.target.value; refresh(); } }),
      select([['', 'Any priority'], ...state.priorities.map((p) => [p, p])], filters.priority, { onchange: (e) => { filters.priority = e.target.value; refresh(); } }),
    ]),
    el('div', { class: 'card flush' }, el('div', { class: 'table-scroll' }, table)),
  );
}

// ------------------------------------------------------------ detail view

export async function openWorkOrder(id, onChange = () => {}) {
  let detail;
  try { detail = await api('/api/work-orders/' + id); } catch (err) { return toast(err.message); }
  const { workOrder: w, logs, parts, pm } = detail;
  const techs = [...new Set([state.me.name, ...state.users.map((u) => u.name), ...state.technicians])];
  let dirty = false;

  const close = openModal(`${woLabel(w)} — ${w.title}`, (close) => {
    const f = {
      title: el('input', { value: w.title }),
      machine: el('input', { list: 'machine-list', value: machineName(w.machineId) }),
      orderNumber: el('input', { value: w.orderNumber, placeholder: 'from Plex' }),
      priority: select(state.priorities, w.priority),
      status: select(state.statuses, w.status),
      assignedTo: select([['', '— unassigned —'], ...techs.map((t) => [t, t])], w.assignedTo),
      dueDate: el('input', { type: 'date', value: w.dueDate || '' }),
      description: el('textarea', { rows: 3 }),
    };
    f.description.value = w.description || '';
    Object.values(f).forEach((i) => i.addEventListener('input', () => { dirty = true; saveBtn.disabled = false; }));
    Object.values(f).forEach((i) => i.addEventListener('change', () => { dirty = true; saveBtn.disabled = false; }));

    const saveBtn = el('button', { class: 'primary', disabled: true, onclick: async () => {
      try {
        await api('/api/work-orders/' + w.id, { method: 'PATCH', body: {
          title: f.title.value.trim(), machineName: f.machine.value.trim(), orderNumber: f.orderNumber.value.trim(),
          priority: f.priority.value, status: f.status.value, assignedTo: f.assignedTo.value,
          dueDate: f.dueDate.value || null, description: f.description.value,
        } });
        toast('Saved');
        await reloadBootstrap();
        close(); onChange();
      } catch (err) { toast(err.message); }
    } }, 'Save changes');

    const note = el('input', { placeholder: 'Add a note (e.g. "called vendor, ships Tuesday")' });
    const addNote = async () => {
      if (!note.value.trim()) return;
      try {
        await api(`/api/work-orders/${w.id}/notes`, { method: 'POST', body: { text: note.value.trim() } });
        close(); onChange(); openWorkOrder(w.id, onChange);
      } catch (err) { toast(err.message); }
    };
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter') addNote(); });

    const total = logs.reduce((s, l) => s + l.minutes, 0);
    const timeline = [
      ...logs.map((l) => ({ at: l.startedAt || l.createdAt, kind: 'log', l })),
      ...(w.history || []).map((h) => ({ at: h.at, kind: h.note ? 'note' : 'change', h })),
    ].sort((a, b) => b.at.localeCompare(a.at));

    const partRows = parts.map((p) => el('tr', {}, [
      el('td', {}, [p.name, p.partNumber ? el('span', { class: 'muted' }, ` (${p.partNumber})`) : null]),
      el('td', { class: 'num' }, String(p.quantity)),
      el('td', {}, select(state.partStatuses, p.status, { class: 'inline', onchange: async (e) => {
        await api('/api/parts/' + p.id, { method: 'PATCH', body: { status: e.target.value } });
        toast(`${p.name} → ${e.target.value}`);
        onChange();
      } })),
    ]));

    const reopen = () => { close(); onChange(); openWorkOrder(w.id, onChange); };

    return el('div', { class: 'wo-detail' }, [
      el('div', { class: 'wo-meta' }, [
        badge(w.status), badge(w.priority, w.priority),
        el('span', { class: 'muted' }, `Opened ${fmtWhen(w.createdAt)}${w.createdBy ? ' by ' + w.createdBy : ''} · source: ${w.source}`),
        w.completedAt ? el('span', { class: 'muted' }, `· completed ${fmtWhen(w.completedAt)}`) : null,
        pm ? el('span', { class: 'tag' }, `PM every ${pm.intervalDays} days`) : null,
      ]),
      el('div', { class: 'row-end left' }, [
        el('button', { class: 'primary', onclick: () => { close(); openLogForm({ mode: 'log', workOrder: w, onDone: onChange }); } }, '+ Log work on this'),
        w.status !== 'completed' ? el('button', { onclick: async () => {
          await api('/api/work-orders/' + w.id, { method: 'PATCH', body: { status: 'completed' } });
          toast('Marked completed'); close(); onChange();
        } }, '✓ Mark completed') : null,
      ]),
      el('div', { class: 'grid-form' }, [
        field('Title', f.title), field('Machine', f.machine),
        field('Plex WO#', f.orderNumber), field('Priority', f.priority),
        field('Status', f.status), field('Assigned to', f.assignedTo),
        field('Due date', f.dueDate), el('span'),
      ]),
      field('Description', f.description),
      el('div', { class: 'row-end' }, [
        isSupervisor() ? el('button', { class: 'danger ghost', onclick: async () => {
          if (!(await confirmDialog('Delete this work order? Its time entries and parts are kept (just unlinked). Usually “cancelled” status is better.'))) return;
          await api('/api/work-orders/' + w.id, { method: 'DELETE' });
          toast('Deleted'); close(); onChange();
        } }, 'Delete') : null,
        el('span', { class: 'spacer' }),
        saveBtn,
      ]),

      el('h4', {}, ['Parts ', el('button', { class: 'ghost small-btn', onclick: () => openPartForm({ workOrder: w, onDone: reopen }) }, '+ Add part')]),
      parts.length ? el('table', { class: 'data' }, [
        el('thead', {}, el('tr', {}, [el('th', {}, 'Part'), el('th', { class: 'num' }, 'Qty'), el('th', {}, 'Status')])),
        el('tbody', {}, partRows),
      ]) : el('p', { class: 'muted' }, 'No parts on this order.'),

      el('h4', {}, `Activity · ${fmtHours(total)} logged`),
      el('div', { class: 'note-add' }, [note, el('button', { onclick: addNote }, 'Add note')]),
      el('div', { class: 'timeline' }, timeline.map((t) => {
        if (t.kind === 'log') {
          return el('div', { class: 'tl log' }, [
            el('div', { class: 'tl-when' }, [fmtDay(t.l.date), t.l.technician || '—', t.l.minutes ? fmtHours(t.l.minutes) : ''].filter(Boolean).join(' · ')),
            el('div', {}, t.l.notes || el('span', { class: 'muted' }, '(no notes)')),
          ]);
        }
        return el('div', { class: 'tl ' + t.kind }, [
          el('div', { class: 'tl-when' }, `${fmtWhen(t.h.at)}${t.h.by ? ' · ' + t.h.by : ''}`),
          el('div', {}, t.h.text),
        ]);
      })),
    ]);
  }, { wide: true });
  return close;
}

// --------------------------------------------------------------- new order

export function openNewOrder({ onDone, machineName: presetMachine = '' } = {}) {
  const techs = [...new Set([state.me.name, ...state.users.map((u) => u.name), ...state.technicians])];
  openModal('New work order', (close) => {
    const f = {
      title: el('input', { placeholder: 'What needs doing' }),
      machine: el('input', { list: 'machine-list', placeholder: 'e.g. CNC 3', value: presetMachine }),
      orderNumber: el('input', { placeholder: 'optional' }),
      priority: select(state.priorities, 'medium'),
      // On your own tablet, new orders are yours; on the shared system the supervisor picks.
      assignedTo: select([['', '— unassigned —'], ...techs.map((t) => [t, t])], state.local ? state.me.name : ''),
      dueDate: el('input', { type: 'date' }),
      description: el('textarea', { rows: 3 }),
    };
    const save = async () => {
      if (!f.title.value.trim()) return toast('Give it a title');
      try {
        await api('/api/work-orders', { method: 'POST', body: {
          title: f.title.value.trim(), machineName: f.machine.value.trim(), orderNumber: f.orderNumber.value.trim(),
          priority: f.priority.value, assignedTo: f.assignedTo.value, dueDate: f.dueDate.value || null,
          description: f.description.value.trim(),
        } });
        await reloadBootstrap();
        toast('Work order created');
        close(); onDone && onDone();
      } catch (err) { toast(err.message); }
    };
    return el('div', {}, [
      el('div', { class: 'grid-form' }, [
        field('Title', f.title), field('Machine', f.machine),
        field('Plex WO#', f.orderNumber), field('Priority', f.priority),
        field('Assign to', f.assignedTo), field('Due date', f.dueDate),
      ]),
      field('Description', f.description),
      el('div', { class: 'row-end' }, [el('button', { class: 'ghost', onclick: close }, 'Cancel'), el('button', { class: 'primary', onclick: save }, 'Create')]),
    ]);
  });
}

export function openEmailForm(onDone) {
  openModal('Work order from email', (close) => {
    const subject = el('input');
    const body = el('textarea', { rows: 8 });
    return el('div', {}, [
      el('p', { class: 'desc' }, 'Paste the subject and body of a work-order email from Plex. It pulls out the order number, machine and priority. Pasting the same order twice is harmless.'),
      field('Subject', subject), field('Body', body),
      el('div', { class: 'row-end' }, [
        el('button', { class: 'ghost', onclick: close }, 'Cancel'),
        el('button', { class: 'primary', onclick: async () => {
          try {
            const out = await api('/api/ingest/email', { method: 'POST', body: { subject: subject.value, body: body.value } });
            await reloadBootstrap();
            toast(out.created ? `Created ${woLabel(out.workOrder)}` : `Already had ${woLabel(out.workOrder)}`);
            close(); onDone && onDone();
          } catch (err) { toast(err.message); }
        } }, 'Create order'),
      ]),
    ]);
  });
}

export { statusText };
