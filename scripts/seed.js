'use strict';
/**
 * Demo data so every screen has something to show.
 *
 *   node scripts/seed.js                 add demo data (refuses if work data already exists)
 *   node scripts/seed.js --force         wipe work data and reseed
 *   node scripts/seed.js --clear         wipe work data, KEEP accounts (start real tracking)
 *   node scripts/seed.js --clear --all   wipe everything, including accounts
 *
 * Stop the server first: it keeps data in memory and would overwrite changes
 * made underneath it.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT) || 3000;

const force = process.argv.includes('--force');
const clear = process.argv.includes('--clear');
const all = process.argv.includes('--all');

function serverRunning() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/auth/status', timeout: 800 }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function wipeWorkData(keepAccounts) {
  if (!fs.existsSync(DB_FILE)) return;
  if (!keepAccounts) { fs.rmSync(DB_FILE, { force: true }); return; }
  const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const kept = { users: d.users || [], sessions: d.sessions || [], meta: { schemaVersion: 2, nextRef: 1 } };
  fs.writeFileSync(DB_FILE, JSON.stringify(kept, null, 2));
}

(async () => {
  if (await serverRunning()) {
    console.error(`The tracker is running on port ${PORT}. Close it first (close its window), then run this again.`);
    process.exit(1);
  }

  if (clear) {
    wipeWorkData(!all);
    console.log(all ? 'Everything erased, including accounts. Next visit starts first-time setup.'
      : 'Work data erased. Accounts kept — sign in as usual and start tracking real work.');
    return;
  }

  if (fs.existsSync(DB_FILE) && !force) {
    const existing = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if ((existing.workOrders || []).length > 0) {
      console.error('There is already work data. Use --force to wipe it and load demo data.');
      process.exit(1);
    }
  }
  if (force) wipeWorkData(true);

  const store = require('../lib/store');
  const DAY = 86400000;
  const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
  const dateAgo = (n) => store.localDate(new Date(Date.now() - n * DAY));

  const m = {
    cnc3: store.createMachine({ name: 'CNC 3', area: 'Machining' }),
    cnc1: store.createMachine({ name: 'CNC 1', area: 'Machining' }),
    press2: store.createMachine({ name: 'Press 2', area: 'Stamping' }),
    conveyorA: store.createMachine({ name: 'Conveyor A', area: 'Assembly' }),
    welder1: store.createMachine({ name: 'Welder 1', area: 'Fabrication' }),
    compressor: store.createMachine({ name: 'Air Compressor', area: 'Facilities' }),
  };
  const me = (store.listUsers().find((u) => u.role === 'supervisor') || { name: 'Mark' }).name;

  const wo = (machine, fields) => store.createWorkOrder({ machineId: machine.id, assignedTo: me, source: 'email', ...fields }, 'demo');
  const log = (machine, order, n, minutes, notes, tech = me) => store.createWorkLog({
    machineId: machine.id, workOrderId: order ? order.id : null, technician: tech, date: dateAgo(n), minutes, notes,
  });

  // Press 2: frequent breakdowns + a repeat issue (trips the attention flags)
  const p1 = wo(m.press2, { orderNumber: '10241', title: 'Hydraulic pressure dropping', description: 'Press 2 losing pressure mid-cycle, suspect pump seal', priority: 'high', status: 'completed', createdAt: daysAgo(24), completedAt: daysAgo(23) });
  const p2 = wo(m.press2, { orderNumber: '10288', title: 'Hydraulic pressure dropping again', description: 'Same pressure loss on Press 2, pump seal replaced 3 weeks ago', priority: 'high', status: 'waiting_parts', createdAt: daysAgo(6), dueDate: dateAgo(-3) });
  const p3 = wo(m.press2, { orderNumber: '10262', title: 'Die alignment off', description: 'Parts coming out of spec on Press 2', priority: 'medium', status: 'completed', createdAt: daysAgo(14), completedAt: daysAgo(13) });
  log(m.press2, p1, 23, 150, 'Replaced hydraulic pump seal on Press 2, tested at full pressure, back up and running');
  log(m.press2, p3, 13, 90, 'Realigned die on Press 2, ran test batch, parts in spec');
  const l3 = log(m.press2, p2, 1, 120, 'Tore down pump on Press 2 again, seal is fine — scoring on the cylinder wall. Need a hydraulic cylinder.');

  // CNC 3
  const c1 = wo(m.cnc3, { orderNumber: '10195', title: 'Spindle belt squealing', description: 'Belt noise at high RPM on CNC 3', priority: 'medium', status: 'completed', createdAt: daysAgo(41), completedAt: daysAgo(40) });
  const c2 = wo(m.cnc3, { orderNumber: '10301', title: 'Coolant not flowing', description: 'Coolant pump on CNC 3 not priming', priority: 'high', status: 'waiting_parts', createdAt: daysAgo(3) });
  log(m.cnc3, c1, 40, 75, 'Replaced spindle belt on CNC 3, tensioned and tested');
  log(m.cnc3, c2, 1, 60, 'Diagnosed coolant pump on CNC 3, impeller cracked. Waiting on a coolant pump.');

  // Conveyor A: stale order
  const v1 = wo(m.conveyorA, { orderNumber: '10218', title: 'Belt tracking drift', description: 'Conveyor A belt drifting left, possibly worn idler', priority: 'low', status: 'in_progress', createdAt: daysAgo(19) });
  log(m.conveyorA, v1, 17, 45, 'Adjusted tracking on Conveyor A, drifting back after a shift. Idler bearing worn.');

  // Weekend-ish activity (today and yesterday) so the reports have content
  const w1 = wo(m.welder1, { title: 'Wire feed jamming', description: 'Feed motor sticking on Welder 1', priority: 'medium', status: 'completed', createdAt: daysAgo(1), completedAt: daysAgo(0), source: 'tablet' });
  const wl = log(m.welder1, w1, 0, 105, 'Cleaned and rebuilt wire feed on Welder 1, replaced drive rollers. Running good.');
  const n1 = wo(m.cnc1, { orderNumber: '10275', title: 'Way lube alarm', description: 'Low way lube pressure alarm on CNC 1', priority: 'low', status: 'completed', createdAt: daysAgo(1), completedAt: daysAgo(1) });
  log(m.cnc1, n1, 1, 30, 'Topped off way lube on CNC 1 and cleared alarm, checked lines for leaks', 'Dave');
  const a1 = wo(m.compressor, { orderNumber: '10310', title: 'Compressor short-cycling', description: 'Air compressor kicking on and off rapidly', priority: 'urgent', status: 'waiting_parts', createdAt: daysAgo(1), assignedTo: 'Dave' });
  const al = log(m.compressor, a1, 0, 40, 'Checked air compressor, pressure switch chattering. Need a pressure switch.', 'Dave');
  wo(m.cnc1, { title: 'Chip conveyor noisy', description: 'Grinding noise from chip conveyor on CNC 1', priority: 'medium', status: 'open', createdAt: daysAgo(0), assignedTo: '', source: 'manual' });

  // Older history for the trend chart
  const h1 = wo(m.cnc1, { orderNumber: '10102', title: 'Tool changer fault', description: 'ATC arm stalling on CNC 1', priority: 'high', status: 'completed', createdAt: daysAgo(62), completedAt: daysAgo(60) });
  log(m.cnc1, h1, 60, 180, 'Rebuilt ATC arm on CNC 1, replaced solenoid');

  // Parts
  store.createPart({ name: 'hydraulic cylinder', machineId: m.press2.id, workOrderId: p2.id, logId: l3.id, status: 'needed', createdAt: daysAgo(1) });
  store.createPart({ name: 'coolant pump', partNumber: 'CP-4410', vendor: 'Grainger', machineId: m.cnc3.id, workOrderId: c2.id, status: 'ordered' });
  store.createPart({ name: 'idler bearing', quantity: 2, machineId: m.conveyorA.id, workOrderId: v1.id, status: 'needed', createdAt: daysAgo(17) });
  store.createPart({ name: 'pressure switch', machineId: m.compressor.id, workOrderId: a1.id, logId: al.id, status: 'needed' });
  store.createPart({ name: 'drive rollers', machineId: m.welder1.id, workOrderId: w1.id, logId: wl.id, status: 'installed' });
  store.createPart({ name: 'spindle belt', partNumber: 'SB-220', machineId: m.cnc3.id, workOrderId: c1.id, status: 'installed', createdAt: daysAgo(40) });

  // Preventive maintenance
  store.createPmSchedule({ machineId: m.press2.id, title: 'Change hydraulic filter', intervalDays: 90, leadDays: 5, nextDueDate: dateAgo(-3), priority: 'medium', description: '1. Lock out\n2. Replace filter element\n3. Check fluid level' });
  store.createPmSchedule({ machineId: m.compressor.id, title: 'Drain tank, check belts', intervalDays: 7, leadDays: 1, nextDueDate: dateAgo(-6) });
  require('../lib/pm').generateDue();

  store.saveNow();
  const d = store.load();
  console.log('Demo data loaded:');
  console.log(`  ${d.machines.length} machines, ${d.workOrders.length} work orders, ${d.workLogs.length} work log entries, ${d.parts.length} parts, ${d.pmSchedules.length} PM schedules`);
  console.log('When you are done looking around: node scripts/seed.js --clear  (keeps your login)');
})();
