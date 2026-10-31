'use strict';
/**
 * JSON-file data store.
 *
 * Deliberately simple: all data lives in data/db.json and is loaded into
 * memory. Writes are atomic (write temp file, then rename). This is plenty
 * for a maintenance department's records; the accessor API below is the
 * contract, so the file backend can be swapped for SQLite/Postgres later
 * without touching the server or UI.
 *
 * Dates: "date" fields (work log date, due dates) are plain local calendar
 * strings "YYYY-MM-DD" chosen by the person entering them, so a report for
 * "Saturday" means Saturday where the work happened, regardless of what
 * time zone the server runs in. Timestamps (createdAt etc.) are ISO UTC.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SCHEMA_VERSION = 2;

const EMPTY_DB = {
  users: [],         // { id, name, role, salt, hash, active, createdAt }
  sessions: [],      // { id (sha256 of token), userId, createdAt, lastSeenAt, expiresAt }
  machines: [],      // { id, name, area, notes, createdAt }
  workOrders: [],    // { id, ref, orderNumber, machineId, title, description, priority, status,
                     //   assignedTo, dueDate, source, pmId, createdBy, history[],
                     //   createdAt, updatedAt, completedAt }
  workLogs: [],      // { id, workOrderId, machineId, technician, userId, loggedBy, date, minutes,
                     //   notes, running, startedAt, endedAt, entered, enteredAt, clientId,
                     //   createdAt, updatedAt }
  parts: [],         // { id, name, partNumber, quantity, machineId, workOrderId, status, vendor,
                     //   notes, requestedBy, orderedAt, receivedAt, installedAt, createdAt, updatedAt }
  pmSchedules: [],   // { id, machineId, title, description, intervalDays, leadDays, nextDueDate,
                     //   lastDoneDate, assignedTo, priority, active, createdAt, updatedAt }
  reportNotes: {},   // { [periodKey]: { text, by, updatedAt } }
  technicians: [],   // legacy name list from v1 (names now come from users + work logs)
  meta: { schemaVersion: SCHEMA_VERSION, nextRef: 1 },
};

const WORK_ORDER_STATUSES = ['open', 'in_progress', 'waiting_parts', 'completed', 'cancelled'];
const PART_STATUSES = ['needed', 'ordered', 'received', 'installed'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const ROLES = ['supervisor', 'tech'];
const CLOSED = ['completed', 'cancelled'];

let db = null;
let saveTimer = null;

function id() {
  return crypto.randomBytes(8).toString('hex');
}

function now() {
  return new Date().toISOString();
}

/** Local calendar date (server's time zone — set TZ=America/Chicago etc. on a cloud host). */
function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return localDate(d);
}

// ------------------------------------------------------------ load / save

function migrate(d) {
  for (const key of Object.keys(EMPTY_DB)) {
    if (!(key in d)) d[key] = structuredClone(EMPTY_DB[key]);
  }
  d.meta = { ...EMPTY_DB.meta, ...d.meta };
  if ((d.meta.schemaVersion || 1) < 2) {
    // v1 -> v2: give every existing order a short reference number and an
    // empty history; tag parts/logs with the new optional fields.
    const byAge = [...d.workOrders].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let ref = 1;
    for (const wo of byAge) {
      if (!wo.ref) wo.ref = ref++;
      wo.history = wo.history || [];
      if (!('dueDate' in wo)) wo.dueDate = null;
      if (!('pmId' in wo)) wo.pmId = null;
      if (!('createdBy' in wo)) wo.createdBy = '';
    }
    d.meta.nextRef = Math.max(ref, d.meta.nextRef || 1);
    for (const log of d.workLogs) {
      if (!('entered' in log)) log.entered = false;
      if (!('running' in log)) log.running = false;
    }
    d.meta.schemaVersion = 2;
  }
  return d;
}

function load() {
  if (db) return db;
  try {
    db = migrate(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    db = structuredClone(EMPTY_DB);
  }
  return db;
}

function writeFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function save() {
  // Coalesce bursts of writes into one disk write per tick.
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeFile(); }, 0);
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (db) writeFile();
}

/** Daily safety copy: data/backups/db-YYYY-MM-DD.json, keeps the last 30. */
function backupDaily() {
  if (!db) return null;
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `db-${localDate()}.json`);
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
  const old = fs.readdirSync(dir).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 30))) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && k in obj) out[k] = obj[k];
  return out;
}

// ------------------------------------------------------------------ users

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function publicUser(u) {
  return u ? { id: u.id, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt } : null;
}

function listUsers() { return load().users; }
function findUser(userId) { return load().users.find((u) => u.id === userId) || null; }
function findUserByName(name) {
  const n = normalizeName(name);
  return load().users.find((u) => normalizeName(u.name) === n) || null;
}

function createUser({ name, role, salt, hash }) {
  const u = {
    id: id(), name: String(name).trim().replace(/\s+/g, ' '),
    role: ROLES.includes(role) ? role : 'tech',
    salt, hash, active: true, createdAt: now(),
  };
  load().users.push(u);
  save();
  return u;
}

function updateUser(userId, fields) {
  const u = findUser(userId);
  if (!u) return null;
  Object.assign(u, pick(fields, ['name', 'role', 'salt', 'hash', 'active']));
  save();
  return u;
}

// --------------------------------------------------------------- sessions

function createSession(tokenHash, userId, ttlDays) {
  const d = load();
  const s = {
    id: tokenHash, userId, createdAt: now(), lastSeenAt: now(),
    expiresAt: new Date(Date.now() + ttlDays * 86400000).toISOString(),
  };
  d.sessions.push(s);
  save();
  return s;
}

function findSession(tokenHash) {
  return load().sessions.find((s) => s.id === tokenHash) || null;
}

function touchSession(s, ttlDays) {
  // Sliding expiry, but only write to disk about once an hour per session.
  if (Date.now() - new Date(s.lastSeenAt).getTime() < 3600000) return;
  s.lastSeenAt = now();
  s.expiresAt = new Date(Date.now() + ttlDays * 86400000).toISOString();
  save();
}

function deleteSessions(predicate) {
  const d = load();
  const before = d.sessions.length;
  d.sessions = d.sessions.filter((s) => !predicate(s));
  if (d.sessions.length !== before) save();
}

// ---------------------------------------------------------------- machines

function listMachines() {
  return load().machines;
}

function findMachine(machineId) {
  return load().machines.find((m) => m.id === machineId) || null;
}

/** Find a machine by (fuzzy) name, or create it. Parsers rely on this so an
 *  email mentioning a machine we haven't seen yet still lands somewhere. */
function resolveMachine(name, { create = true } = {}) {
  const norm = normalizeName(name);
  if (!norm) return null;
  const d = load();
  let m = d.machines.find((x) => normalizeName(x.name) === norm);
  if (!m) {
    // Substring match either direction: "CNC 3" matches "CNC 3 (Haas)".
    m = d.machines.find((x) => {
      const xn = normalizeName(x.name);
      return xn.length >= 3 && norm.length >= 3 && (xn.includes(norm) || norm.includes(xn));
    });
  }
  if (!m && create) {
    m = { id: id(), name: String(name).trim().replace(/\s+/g, ' '), area: '', notes: '', createdAt: now() };
    d.machines.push(m);
    save();
  }
  return m || null;
}

function createMachine({ name, area = '', notes = '' }) {
  const d = load();
  const existing = d.machines.find((m) => normalizeName(m.name) === normalizeName(name));
  if (existing) return existing;
  const m = { id: id(), name: String(name).trim(), area, notes, createdAt: now() };
  d.machines.push(m);
  save();
  return m;
}

function updateMachine(machineId, fields) {
  const m = findMachine(machineId);
  if (!m) return null;
  Object.assign(m, pick(fields, ['name', 'area', 'notes']));
  save();
  return m;
}

// ------------------------------------------------------------- work orders

function listWorkOrders() {
  return load().workOrders;
}

function findWorkOrder(woId) {
  return load().workOrders.find((w) => w.id === woId) || null;
}

function findWorkOrderByNumber(orderNumber) {
  if (!orderNumber) return null;
  const norm = String(orderNumber).trim().toLowerCase();
  return load().workOrders.find((w) => String(w.orderNumber).trim().toLowerCase() === norm) || null;
}

function createWorkOrder(fields, by = '') {
  const d = load();
  const wo = {
    id: id(),
    ref: d.meta.nextRef++,
    orderNumber: String(fields.orderNumber || '').trim(),
    machineId: fields.machineId || null,
    title: String(fields.title || '').trim() || 'Untitled work order',
    description: fields.description || '',
    priority: PRIORITIES.includes(fields.priority) ? fields.priority : 'medium',
    status: WORK_ORDER_STATUSES.includes(fields.status) ? fields.status : 'open',
    assignedTo: fields.assignedTo || '',
    dueDate: isDateStr(fields.dueDate) ? fields.dueDate : null,
    source: fields.source || 'manual',
    pmId: fields.pmId || null,
    createdBy: by || fields.createdBy || '',
    history: [{ at: now(), by, text: 'created' }],
    createdAt: fields.createdAt || now(),
    updatedAt: now(),
    completedAt: fields.completedAt || null,
  };
  d.workOrders.push(wo);
  save();
  return wo;
}

const WO_EDITABLE = ['orderNumber', 'machineId', 'title', 'description', 'priority',
  'status', 'assignedTo', 'dueDate', 'completedAt'];

function describeChange(key, from, to) {
  const show = (v) => (v === null || v === undefined || v === '') ? '—' : String(v).replace('_', ' ');
  if (key === 'description') return 'edited description';
  if (key === 'machineId') {
    const a = findMachine(from), b = findMachine(to);
    return `machine ${a ? a.name : '—'} → ${b ? b.name : '—'}`;
  }
  const label = { orderNumber: 'company WO#', assignedTo: 'assigned', dueDate: 'due' }[key] || key;
  return `${label} ${show(from)} → ${show(to)}`;
}

function updateWorkOrder(woId, fields, by = '') {
  const wo = findWorkOrder(woId);
  if (!wo) return null;
  const changes = [];
  for (const key of WO_EDITABLE) {
    if (!(key in fields)) continue;
    let v = fields[key];
    if (key === 'status' && !WORK_ORDER_STATUSES.includes(v)) continue;
    if (key === 'priority' && !PRIORITIES.includes(v)) continue;
    if (key === 'dueDate' && v && !isDateStr(v)) continue;
    if (key === 'dueDate' && !v) v = null;
    if (wo[key] === v) continue;
    if (key !== 'completedAt') changes.push(describeChange(key, wo[key], v));
    wo[key] = v;
  }
  if (wo.status === 'completed' && !wo.completedAt) wo.completedAt = now();
  if (wo.status !== 'completed' && 'status' in fields && !('completedAt' in fields)) wo.completedAt = null;
  if (changes.length) {
    wo.history = wo.history || [];
    wo.history.push({ at: now(), by, text: changes.join('; ') });
  }
  wo.updatedAt = now();
  save();
  return wo;
}

function addWorkOrderNote(woId, text, by = '') {
  const wo = findWorkOrder(woId);
  if (!wo) return null;
  wo.history = wo.history || [];
  wo.history.push({ at: now(), by, text: String(text).slice(0, 2000), note: true });
  wo.updatedAt = now();
  save();
  return wo;
}

function deleteWorkOrder(woId) {
  const d = load();
  const idx = d.workOrders.findIndex((w) => w.id === woId);
  if (idx < 0) return false;
  d.workOrders.splice(idx, 1);
  // Keep the time and parts history; just detach it from the deleted order.
  for (const l of d.workLogs) if (l.workOrderId === woId) l.workOrderId = null;
  for (const p of d.parts) if (p.workOrderId === woId) p.workOrderId = null;
  save();
  return true;
}

// --------------------------------------------------------------- work logs

function listWorkLogs() {
  return load().workLogs;
}

function findWorkLog(logId) {
  return load().workLogs.find((l) => l.id === logId) || null;
}

function findWorkLogByClientId(clientId) {
  if (!clientId) return null;
  return load().workLogs.find((l) => l.clientId === clientId) || null;
}

function createWorkLog(fields) {
  const d = load();
  const log = {
    id: id(),
    workOrderId: fields.workOrderId || null,
    machineId: fields.machineId || null,
    technician: fields.technician || '',
    userId: fields.userId || null,
    loggedBy: fields.loggedBy || '',
    date: isDateStr(fields.date) ? fields.date : localDate(),
    minutes: Math.max(0, Math.round(Number(fields.minutes) || 0)),
    notes: fields.notes || '',
    running: !!fields.running,
    startedAt: fields.startedAt || null,
    endedAt: fields.endedAt || null,
    entered: false,
    enteredAt: null,
    clientId: fields.clientId || null,
    source: fields.source || '',
    createdOrderId: fields.createdOrderId || null,
    createdAt: now(),
    updatedAt: now(),
  };
  d.workLogs.push(log);
  save();
  return log;
}

function updateWorkLog(logId, fields) {
  const log = findWorkLog(logId);
  if (!log) return null;
  const allowed = ['workOrderId', 'machineId', 'technician', 'userId', 'date', 'minutes', 'notes',
    'running', 'startedAt', 'endedAt', 'entered'];
  for (const key of allowed) {
    if (!(key in fields)) continue;
    if (key === 'date' && !isDateStr(fields.date)) continue;
    if (key === 'minutes') { log.minutes = Math.max(0, Math.round(Number(fields.minutes) || 0)); continue; }
    if (key === 'entered') {
      log.entered = !!fields.entered;
      log.enteredAt = log.entered ? now() : null;
      continue;
    }
    log[key] = fields[key];
  }
  log.updatedAt = now();
  save();
  return log;
}

function deleteWorkLog(logId) {
  const d = load();
  const idx = d.workLogs.findIndex((l) => l.id === logId);
  if (idx < 0) return false;
  d.workLogs.splice(idx, 1);
  save();
  return true;
}

// ------------------------------------------------------------------- parts
// (logId links a part to the work-log entry that used/requested it, so the
//  end-of-day list can show "parts used" next to each entry.)

function listParts() {
  return load().parts;
}

function findPart(partId) {
  return load().parts.find((p) => p.id === partId) || null;
}

function stampPartStatus(part, status, at = now()) {
  const field = { ordered: 'orderedAt', received: 'receivedAt', installed: 'installedAt' }[status];
  if (field && !part[field]) part[field] = at;
}

function createPart(fields) {
  const d = load();
  const part = {
    id: id(),
    name: String(fields.name || '').trim() || 'Unnamed part',
    partNumber: fields.partNumber || '',
    quantity: Number(fields.quantity) || 1,
    machineId: fields.machineId || null,
    workOrderId: fields.workOrderId || null,
    logId: fields.logId || null,
    status: PART_STATUSES.includes(fields.status) ? fields.status : 'needed',
    vendor: fields.vendor || '',
    notes: fields.notes || '',
    requestedBy: fields.requestedBy || '',
    orderedAt: null,
    receivedAt: null,
    installedAt: null,
    createdAt: fields.createdAt || now(),
    updatedAt: now(),
  };
  stampPartStatus(part, part.status, part.createdAt);
  d.parts.push(part);
  save();
  return part;
}

function updatePart(partId, fields) {
  const part = findPart(partId);
  if (!part) return null;
  const allowed = ['name', 'partNumber', 'quantity', 'machineId', 'workOrderId', 'status', 'vendor', 'notes'];
  for (const key of allowed) {
    if (!(key in fields)) continue;
    if (key === 'status' && !PART_STATUSES.includes(fields.status)) continue;
    part[key] = key === 'quantity' ? (Number(fields.quantity) || 1) : fields[key];
  }
  if ('status' in fields) stampPartStatus(part, part.status);
  part.updatedAt = now();
  save();
  return part;
}

function deletePart(partId) {
  const d = load();
  const idx = d.parts.findIndex((p) => p.id === partId);
  if (idx < 0) return false;
  d.parts.splice(idx, 1);
  save();
  return true;
}

// ---------------------------------------------------- preventive maintenance

function listPmSchedules() {
  return load().pmSchedules;
}

function findPmSchedule(pmId) {
  return load().pmSchedules.find((p) => p.id === pmId) || null;
}

function createPmSchedule(fields) {
  const pm = {
    id: id(),
    machineId: fields.machineId || null,
    title: String(fields.title || '').trim() || 'Preventive maintenance',
    description: fields.description || '',
    intervalDays: Math.max(1, Math.round(Number(fields.intervalDays) || 30)),
    leadDays: Math.max(0, Math.round(Number(fields.leadDays ?? 3))),
    nextDueDate: isDateStr(fields.nextDueDate) ? fields.nextDueDate : localDate(),
    lastDoneDate: isDateStr(fields.lastDoneDate) ? fields.lastDoneDate : null,
    assignedTo: fields.assignedTo || '',
    priority: PRIORITIES.includes(fields.priority) ? fields.priority : 'medium',
    active: fields.active !== false,
    createdAt: now(),
    updatedAt: now(),
  };
  load().pmSchedules.push(pm);
  save();
  return pm;
}

function updatePmSchedule(pmId, fields) {
  const pm = findPmSchedule(pmId);
  if (!pm) return null;
  for (const key of ['machineId', 'title', 'description', 'assignedTo', 'active']) {
    if (key in fields) pm[key] = fields[key];
  }
  if ('priority' in fields && PRIORITIES.includes(fields.priority)) pm.priority = fields.priority;
  if ('intervalDays' in fields) pm.intervalDays = Math.max(1, Math.round(Number(fields.intervalDays) || 30));
  if ('leadDays' in fields) pm.leadDays = Math.max(0, Math.round(Number(fields.leadDays) || 0));
  if ('nextDueDate' in fields && isDateStr(fields.nextDueDate)) pm.nextDueDate = fields.nextDueDate;
  if ('lastDoneDate' in fields && (fields.lastDoneDate === null || isDateStr(fields.lastDoneDate))) pm.lastDoneDate = fields.lastDoneDate;
  pm.updatedAt = now();
  save();
  return pm;
}

function deletePmSchedule(pmId) {
  const d = load();
  const idx = d.pmSchedules.findIndex((p) => p.id === pmId);
  if (idx < 0) return false;
  d.pmSchedules.splice(idx, 1);
  save();
  return true;
}

// ------------------------------------------------------------ report notes

function getReportNote(key) {
  return load().reportNotes[key] || null;
}

function setReportNote(key, text, by) {
  load().reportNotes[key] = { text: String(text || '').slice(0, 20000), by, updatedAt: now() };
  save();
  return load().reportNotes[key];
}

// ------------------------------------------------------------- technicians

function listTechnicians() {
  return load().technicians;
}

function resolveTechnician(name) {
  const norm = normalizeName(name);
  if (!norm) return null;
  const d = load();
  let t = d.technicians.find((x) => normalizeName(x.name) === norm);
  if (!t) {
    t = { id: id(), name: String(name).trim(), email: '' };
    d.technicians.push(t);
    save();
  }
  return t;
}

/** Every name that has done or been assigned work, plus all active users. */
function allTechnicianNames() {
  const d = load();
  const names = new Set();
  for (const u of d.users) if (u.active) names.add(u.name);
  for (const t of d.technicians) names.add(t.name);
  for (const l of d.workLogs) if (l.technician) names.add(l.technician);
  return [...names].sort((a, b) => a.localeCompare(b));
}

module.exports = {
  load, save, saveNow, backupDaily, DATA_DIR, DB_FILE,
  WORK_ORDER_STATUSES, PART_STATUSES, PRIORITIES, ROLES, CLOSED,
  localDate, isDateStr, addDays, normalizeName,
  listUsers, findUser, findUserByName, createUser, updateUser, publicUser,
  createSession, findSession, touchSession, deleteSessions,
  listMachines, findMachine, resolveMachine, createMachine, updateMachine,
  listWorkOrders, findWorkOrder, findWorkOrderByNumber, createWorkOrder, updateWorkOrder,
  addWorkOrderNote, deleteWorkOrder,
  listWorkLogs, findWorkLog, findWorkLogByClientId, createWorkLog, updateWorkLog, deleteWorkLog,
  listParts, findPart, createPart, updatePart, deletePart,
  listPmSchedules, findPmSchedule, createPmSchedule, updatePmSchedule, deletePmSchedule,
  getReportNote, setReportNote,
  listTechnicians, resolveTechnician, allTechnicianNames,
};
