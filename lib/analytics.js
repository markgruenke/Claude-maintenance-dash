'use strict';
/**
 * Analytics computed over the store on demand. Everything here is derived —
 * no state of its own — so it is always consistent with the records.
 */

const store = require('./store');

const DAY_MS = 24 * 60 * 60 * 1000;

// Tunable thresholds for the attention flags.
const FLAG_RULES = {
  frequentBreakdownCount: 3,   // >= N work orders ...
  frequentBreakdownDays: 30,   // ... within this window => flag
  repeatIssueDays: 60,         // similar issue on same machine within window
  staleOrderDays: 14,          // open order older than this => flag
  partOverdueDays: 7,          // part still "needed" after this => flag
};

function within(dateStr, from, to) {
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return false;
  if (from && t < from.getTime()) return false;
  if (to && t > to.getTime()) return false;
  return true;
}

/** Words that carry meaning when comparing two issue descriptions. */
const STOPWORDS = new Set(('the a an is was on at in of to for and or with again still keeps ' +
  'not wont won t it its this that machine issue problem work order down broken').split(' '));

function issueKeywords(wo) {
  const text = (wo.title + ' ' + wo.description).toLowerCase();
  const words = text.match(/[a-z][a-z0-9-]{2,}/g) || [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

function keywordOverlap(a, b) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const smaller = Math.min(a.size, b.size) || 1;
  return { shared, ratio: shared / smaller };
}

/**
 * Attention flags, most severe first. Severity uses the status vocabulary
 * (warning / serious / critical) so the UI can map straight to status colors.
 */
function computeFlags() {
  const flags = [];
  const nowMs = Date.now();
  const orders = store.listWorkOrders().filter((w) => w.status !== 'cancelled');
  const machines = store.listMachines();
  const byMachine = new Map(machines.map((m) => [m.id, []]));
  for (const wo of orders) {
    if (wo.machineId && byMachine.has(wo.machineId)) byMachine.get(wo.machineId).push(wo);
  }

  for (const machine of machines) {
    const list = byMachine.get(machine.id) || [];

    // Frequent breakdowns: N+ orders opened inside the rolling window.
    const recent = list.filter((wo) => nowMs - new Date(wo.createdAt).getTime() <= FLAG_RULES.frequentBreakdownDays * DAY_MS);
    if (recent.length >= FLAG_RULES.frequentBreakdownCount) {
      flags.push({
        type: 'frequent_breakdowns',
        severity: recent.length >= FLAG_RULES.frequentBreakdownCount + 2 ? 'critical' : 'serious',
        machineId: machine.id,
        machineName: machine.name,
        message: `${machine.name}: ${recent.length} work orders in the last ${FLAG_RULES.frequentBreakdownDays} days`,
        workOrderIds: recent.map((w) => w.id),
      });
    }

    // Repeat issue: two orders on the same machine whose descriptions share
    // enough keywords, within the window. Cheap heuristic, works well for
    // notes like "conveyor belt slipping" recurring.
    const windowed = list
      .filter((wo) => nowMs - new Date(wo.createdAt).getTime() <= FLAG_RULES.repeatIssueDays * DAY_MS)
      .map((wo) => ({ wo, kw: issueKeywords(wo) }));
    outer:
    for (let i = 0; i < windowed.length; i++) {
      for (let j = i + 1; j < windowed.length; j++) {
        const { shared, ratio } = keywordOverlap(windowed[i].kw, windowed[j].kw);
        if (shared >= 2 && ratio >= 0.5) {
          flags.push({
            type: 'repeat_issue',
            severity: 'warning',
            machineId: machine.id,
            machineName: machine.name,
            message: `${machine.name}: possible repeat issue — "${windowed[i].wo.title}" and "${windowed[j].wo.title}"`,
            workOrderIds: [windowed[i].wo.id, windowed[j].wo.id],
          });
          break outer; // one repeat-issue flag per machine is enough noise
        }
      }
    }
  }

  // Stale open orders.
  for (const wo of orders) {
    if (['completed', 'cancelled'].includes(wo.status)) continue;
    const ageDays = Math.floor((nowMs - new Date(wo.createdAt).getTime()) / DAY_MS);
    if (ageDays >= FLAG_RULES.staleOrderDays) {
      const machine = wo.machineId ? store.findMachine(wo.machineId) : null;
      flags.push({
        type: 'stale_order',
        severity: 'warning',
        machineId: wo.machineId,
        machineName: machine ? machine.name : '',
        message: `Order ${wo.orderNumber || wo.title} open for ${ageDays} days`,
        workOrderIds: [wo.id],
      });
    }
  }

  // Parts sitting in "needed" too long.
  for (const part of store.listParts()) {
    if (part.status !== 'needed') continue;
    const ageDays = Math.floor((nowMs - new Date(part.createdAt).getTime()) / DAY_MS);
    if (ageDays >= FLAG_RULES.partOverdueDays) {
      const machine = part.machineId ? store.findMachine(part.machineId) : null;
      flags.push({
        type: 'part_overdue',
        severity: 'warning',
        machineId: part.machineId,
        machineName: machine ? machine.name : '',
        message: `Part "${part.name}" needed for ${ageDays} days and not ordered`,
        partId: part.id,
      });
    }
  }

  const rank = { critical: 0, serious: 1, warning: 2 };
  flags.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  return flags;
}

/**
 * Per-machine rollup within [from, to]: hours logged, order counts, last issue.
 */
function perMachineStats(from, to) {
  const machines = store.listMachines();
  const stats = new Map(machines.map((m) => [m.id, {
    machineId: m.id,
    machineName: m.name,
    area: m.area || '',
    minutes: 0,
    orderCount: 0,
    openCount: 0,
    lastIssueAt: null,
  }]));

  for (const log of store.listWorkLogs()) {
    if (!within(log.date, from, to)) continue;
    const s = stats.get(log.machineId);
    if (s) s.minutes += log.minutes;
  }
  for (const wo of store.listWorkOrders()) {
    if (wo.status === 'cancelled') continue;
    const s = stats.get(wo.machineId);
    if (!s) continue;
    if (within(wo.createdAt, from, to)) {
      s.orderCount += 1;
      if (!s.lastIssueAt || wo.createdAt > s.lastIssueAt) s.lastIssueAt = wo.createdAt;
    }
    if (!['completed', 'cancelled'].includes(wo.status)) s.openCount += 1;
  }

  return [...stats.values()].filter((s) => s.minutes > 0 || s.orderCount > 0 || s.openCount > 0);
}

/** Weekly buckets of work orders opened, for the trend chart. */
function ordersOverTime(from, to) {
  const orders = store.listWorkOrders().filter((w) => w.status !== 'cancelled' && within(w.createdAt, from, to));
  if (orders.length === 0) return [];
  const start = from || new Date(Math.min(...orders.map((w) => new Date(w.createdAt).getTime())));
  const end = to || new Date();

  // Align buckets to Monday so weeks are stable across refreshes.
  const first = new Date(start);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7));

  const buckets = [];
  for (let t = first.getTime(); t <= end.getTime(); t += 7 * DAY_MS) {
    buckets.push({ weekStart: new Date(t).toISOString().slice(0, 10), count: 0 });
  }
  for (const wo of orders) {
    const idx = Math.floor((new Date(wo.createdAt).getTime() - first.getTime()) / (7 * DAY_MS));
    if (buckets[idx]) buckets[idx].count += 1;
  }
  return buckets;
}

function summary(from, to) {
  const orders = store.listWorkOrders();
  const open = orders.filter((w) => !['completed', 'cancelled'].includes(w.status));
  const minutes = store.listWorkLogs()
    .filter((l) => within(l.date, from, to))
    .reduce((sum, l) => sum + l.minutes, 0);
  const partsNeeded = store.listParts().filter((p) => ['needed', 'ordered'].includes(p.status));
  const flags = computeFlags();
  return {
    openOrders: open.length,
    waitingParts: open.filter((w) => w.status === 'waiting_parts').length,
    minutesLogged: minutes,
    partsNeeded: partsNeeded.length,
    flagCount: flags.length,
    flaggedMachines: new Set(flags.filter((f) => f.machineId).map((f) => f.machineId)).size,
  };
}

module.exports = { computeFlags, perMachineStats, ordersOverTime, summary, FLAG_RULES };
