'use strict';
/**
 * The tracker's API logic, independent of how requests arrive.
 *
 * The same code runs in two places:
 *   - server.js (Node): the shared, multi-person system. Adds accounts,
 *     sign-in, and HTTP on top of this.
 *   - the tablet app (browser): bundled by scripts/build-tablet.js and called
 *     in-process, with all data stored on the tablet.
 *
 * handle() takes an already-parsed request and returns { status, data }.
 */

const store = require('./store');
const parser = require('./parser');
const analytics = require('./analytics');
const reports = require('./reports');
const pm = require('./pm');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const reply = (status, data, headers) => ({ status, data, headers });

function parseDate(s, endOfDay = false) {
  if (!s) return null;
  const d = new Date(endOfDay ? s + 'T23:59:59.999' : s + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

const isSupervisor = (user) => user && user.role === 'supervisor';
function requireSupervisor(user) {
  if (!isSupervisor(user)) fail(403, 'Only a supervisor can do that');
}

function resolveMachineFromBody(body) {
  if (body.machineId) return store.findMachine(body.machineId);
  if (body.machineName && String(body.machineName).trim()) return store.resolveMachine(body.machineName);
  return null;
}

/** Who the work belongs to. Supervisors may log on behalf of anyone (that's
 *  how one person can act as the whole crew while setting things up). */
function workerFor(user, requestedName) {
  const name = String(requestedName || '').trim();
  if (!name || !isSupervisor(user) || store.normalizeName(name) === store.normalizeName(user.name)) {
    return { technician: user.name, userId: user.id };
  }
  const u = store.findUserByName(name);
  return { technician: u ? u.name : name, userId: u ? u.id : null };
}

function canEditLog(user, log) {
  return isSupervisor(user) || log.userId === user.id
    || (!log.userId && store.normalizeName(log.technician) === store.normalizeName(user.name));
}

function partNames(list) {
  return (Array.isArray(list) ? list : [])
    .map((p) => {
      if (typeof p !== 'string') return p;
      // "2 sprockets", "2x bearing", "3 x filters" -> quantity + name
      const m = p.trim().match(/^(\d{1,3})\s*[x×]?\s+(.+)$/i);
      return m ? { name: m[2], quantity: Number(m[1]) } : { name: p };
    })
    .filter((p) => p && String(p.name || '').trim())
    .map((p) => ({ name: String(p.name).trim(), quantity: Number(p.quantity) || 1, partNumber: p.partNumber || '' }));
}

/** Update a work order and run follow-on rules (PM roll-forward). */
function changeWorkOrder(wo, fields, by) {
  const wasCompleted = wo.status === 'completed';
  const updated = store.updateWorkOrder(wo.id, fields, by);
  if (!wasCompleted && updated.status === 'completed') pm.onWorkOrderUpdated(updated);
  return updated;
}

// ---------------------------------------------------------- work commits

// Words that say nothing about *which* problem an entry is about.
const FILLER = new Set(('the and for with that this was were have has had from into onto then than they them ' +
  'about around still need needs needed order ordered waiting parts part replaced replace checked check fixed ' +
  'working work worked running back again today hour hours minute minutes looked look some more just also ' +
  'went came got done tested test said says will would could should there their what when where which while ' +
  'machine issue problem down good fine new old one two three four five half couple').split(' '));

const stem = (w) => w.replace(/(?:ing|ed|es|s)$/, '');
const FILLER_STEMS = new Set([...FILLER].map(stem));

function keywords(text, machineName = '') {
  const skip = new Set(store.normalizeName(machineName).split(' ').map(stem));
  return new Set((String(text).toLowerCase().match(/[a-z][a-z-]{3,}/g) || [])
    .map(stem)
    .filter((w) => w.length >= 3 && !FILLER_STEMS.has(w) && !skip.has(w)));
}

/**
 * Which open job on this machine (if any) is this entry about? Only one that
 * shares a meaningful word with it ("hydraulic", "leak", "coolant"…).
 * Otherwise the entry gets its own job, so unrelated work on the same
 * machine (a PM, a different fault) doesn't get merged together.
 */
function matchOpenJob(machine, text) {
  const said = keywords(text, machine.name);
  let best = null;
  let bestScore = 0;
  const open = store.listWorkOrders()
    .filter((w) => w.machineId === machine.id && !store.CLOSED.includes(w.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const w of open) {
    const theirs = keywords(w.title + ' ' + w.description, machine.name);
    let score = 0;
    for (const k of said) if (theirs.has(k)) score++;
    // A PM job only takes entries that say "PM" or clearly match it.
    if (w.pmId && !/\b(?:pm|preventive|preventative)\b/i.test(text) && score < 2) continue;
    if (score > bestScore) { best = w; bestScore = score; }
  }
  return best;
}

const sameText = (a, b) => store.normalizeName(a) === store.normalizeName(b);

/**
 * What a typed Job box means. "NO_WO#003 — Press 2 …" (a picked suggestion),
 * "NO_WO#003", "WO#10288" or a bare number -> that order; the exact title of
 * the current or another open order -> that order; anything else -> the title
 * for a job.
 */
function resolveJobText(text, current = null) {
  const t = String(text || '').trim();
  if (!t) return {};
  const head = t.split(/\s+[—–]\s+|\s+-\s+/)[0].trim();
  const byRef = store.findWorkOrderByRef(head);
  if (byRef) return { wo: byRef };
  if (current && sameText(current.title, t)) return { wo: current };
  const same = store.listWorkOrders().find((w) => !store.CLOSED.includes(w.status) && sameText(w.title, t));
  if (same) return { wo: same };
  return { title: t.slice(0, 120) };
}

/** An order this entry created that nothing else has been logged on. */
function isOwnJob(wo, log) {
  return !!wo && log.createdOrderId === wo.id
    && !store.listWorkLogs().some((l) => l.workOrderId === wo.id && l.id !== log.id);
}

/**
 * Edit screen: apply the typed Job text and Plex WO# to an entry. Returns
 * the fields to save on the entry ({ workOrderId, createdOrderId }).
 * Renames the entry's own job; never renames a job shared with other
 * entries or put in for you (the entry gets a new job instead).
 */
function applyJobEdit(log, body, user) {
  const out = {};
  let wo = log.workOrderId ? store.findWorkOrder(log.workOrderId) : null;
  const machineId = body.machineId !== undefined ? body.machineId : log.machineId;
  const newJob = (fields) => {
    const created = store.createWorkOrder({
      machineId, source: log.source || 'typed', assignedTo: log.technician, status: 'in_progress', ...fields,
    }, user.name);
    out.createdOrderId = created.id;
    return created;
  };

  if (body.jobText !== undefined && String(body.jobText).trim()) {
    const r = resolveJobText(body.jobText, wo);
    if (r.wo) wo = r.wo;
    else if (wo && isOwnJob(wo, log)) wo = store.updateWorkOrder(wo.id, { title: r.title }, user.name);
    else wo = newJob({ title: r.title });
  }

  if (body.orderNumber !== undefined) {
    const num = String(body.orderNumber || '').trim().replace(/^w\.?\s*o\.?\s*#?\s*/i, '');
    if (num && (!wo || wo.orderNumber !== num)) {
      const other = store.findWorkOrderByNumber(num);
      if (other && (!wo || other.id !== wo.id)) wo = other; // that Plex order already exists: put the entry on it
      else if (wo) wo = store.updateWorkOrder(wo.id, { orderNumber: num }, user.name);
      else wo = newJob({ title: titleFrom(log.notes, 'General work'), orderNumber: num });
    } else if (!num && wo && wo.orderNumber) {
      wo = store.updateWorkOrder(wo.id, { orderNumber: '' }, user.name);
    }
  }

  if (wo && wo.id !== log.workOrderId) {
    out.workOrderId = wo.id;
    // The entry's old job was only there for this entry: don't leave it behind empty.
    const old = log.workOrderId ? store.findWorkOrder(log.workOrderId) : null;
    if (old && isOwnJob(old, log)) {
      store.updateWorkLog(log.id, { workOrderId: wo.id });
      store.deleteWorkOrder(old.id);
    }
  }
  return out;
}

/** A short job title from free text: the first sentence, trimmed. */
function titleFrom(text, fallback) {
  // First sentence of the first line. (No regex lookbehind: older iPads'
  // Safari can't parse it, and this code also runs on the tablet.)
  const line = String(text || '').split('\n')[0];
  const m = line.match(/^(.*?[.!?])(?:\s|$)/);
  let first = (m ? m[1] : line).replace(/[.!?]+$/, '').trim();
  // Spoken entries are one long sentence: the part before the first comma
  // usually says what the job was ("Press 2 replaced the hydraulic hose").
  const clause = first.split(/,\s*/)[0].trim();
  if (clause.length >= 12) first = clause;
  if (!first) return fallback;
  if (first.length <= 70) return first.charAt(0).toUpperCase() + first.slice(1);
  const cut = first.slice(0, 70);
  return cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 70) + '…';
}

/**
 * The one place a piece of work gets recorded — used by voice/typed
 * entries, the detailed form, and pasted notes.
 *
 * Attaches the entry to a job (the WO# mentioned, the machine's open job, or
 * a new job made automatically), files parts used / needed, and moves the
 * job's status along. Nobody has to fill in work-order details by hand.
 */
function commitWork(body, user) {
  const worker = workerFor(user, body.technician);
  let machine = resolveMachineFromBody(body);

  // --- which work order?
  let workOrder = null;
  let createdOrder = false;
  if (body.workOrderId) {
    workOrder = store.findWorkOrder(body.workOrderId);
    if (!workOrder) fail(400, 'That work order no longer exists');
  }
  // Job typed into the form: an existing order (picked suggestion, its
  // number, or its exact title) or the title for a new one.
  let newOrderTitle = String(body.newOrderTitle || '').trim();
  if (!workOrder && body.jobText !== undefined) {
    const r = resolveJobText(body.jobText);
    if (r.wo) workOrder = r.wo;
    else if (r.title) newOrderTitle = r.title;
  }
  let orderNumber = String(body.orderNumber || '').trim();
  if (!workOrder && orderNumber) workOrder = store.findWorkOrderByRef(orderNumber);
  // One of our own numbers that doesn't exist (yet) is not a Plex number.
  if (!workOrder && store.parseNoWo(orderNumber)) orderNumber = '';
  if (!machine && workOrder && workOrder.machineId) machine = store.findMachine(workOrder.machineId);

  if (!workOrder && body.attachToOpen && machine) {
    workOrder = matchOpenJob(machine, String(body.notes || ''));
  }
  const notes = String(body.notes || '').trim();
  // Entries from Today (alwaysJob) always end up on a work order, so they
  // show in Work Orders; no Plex WO# means it gets its own NO_WO#### number.
  if (!workOrder && (body.alwaysJob || machine || newOrderTitle || orderNumber)) {
    workOrder = store.createWorkOrder({
      machineId: machine ? machine.id : null,
      orderNumber,
      title: newOrderTitle || titleFrom(notes, machine ? 'Work on ' + machine.name : 'General work'),
      description: notes,
      priority: body.priority,
      source: body.source || 'tablet',
      assignedTo: worker.technician,
    }, user.name);
    createdOrder = true;
  }

  // --- the log entry
  const log = store.createWorkLog({
    workOrderId: workOrder ? workOrder.id : null,
    machineId: machine ? machine.id : (workOrder ? workOrder.machineId : null),
    technician: worker.technician,
    userId: worker.userId,
    loggedBy: user.name,
    date: body.date,
    minutes: body.minutes,
    notes,
    clientId: body.clientId,
    source: body.source,
    createdOrderId: createdOrder ? workOrder.id : null,
  });

  // --- parts
  const partFields = { machineId: log.machineId, workOrderId: log.workOrderId, logId: log.id, requestedBy: worker.technician };
  const partsUsed = partNames(body.partsUsed).map((p) => store.createPart({ ...p, ...partFields, status: 'installed', notes: 'used ' + log.date }));
  const partsNeeded = partNames(body.partsNeeded).map((p) => store.createPart({ ...p, ...partFields, status: 'needed', notes: 'requested ' + log.date }));

  // --- status
  if (workOrder) {
    const patch = {};
    let next = body.statusAfter;
    if (!next && partsNeeded.length) next = 'waiting_parts';
    // A job made just now from an entry that didn't say "still working" etc.
    // is a one-off that's finished; don't leave it cluttering the open list.
    if (!next && createdOrder && body.defaultNewStatus) next = body.defaultNewStatus;
    if (!next && workOrder.status === 'open') next = 'in_progress';
    if (store.WORK_ORDER_STATUSES.includes(next) && next !== workOrder.status && workOrder.status !== 'completed') patch.status = next;
    if (!workOrder.assignedTo) patch.assignedTo = worker.technician;
    if (Object.keys(patch).length) workOrder = changeWorkOrder(workOrder, patch, user.name);
  }

  return { workOrder, createdOrder, log, partsUsed, partsNeeded };
}

/**
 * Make an entry's parts match corrected lists (from the Edit screen).
 * "Used" = installed parts; "needed" = anything not installed yet (needed,
 * ordered, received). Parts that are still listed keep their record and
 * progress (an "ordered" part stays ordered); removed ones are deleted; new
 * ones are added. Undefined list = leave that side alone.
 */
function replaceLogParts(log, usedList, neededList, user) {
  const key = (n) => store.normalizeName(n);
  const sync = (list, mine, newStatus) => {
    if (list === undefined) return;
    const wanted = partNames(list);
    const pool = [...mine];
    for (const w of wanted) {
      const i = pool.findIndex((p) => key(p.name) === key(w.name));
      if (i >= 0) {
        const [match] = pool.splice(i, 1);
        if (match.quantity !== w.quantity) store.updatePart(match.id, { quantity: w.quantity });
      } else {
        store.createPart({
          ...w, machineId: log.machineId, workOrderId: log.workOrderId, logId: log.id,
          requestedBy: log.technician || user.name, status: newStatus,
          notes: (newStatus === 'installed' ? 'used ' : 'requested ') + log.date,
        });
      }
    }
    for (const leftover of pool) store.deletePart(leftover.id);
  };
  const parts = store.listParts().filter((p) => p.logId === log.id);
  sync(usedList, parts.filter((p) => p.status === 'installed'), 'installed');
  sync(neededList, parts.filter((p) => p.status !== 'installed'), 'needed');
}

/**
 * Remove an entry and whatever it created on its own: its parts, and the
 * job it opened if nothing else has been logged against that job since.
 * (So "Undo" after a mis-heard voice entry leaves no trace.)
 */
function removeWorkLog(log) {
  store.deleteWorkLog(log.id);
  for (const p of store.listParts().filter((x) => x.logId === log.id)) store.deletePart(p.id);
  for (const ph of store.listPhotos().filter((x) => x.logId === log.id)) store.deletePhoto(ph.id);
  if (log.createdOrderId && !store.listWorkLogs().some((l) => l.workOrderId === log.createdOrderId)) {
    store.deleteWorkOrder(log.createdOrderId);
  }
}

/** Turn a parsed email into records. Reuses the order if the WO# is known. */
function ingestEmail(payload, by) {
  const parsed = parser.parseEmail(payload);
  const machine = parsed.machineName ? store.resolveMachine(parsed.machineName) : null;
  const existing = parsed.orderNumber ? store.findWorkOrderByNumber(parsed.orderNumber) : null;
  if (existing) return { created: false, workOrder: existing, parsed };
  const wo = store.createWorkOrder({
    orderNumber: parsed.orderNumber,
    machineId: machine ? machine.id : null,
    title: parsed.title,
    description: parsed.description,
    priority: parsed.priority,
    source: 'email',
    createdAt: parsed.receivedAt || undefined,
  }, by);
  return { created: true, workOrder: wo, parsed };
}

// ------------------------------------------------------------- dashboard

function dashboard(query) {
  const from = parseDate(query.get('from'));
  const to = parseDate(query.get('to'), true);
  const machineId = query.get('machineId') || null;
  const technician = query.get('technician') || null;

  const inRange = (dateStr) => {
    const t = new Date(dateStr).getTime();
    if (from && t < from.getTime()) return false;
    if (to && t > to.getTime()) return false;
    return true;
  };

  let workOrders = store.listWorkOrders().filter((w) =>
    !store.CLOSED.includes(w.status) ? true : inRange(w.completedAt || w.createdAt));
  let workLogs = store.listWorkLogs().filter((l) => inRange(l.date));
  let parts = store.listParts();

  if (machineId) {
    workOrders = workOrders.filter((w) => w.machineId === machineId);
    workLogs = workLogs.filter((l) => l.machineId === machineId);
    parts = parts.filter((p) => p.machineId === machineId);
  }
  if (technician) {
    workOrders = workOrders.filter((w) => !w.assignedTo || w.assignedTo === technician);
    workLogs = workLogs.filter((l) => l.technician === technician);
  }

  return {
    machines: store.listMachines(),
    technicians: store.allTechnicianNames().map((name) => ({ name })),
    workOrders, workLogs, parts,
    summary: analytics.summary(from, to),
    perMachine: analytics.perMachineStats(from, to),
    ordersOverTime: analytics.ordersOverTime(from, to),
    flags: analytics.computeFlags().filter((f) => !machineId || f.machineId === machineId),
  };
}

// ------------------------------------------------------------- import

const WORK_KEYS = ['machines', 'workOrders', 'workLogs', 'parts', 'pmSchedules'];

/** Validate a backup/export file before it replaces anything. */
function checkImport(data) {
  if (!data || typeof data !== 'object') fail(400, 'That file isn’t a tracker backup');
  for (const k of ['machines', 'workOrders', 'workLogs', 'parts']) {
    if (!Array.isArray(data[k])) fail(400, `That file isn’t a tracker backup (no ${k})`);
  }
  for (const k of ['pmSchedules']) if (data[k] !== undefined && !Array.isArray(data[k])) fail(400, 'Backup file is damaged');
}

// ------------------------------------------------------------------ routing

/**
 * @param {object} req
 * @param {string} req.method
 * @param {string[]} req.seg    path segments, e.g. ['api', 'work-orders', '<id>']
 * @param {URLSearchParams} req.query
 * @param {object} req.body     parsed JSON body ({} for GET)
 * @param {object} req.user     the signed-in user ({ id, name, role })
 */
async function handle({ method, seg, query, body = {}, user }) {
  const q = (k) => query.get(k) || '';

  // ------------------------------------------------------------ bootstrap
  if (method === 'GET' && seg[1] === 'bootstrap') {
    return reply(200, {
      me: store.publicUser(user),
      machines: store.listMachines(),
      technicians: store.allTechnicianNames(),
      users: store.listUsers().filter((u) => u.active).map(store.publicUser),
      statuses: store.WORK_ORDER_STATUSES,
      partStatuses: store.PART_STATUSES,
      priorities: store.PRIORITIES,
      serverToday: store.localDate(),
    });
  }

  if (method === 'GET' && seg[1] === 'dashboard') return reply(200, dashboard(query));

  // ---------------------------------------------------------- machines
  if (seg[1] === 'machines') {
    if (method === 'GET') return reply(200, store.listMachines());
    if (method === 'POST') {
      if (!String(body.name || '').trim()) fail(400, 'name is required');
      return reply(201, store.createMachine(body));
    }
    if (method === 'PATCH' && seg[2]) {
      requireSupervisor(user);
      const m = store.updateMachine(seg[2], body);
      return m ? reply(200, m) : fail(404, 'not found');
    }
  }

  // ------------------------------------------------------- work orders
  if (seg[1] === 'work-orders') {
    if (method === 'GET' && !seg[2]) {
      let list = store.listWorkOrders();
      if (q('status') === 'open') list = list.filter((w) => !store.CLOSED.includes(w.status));
      if (q('machineId')) list = list.filter((w) => w.machineId === q('machineId'));
      return reply(200, list);
    }
    if (method === 'GET' && seg[2]) {
      const wo = store.findWorkOrder(seg[2]);
      if (!wo) fail(404, 'not found');
      return reply(200, {
        workOrder: wo,
        logs: store.listWorkLogs().filter((l) => l.workOrderId === wo.id)
          .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
        parts: store.listParts().filter((p) => p.workOrderId === wo.id),
        pm: wo.pmId ? store.findPmSchedule(wo.pmId) : null,
        photos: store.listPhotos().filter((ph) => ph.workOrderId === wo.id),
      });
    }
    if (method === 'POST' && !seg[2]) {
      const m = resolveMachineFromBody(body);
      if (body.orderNumber && store.findWorkOrderByNumber(body.orderNumber)) {
        fail(409, `Work order #${body.orderNumber} already exists`);
      }
      const wo = store.createWorkOrder({ ...body, machineId: m ? m.id : null, source: body.source || 'manual' }, user.name);
      return reply(201, wo);
    }
    if (method === 'POST' && seg[3] === 'notes') {
      if (!String(body.text || '').trim()) fail(400, 'Note is empty');
      const wo = store.addWorkOrderNote(seg[2], body.text, user.name);
      return wo ? reply(201, wo) : fail(404, 'not found');
    }
    if (method === 'PATCH' && seg[2]) {
      const wo = store.findWorkOrder(seg[2]);
      if (!wo) fail(404, 'not found');
      if (body.machineName !== undefined && !body.machineId) {
        const m = resolveMachineFromBody(body);
        body.machineId = m ? m.id : null;
      }
      return reply(200, changeWorkOrder(wo, body, user.name));
    }
    if (method === 'DELETE' && seg[2]) {
      requireSupervisor(user);
      return store.deleteWorkOrder(seg[2]) ? reply(200, { ok: true }) : fail(404, 'not found');
    }
  }

  // --------------------------------------------------------- work logs
  if (seg[1] === 'work-logs') {
    if (method === 'GET') {
      const from = q('from'), to = q('to') || q('from'), tech = q('technician');
      let list = store.listWorkLogs();
      if (from) list = list.filter((l) => l.date >= from && l.date <= to);
      if (tech) list = list.filter((l) => l.technician === tech);
      return reply(200, list);
    }

    if (method === 'POST' && !seg[2]) {
      const dup = store.findWorkLogByClientId(body.clientId);
      if (dup) return reply(200, { log: dup, duplicate: true });
      // Like Today's entries, every detailed entry lands on a work order.
      return reply(201, commitWork({ ...body, alwaysJob: true }, user));
    }

    if ((method === 'PATCH' || method === 'DELETE') && seg[2]) {
      const log = store.findWorkLog(seg[2]);
      if (!log) fail(404, 'not found');
      if (!canEditLog(user, log)) fail(403, 'You can only change your own entries');
      if (method === 'DELETE') {
        removeWorkLog(log);
        return reply(200, { ok: true });
      }
      const patch = { ...body };
      if ('technician' in patch) {
        if (isSupervisor(user)) Object.assign(patch, workerFor(user, patch.technician));
        else { delete patch.technician; }
      }
      delete patch.userId;
      if (patch.machineName !== undefined) {
        const m = resolveMachineFromBody({ machineName: patch.machineName });
        patch.machineId = m ? m.id : null;
      }
      // Job box / Plex WO# from the Edit screen.
      if ('jobText' in patch || 'orderNumber' in patch) {
        Object.assign(patch, applyJobEdit(log, patch, user));
      }
      delete patch.jobText; delete patch.orderNumber; delete patch.createdOrderIdInput;
      const hasParts = 'partsUsed' in patch || 'partsNeeded' in patch;
      const statusAfter = patch.statusAfter;
      const partsUsed = patch.partsUsed;
      const partsNeeded = patch.partsNeeded;
      delete patch.partsUsed; delete patch.partsNeeded; delete patch.statusAfter;
      const updated = store.updateWorkLog(log.id, patch);
      // Parts follow the entry if it was moved to another job or machine.
      for (const p of store.listParts().filter((x) => x.logId === log.id)) {
        if (p.workOrderId !== updated.workOrderId || p.machineId !== updated.machineId) {
          store.updatePart(p.id, { workOrderId: updated.workOrderId, machineId: updated.machineId });
        }
      }
      // …and so do its photos.
      for (const ph of store.listPhotos().filter((x) => x.logId === log.id)) {
        if (ph.workOrderId !== updated.workOrderId) store.updatePhoto(ph.id, { workOrderId: updated.workOrderId });
      }
      if (hasParts) {
        replaceLogParts(updated, partsUsed, partsNeeded, user);
      }
      const wo = updated.workOrderId ? store.findWorkOrder(updated.workOrderId) : null;
      if (wo && store.WORK_ORDER_STATUSES.includes(statusAfter) && statusAfter !== wo.status) {
        changeWorkOrder(wo, { status: statusAfter }, user.name);
      }
      return reply(200, updated);
    }
  }

  // ------------------------------------------------------------ photos
  if (seg[1] === 'photos') {
    if (method === 'GET' && !seg[2]) {
      let list = store.listPhotos();
      if (q('workOrderId')) list = list.filter((ph) => ph.workOrderId === q('workOrderId'));
      if (q('logId')) list = list.filter((ph) => ph.logId === q('logId'));
      if (q('partId')) list = list.filter((ph) => ph.partId === q('partId'));
      return reply(200, list);
    }
    if (method === 'POST' && !seg[2]) {
      const isImage = (v) => typeof v === 'string' && /^data:image\/(?:jpeg|png|webp);base64,/.test(v);
      if (!isImage(body.full)) fail(400, 'That isn’t a photo');
      if (body.full.length > 12 * 1024 * 1024) fail(413, 'Photo is too large');
      let workOrderId = body.workOrderId || null;
      const log = body.logId ? store.findWorkLog(body.logId) : null;
      const part = body.partId ? store.findPart(body.partId) : null;
      if (body.partId && !part) fail(400, 'That part no longer exists');
      if (part && !workOrderId) workOrderId = part.workOrderId;
      if (body.logId && !log) fail(400, 'That entry no longer exists');
      if (log && !workOrderId) workOrderId = log.workOrderId;
      if (workOrderId && !store.findWorkOrder(workOrderId)) fail(400, 'That work order no longer exists');
      if (!workOrderId && !log && !part) fail(400, 'Attach the photo to a work order, an entry or a part');
      const photo = store.createPhoto({
        workOrderId, logId: log ? log.id : null, partId: part ? part.id : null,
        kind: part ? 'part' : body.kind, caption: body.caption,
        width: body.width, height: body.height, bytes: Math.round(body.full.length * 0.75), by: user.name,
      }, { full: body.full, thumb: isImage(body.thumb) ? body.thumb : null });
      return reply(201, photo);
    }
    if (method === 'PATCH' && seg[2]) {
      const photo = store.updatePhoto(seg[2], { ...(('kind' in body) ? { kind: body.kind } : {}), ...(('caption' in body) ? { caption: body.caption } : {}) });
      return photo ? reply(200, photo) : fail(404, 'not found');
    }
    if (method === 'DELETE' && seg[2]) {
      return store.deletePhoto(seg[2]) ? reply(200, { ok: true }) : fail(404, 'not found');
    }
  }

  // ------------------------------------------------------------- parts
  if (seg[1] === 'parts') {
    if (method === 'GET') return reply(200, store.listParts());
    if (method === 'POST') {
      if (!String(body.name || '').trim()) fail(400, 'name is required');
      let m = resolveMachineFromBody(body);
      const wo = body.workOrderId ? store.findWorkOrder(body.workOrderId) : null;
      if (!m && wo && wo.machineId) m = store.findMachine(wo.machineId);
      const part = store.createPart({ ...body, machineId: m ? m.id : null, workOrderId: wo ? wo.id : null, requestedBy: user.name });
      if (wo && part.status === 'needed' && ['open', 'in_progress'].includes(wo.status)) {
        changeWorkOrder(wo, { status: 'waiting_parts' }, user.name);
      }
      return reply(201, part);
    }
    if (method === 'PATCH' && seg[2]) {
      if (body.machineName !== undefined) {
        const m = resolveMachineFromBody({ machineName: body.machineName });
        body.machineId = m ? m.id : null;
      }
      const part = store.updatePart(seg[2], body);
      return part ? reply(200, part) : fail(404, 'not found');
    }
    if (method === 'DELETE' && seg[2]) {
      return store.deletePart(seg[2]) ? reply(200, { ok: true }) : fail(404, 'not found');
    }
  }

  // ------------------------------------------------ preventive maintenance
  if (seg[1] === 'pm') {
    if (method === 'GET') return reply(200, store.listPmSchedules());
    requireSupervisor(user);
    if (method === 'POST' && seg[2] === 'run') return reply(200, { created: pm.generateDue() });
    if (body.machineName !== undefined) {
      const m = resolveMachineFromBody({ machineName: body.machineName });
      body.machineId = m ? m.id : null;
    }
    if (method === 'POST' && !seg[2]) {
      const created = store.createPmSchedule(body);
      pm.generateDue();
      return reply(201, created);
    }
    if (method === 'PATCH' && seg[2]) {
      const updated = store.updatePmSchedule(seg[2], body);
      if (!updated) fail(404, 'not found');
      pm.generateDue();
      return reply(200, updated);
    }
    if (method === 'DELETE' && seg[2]) {
      return store.deletePmSchedule(seg[2]) ? reply(200, { ok: true }) : fail(404, 'not found');
    }
  }

  // ----------------------------------------------------------- reports
  if (seg[1] === 'reports') {
    if (method === 'GET' && !seg[2]) {
      return reply(200, reports.buildReport({
        from: q('from'), to: q('to'), technician: q('technician'), tz: q('tz'),
      }));
    }
    if (method === 'PUT' && seg[2] === 'notes') {
      if (!/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(String(body.key || ''))) fail(400, 'bad report key');
      return reply(200, store.setReportNote(body.key, body.text, user.name));
    }
  }

  // ------------------------------------------------------------ ingest
  if (seg[1] === 'ingest' && method === 'POST') {
    if (seg[2] === 'email') {
      if (!body.subject && !body.body) fail(400, 'subject or body required');
      return reply(201, ingestEmail(body, user.name));
    }
    if (seg[2] === 'notes' && seg[3] === 'preview') {
      if (!body.text) fail(400, 'text required');
      return reply(200, parser.parseNotes(body.text, store.listMachines().map((m) => m.name)));
    }
    // Voice / typed / pasted entries all land here. Resends from the
    // tablet's offline queue are recognised by clientId and ignored.
    if (seg[2] === 'notes') {
      if (!String(body.text || '').trim()) fail(400, 'Say or type what you did first');
      const dup = store.findWorkLogByClientId(body.clientId);
      if (dup) return reply(200, { log: dup, duplicate: true });
      const parsed = parser.parseNotes(body.text, store.listMachines().map((m) => m.name));
      const o = body.overrides || {};
      // Logging straight onto a chosen work order (Today's "Assigned to you"
      // 🎤 Log button): that order, and its machine, win over anything heard.
      let target = null;
      if (body.workOrderId) {
        target = store.findWorkOrder(body.workOrderId);
        if (!target) fail(400, 'That work order no longer exists');
      }
      const out = commitWork({
        technician: body.technician,
        date: body.date,
        workOrderId: target ? target.id : undefined,
        machineId: target && target.machineId ? target.machineId : undefined,
        machineName: target && target.machineId ? undefined : (o.machineName ?? parsed.machineName),
        orderNumber: target ? undefined : (o.orderNumber ?? parsed.orderNumber),
        attachToOpen: true,
        alwaysJob: true,
        minutes: o.minutes ?? parsed.minutes ?? 0,
        notes: parsed.notes,
        partsUsed: o.partsUsed ?? parsed.partsUsed,
        partsNeeded: o.partsNeeded ?? parsed.partsNeeded,
        statusAfter: o.statusHint ?? parsed.statusHint,
        clientId: body.clientId,
        defaultNewStatus: 'completed',
        source: ['voice', 'typed', 'notes'].includes(body.source) ? body.source : 'notes',
      }, user);
      return reply(201, { parsed, ...out });
    }
  }

  // ------------------------------------------------------------ export
  if (method === 'GET' && seg[1] === 'export') {
    requireSupervisor(user);
    const d = store.load();
    const safe = { ...d, users: d.users.map(store.publicUser), sessions: undefined };
    // ?photos=1: put the photo images in the file too, so a backup is complete.
    if (q('photos') === '1') {
      safe.photoFiles = {};
      for (const ph of d.photos) safe.photoFiles[ph.id] = store.photoDataUrls(ph.id);
    }
    return reply(200, safe, {
      'Content-Disposition': `attachment; filename="maintenance-export-${store.localDate()}.json"`,
    });
  }

  // ------------------------------------------------------------ import
  // Restore a backup (or move tablet data into a server). Replaces all work
  // data; accounts are untouched.
  if (method === 'POST' && seg[1] === 'import') {
    requireSupervisor(user);
    checkImport(body.data);
    const oldPhotos = store.listPhotos().map((ph) => ph.id);
    const counts = store.replaceWorkData(body.data);
    // Photo images that came with the backup; drop images of photos that are gone.
    const files = body.data.photoFiles || {};
    for (const ph of store.listPhotos()) if (files[ph.id] && files[ph.id].full) store.savePhotoFiles(ph.id, files[ph.id]);
    const keep = new Set(store.listPhotos().map((ph) => ph.id));
    for (const pid of oldPhotos) if (!keep.has(pid)) store.deletePhoto(pid);
    counts.photos = store.listPhotos().length;
    pm.generateDue();
    return reply(200, { ok: true, counts });
  }

  fail(404, 'no such endpoint');
}

module.exports = { handle, HttpError, fail, commitWork, chores: () => pm.generateDue() };
