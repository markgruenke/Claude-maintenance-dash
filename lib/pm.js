'use strict';
/**
 * Preventive maintenance: recurring tasks ("grease Press 2 every 30 days")
 * that turn into ordinary work orders when they come due, and roll their
 * next due date forward when that work order is completed.
 */

const store = require('./store');

/**
 * Create a work order for every active PM schedule that is due within its
 * lead time and doesn't already have an open order. Safe to call often.
 * @returns {Array} work orders created
 */
function generateDue(today = store.localDate()) {
  const created = [];
  const openPmIds = new Set(store.listWorkOrders()
    .filter((w) => w.pmId && !store.CLOSED.includes(w.status))
    .map((w) => w.pmId));

  for (const pm of store.listPmSchedules()) {
    if (!pm.active || openPmIds.has(pm.id)) continue;
    const showFrom = store.addDays(pm.nextDueDate, -pm.leadDays);
    if (showFrom > today) continue;
    created.push(store.createWorkOrder({
      machineId: pm.machineId,
      title: `PM: ${pm.title}`,
      description: pm.description,
      priority: pm.priority,
      assignedTo: pm.assignedTo,
      dueDate: pm.nextDueDate,
      source: 'pm',
      pmId: pm.id,
    }, 'PM scheduler'));
  }
  return created;
}

/** Call after a work order changes; rolls the PM forward when its order is done. */
function onWorkOrderUpdated(wo, today = store.localDate()) {
  if (!wo || !wo.pmId || wo.status !== 'completed') return null;
  const pm = store.findPmSchedule(wo.pmId);
  if (!pm) return null;
  const doneDate = today;
  // Schedule from the day it was actually done, so a late PM doesn't come
  // due again immediately.
  return store.updatePmSchedule(pm.id, {
    lastDoneDate: doneDate,
    nextDueDate: store.addDays(doneDate, pm.intervalDays),
  });
}

module.exports = { generateDue, onWorkOrderUpdated };
