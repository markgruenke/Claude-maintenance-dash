'use strict';
/**
 * JSON-file data store.
 *
 * Deliberately simple: all data lives in data/db.json and is loaded into
 * memory. Writes are atomic (write temp file, then rename). This is plenty
 * for a small team's maintenance records; the accessor API below is the
 * contract, so the file backend can be swapped for SQLite/Postgres later
 * without touching the server or UI.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY_DB = {
  machines: [],      // { id, name, area, notes, createdAt }
  workOrders: [],    // { id, orderNumber, machineId, title, description, priority,
                     //   status, assignedTo, source, createdAt, updatedAt, completedAt }
  workLogs: [],      // { id, workOrderId, machineId, technician, date, minutes, notes, createdAt }
  parts: [],         // { id, name, partNumber, quantity, machineId, workOrderId,
                     //   status, notes, createdAt, updatedAt }
  technicians: [],   // { id, name, email }
  meta: { schemaVersion: 1 },
};

const WORK_ORDER_STATUSES = ['open', 'in_progress', 'waiting_parts', 'completed', 'cancelled'];
const PART_STATUSES = ['needed', 'ordered', 'received', 'installed'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

let db = null;
let saveTimer = null;

function id() {
  return crypto.randomBytes(8).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // Fill in any collections added after this file was first written.
    for (const key of Object.keys(EMPTY_DB)) {
      if (!(key in db)) db[key] = structuredClone(EMPTY_DB[key]);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    db = structuredClone(EMPTY_DB);
  }
  return db;
}

function save() {
  // Coalesce bursts of writes into one disk write per tick.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 0);
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------------------------------------------------------------- machines

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

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

function createWorkOrder(fields) {
  const d = load();
  const wo = {
    id: id(),
    orderNumber: fields.orderNumber || '',
    machineId: fields.machineId || null,
    title: fields.title || 'Untitled work order',
    description: fields.description || '',
    priority: PRIORITIES.includes(fields.priority) ? fields.priority : 'medium',
    status: WORK_ORDER_STATUSES.includes(fields.status) ? fields.status : 'open',
    assignedTo: fields.assignedTo || '',
    source: fields.source || 'manual',
    createdAt: fields.createdAt || now(),
    updatedAt: now(),
    completedAt: fields.completedAt || null,
  };
  d.workOrders.push(wo);
  save();
  return wo;
}

function updateWorkOrder(woId, fields) {
  const wo = findWorkOrder(woId);
  if (!wo) return null;
  const allowed = ['orderNumber', 'machineId', 'title', 'description', 'priority',
    'status', 'assignedTo', 'completedAt'];
  for (const key of allowed) {
    if (key in fields) wo[key] = fields[key];
  }
  if (fields.status === 'completed' && !wo.completedAt) wo.completedAt = now();
  if (fields.status && fields.status !== 'completed' && !('completedAt' in fields)) wo.completedAt = null;
  wo.updatedAt = now();
  save();
  return wo;
}

// --------------------------------------------------------------- work logs

function listWorkLogs() {
  return load().workLogs;
}

function createWorkLog(fields) {
  const d = load();
  const log = {
    id: id(),
    workOrderId: fields.workOrderId || null,
    machineId: fields.machineId || null,
    technician: fields.technician || '',
    date: fields.date || now().slice(0, 10),
    minutes: Number(fields.minutes) || 0,
    notes: fields.notes || '',
    createdAt: now(),
  };
  d.workLogs.push(log);
  save();
  return log;
}

// ------------------------------------------------------------------- parts

function listParts() {
  return load().parts;
}

function findPart(partId) {
  return load().parts.find((p) => p.id === partId) || null;
}

function createPart(fields) {
  const d = load();
  const part = {
    id: id(),
    name: fields.name || 'Unnamed part',
    partNumber: fields.partNumber || '',
    quantity: Number(fields.quantity) || 1,
    machineId: fields.machineId || null,
    workOrderId: fields.workOrderId || null,
    status: PART_STATUSES.includes(fields.status) ? fields.status : 'needed',
    notes: fields.notes || '',
    createdAt: now(),
    updatedAt: now(),
  };
  d.parts.push(part);
  save();
  return part;
}

function updatePart(partId, fields) {
  const part = findPart(partId);
  if (!part) return null;
  const allowed = ['name', 'partNumber', 'quantity', 'machineId', 'workOrderId', 'status', 'notes'];
  for (const key of allowed) {
    if (key in fields) part[key] = fields[key];
  }
  part.updatedAt = now();
  save();
  return part;
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

module.exports = {
  load, save, saveNow,
  WORK_ORDER_STATUSES, PART_STATUSES, PRIORITIES,
  listMachines, findMachine, resolveMachine, createMachine,
  listWorkOrders, findWorkOrder, findWorkOrderByNumber, createWorkOrder, updateWorkOrder,
  listWorkLogs, createWorkLog,
  listParts, findPart, createPart, updatePart,
  listTechnicians, resolveTechnician,
};
