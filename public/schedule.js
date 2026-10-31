/* Schedule: what's due when (overdue / today / this week / later), who has
   what, and the preventive-maintenance schedules that feed it. */

import {
  mount, el, api, toast, state, isSupervisor, openModal, field, select, confirmDialog, reloadBootstrap,
  fmtDay, localDate, addDays, machineName, woLabel, badge,
} from './core.js';
import { openWorkOrder } from './orders.js';

export async function renderSchedule(root) {
  const [orders, pms] = await Promise.all([api('/api/work-orders?status=open'), api('/api/pm')]);
  const refresh = () => renderSchedule(root);
  const today = localDate();
  const weekEnd = addDays(today, 7);

  const buckets = [
    ['Overdue', (w) => w.dueDate && w.dueDate < today, 'overdue'],
    ['Due today', (w) => w.dueDate === today, ''],
    ['Next 7 days', (w) => w.dueDate && w.dueDate > today && w.dueDate <= weekEnd, ''],
    ['Later', (w) => w.dueDate && w.dueDate > weekEnd, ''],
  ];
  const noDue = orders.filter((w) => !w.dueDate);

  const orderRow = (w) => el('div', { class: 'wo-row', onclick: () => openWorkOrder(w.id, refresh) }, [
    el('div', { class: 'nowrap date-col' }, w.dueDate ? fmtDay(w.dueDate) : ''),
    el('div', { class: 'grow' }, [
      el('div', {}, [el('strong', {}, machineName(w.machineId) || '—'), ' ', w.title, w.source === 'pm' ? el('span', { class: 'tag' }, 'PM') : null]),
      el('div', { class: 'muted small' }, [woLabel(w), ' · ', w.assignedTo || 'unassigned']),
    ]),
    badge(w.priority, w.priority), badge(w.status),
  ]);

  // Workload by person
  const load = new Map();
  for (const w of orders) {
    const k = w.assignedTo || '— unassigned —';
    if (!load.has(k)) load.set(k, { total: 0, urgent: 0, overdue: 0 });
    const s = load.get(k);
    s.total++;
    if (['urgent', 'high'].includes(w.priority)) s.urgent++;
    if (w.dueDate && w.dueDate < today) s.overdue++;
  }

  mount(root, 
    el('div', { class: 'view-head' }, [el('h2', {}, 'Schedule')]),
    el('div', { class: 'grid2' }, [
      el('div', { class: 'card' }, [
        el('h2', {}, 'Due dates'),
        el('p', { class: 'desc' }, `Open work orders with a due date. ${noDue.length} more open order${noDue.length === 1 ? ' has' : 's have'} no due date — set one in the order.`),
        ...buckets.map(([title, test, cls]) => {
          const list = orders.filter(test).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
          if (!list.length) return null;
          return el('div', { class: 'bucket ' + cls }, [el('h4', {}, `${title} (${list.length})`), ...list.map(orderRow)]);
        }),
        orders.some((w) => w.dueDate) ? null : el('div', { class: 'empty' }, 'Nothing has a due date yet.'),
      ]),
      el('div', { class: 'card' }, [
        el('h2', {}, 'Workload'),
        el('p', { class: 'desc' }, 'Open orders per person'),
        el('table', { class: 'data' }, [
          el('thead', {}, el('tr', {}, [el('th', {}, 'Person'), el('th', { class: 'num' }, 'Open'), el('th', { class: 'num' }, 'High/urgent'), el('th', { class: 'num' }, 'Overdue')])),
          el('tbody', {}, [...load.entries()].sort((a, b) => b[1].total - a[1].total).map(([name, s]) => el('tr', {}, [
            el('td', {}, el('a', { href: '#orders', onclick: () => sessionStorage.setItem('mt_assigned_filter', name) }, name)),
            el('td', { class: 'num' }, String(s.total)),
            el('td', { class: 'num' }, String(s.urgent)),
            el('td', { class: 'num' + (s.overdue ? ' overdue' : '') }, String(s.overdue)),
          ]))),
        ]),
      ]),
    ]),
    el('div', { class: 'card' }, [
      el('h2', {}, [
        'Preventive maintenance',
        el('span', { class: 'spacer' }),
        isSupervisor() ? el('button', { onclick: async () => {
          const out = await api('/api/pm/run', { method: 'POST' });
          toast(out.created.length ? `Created ${out.created.length} PM work order${out.created.length === 1 ? '' : 's'}` : 'Nothing new is due');
          refresh();
        } }, 'Check now') : null,
        isSupervisor() ? el('button', { class: 'primary', onclick: () => openPmForm({ onDone: refresh }) }, '+ Add PM') : null,
      ]),
      el('p', { class: 'desc' }, 'Recurring tasks. A work order is created automatically a few days before each one is due (the “lead days”); completing that order schedules the next one.'),
      pms.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'data' }, [
        el('thead', {}, el('tr', {}, ['Machine', 'Task', 'Every', 'Next due', 'Last done', 'Assigned', 'Active', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, [...pms].sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate)).map((pm) => el('tr', { class: pm.active ? '' : 'inactive' }, [
          el('td', {}, machineName(pm.machineId) || '—'),
          el('td', {}, pm.title),
          el('td', { class: 'nowrap' }, `${pm.intervalDays} days`),
          el('td', { class: 'nowrap' + (pm.nextDueDate < today ? ' overdue' : '') }, fmtDay(pm.nextDueDate)),
          el('td', { class: 'nowrap' }, pm.lastDoneDate ? fmtDay(pm.lastDoneDate) : '—'),
          el('td', {}, pm.assignedTo || '—'),
          el('td', {}, pm.active ? 'yes' : 'paused'),
          el('td', {}, isSupervisor() ? el('button', { class: 'ghost', onclick: () => openPmForm({ pm, onDone: refresh }) }, 'Edit') : null),
        ]))),
      ])) : el('div', { class: 'empty' }, 'No PM schedules yet. Add things like “Grease Press 2 — every 30 days”.'),
    ]),
  );
}

function openPmForm({ pm = null, onDone } = {}) {
  const techs = [...new Set([...state.users.map((u) => u.name), ...state.technicians])];
  openModal(pm ? 'Edit PM schedule' : 'New PM schedule', (close) => {
    const f = {
      title: el('input', { value: pm ? pm.title : '', placeholder: 'e.g. Grease bearings, change hydraulic filter' }),
      machine: el('input', { list: 'machine-list', value: pm ? machineName(pm.machineId) : '' }),
      intervalDays: el('input', { type: 'number', min: 1, value: pm ? pm.intervalDays : 30 }),
      leadDays: el('input', { type: 'number', min: 0, value: pm ? pm.leadDays : 3 }),
      nextDueDate: el('input', { type: 'date', value: pm ? pm.nextDueDate : localDate() }),
      priority: select(state.priorities, pm ? pm.priority : 'medium'),
      assignedTo: select([['', '— unassigned —'], ...techs.map((t) => [t, t])], pm ? pm.assignedTo : ''),
      active: select([['yes', 'Active'], ['no', 'Paused']], pm && !pm.active ? 'no' : 'yes'),
      description: el('textarea', { rows: 4, placeholder: 'Steps / checklist (copied into each work order)' }),
    };
    f.description.value = pm ? pm.description : '';
    const save = async () => {
      if (!f.title.value.trim()) return toast('Give the task a name');
      const body = {
        title: f.title.value.trim(), machineName: f.machine.value.trim(), intervalDays: Number(f.intervalDays.value),
        leadDays: Number(f.leadDays.value), nextDueDate: f.nextDueDate.value, priority: f.priority.value,
        assignedTo: f.assignedTo.value, active: f.active.value === 'yes', description: f.description.value,
      };
      try {
        if (pm) await api('/api/pm/' + pm.id, { method: 'PATCH', body });
        else await api('/api/pm', { method: 'POST', body });
        await reloadBootstrap();
        toast('PM saved');
        close(); onDone && onDone();
      } catch (err) { toast(err.message); }
    };
    return el('div', {}, [
      el('div', { class: 'grid-form' }, [
        field('Task', f.title), field('Machine', f.machine),
        field('Repeat every (days)', f.intervalDays, '7 weekly · 30 monthly · 90 quarterly'), field('Next due', f.nextDueDate),
        field('Create order this many days early', f.leadDays), field('Priority', f.priority),
        field('Assign to', f.assignedTo), field('Status', f.active),
      ]),
      field('Checklist / instructions', f.description),
      el('div', { class: 'row-end' }, [
        pm ? el('button', { class: 'danger ghost', onclick: async () => {
          if (!(await confirmDialog('Delete this PM schedule? Work orders it already made stay.'))) return;
          await api('/api/pm/' + pm.id, { method: 'DELETE' });
          close(); onDone && onDone();
        } }, 'Delete') : null,
        el('span', { class: 'spacer' }),
        el('button', { class: 'ghost', onclick: close }, 'Cancel'),
        el('button', { class: 'primary', onclick: save }, 'Save'),
      ]),
    ]);
  });
}
