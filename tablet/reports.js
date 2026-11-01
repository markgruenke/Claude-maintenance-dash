/* Reports: the end-of-day list (to re-enter into the company system) and the
   handoff report for the supervisor / next shift (done, still open, parts). */

import {
  mount, el, api, toast, state, copyText, fmtHours, fmtDay, localDate, addDays, badge, TZ,
} from './core.js';
import { openWorkOrder } from './orders.js';

const opts = { preset: 'today', from: '', to: '', tab: 'daily', technician: '' };

export function presetRange(preset, today = localDate()) {
  const dow = new Date(today + 'T12:00:00').getDay(); // 0 Sun … 6 Sat
  switch (preset) {
    case 'yesterday': return [addDays(today, -1), addDays(today, -1)];
    case 'weekend': { // Fri–Sun: this one if we're in it, else the last one
      const from = addDays(today, -((dow - 5 + 7) % 7));
      return [from, addDays(from, 2)];
    }
    case 'satsun': {
      const from = addDays(today, -((dow - 6 + 7) % 7));
      return [from, addDays(from, 1)];
    }
    case 'week': return [addDays(today, -6), today];
    default: return [today, today];
  }
}

export function applyRouteParams(params) {
  for (const k of Object.keys(opts)) if (params.has(k)) opts[k] = params.get(k);
}

export async function renderReports(root) {
  if (opts.preset !== 'custom') [opts.from, opts.to] = presetRange(opts.preset);
  if (!opts.from) [opts.from, opts.to] = presetRange('today');
  const refresh = () => renderReports(root);

  const r = await api(`/api/reports?from=${opts.from}&to=${opts.to}&technician=${encodeURIComponent(opts.technician)}&tz=${encodeURIComponent(TZ)}`);

  const presets = [['today', 'Today'], ['yesterday', 'Yesterday'], ['weekend', 'Weekend (Fri–Sun)'], ['satsun', 'Weekend (Sat–Sun)'], ['week', 'Last 7 days']];
  const fromIn = el('input', { type: 'date', value: opts.from, onchange: (e) => { opts.preset = 'custom'; opts.from = e.target.value; if (opts.to < opts.from) opts.to = opts.from; refresh(); } });
  const toIn = el('input', { type: 'date', value: opts.to, onchange: (e) => { opts.preset = 'custom'; opts.to = e.target.value; refresh(); } });
  const names = [...new Set([...state.users.map((u) => u.name), ...state.technicians])];
  const techSel = el('select', { onchange: (e) => { opts.technician = e.target.value; refresh(); } },
    [el('option', { value: '' }, 'Everyone'), ...names.map((n) => el('option', { value: n }, n))]);
  techSel.value = opts.technician;

  const period = r.from === r.to ? fmtDay(r.from, { year: 'numeric' }) : `${fmtDay(r.from)} – ${fmtDay(r.to, { year: 'numeric' })}`;

  mount(root, 
    el('div', { class: 'view-head no-print' }, [el('h2', {}, 'Reports')]),
    el('div', { class: 'filters no-print' }, [
      el('div', { class: 'seg' }, presets.map(([v, label]) => el('button', {
        class: opts.preset === v ? 'on' : '', onclick: () => { opts.preset = v; refresh(); },
      }, label))),
      fromIn, el('span', { class: 'muted' }, 'to'), toIn,
      techSel,
    ]),
    el('div', { class: 'tabs-row no-print' }, [
      el('button', { class: 'tab' + (opts.tab === 'daily' ? ' on' : ''), onclick: () => { opts.tab = 'daily'; refresh(); } }, 'Work list (for company system)'),
      el('button', { class: 'tab' + (opts.tab === 'handoff' ? ' on' : ''), onclick: () => { opts.tab = 'handoff'; refresh(); } }, 'Handoff report (supervisor / next shift)'),
    ]),
    opts.tab === 'daily' ? dailyView(r, period, refresh) : handoffView(r, period, refresh),
  );
}

function kpi(label, value, cls = '') {
  return el('div', { class: 'tile' }, [el('div', { class: 'label' }, label), el('div', { class: 'value ' + cls }, String(value))]);
}

function dailyView(r, period, refresh) {
  const entries = r.entries;
  const entered = entries.filter((e) => e.entered).length;
  const entryText = (e) => [
    [e.clock, e.machineName, e.minutes ? fmtHours(e.minutes) : '', e.workOrderLabel].filter(Boolean).join(' — '),
    e.notes,
    e.partsUsed.length ? 'Parts used: ' + e.partsUsed.join(', ') : '',
    e.partsNeeded.length ? 'Parts needed: ' + e.partsNeeded.join(', ') : '',
  ].filter(Boolean).join('\n');

  let lastDate = '';
  const rows = [];
  for (const e of entries) {
    if (r.from !== r.to && e.date !== lastDate) {
      rows.push(el('tr', { class: 'day-row' }, el('td', { colspan: 7 }, fmtDay(e.date))));
      lastDate = e.date;
    }
    rows.push(el('tr', { class: e.entered ? 'is-entered' : '' }, [
      el('td', { class: 'no-print' }, el('input', {
        type: 'checkbox', checked: e.entered, 'aria-label': 'Entered in company system',
        onchange: async (ev) => {
          try { await api(`/api/work-logs/${e.id}`, { method: 'PATCH', body: { entered: ev.target.checked } }); refresh(); }
          catch (err) { toast(err.message); }
        },
      })),
      el('td', { class: 'nowrap' }, e.clock),
      el('td', {}, [e.machineName || '—', e.workOrderLabel ? el('div', { class: 'muted small' }, e.workOrderLabel) : null]),
      el('td', {}, [
        el('div', { class: 'pre' }, e.notes),
        e.partsUsed.length ? el('div', { class: 'muted small' }, 'Used: ' + e.partsUsed.join(', ')) : null,
        e.partsNeeded.length ? el('div', { class: 'muted small' }, 'Needed: ' + e.partsNeeded.join(', ')) : null,
      ]),
      el('td', {}, e.technician),
      el('td', { class: 'num nowrap' }, e.minutes ? fmtHours(e.minutes) : '—'),
      el('td', { class: 'no-print' }, el('button', { class: 'ghost', onclick: () => copyText(entryText(e)) }, 'Copy')),
    ]));
  }

  return el('div', { class: 'report' }, [
    el('div', { class: 'report-title' }, [
      el('h2', {}, `Work list — ${period}${r.technician ? ' — ' + r.technician : ''}`),
      el('span', { class: 'spacer' }),
      el('button', { class: 'no-print', onclick: () => copyText(r.dailyText) }, 'Copy all as text'),
      el('button', { class: 'no-print', onclick: () => window.print() }, 'Print'),
    ]),
    el('div', { class: 'kpis small-kpis' }, [
      kpi('Time logged', fmtHours(r.totals.minutes)),
      kpi('Entries', r.totals.entries),
      kpi('Entered in company system', `${entered} / ${entries.length}`, entries.length && entered === entries.length ? 'good' : ''),
    ]),
    el('div', { class: 'card flush' }, entries.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'data' }, [
      el('thead', {}, el('tr', {}, [el('th', { class: 'no-print' }, '✓'), el('th', {}, 'Time'), el('th', {}, 'Machine'), el('th', {}, 'Work done'), el('th', {}, 'Tech'), el('th', { class: 'num' }, 'Spent'), el('th', { class: 'no-print' }, '')])),
      el('tbody', {}, rows),
    ])) : el('div', { class: 'empty' }, 'No work logged in this period.')),
  ]);
}

function orderList(list, { showLast = true, showParts = true, refresh }) {
  if (!list.length) return el('p', { class: 'muted' }, 'None.');
  return el('ul', { class: 'rlist' }, list.map((o) => el('li', {}, [
    el('div', {}, [
      el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); openWorkOrder(o.id, refresh); } }, o.label),
      ' ', el('strong', {}, o.machineName ? o.machineName + ' — ' : ''), o.title, ' ',
      badge(o.status), ['urgent', 'high'].includes(o.priority) ? badge(o.priority, o.priority) : null,
      o.minutes ? el('span', { class: 'muted' }, ' · ' + fmtHours(o.minutes)) : null,
      o.dueDate ? el('span', { class: 'muted' }, ' · due ' + fmtDay(o.dueDate)) : null,
      o.assignedTo ? el('span', { class: 'muted' }, ' · ' + o.assignedTo) : null,
    ]),
    showLast && o.lastNote ? el('div', { class: 'muted pre' }, o.lastNote) : null,
    showParts && o.partsOutstanding.length ? el('div', { class: 'small' }, 'Needs: ' + o.partsOutstanding.map((p) => `${p.line} [${p.status}]`).join(', ')) : null,
  ])));
}

function partList(list) {
  return el('ul', { class: 'rlist' }, list.map((p) => el('li', {}, [
    el('strong', {}, p.line), p.machineName ? ` — ${p.machineName}` : '', p.workOrderLabel ? el('span', { class: 'muted' }, ` (${p.workOrderLabel})`) : null,
    p.vendor ? el('span', { class: 'muted' }, ` · ${p.vendor}`) : null,
  ])));
}

function handoffView(r, period, refresh) {
  const note = el('textarea', { rows: 4, placeholder: 'Anything the supervisor or day shift should know: safety issues, machines left locked out, what to start on first, who to call…' });
  note.value = r.note || '';
  const status = el('span', { class: 'muted small' }, r.noteUpdatedAt ? `Saved${r.noteBy ? ' by ' + r.noteBy : ''}` : '');
  let saveTimer;
  const saveNote = async () => {
    try {
      await api('/api/reports/notes', { method: 'PUT', body: { key: r.key, text: note.value } });
      status.textContent = 'Saved';
      r.note = note.value;
    } catch (err) { status.textContent = 'Not saved: ' + err.message; }
  };
  note.addEventListener('input', () => { status.textContent = 'Typing…'; clearTimeout(saveTimer); saveTimer = setTimeout(saveNote, 800); });

  const freshText = async () => {
    clearTimeout(saveTimer);
    if (note.value !== (r.note || '')) await saveNote();
    const again = await api(`/api/reports?from=${r.from}&to=${r.to}&technician=${encodeURIComponent(r.technician)}&tz=${encodeURIComponent(TZ)}`);
    return again.handoffText;
  };
  const emailIt = async () => {
    const text = await freshText();
    const subject = `Maintenance report — ${period}`;
    // Long mailto: links get cut off by some mail apps, so copy first and
    // only put the body in the link when it's short.
    await copyText(text);
    const body = text.length < 1800 ? text : '(Report copied to clipboard — paste it here.)\n';
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  const section = (title, content, count) => el('section', { class: 'rsec' }, [el('h3', {}, count !== undefined ? `${title} (${count})` : title), content]);

  return el('div', { class: 'report' }, [
    el('div', { class: 'report-title' }, [
      el('h2', {}, `Maintenance report — ${period}${r.technician ? ' — ' + r.technician : ''}`),
      el('span', { class: 'spacer' }),
      el('button', { class: 'no-print', onclick: async () => copyText(await freshText()) }, 'Copy as text'),
      el('button', { class: 'no-print', onclick: emailIt }, 'Email'),
      el('button', { class: 'no-print', onclick: () => window.print() }, 'Print / PDF'),
    ]),
    el('div', { class: 'kpis small-kpis' }, [
      kpi('Time logged', fmtHours(r.totals.minutes)),
      kpi('Jobs worked', r.totals.orders),
      kpi('Completed', r.totals.completed, r.totals.completed ? 'good' : ''),
      kpi('New orders', r.totals.openedInRange),
      kpi('Parts to order', r.partsNeeded.length),
    ]),
    el('div', { class: 'card' }, [
      el('h3', {}, ['Notes for supervisor / next shift ', status]),
      el('div', { class: 'no-print' }, note),
      el('div', { class: 'print-only pre' }, r.note || '(none)'),
    ]),
    el('div', { class: 'card' }, [
      section('Completed', orderList(r.completed, { showParts: false, refresh }), r.completed.length),
      section('Still open — worked on this period', orderList(r.workedOpen, { refresh }), r.workedOpen.length),
      r.misc.length ? section('Other work (no work order)', el('ul', { class: 'rlist' }, r.misc.map((e) => el('li', {}, `${fmtDay(e.date)} · ${fmtHours(e.minutes)} · ${e.notes}`)))) : null,
    ]),
    el('div', { class: 'card' }, [
      el('h3', {}, 'Parts'),
      !r.partsNeeded.length && !r.partsOrdered.length && !r.partsReceived.length ? el('p', { class: 'muted' }, 'Nothing outstanding.') : null,
      r.partsNeeded.length ? el('div', {}, [el('h4', {}, `Need to order (${r.partsNeeded.length})`), partList(r.partsNeeded)]) : null,
      r.partsOrdered.length ? el('div', {}, [el('h4', {}, `On order (${r.partsOrdered.length})`), partList(r.partsOrdered)]) : null,
      r.partsReceived.length ? el('div', {}, [el('h4', {}, `Received, not installed (${r.partsReceived.length})`), partList(r.partsReceived)]) : null,
      r.partsUsed.length ? el('p', { class: 'small' }, 'Used this period: ' + r.partsUsed.map((p) => p.line).join(', ')) : null,
    ]),
    el('div', { class: 'card' }, [
      section('Other open work orders', orderList(r.backlog, { showLast: false, refresh }), r.backlog.length),
    ]),
    r.pmDue.length ? el('div', { class: 'card' }, [
      section('Preventive maintenance due soon', el('ul', { class: 'rlist' }, r.pmDue.map((pm) => el('li', {}, `${fmtDay(pm.nextDueDate)} — ${pm.machineName ? pm.machineName + ' — ' : ''}${pm.title}`)))),
    ]) : null,
    r.flags.length ? el('div', { class: 'card' }, [
      section('Watch list', el('ul', { class: 'rlist' }, r.flags.slice(0, 10).map((f) => el('li', { class: 'flag-li ' + f.severity }, f.message)))),
    ]) : null,
  ]);
}
