'use strict';
/**
 * Maintenance dashboard server — zero dependencies, plain Node.
 *
 *   node server.js            start on http://localhost:3000
 *   PORT=8080 node server.js  pick a port
 *   DATA_DIR=/path node ...   store data somewhere else
 *
 * API surface (all JSON):
 *   GET  /api/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD&machineId=..&technician=..
 *   GET  /api/machines            POST /api/machines
 *   GET  /api/work-orders         POST /api/work-orders     PATCH /api/work-orders/:id
 *   GET  /api/work-logs           POST /api/work-logs
 *   GET  /api/parts               POST /api/parts           PATCH /api/parts/:id
 *   POST /api/ingest/email        { subject, body, from?, receivedAt? }
 *   POST /api/ingest/notes/preview { text }        -> parsed suggestion, no writes
 *   POST /api/ingest/notes        { text, technician?, date?, overrides? } -> commits
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const store = require('./lib/store');
const parser = require('./lib/parser');
const analytics = require('./lib/analytics');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const INGEST_TOKEN = process.env.INGEST_TOKEN || ''; // optional shared secret for /api/ingest/*

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) { // 1 MB is plenty for any email or note
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function parseDate(s, endOfDay = false) {
  if (!s) return null;
  const d = new Date(endOfDay ? s + 'T23:59:59.999' : s + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

// ------------------------------------------------------------- ingest flows

/** Turn a parsed email into records. Reuses the order if the WO# is known. */
function ingestEmail(payload) {
  const parsed = parser.parseEmail(payload);
  const machine = parsed.machineName ? store.resolveMachine(parsed.machineName) : null;

  const existing = parsed.orderNumber ? store.findWorkOrderByNumber(parsed.orderNumber) : null;
  if (existing) {
    return { created: false, workOrder: existing, parsed };
  }
  const wo = store.createWorkOrder({
    orderNumber: parsed.orderNumber,
    machineId: machine ? machine.id : null,
    title: parsed.title,
    description: parsed.description,
    priority: parsed.priority,
    source: 'email',
    createdAt: parsed.receivedAt || undefined,
  });
  return { created: true, workOrder: wo, parsed };
}

/**
 * Commit a parsed note: create a work log, attach it to a matching open work
 * order on that machine (or the WO# it names), file parts used/needed, and
 * nudge the order's status when the note clearly says fixed / waiting on parts.
 */
function ingestNotes(payload) {
  const knownNames = store.listMachines().map((m) => m.name);
  const parsed = parser.parseNotes(payload.text, knownNames);
  const o = payload.overrides || {};

  const machineName = o.machineName ?? parsed.machineName;
  const machine = machineName ? store.resolveMachine(machineName) : null;
  const technician = payload.technician || 'me';

  // Find the order this note belongs to: explicit WO# first, then the most
  // recent non-completed order on the machine, else create one from the note.
  let workOrder = null;
  const orderNumber = o.orderNumber ?? parsed.orderNumber;
  if (orderNumber) workOrder = store.findWorkOrderByNumber(orderNumber);
  if (!workOrder && machine) {
    workOrder = store.listWorkOrders()
      .filter((w) => w.machineId === machine.id && !['completed', 'cancelled'].includes(w.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
  }
  let createdOrder = false;
  if (!workOrder && machine) {
    workOrder = store.createWorkOrder({
      machineId: machine.id,
      title: (parsed.notes.split('\n')[0] || 'Work from notes').slice(0, 120),
      description: parsed.notes,
      source: 'notes',
      assignedTo: technician,
    });
    createdOrder = true;
  }

  const log = store.createWorkLog({
    workOrderId: workOrder ? workOrder.id : null,
    machineId: machine ? machine.id : (workOrder ? workOrder.machineId : null),
    technician,
    date: payload.date || new Date().toISOString().slice(0, 10),
    minutes: o.minutes ?? parsed.minutes ?? 0,
    notes: parsed.notes,
  });

  const partsUsed = (o.partsUsed ?? parsed.partsUsed).map((name) => store.createPart({
    name,
    machineId: log.machineId,
    workOrderId: log.workOrderId,
    status: 'installed',
    notes: 'from notes ' + log.date,
  }));
  const partsNeeded = (o.partsNeeded ?? parsed.partsNeeded).map((name) => store.createPart({
    name,
    machineId: log.machineId,
    workOrderId: log.workOrderId,
    status: 'needed',
    notes: 'from notes ' + log.date,
  }));

  const statusHint = o.statusHint ?? parsed.statusHint;
  if (workOrder && statusHint && workOrder.status !== 'completed') {
    store.updateWorkOrder(workOrder.id, { status: statusHint, assignedTo: workOrder.assignedTo || technician });
  }

  return { parsed, workOrder, createdOrder, log, partsUsed, partsNeeded };
}

// ------------------------------------------------------------------ routing

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // Optional shared-secret check for ingestion endpoints (used by email
  // forwarders hitting the webhook from outside).
  if (seg[1] === 'ingest' && INGEST_TOKEN) {
    const token = req.headers['x-ingest-token'] || url.searchParams.get('token');
    if (token !== INGEST_TOKEN) return sendJson(res, 401, { error: 'bad ingest token' });
  }

  // GET /api/dashboard — one call that feeds the whole UI.
  if (method === 'GET' && seg[1] === 'dashboard') {
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
      // Open orders always show regardless of range; completed ones only in range.
      !['completed', 'cancelled'].includes(w.status) ? true : inRange(w.completedAt || w.createdAt));
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

    return sendJson(res, 200, {
      machines: store.listMachines(),
      technicians: store.listTechnicians(),
      workOrders,
      workLogs,
      parts,
      summary: analytics.summary(from, to),
      perMachine: analytics.perMachineStats(from, to),
      ordersOverTime: analytics.ordersOverTime(from, to),
      flags: analytics.computeFlags().filter((f) => !machineId || f.machineId === machineId),
    });
  }

  if (seg[1] === 'machines') {
    if (method === 'GET') return sendJson(res, 200, store.listMachines());
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.name) return sendJson(res, 400, { error: 'name is required' });
      return sendJson(res, 201, store.createMachine(body));
    }
  }

  if (seg[1] === 'work-orders') {
    if (method === 'GET') return sendJson(res, 200, store.listWorkOrders());
    if (method === 'POST') {
      const body = await readBody(req);
      if (body.machineName && !body.machineId) {
        const m = store.resolveMachine(body.machineName);
        body.machineId = m ? m.id : null;
      }
      return sendJson(res, 201, store.createWorkOrder(body));
    }
    if (method === 'PATCH' && seg[2]) {
      const body = await readBody(req);
      const wo = store.updateWorkOrder(seg[2], body);
      return wo ? sendJson(res, 200, wo) : sendJson(res, 404, { error: 'not found' });
    }
  }

  if (seg[1] === 'work-logs') {
    if (method === 'GET') return sendJson(res, 200, store.listWorkLogs());
    if (method === 'POST') {
      const body = await readBody(req);
      if (body.machineName && !body.machineId) {
        const m = store.resolveMachine(body.machineName);
        body.machineId = m ? m.id : null;
      }
      return sendJson(res, 201, store.createWorkLog(body));
    }
  }

  if (seg[1] === 'parts') {
    if (method === 'GET') return sendJson(res, 200, store.listParts());
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.name) return sendJson(res, 400, { error: 'name is required' });
      if (body.machineName && !body.machineId) {
        const m = store.resolveMachine(body.machineName);
        body.machineId = m ? m.id : null;
      }
      return sendJson(res, 201, store.createPart(body));
    }
    if (method === 'PATCH' && seg[2]) {
      const body = await readBody(req);
      const part = store.updatePart(seg[2], body);
      return part ? sendJson(res, 200, part) : sendJson(res, 404, { error: 'not found' });
    }
  }

  if (seg[1] === 'ingest' && method === 'POST') {
    const body = await readBody(req);
    if (seg[2] === 'email') {
      if (!body.subject && !body.body) return sendJson(res, 400, { error: 'subject or body required' });
      return sendJson(res, 201, ingestEmail(body));
    }
    if (seg[2] === 'notes' && seg[3] === 'preview') {
      if (!body.text) return sendJson(res, 400, { error: 'text required' });
      const knownNames = store.listMachines().map((m) => m.name);
      return sendJson(res, 200, parser.parseNotes(body.text, knownNames));
    }
    if (seg[2] === 'notes') {
      if (!body.text) return sendJson(res, 400, { error: 'text required' });
      return sendJson(res, 201, ingestNotes(body));
    }
  }

  return sendJson(res, 404, { error: 'no such endpoint' });
}

function serveStatic(req, res, url) {
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    return sendJson(res, err.message === 'invalid JSON body' || err.message === 'body too large' ? 400 : 500,
      { error: err.message });
  }
});

process.on('SIGINT', () => { store.saveNow(); process.exit(0); });
process.on('SIGTERM', () => { store.saveNow(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`Maintenance dashboard running at http://localhost:${PORT}`);
});
