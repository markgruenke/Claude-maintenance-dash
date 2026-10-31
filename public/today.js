/* "Today" — the tablet screen. Log work as you go, run job timers, and see
   the day's list (with "entered in company system" check-offs). */

import {
  mount, el, api, toast, state, isSupervisor, fmtHours, fmtElapsed, fmtTime, fmtDay, localDate,
  machineName, woLabel, badge, confirmDialog, copyText,
} from './core.js';
import { openLogForm, openNotesForm, currentWorker } from './logform.js';
import { openWorkOrder } from './orders.js';

let tickTimer = null;
let viewDate = localDate();

export async function renderToday(root) {
  const worker = currentWorker();
  const [logs, running, report, openOrders] = await Promise.all([
    api(`/api/work-logs?from=${viewDate}&to=${viewDate}&technician=${encodeURIComponent(worker)}`),
    api(`/api/work-logs?running=1&technician=${encodeURIComponent(worker)}`),
    api(`/api/reports?from=${viewDate}&to=${viewDate}&technician=${encodeURIComponent(worker)}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || '')}`),
    api('/api/work-orders?status=open'),
  ]);
  const refresh = () => renderToday(root);
  const done = logs.filter((l) => !l.running);
  const total = done.reduce((s, l) => s + l.minutes, 0);
  const mine = openOrders.filter((w) => w.assignedTo === worker)
    .sort((a, b) => ({ urgent: 0, high: 1, medium: 2, low: 3 }[a.priority] - { urgent: 0, high: 1, medium: 2, low: 3 }[b.priority]));
  const unassigned = openOrders.filter((w) => !w.assignedTo);

  // ---- header: date + who
  const dateInput = el('input', { type: 'date', value: viewDate, onchange: (e) => { viewDate = e.target.value || localDate(); refresh(); } });
  const whoBox = isSupervisor()
    ? el('label', { class: 'inline-fld' }, ['Logging as ', (() => {
      const names = [...new Set([state.me.name, ...state.users.map((u) => u.name), ...state.technicians])];
      const s = el('select', { onchange: (e) => { try { localStorage.setItem('mt_worker', e.target.value); } catch { /* */ } refresh(); } },
        names.map((n) => el('option', { value: n }, n)));
      s.value = worker;
      return s;
    })()])
    : el('span', { class: 'muted' }, worker);

  // ---- running timers
  const timerCards = running.map((l) => {
    const wo = openOrders.find((w) => w.id === l.workOrderId);
    const clock = el('span', { class: 'clock', 'data-start': l.startedAt }, fmtElapsed(Date.now() - Date.parse(l.startedAt)));
    return el('div', { class: 'timer-card' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'tc-title' }, [machineName(l.machineId) || 'Job', wo ? ` — ${wo.title}` : '']),
        el('div', { class: 'muted' }, [`Started ${fmtTime(l.startedAt)}`, l.date !== localDate() ? ` on ${fmtDay(l.date)}` : '', l.notes ? ` · ${l.notes}` : '']),
      ]),
      clock,
      el('button', { class: 'primary big', onclick: () => openLogForm({ mode: 'stop', log: l, onDone: refresh }) }, '■ Stop & log'),
    ]);
  });

  // ---- entry cards
  const entryCards = report.entries.filter((e) => !e.running).map((e) => {
    const log = logs.find((l) => l.id === e.id);
    const check = el('input', {
      type: 'checkbox', checked: e.entered,
      onchange: async (ev) => {
        try { await api(`/api/work-logs/${e.id}`, { method: 'PATCH', body: { entered: ev.target.checked } }); refresh(); }
        catch (err) { toast(err.message); ev.target.checked = !ev.target.checked; }
      },
    });
    return el('div', { class: 'entry' + (e.entered ? ' is-entered' : '') }, [
      el('div', { class: 'entry-main' }, [
        el('div', { class: 'entry-head' }, [
          el('strong', {}, e.machineName || 'General'),
          e.workOrderLabel ? el('a', { href: '#', class: 'wo-link', onclick: (ev) => { ev.preventDefault(); openWorkOrder(e.workOrderId, refresh); } }, `${e.workOrderLabel} — ${e.workOrderTitle}`) : null,
          e.workOrderStatus ? badge(e.workOrderStatus) : null,
          el('span', { class: 'spacer' }),
          el('span', { class: 'hours' }, fmtHours(e.minutes)),
        ]),
        el('div', { class: 'entry-notes' }, e.notes),
        e.partsUsed.length ? el('div', { class: 'muted small' }, 'Parts used: ' + e.partsUsed.join(', ')) : null,
        e.partsNeeded.length ? el('div', { class: 'muted small' }, 'Parts needed: ' + e.partsNeeded.join(', ')) : null,
      ]),
      el('div', { class: 'entry-actions' }, [
        el('label', { class: 'entered', title: 'Tick once it is in the company system' }, [check, ' Entered']),
        el('button', { class: 'ghost', onclick: () => openLogForm({ mode: 'edit', log, onDone: refresh }) }, 'Edit'),
        el('button', { class: 'ghost', onclick: async () => {
          if (!(await confirmDialog('Delete this entry? Parts it added stay on the parts list.'))) return;
          await api(`/api/work-logs/${e.id}`, { method: 'DELETE' });
          toast('Entry deleted');
          refresh();
        } }, 'Delete'),
      ]),
    ]);
  });

  const notEntered = report.entries.filter((e) => !e.running && !e.entered).length;

  mount(root, 
    el('div', { class: 'today-head' }, [
      el('h2', {}, viewDate === localDate() ? 'Today' : fmtDay(viewDate)),
      dateInput,
      el('span', { class: 'spacer' }),
      whoBox,
    ]),
    el('div', { class: 'big-actions' }, [
      el('button', { class: 'primary huge', onclick: () => openLogForm({ mode: 'log', date: viewDate, onDone: refresh }) }, [el('span', { class: 'ico' }, '+'), 'Log work']),
      el('button', { class: 'huge', onclick: () => openLogForm({ mode: 'start', date: viewDate, onDone: refresh }) }, [el('span', { class: 'ico' }, '▶'), 'Start job timer']),
      el('button', { class: 'huge', onclick: () => openNotesForm({ date: viewDate, onDone: refresh }) }, [el('span', { class: 'ico' }, '✎'), 'Paste notes']),
    ]),
    timerCards.length ? el('div', { class: 'timers' }, timerCards) : null,
    el('div', { class: 'kpis small-kpis' }, [
      kpi('Time logged', fmtHours(total)),
      kpi('Entries', done.length),
      kpi('Not yet entered', notEntered, notEntered ? '' : 'good'),
      kpi('My open jobs', mine.length),
    ]),
    el('div', { class: 'card' }, [
      el('h2', {}, [
        'Work list',
        el('span', { class: 'spacer' }),
        el('button', { class: 'ghost', onclick: () => copyText(report.dailyText) }, 'Copy list'),
        el('a', { class: 'btn ghost', href: `#reports?preset=custom&from=${viewDate}&to=${viewDate}&tab=daily&technician=${encodeURIComponent(worker)}` }, 'End-of-day view →'),
      ]),
      el('p', { class: 'desc' }, 'Tick “Entered” as you put each one into the company system.'),
      entryCards.length ? el('div', { class: 'entries' }, entryCards) : el('div', { class: 'empty' }, 'Nothing logged yet. Tap “Log work” when you finish something.'),
    ]),
    el('div', { class: 'card' }, [
      el('h2', {}, `My open work orders (${mine.length})`),
      el('p', { class: 'desc' }, 'Assigned to ' + worker + (unassigned.length ? ` · ${unassigned.length} unassigned order${unassigned.length === 1 ? '' : 's'} in Work Orders` : '')),
      mine.length ? el('div', { class: 'wo-list' }, mine.map((w) => el('div', { class: 'wo-row' }, [
        el('div', { class: 'grow', onclick: () => openWorkOrder(w.id, refresh) }, [
          el('div', {}, [el('strong', {}, machineName(w.machineId) || '—'), ' ', w.title]),
          el('div', { class: 'muted small' }, [woLabel(w), w.dueDate ? ` · due ${fmtDay(w.dueDate)}` : '']),
        ]),
        badge(w.priority, w.priority),
        badge(w.status),
        el('button', { onclick: () => openLogForm({ mode: 'log', workOrder: w, date: viewDate, onDone: refresh }) }, 'Log'),
        el('button', { onclick: () => openLogForm({ mode: 'start', workOrder: w, date: viewDate, onDone: refresh }) }, '▶'),
      ]))) : el('div', { class: 'empty' }, 'Nothing assigned to you right now.'),
    ]),
  );

  clearInterval(tickTimer);
  if (running.length) {
    tickTimer = setInterval(() => {
      document.querySelectorAll('.clock[data-start]').forEach((c) => {
        c.textContent = fmtElapsed(Date.now() - Date.parse(c.dataset.start));
      });
    }, 15000);
  }
}

function kpi(label, value, cls = '') {
  return el('div', { class: 'tile' }, [el('div', { class: 'label' }, label), el('div', { class: 'value ' + cls }, String(value))]);
}
