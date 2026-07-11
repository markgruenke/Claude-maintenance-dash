'use strict';
/**
 * Seed realistic demo data so the dashboard has something to show.
 *
 *   node scripts/seed.js          add demo data (refuses if data already exists)
 *   node scripts/seed.js --force  wipe and reseed
 *   node scripts/seed.js --clear  wipe everything (start fresh for real use)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const force = process.argv.includes('--force');
const clear = process.argv.includes('--clear');

if (clear) {
  fs.rmSync(DB_FILE, { force: true });
  console.log('Data cleared. The dashboard starts empty now.');
  process.exit(0);
}

if (fs.existsSync(DB_FILE) && !force) {
  const existing = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if ((existing.workOrders || []).length > 0) {
    console.error('data/db.json already has work orders. Use --force to wipe and reseed.');
    process.exit(1);
  }
}

const store = require('../lib/store');
if (force) {
  fs.rmSync(DB_FILE, { force: true });
}

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const dateAgo = (n) => daysAgo(n).slice(0, 10);

const machines = {
  cnc3: store.createMachine({ name: 'CNC 3', area: 'Machining' }),
  cnc1: store.createMachine({ name: 'CNC 1', area: 'Machining' }),
  press2: store.createMachine({ name: 'Press 2', area: 'Stamping' }),
  conveyorA: store.createMachine({ name: 'Conveyor A', area: 'Assembly' }),
  welder1: store.createMachine({ name: 'Welder 1', area: 'Fabrication' }),
  compressor: store.createMachine({ name: 'Air Compressor', area: 'Facilities' }),
};

store.resolveTechnician('Mark');

function wo(machine, fields) {
  return store.createWorkOrder({ machineId: machine.id, assignedTo: 'Mark', ...fields });
}

function log(machine, order, n, minutes, notes) {
  store.createWorkLog({
    machineId: machine.id, workOrderId: order ? order.id : null,
    technician: 'Mark', date: dateAgo(n), minutes, notes,
  });
}

// --- Press 2: frequent breakdowns (trips the 3-in-30-days flag) + repeat issue
const p1 = wo(machines.press2, { orderNumber: '10241', title: 'Hydraulic pressure dropping', description: 'Press 2 losing pressure mid-cycle, suspect pump seal', priority: 'high', status: 'completed', createdAt: daysAgo(24), completedAt: daysAgo(23), source: 'email' });
const p2 = wo(machines.press2, { orderNumber: '10288', title: 'Hydraulic pressure dropping again', description: 'Same pressure loss on Press 2, pump seal replaced 3 weeks ago', priority: 'high', status: 'in_progress', createdAt: daysAgo(6), source: 'email' });
const p3 = wo(machines.press2, { orderNumber: '10262', title: 'Die alignment off', description: 'Parts coming out of spec on Press 2', priority: 'medium', status: 'completed', createdAt: daysAgo(14), completedAt: daysAgo(13), source: 'email' });
log(machines.press2, p1, 23, 150, 'Replaced hydraulic pump seal on Press 2, tested at full pressure, back up and running');
log(machines.press2, p3, 13, 90, 'Realigned die on Press 2, ran test batch, parts in spec');
log(machines.press2, p2, 5, 120, 'Tore down pump on Press 2 again, seal is fine — scoring on the cylinder wall. Need to order a hydraulic cylinder.');

// --- CNC 3: steady work
const c1 = wo(machines.cnc3, { orderNumber: '10195', title: 'Spindle belt squealing', description: 'Belt noise at high RPM on CNC 3', priority: 'medium', status: 'completed', createdAt: daysAgo(41), completedAt: daysAgo(40), source: 'email' });
const c2 = wo(machines.cnc3, { orderNumber: '10301', title: 'Coolant not flowing', description: 'Coolant pump on CNC 3 not priming', priority: 'high', status: 'waiting_parts', createdAt: daysAgo(3), source: 'email' });
log(machines.cnc3, c1, 40, 75, 'Replaced spindle belt on CNC 3, tensioned and tested');
log(machines.cnc3, c2, 2, 60, 'Diagnosed coolant pump on CNC 3, impeller cracked. Waiting on a coolant pump.');

// --- Conveyor A: stale order (trips the 14-day flag)
const v1 = wo(machines.conveyorA, { orderNumber: '10218', title: 'Belt tracking drift', description: 'Conveyor A belt drifting left, needs tracking adjustment and possibly new idler', priority: 'low', status: 'open', createdAt: daysAgo(19), source: 'email' });
log(machines.conveyorA, v1, 17, 45, 'Adjusted tracking on Conveyor A, drifting back after a shift. Idler bearing worn.');

// --- Welder 1 + CNC 1 + compressor: background activity
const w1 = wo(machines.welder1, { orderNumber: '10250', title: 'Wire feed jamming', description: 'Feed motor sticking on Welder 1', priority: 'medium', status: 'completed', createdAt: daysAgo(16), completedAt: daysAgo(15), source: 'email' });
log(machines.welder1, w1, 15, 105, 'Cleaned and rebuilt wire feed on Welder 1, replaced drive rollers');
const n1 = wo(machines.cnc1, { orderNumber: '10275', title: 'Way lube alarm', description: 'Low way lube pressure alarm on CNC 1', priority: 'low', status: 'completed', createdAt: daysAgo(9), completedAt: daysAgo(9), source: 'email' });
log(machines.cnc1, n1, 9, 30, 'Topped off way lube on CNC 1 and cleared alarm, checked lines for leaks');
const a1 = wo(machines.compressor, { orderNumber: '10310', title: 'Compressor short-cycling', description: 'Air compressor kicking on and off rapidly', priority: 'urgent', status: 'open', createdAt: daysAgo(1), source: 'email' });
log(machines.compressor, a1, 0, 40, 'Checked air compressor, pressure switch chattering. Need to order a pressure switch.');

// Older history so the trend chart has shape
const h1 = wo(machines.cnc1, { orderNumber: '10102', title: 'Tool changer fault', description: 'ATC arm stalling on CNC 1', priority: 'high', status: 'completed', createdAt: daysAgo(62), completedAt: daysAgo(60), source: 'email' });
log(machines.cnc1, h1, 60, 180, 'Rebuilt ATC arm on CNC 1, replaced solenoid');
const h2 = wo(machines.conveyorA, { orderNumber: '10150', title: 'Motor overload trips', description: 'Conveyor A drive motor tripping overloads', priority: 'medium', status: 'completed', createdAt: daysAgo(50), completedAt: daysAgo(49), source: 'email' });
log(machines.conveyorA, h2, 49, 95, 'Replaced drive motor overload relay on Conveyor A');

// Parts
store.createPart({ name: 'hydraulic cylinder', machineId: machines.press2.id, workOrderId: p2.id, status: 'needed', notes: 'from notes ' + dateAgo(5), createdAt: daysAgo(5) });
store.createPart({ name: 'coolant pump', partNumber: 'CP-4410', machineId: machines.cnc3.id, workOrderId: c2.id, status: 'ordered', notes: 'ETA next week' });
store.createPart({ name: 'idler bearing', machineId: machines.conveyorA.id, workOrderId: v1.id, status: 'needed', notes: 'from notes ' + dateAgo(17) });
store.createPart({ name: 'pressure switch', machineId: machines.compressor.id, workOrderId: a1.id, status: 'needed' });
store.createPart({ name: 'spindle belt', partNumber: 'SB-220', machineId: machines.cnc3.id, workOrderId: c1.id, status: 'installed' });
store.createPart({ name: 'hydraulic pump seal', machineId: machines.press2.id, workOrderId: p1.id, status: 'installed' });
store.createPart({ name: 'drive rollers', machineId: machines.welder1.id, workOrderId: w1.id, status: 'installed' });

// Backdate the "needed" parts so the overdue-part flag has something to catch.
const db = store.load();
for (const part of db.parts) {
  if (part.name === 'idler bearing') part.createdAt = daysAgo(17);
  if (part.name === 'hydraulic cylinder') part.createdAt = daysAgo(5);
}

store.saveNow();
console.log('Seeded demo data:');
console.log(`  ${db.machines.length} machines, ${db.workOrders.length} work orders, ${db.workLogs.length} work logs, ${db.parts.length} parts`);
console.log('Run `node scripts/seed.js --clear` to wipe it when you want to start tracking real work.');
