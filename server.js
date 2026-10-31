'use strict';
/**
 * Maintenance tracker server — zero dependencies, plain Node (>= 18).
 *
 *   node server.js            start on http://localhost:3000
 *   PORT=8080 node server.js  pick a port
 *   DATA_DIR=/path node ...   store data somewhere else
 *   TZ=America/Chicago ...    server's local time zone (matters on cloud hosts)
 *   INGEST_TOKEN=secret ...   lets an email forwarder POST /api/ingest/email
 *   SECURE_COOKIES=1 ...      force Secure cookies (auto-on behind an https proxy)
 *
 * Everything under /api requires a signed-in user except the auth routes and
 * the token-protected email webhook. The first visit creates the supervisor
 * account. See README.md for the full API list.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const store = require('./lib/store');
const parser = require('./lib/parser');
const analytics = require('./lib/analytics');
const auth = require('./lib/auth');
const reports = require('./lib/reports');
const pm = require('./lib/pm');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) { // 1 MB is plenty for any email or note
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new HttpError(400, 'invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function parseDate(s, endOfDay = false) {
  if (!s) return null;
  const d = new Date(endOfDay ? s + 'T23:59:59.999' : s + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function clientIp(req) {
  // Only trust X-Forwarded-For when explicitly told we're behind a proxy.
  if (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
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
    .map((p) => (typeof p === 'string' ? { name: p } : p))
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

/** A short job title from free text: the first sentence, trimmed. */
function titleFrom(text, fallback) {
  const first = String(text || '').split(/(?<=[.!?])\s+|\n/)[0].replace(/[.!?]+$/, '').trim();
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
  const orderNumber = String(body.orderNumber || '').trim();
  if (!workOrder && orderNumber) workOrder = store.findWorkOrderByNumber(orderNumber);
  if (!machine && workOrder && workOrder.machineId) machine = store.findMachine(workOrder.machineId);

  if (!workOrder && body.attachToOpen && machine) {
    workOrder = matchOpenJob(machine, String(body.notes || ''));
  }
  const notes = String(body.notes || '').trim();
  if (!workOrder && (machine || body.newOrderTitle || orderNumber)) {
    workOrder = store.createWorkOrder({
      machineId: machine ? machine.id : null,
      orderNumber,
      title: String(body.newOrderTitle || '').trim() || titleFrom(notes, 'Work on ' + (machine ? machine.name : 'equipment')),
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
 * Remove an entry and whatever it created on its own: its parts, and the
 * job it opened if nothing else has been logged against that job since.
 * (So "Undo" after a mis-heard voice entry leaves no trace.)
 */
function removeWorkLog(log) {
  store.deleteWorkLog(log.id);
  for (const p of store.listParts().filter((x) => x.logId === log.id)) store.deletePart(p.id);
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

function dashboard(url) {
  const from = parseDate(url.searchParams.get('from'));
  const to = parseDate(url.searchParams.get('to'), true);
  const machineId = url.searchParams.get('machineId') || null;
  const technician = url.searchParams.get('technician') || null;

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

// ------------------------------------------------------------------ routing

async function handleAuth(req, res, seg) {
  const method = req.method;
  const action = seg[2];

  if (action === 'status' && method === 'GET') {
    const user = auth.userFromRequest(req);
    return sendJson(res, 200, { setupNeeded: store.listUsers().length === 0, user: store.publicUser(user) });
  }
  if (method !== 'POST') fail(404, 'no such endpoint');
  const body = await readBody(req);

  if (action === 'setup') {
    if (store.listUsers().length > 0) fail(409, 'Setup is already done — sign in instead');
    const name = String(body.name || '').trim();
    if (!name) fail(400, 'Enter your name');
    const problem = auth.secretProblem(body.secret, 'supervisor');
    if (problem) fail(400, problem);
    const user = store.createUser({ name, role: 'supervisor', ...auth.hashSecret(body.secret) });
    const token = auth.startSession(user);
    return sendJson(res, 201, { user: store.publicUser(user) }, { 'Set-Cookie': auth.sessionCookie(req, token) });
  }

  if (action === 'login') {
    const name = String(body.name || '').trim();
    const ip = clientIp(req);
    if (auth.isLocked(name, ip)) fail(429, 'Too many wrong tries. Wait 15 minutes and try again.');
    const user = store.findUserByName(name);
    if (!user || !user.active || !auth.verifySecret(body.secret, user)) {
      auth.recordFailure(name, ip);
      fail(401, 'Name or PIN is wrong');
    }
    auth.clearFailures(name);
    const token = auth.startSession(user);
    return sendJson(res, 200, { user: store.publicUser(user) }, { 'Set-Cookie': auth.sessionCookie(req, token) });
  }

  if (action === 'logout') {
    auth.userFromRequest(req);
    auth.endSession(req);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(req) });
  }

  fail(404, 'no such endpoint');
}

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  const q = (k) => url.searchParams.get(k) || '';

  // Every write must be JSON. Browsers can't send that cross-site without a
  // CORS preflight (which we never grant), so this doubles as CSRF defense.
  if (method !== 'GET' && method !== 'HEAD') {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.includes('application/json')) fail(415, 'Send JSON (Content-Type: application/json)');
  }

  if (seg[1] === 'auth') return handleAuth(req, res, seg);

  // Email webhook: allowed with the shared token, no login needed.
  let user = auth.userFromRequest(req);
  if (!user && seg[1] === 'ingest' && seg[2] === 'email' && INGEST_TOKEN) {
    const token = req.headers['x-ingest-token'] || url.searchParams.get('token');
    if (token === INGEST_TOKEN) user = { id: null, name: 'email', role: 'tech' };
  }
  if (!user) fail(401, 'Please sign in');

  // ---------------------------------------------------------------- me
  if (seg[1] === 'me') {
    if (method === 'GET' && !seg[2]) return sendJson(res, 200, store.publicUser(user));
    if (method === 'POST' && seg[2] === 'secret') {
      const body = await readBody(req);
      if (!auth.verifySecret(body.current, user)) fail(400, 'Current PIN/password is wrong');
      const problem = auth.secretProblem(body.next, user.role);
      if (problem) fail(400, problem);
      store.updateUser(user.id, auth.hashSecret(body.next));
      return sendJson(res, 200, { ok: true });
    }
  }

  // ------------------------------------------------------------ bootstrap
  if (method === 'GET' && seg[1] === 'bootstrap') {
    return sendJson(res, 200, {
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

  if (method === 'GET' && seg[1] === 'dashboard') return sendJson(res, 200, dashboard(url));

  // ------------------------------------------------------------- users
  if (seg[1] === 'users') {
    requireSupervisor(user);
    if (method === 'GET') return sendJson(res, 200, store.listUsers().map(store.publicUser));
    const body = await readBody(req);
    if (method === 'POST') {
      const name = String(body.name || '').trim();
      if (!name) fail(400, 'Name is required');
      if (store.findUserByName(name)) fail(409, 'Someone with that name already has an account');
      const role = store.ROLES.includes(body.role) ? body.role : 'tech';
      const problem = auth.secretProblem(body.secret, role);
      if (problem) fail(400, problem);
      const u = store.createUser({ name, role, ...auth.hashSecret(body.secret) });
      return sendJson(res, 201, store.publicUser(u));
    }
    if (method === 'PATCH' && seg[2]) {
      const target = store.findUser(seg[2]);
      if (!target) fail(404, 'not found');
      const patch = {};
      if ('role' in body && store.ROLES.includes(body.role)) patch.role = body.role;
      if ('active' in body) patch.active = !!body.active;
      if ('name' in body && String(body.name).trim()) {
        const clash = store.findUserByName(body.name);
        if (clash && clash.id !== target.id) fail(409, 'That name is taken');
        patch.name = String(body.name).trim();
      }
      const finalRole = patch.role || target.role;
      const finalActive = 'active' in patch ? patch.active : target.active;
      if (target.role === 'supervisor' && (finalRole !== 'supervisor' || !finalActive)) {
        const others = store.listUsers().filter((u) => u.id !== target.id && u.role === 'supervisor' && u.active);
        if (!others.length) fail(400, 'Keep at least one active supervisor');
      }
      if (body.secret) {
        const problem = auth.secretProblem(body.secret, finalRole);
        if (problem) fail(400, problem);
        Object.assign(patch, auth.hashSecret(body.secret));
        store.deleteSessions((s) => s.userId === target.id && s.id !== req.sessionId);
      } else if (finalRole === 'supervisor' && target.role !== 'supervisor') {
        fail(400, `Set a new password (${auth.MIN_SUPERVISOR_SECRET}+ characters) when promoting to supervisor`);
      }
      if (patch.active === false) store.deleteSessions((s) => s.userId === target.id);
      return sendJson(res, 200, store.publicUser(store.updateUser(target.id, patch)));
    }
  }

  // ---------------------------------------------------------- machines
  if (seg[1] === 'machines') {
    if (method === 'GET') return sendJson(res, 200, store.listMachines());
    const body = await readBody(req);
    if (method === 'POST') {
      if (!String(body.name || '').trim()) fail(400, 'name is required');
      return sendJson(res, 201, store.createMachine(body));
    }
    if (method === 'PATCH' && seg[2]) {
      requireSupervisor(user);
      const m = store.updateMachine(seg[2], body);
      return m ? sendJson(res, 200, m) : fail(404, 'not found');
    }
  }

  // ------------------------------------------------------- work orders
  if (seg[1] === 'work-orders') {
    if (method === 'GET' && !seg[2]) {
      let list = store.listWorkOrders();
      if (q('status') === 'open') list = list.filter((w) => !store.CLOSED.includes(w.status));
      if (q('machineId')) list = list.filter((w) => w.machineId === q('machineId'));
      return sendJson(res, 200, list);
    }
    if (method === 'GET' && seg[2]) {
      const wo = store.findWorkOrder(seg[2]);
      if (!wo) fail(404, 'not found');
      return sendJson(res, 200, {
        workOrder: wo,
        logs: store.listWorkLogs().filter((l) => l.workOrderId === wo.id)
          .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
        parts: store.listParts().filter((p) => p.workOrderId === wo.id),
        pm: wo.pmId ? store.findPmSchedule(wo.pmId) : null,
      });
    }
    const body = await readBody(req);
    if (method === 'POST' && !seg[2]) {
      const m = resolveMachineFromBody(body);
      if (body.orderNumber && store.findWorkOrderByNumber(body.orderNumber)) {
        fail(409, `Work order #${body.orderNumber} already exists`);
      }
      const wo = store.createWorkOrder({ ...body, machineId: m ? m.id : null, source: body.source || 'manual' }, user.name);
      return sendJson(res, 201, wo);
    }
    if (method === 'POST' && seg[3] === 'notes') {
      if (!String(body.text || '').trim()) fail(400, 'Note is empty');
      const wo = store.addWorkOrderNote(seg[2], body.text, user.name);
      return wo ? sendJson(res, 201, wo) : fail(404, 'not found');
    }
    if (method === 'PATCH' && seg[2]) {
      const wo = store.findWorkOrder(seg[2]);
      if (!wo) fail(404, 'not found');
      if (body.machineName !== undefined && !body.machineId) {
        const m = resolveMachineFromBody(body);
        body.machineId = m ? m.id : null;
      }
      return sendJson(res, 200, changeWorkOrder(wo, body, user.name));
    }
    if (method === 'DELETE' && seg[2]) {
      requireSupervisor(user);
      return store.deleteWorkOrder(seg[2]) ? sendJson(res, 200, { ok: true }) : fail(404, 'not found');
    }
  }

  // --------------------------------------------------------- work logs
  if (seg[1] === 'work-logs') {
    if (method === 'GET') {
      const from = q('from'), to = q('to') || q('from'), tech = q('technician');
      let list = store.listWorkLogs();
      if (from) list = list.filter((l) => l.date >= from && l.date <= to);
      if (tech) list = list.filter((l) => l.technician === tech);
      return sendJson(res, 200, list);
    }
    const body = await readBody(req);

    if (method === 'POST' && !seg[2]) {
      const dup = store.findWorkLogByClientId(body.clientId);
      if (dup) return sendJson(res, 200, { log: dup, duplicate: true });
      return sendJson(res, 201, commitWork(body, user));
    }

    if ((method === 'PATCH' || method === 'DELETE') && seg[2]) {
      const log = store.findWorkLog(seg[2]);
      if (!log) fail(404, 'not found');
      if (!canEditLog(user, log)) fail(403, 'You can only change your own entries');
      if (method === 'DELETE') {
        removeWorkLog(log);
        return sendJson(res, 200, { ok: true });
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
      return sendJson(res, 200, store.updateWorkLog(log.id, patch));
    }
  }

  // ------------------------------------------------------------- parts
  if (seg[1] === 'parts') {
    if (method === 'GET') return sendJson(res, 200, store.listParts());
    const body = await readBody(req);
    if (method === 'POST') {
      if (!String(body.name || '').trim()) fail(400, 'name is required');
      let m = resolveMachineFromBody(body);
      const wo = body.workOrderId ? store.findWorkOrder(body.workOrderId) : null;
      if (!m && wo && wo.machineId) m = store.findMachine(wo.machineId);
      const part = store.createPart({ ...body, machineId: m ? m.id : null, workOrderId: wo ? wo.id : null, requestedBy: user.name });
      if (wo && part.status === 'needed' && ['open', 'in_progress'].includes(wo.status)) {
        changeWorkOrder(wo, { status: 'waiting_parts' }, user.name);
      }
      return sendJson(res, 201, part);
    }
    if (method === 'PATCH' && seg[2]) {
      if (body.machineName !== undefined) {
        const m = resolveMachineFromBody({ machineName: body.machineName });
        body.machineId = m ? m.id : null;
      }
      const part = store.updatePart(seg[2], body);
      return part ? sendJson(res, 200, part) : fail(404, 'not found');
    }
    if (method === 'DELETE' && seg[2]) {
      return store.deletePart(seg[2]) ? sendJson(res, 200, { ok: true }) : fail(404, 'not found');
    }
  }

  // ------------------------------------------------ preventive maintenance
  if (seg[1] === 'pm') {
    if (method === 'GET') return sendJson(res, 200, store.listPmSchedules());
    requireSupervisor(user);
    const body = await readBody(req);
    if (method === 'POST' && seg[2] === 'run') return sendJson(res, 200, { created: pm.generateDue() });
    if (body.machineName !== undefined) {
      const m = resolveMachineFromBody({ machineName: body.machineName });
      body.machineId = m ? m.id : null;
    }
    if (method === 'POST' && !seg[2]) {
      const created = store.createPmSchedule(body);
      pm.generateDue();
      return sendJson(res, 201, created);
    }
    if (method === 'PATCH' && seg[2]) {
      const updated = store.updatePmSchedule(seg[2], body);
      if (!updated) fail(404, 'not found');
      pm.generateDue();
      return sendJson(res, 200, updated);
    }
    if (method === 'DELETE' && seg[2]) {
      return store.deletePmSchedule(seg[2]) ? sendJson(res, 200, { ok: true }) : fail(404, 'not found');
    }
  }

  // ----------------------------------------------------------- reports
  if (seg[1] === 'reports') {
    if (method === 'GET' && !seg[2]) {
      return sendJson(res, 200, reports.buildReport({
        from: q('from'), to: q('to'), technician: q('technician'), tz: q('tz'),
      }));
    }
    if (method === 'PUT' && seg[2] === 'notes') {
      const body = await readBody(req);
      if (!/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(String(body.key || ''))) fail(400, 'bad report key');
      return sendJson(res, 200, store.setReportNote(body.key, body.text, user.name));
    }
  }

  // ------------------------------------------------------------ ingest
  if (seg[1] === 'ingest' && method === 'POST') {
    const body = await readBody(req);
    if (seg[2] === 'email') {
      if (!body.subject && !body.body) fail(400, 'subject or body required');
      return sendJson(res, 201, ingestEmail(body, user.name));
    }
    if (seg[2] === 'notes' && seg[3] === 'preview') {
      if (!body.text) fail(400, 'text required');
      return sendJson(res, 200, parser.parseNotes(body.text, store.listMachines().map((m) => m.name)));
    }
    // Voice / typed / pasted entries all land here. Resends from the
    // tablet's offline queue are recognised by clientId and ignored.
    if (seg[2] === 'notes') {
      if (!String(body.text || '').trim()) fail(400, 'Say or type what you did first');
      const dup = store.findWorkLogByClientId(body.clientId);
      if (dup) return sendJson(res, 200, { log: dup, duplicate: true });
      const parsed = parser.parseNotes(body.text, store.listMachines().map((m) => m.name));
      const o = body.overrides || {};
      const out = commitWork({
        technician: body.technician,
        date: body.date,
        machineName: o.machineName ?? parsed.machineName,
        orderNumber: o.orderNumber ?? parsed.orderNumber,
        attachToOpen: true,
        minutes: o.minutes ?? parsed.minutes ?? 0,
        notes: parsed.notes,
        partsUsed: o.partsUsed ?? parsed.partsUsed,
        partsNeeded: o.partsNeeded ?? parsed.partsNeeded,
        statusAfter: o.statusHint ?? parsed.statusHint,
        clientId: body.clientId,
        defaultNewStatus: 'completed',
        source: ['voice', 'typed', 'notes'].includes(body.source) ? body.source : 'notes',
      }, user);
      return sendJson(res, 201, { parsed, ...out });
    }
  }

  // ------------------------------------------------------------ export
  if (method === 'GET' && seg[1] === 'export') {
    requireSupervisor(user);
    const d = store.load();
    const safe = { ...d, users: d.users.map(store.publicUser), sessions: undefined };
    return sendJson(res, 200, safe, {
      'Content-Disposition': `attachment; filename="maintenance-export-${store.localDate()}.json"`,
    });
  }

  fail(404, 'no such endpoint');
}

function serveStatic(req, res, url) {
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(decodeURIComponent(filePath)).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); res.end(); return; }
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    return sendJson(res, 500, { error: 'Server error: ' + err.message });
  }
});

// ------------------------------------------------------- background chores

let lastBackupDate = '';
function chores() {
  try {
    store.load();
    pm.generateDue();
    auth.pruneSessions();
    const today = store.localDate();
    if (lastBackupDate !== today && fs.existsSync(store.DB_FILE)) {
      store.saveNow();
      store.backupDaily();
      lastBackupDate = today;
    }
  } catch (err) {
    console.error('background chores failed:', err.message);
  }
}

process.on('SIGINT', () => { store.saveNow(); process.exit(0); });
process.on('SIGTERM', () => { store.saveNow(); process.exit(0); });

if (require.main === module) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use — the tracker is probably already running.`);
      console.error(`Open http://localhost:${PORT} in a browser, or start with a different PORT.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, () => {
    console.log(`Maintenance tracker running at http://localhost:${PORT}`);
    chores();
    setInterval(chores, 15 * 60000).unref();
  });
}

module.exports = { server, chores };
