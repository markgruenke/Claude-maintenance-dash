'use strict';
/**
 * Shift reports: the end-of-day work list (for re-entering into the company
 * system) and the handoff report (what got done, what's still open, what
 * parts we need). Built server-side so the same data can later be emailed
 * on a schedule; the UI renders the structured data and offers `text` for
 * copy/paste.
 */

const store = require('./store');
const analytics = require('./analytics');

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };

/** ISO timestamp -> "YYYY-MM-DD" in the viewer's time zone (falls back to server's). */
function dateIn(iso, tz) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch { /* bad tz name: fall through */ }
  }
  return store.localDate(d);
}

/** ISO timestamp -> "7:42 AM" in the viewer's time zone. */
function clockIn(iso, tz) {
  const opts = { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) };
  try { return new Date(iso).toLocaleTimeString('en-US', opts); } catch { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
}

const inRange = (date, from, to) => !!date && date >= from && date <= to;

function fmtHours(minutes) {
  if (!minutes) return '0 h';
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

function fmtDay(dateStr, withYear = false) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}),
  });
}

function woLabel(wo) {
  if (!wo) return '';
  return wo.orderNumber ? `WO#${wo.orderNumber}` : `M-${wo.ref}`;
}

function machineName(id) {
  const m = id ? store.findMachine(id) : null;
  return m ? m.name : '';
}

function partLine(p) {
  return `${p.name}${p.partNumber ? ` (${p.partNumber})` : ''}${p.quantity > 1 ? ` ×${p.quantity}` : ''}`;
}

/**
 * @param {{from: string, to: string, technician?: string, tz?: string}} opts
 */
function buildReport({ from, to, technician = '', tz = '' }) {
  if (!store.isDateStr(from)) from = store.localDate();
  if (!store.isDateStr(to) || to < from) to = from;

  const allLogs = store.listWorkLogs();
  const logs = allLogs
    .filter((l) => inRange(l.date, from, to))
    .filter((l) => !technician || l.technician === technician)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.startedAt || a.createdAt).localeCompare(b.startedAt || b.createdAt));

  const parts = store.listParts();
  const partsByLog = new Map();
  for (const p of parts) {
    if (!p.logId) continue;
    if (!partsByLog.has(p.logId)) partsByLog.set(p.logId, []);
    partsByLog.get(p.logId).push(p);
  }

  // ---- entries: one per work-log line, in order (end-of-day list)
  const entries = logs.map((l) => {
    const wo = l.workOrderId ? store.findWorkOrder(l.workOrderId) : null;
    const lp = partsByLog.get(l.id) || [];
    return {
      id: l.id,
      date: l.date,
      technician: l.technician,
      minutes: l.minutes,
      loggedAt: l.createdAt,
      clock: clockIn(l.createdAt, tz),
      running: !!l.running,
      notes: l.notes,
      entered: !!l.entered,
      machineName: machineName(l.machineId || (wo && wo.machineId)),
      workOrderId: wo ? wo.id : null,
      workOrderLabel: woLabel(wo),
      orderNumber: wo ? wo.orderNumber : '',
      workOrderTitle: wo ? wo.title : '',
      workOrderStatus: wo ? wo.status : null,
      partsUsed: lp.filter((p) => p.status === 'installed').map(partLine),
      partsNeeded: lp.filter((p) => p.status !== 'installed').map(partLine),
    };
  });

  // ---- per work order rollup
  const byOrder = new Map();
  for (const e of entries) {
    const key = e.workOrderId || 'none:' + e.id;
    if (!byOrder.has(key)) byOrder.set(key, { workOrderId: e.workOrderId, entries: [], minutes: 0 });
    const g = byOrder.get(key);
    g.entries.push(e);
    g.minutes += e.minutes;
  }

  const orderSummary = (wo, group) => {
    const orderParts = parts.filter((p) => p.workOrderId === wo.id);
    return {
      id: wo.id,
      label: woLabel(wo),
      ref: wo.ref,
      orderNumber: wo.orderNumber,
      title: wo.title,
      machineName: machineName(wo.machineId),
      status: wo.status,
      priority: wo.priority,
      assignedTo: wo.assignedTo,
      dueDate: wo.dueDate,
      createdAt: wo.createdAt,
      minutes: group ? group.minutes : 0,
      lastNote: group ? group.entries[group.entries.length - 1].notes : '',
      partsOutstanding: orderParts.filter((p) => ['needed', 'ordered', 'received'].includes(p.status))
        .map((p) => ({ ...p, line: partLine(p) })),
    };
  };

  const orders = store.listWorkOrders();
  const touchedIds = new Set([...byOrder.values()].map((g) => g.workOrderId).filter(Boolean));
  const completedInRange = orders.filter((w) => w.status === 'completed'
    && (inRange(dateIn(w.completedAt, tz), from, to) && (touchedIds.has(w.id) || !technician)));
  const completedIds = new Set(completedInRange.map((w) => w.id));

  const completed = completedInRange.map((w) => orderSummary(w, byOrder.get(w.id)));
  const workedOpen = orders
    .filter((w) => touchedIds.has(w.id) && !store.CLOSED.includes(w.status))
    .map((w) => orderSummary(w, byOrder.get(w.id)))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const backlog = orders
    .filter((w) => !touchedIds.has(w.id) && !store.CLOSED.includes(w.status))
    .map((w) => orderSummary(w, null))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'))
      || a.createdAt.localeCompare(b.createdAt));
  const openedInRange = orders.filter((w) => inRange(dateIn(w.createdAt, tz), from, to)).length;

  // Unlinked work (logged without a machine/order) still has to show up.
  const misc = [...byOrder.values()].filter((g) => !g.workOrderId).flatMap((g) => g.entries);

  // ---- parts
  const withContext = (p) => {
    const wo = p.workOrderId ? store.findWorkOrder(p.workOrderId) : null;
    return { ...p, line: partLine(p), machineName: machineName(p.machineId), workOrderLabel: woLabel(wo) };
  };
  const partsNeeded = parts.filter((p) => p.status === 'needed').map(withContext);
  const partsOrdered = parts.filter((p) => p.status === 'ordered').map(withContext);
  const partsReceived = parts.filter((p) => p.status === 'received').map(withContext);
  const partsUsed = parts.filter((p) => p.status === 'installed' && inRange(dateIn(p.installedAt || p.createdAt, tz), from, to)
    && (!technician || !p.logId || logs.some((l) => l.id === p.logId))).map(withContext);

  // ---- upcoming PM (next 7 days after the period)
  const pmHorizon = store.addDays(to, 7);
  const pmDue = store.listPmSchedules()
    .filter((pm) => pm.active && pm.nextDueDate <= pmHorizon)
    .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate))
    .map((pm) => ({ ...pm, machineName: machineName(pm.machineId) }));

  const totalMinutes = logs.reduce((s, l) => s + l.minutes, 0);
  const key = `${from}_${to}`;
  const note = store.getReportNote(key);

  const report = {
    from, to, technician, key,
    generatedAt: new Date().toISOString(),
    totals: {
      minutes: totalMinutes,
      entries: logs.length,
      orders: touchedIds.size,
      completed: completedIds.size,
      openedInRange,
      machines: new Set(entries.map((e) => e.machineName).filter(Boolean)).size,
      notEntered: entries.filter((e) => !e.entered).length,
    },
    entries, completed, workedOpen, backlog, misc,
    partsNeeded, partsOrdered, partsReceived, partsUsed, pmDue,
    flags: analytics.computeFlags(),
    note: note ? note.text : '',
    noteBy: note ? note.by : '',
    noteUpdatedAt: note ? note.updatedAt : null,
  };
  report.dailyText = dailyText(report);
  report.handoffText = handoffText(report);
  return report;
}

// ----------------------------------------------------------------- text

function wrapNote(text, indent = '   ') {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => indent + l).join('\n');
}

function periodLabel(r) {
  return r.from === r.to ? fmtDay(r.from, true) : `${fmtDay(r.from)} – ${fmtDay(r.to, true)}`;
}

/** End-of-day list: every entry, in order, ready to retype into the company system. */
function dailyText(r) {
  const lines = [];
  lines.push(`WORK LOG — ${periodLabel(r)}${r.technician ? ' — ' + r.technician : ''}`);
  lines.push(`${r.totals.entries} entr${r.totals.entries === 1 ? 'y' : 'ies'}${r.totals.minutes ? `, ${fmtHours(r.totals.minutes)} total` : ''}`);
  lines.push('');
  let lastDate = '';
  r.entries.forEach((e, i) => {
    if (r.from !== r.to && e.date !== lastDate) {
      lines.push(`— ${fmtDay(e.date)} —`);
      lastDate = e.date;
    }
    const head = [e.clock, e.machineName || 'General', e.minutes ? fmtHours(e.minutes) : '', e.orderNumber ? 'WO#' + e.orderNumber : '']
      .filter(Boolean).join(' — ');
    lines.push(`${i + 1}. ${head}${!r.technician && e.technician ? ` (${e.technician})` : ''}`);
    if (e.notes) lines.push(wrapNote(e.notes));
    if (e.partsUsed.length) lines.push(`   Parts used: ${e.partsUsed.join(', ')}`);
    if (e.partsNeeded.length) lines.push(`   Parts needed: ${e.partsNeeded.join(', ')}`);
    lines.push('');
  });
  if (!r.entries.length) lines.push('(no work logged)');
  return lines.join('\n').trimEnd() + '\n';
}

/** Handoff report for the supervisor and the next shift. */
function handoffText(r) {
  const L = [];
  const statusWord = (s) => ({ waiting_parts: 'WAITING ON PARTS', in_progress: 'IN PROGRESS', open: 'OPEN' }[s] || s.toUpperCase());
  const orderHead = (o) => `${o.machineName ? o.machineName + ' — ' : ''}${o.title} (${o.label})`;

  L.push(`MAINTENANCE REPORT — ${periodLabel(r)}${r.technician ? ' — ' + r.technician : ''}`);
  L.push(`Time logged: ${fmtHours(r.totals.minutes)}  |  Jobs worked: ${r.totals.orders}  |  Completed: ${r.totals.completed}  |  New orders: ${r.totals.openedInRange}`);
  L.push('');

  if (r.note && r.note.trim()) {
    L.push('NOTES FOR SUPERVISOR / NEXT SHIFT');
    L.push(wrapNote(r.note, '  '));
    L.push('');
  }

  L.push(`COMPLETED (${r.completed.length})`);
  if (!r.completed.length) L.push('  (none)');
  for (const o of r.completed) {
    L.push(`• ${orderHead(o)}${o.minutes ? ' — ' + fmtHours(o.minutes) : ''}`);
    if (o.lastNote) L.push(wrapNote(o.lastNote, '    '));
  }
  L.push('');

  L.push(`STILL OPEN — WORKED ON THIS PERIOD (${r.workedOpen.length})`);
  if (!r.workedOpen.length) L.push('  (none)');
  for (const o of r.workedOpen) {
    L.push(`• ${orderHead(o)} — ${statusWord(o.status)}${o.minutes ? ' — ' + fmtHours(o.minutes) : ''}`);
    if (o.lastNote) L.push(wrapNote('Last: ' + o.lastNote, '    '));
    if (o.partsOutstanding.length) {
      L.push('    Needs: ' + o.partsOutstanding.map((p) => `${p.line} [${p.status}]`).join(', '));
    }
  }
  L.push('');

  if (r.misc.length) {
    L.push('OTHER WORK (not tied to a work order)');
    for (const e of r.misc) L.push(`• ${fmtDay(e.date)} — ${fmtHours(e.minutes)} — ${String(e.notes).split('\n')[0]}`);
    L.push('');
  }

  const partBlock = (title, list) => {
    if (!list.length) return;
    L.push(title);
    for (const p of list) {
      L.push(`  • ${p.line}${p.machineName ? ' — ' + p.machineName : ''}${p.workOrderLabel ? ' (' + p.workOrderLabel + ')' : ''}${p.vendor ? ' — ' + p.vendor : ''}`);
    }
  };
  L.push('PARTS');
  if (!r.partsNeeded.length && !r.partsOrdered.length && !r.partsReceived.length) L.push('  Nothing outstanding.');
  partBlock(` Need to order (${r.partsNeeded.length}):`, r.partsNeeded);
  partBlock(` On order (${r.partsOrdered.length}):`, r.partsOrdered);
  partBlock(` Received, not installed yet (${r.partsReceived.length}):`, r.partsReceived);
  if (r.partsUsed.length) L.push(` Used this period: ${r.partsUsed.map((p) => p.line).join(', ')}`);
  L.push('');

  L.push(`OTHER OPEN WORK ORDERS (${r.backlog.length})`);
  if (!r.backlog.length) L.push('  (none)');
  for (const o of r.backlog.slice(0, 40)) {
    const tags = [o.priority === 'urgent' || o.priority === 'high' ? o.priority.toUpperCase() : '',
      o.status === 'waiting_parts' ? 'waiting on parts' : '',
      o.dueDate ? 'due ' + fmtDay(o.dueDate) : '',
      o.assignedTo ? '→ ' + o.assignedTo : ''].filter(Boolean).join(', ');
    L.push(`• ${orderHead(o)}${tags ? ' — ' + tags : ''}`);
  }
  if (r.backlog.length > 40) L.push(`  …and ${r.backlog.length - 40} more`);
  L.push('');

  if (r.pmDue.length) {
    L.push('PREVENTIVE MAINTENANCE DUE SOON');
    for (const pm of r.pmDue) L.push(`• ${fmtDay(pm.nextDueDate)} — ${pm.machineName ? pm.machineName + ' — ' : ''}${pm.title}`);
    L.push('');
  }

  if (r.flags.length) {
    L.push('WATCH LIST');
    for (const f of r.flags.slice(0, 10)) L.push(`• ${f.message}`);
    L.push('');
  }

  return L.join('\n').trimEnd() + '\n';
}

module.exports = { buildReport, dateIn, fmtHours };
