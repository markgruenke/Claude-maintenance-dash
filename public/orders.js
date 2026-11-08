/* Work orders: the control-center list, the detail/edit view, and the
   new-order form (manual or pasted email). */

import {
  mount, el, api, toast, state, isSupervisor, openModal, field, select, confirmDialog, reloadBootstrap,
  fmtHours, fmtDay, fmtWhen, daysAgo, machineName, woLabel, badge, statusText, localDate, periodRanges,
} from './core.js';
import { openLogForm } from './logform.js';
import { openPartForm } from './parts.js';
import { addPhotosAskKind, thumbStrip, KINDS as PHOTO_KINDS } from './photos.js';

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
// 'recent' (default): anything touched in the last 7 days, open or done, so
// what you just logged on Today is always right here.
// period: '' or a periodRanges() id (Yesterday / This weekend / Last weekend).
const filters = { status: 'recent', period: '', q: '', machineId: '', assignedTo: '', priority: '' };

// Column sorting: tap a column title to sort by it, again to reverse, a third
// time to go back to the normal order. `key` null = normal order.
const sortBy = { key: null, dir: 1 };
const STATUS_RANK = { open: 0, in_progress: 1, waiting_parts: 2, completed: 3, cancelled: 4 };
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

export async function renderOrders(root) {
  // Arriving from the Schedule page's workload table pre-filters by person.
  const fromSchedule = sessionStorage.getItem('mt_assigned_filter');
  if (fromSchedule) {
    sessionStorage.removeItem('mt_assigned_filter');
    filters.assignedTo = fromSchedule === '— unassigned —' ? '__none' : fromSchedule;
    filters.status = 'active';
  }
  const [orders, logs, parts, photos] = await Promise.all([
    api('/api/work-orders'), api('/api/work-logs'), api('/api/parts'), api('/api/photos'),
  ]);
  const photosBy = new Map();
  for (const ph of photos) if (ph.workOrderId) photosBy.set(ph.workOrderId, (photosBy.get(ph.workOrderId) || 0) + 1);
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

  // Days each order had something happen. With work logged on it: the days
  // the work was done (an entry dated last Saturday counts for Saturday even
  // if it was typed in later) plus its due date. With nothing logged yet
  // (e.g. put in on this tab): the day it was created, finished, or is due.
  const dayOf = (iso) => (iso ? localDate(new Date(iso)) : null);
  const logDays = new Map();
  for (const l of logs) {
    if (!l.workOrderId) continue;
    if (!logDays.has(l.workOrderId)) logDays.set(l.workOrderId, new Set());
    logDays.get(l.workOrderId).add(l.date);
  }
  const activeDays = new Map(orders.map((w) => {
    const days = logDays.has(w.id) ? new Set(logDays.get(w.id)) : new Set([dayOf(w.createdAt), dayOf(w.completedAt)].filter(Boolean));
    if (w.dueDate) days.add(w.dueDate);
    return [w.id, days];
  }));
  const inPeriod = (w, p) => [...activeDays.get(w.id)].some((d) => d >= p.from && d <= p.to);
  const periods = periodRanges(today);
  const period = periods.find((p) => p.id === filters.period) || null;

  const match = (w) => {
    if (period && !inPeriod(w, period)) return false;
    if (!period && filters.status === 'recent' && lastActivity.get(w.id) < weekAgo) return false;
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
  // Sortable columns: [title, key, value(w), first-tap direction, td class].
  // Blank values (no machine, no due date…) always go last.
  const COLUMNS = [
    ['WO #', 'wo', (w) => woLabel(w), 1, ''],
    ['Machine', 'machine', (w) => machineName(w.machineId) || null, 1, ''],
    ['Job', 'job', (w) => w.title, 1, ''],
    ['Priority', 'priority', (w) => PRIORITY_RANK[w.priority], 1, ''],          // urgent first
    ['Status', 'status', (w) => STATUS_RANK[w.status], 1, ''],
    ['Assigned', 'assigned', (w) => w.assignedTo || null, 1, ''],
    ['Due', 'due', (w) => w.dueDate || null, 1, ''],                            // soonest first
    ['Opened', 'opened', (w) => w.createdAt, -1, 'hide-sm'],                    // newest first
    ['Time', 'time', (w) => minutesBy.get(w.id) || null, -1, 'num'],             // most first
    ['Parts', 'parts', (w) => partsBy.get(w.id) || null, -1, 'num hide-sm'],
  ];
  const sortCol = COLUMNS.find((c) => c[1] === sortBy.key) || null;

  const normalOrder = (a, b) => {
    if (period || filters.status === 'recent') return lastActivity.get(b.id).localeCompare(lastActivity.get(a.id));
    const closedA = ['completed', 'cancelled'].includes(a.status), closedB = ['completed', 'cancelled'].includes(b.status);
    if (closedA !== closedB) return closedA ? 1 : -1;
    if (closedA) return String(b.completedAt || b.updatedAt).localeCompare(String(a.completedAt || a.updatedAt));
    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'))
      || a.createdAt.localeCompare(b.createdAt);
  };
  const list = orders.filter(match).sort((a, b) => {
    if (!sortCol) return normalOrder(a, b);
    const va = sortCol[2](a), vb = sortCol[2](b);
    const blankA = va === null || va === undefined || va === '', blankB = vb === null || vb === undefined || vb === '';
    if (blankA || blankB) return blankA === blankB ? normalOrder(a, b) : (blankA ? 1 : -1);
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : natural(va, vb);
    return (c * sortBy.dir) || normalOrder(a, b);
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
    el('thead', {}, el('tr', {}, COLUMNS.map(([title, key, , firstDir, cls]) => {
      const on = sortBy.key === key;
      const arrow = on ? (sortBy.dir === 1 ? ' ▲' : ' ▼') : '';
      return el('th', { class: cls + ' sortable' + (on ? ' sorted' : ''), 'aria-sort': on ? (sortBy.dir === 1 ? 'ascending' : 'descending') : 'none' },
        el('button', {
          type: 'button', class: 'th-sort', title: `Sort by ${title.toLowerCase()}`,
          onclick: () => {
            if (!on) { sortBy.key = key; sortBy.dir = firstDir; }
            else if (sortBy.dir === firstDir) sortBy.dir = -firstDir;   // second tap: reverse
            else { sortBy.key = null; sortBy.dir = 1; }                 // third tap: normal order
            refresh();
          },
        }, [title, el('span', { class: 'sort-arrow' }, arrow)]));
    }))),
    el('tbody', {}, list.map((w) => el('tr', { class: 'clickable', onclick: () => openWorkOrder(w.id, refresh) }, [
      el('td', { class: 'nowrap' }, woLabel(w)),
      el('td', {}, machineName(w.machineId) || '—'),
      el('td', {}, [w.title, w.source === 'pm' ? el('span', { class: 'tag' }, 'PM') : null,
        photosBy.get(w.id) ? el('span', { class: 'tag', title: 'Photos' }, `📷 ${photosBy.get(w.id)}`) : null]),
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
    el('div', { class: 'period-boxes' }, periods.map((p) => {
      const count = orders.filter((w) => inPeriod(w, p)).length;
      const on = filters.period === p.id;
      const dates = p.from === p.to ? fmtDay(p.from) : `${fmtDay(p.from)} – ${fmtDay(p.to)}`;
      return el('button', {
        type: 'button', class: 'period-box' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false',
        onclick: () => {
          // Tap again to go back to the full list. A day or weekend shows
          // everything from then, open or done.
          filters.period = on ? '' : p.id;
          filters.status = on ? 'recent' : 'all';
          refresh();
        },
      }, [
        el('span', { class: 'pb-label' }, p.label),
        el('span', { class: 'pb-dates' }, dates),
        el('span', { class: 'pb-count' }, `${count} work order${count === 1 ? '' : 's'}`),
      ]);
    })),
    period ? el('p', { class: 'period-note' }, [
      `Showing work orders with anything done ${period.from === period.to ? 'on' : 'during'} ${period.label.toLowerCase()} (${period.from === period.to ? fmtDay(period.from) : fmtDay(period.from) + ' – ' + fmtDay(period.to)}): created, worked on, finished or due. `,
      el('button', { class: 'ghost small-btn', onclick: () => { filters.period = ''; filters.status = 'recent'; refresh(); } }, '✕ Show all'),
    ]) : null,
    el('div', { class: 'tabs-row' }, statusTabs.map(([v, label]) => el('button', {
      class: 'tab' + (filters.status === v ? ' on' : ''), onclick: () => { filters.status = v; refresh(); },
    }, label))),
    el('div', { class: 'filters' }, [
      search,
      select([['', 'All machines'], ...state.machines.map((m) => [m.id, m.name])], filters.machineId, { onchange: (e) => { filters.machineId = e.target.value; refresh(); } }),
      select([['', 'Anyone'], ['__none', 'Unassigned'], ...techs.map((t) => [t, t])], filters.assignedTo, { onchange: (e) => { filters.assignedTo = e.target.value; refresh(); } }),
      select([['', 'Any priority'], ...state.priorities.map((p) => [p, p])], filters.priority, { onchange: (e) => { filters.priority = e.target.value; refresh(); } }),
    ]),
    sortCol ? el('p', { class: 'period-note' }, [
      `Sorted by ${sortCol[0].toLowerCase()} ${sortBy.dir === sortCol[3] ? '' : '(reversed) '}· tap the column title again to reverse, a third time for the normal order. `,
      el('button', { class: 'ghost small-btn', onclick: () => { sortBy.key = null; sortBy.dir = 1; refresh(); } }, '✕ Normal order'),
    ]) : null,
    el('div', { class: 'card flush' }, el('div', { class: 'table-scroll' }, table)),
  );
}

// ------------------------------------------------------------ detail view

export async function openWorkOrder(id, onChange = () => {}) {
  let detail;
  try {
    // Fresh machine list first: the Machine box must show this order's
    // machine, or saving the form would clear it.
    await reloadBootstrap();
    detail = await api('/api/work-orders/' + id);
  } catch (err) { return toast(err.message); }
  const { workOrder: w, logs, parts, pm } = detail;
  const photos = detail.photos || [];
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

      el('h4', {}, [`Photos${photos.length ? ` (${photos.length})` : ''} `, el('button', { class: 'ghost small-btn', onclick: () => addPhotosAskKind({ workOrderId: w.id }, { onDone: reopen }) }, '📷 Add photo')]),
      photos.length
        ? el('div', { class: 'photo-groups' }, PHOTO_KINDS.map(([kind, label]) => {
          const these = photos.filter((ph) => ph.kind === kind);
          return these.length ? el('div', { class: 'photo-group' }, [el('div', { class: 'muted small' }, label), thumbStrip(these, { onChange: reopen, showKind: false })]) : null;
        }))
        : el('p', { class: 'muted' }, 'No photos yet. Add what was done, what needs doing, or the part you need.'),

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
