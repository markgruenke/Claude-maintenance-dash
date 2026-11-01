'use strict';
/**
 * End-to-end API tests. Run with:  node --test
 * Each run uses a throwaway data folder, so real data is never touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-test-'));
process.env.DATA_DIR = DATA_DIR;

// A v1 database (from before accounts existed) to prove the upgrade path.
fs.writeFileSync(path.join(DATA_DIR, 'db.json'), JSON.stringify({
  machines: [{ id: 'm1', name: 'Lathe 1', area: '', notes: '', createdAt: '2026-01-01T00:00:00.000Z' }],
  workOrders: [{ id: 'w1', orderNumber: '777', machineId: 'm1', title: 'Old order', description: '', priority: 'low', status: 'open', assignedTo: 'Mark', source: 'email', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', completedAt: null }],
  workLogs: [{ id: 'l1', workOrderId: 'w1', machineId: 'm1', technician: 'Mark', date: '2026-01-02', minutes: 30, notes: 'looked at it', createdAt: '2026-01-02T00:00:00.000Z' }],
  parts: [], technicians: [{ id: 't1', name: 'Mark', email: '' }], meta: { schemaVersion: 1 },
}));

const { server } = require('../server');
const reports = require('../lib/reports');
let base;

function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };
}

const sup = client();
const tech = client();

test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => { server.close(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('v1 data is upgraded: orders get a reference number', async () => {
  const s = await sup('GET', '/api/auth/status');
  assert.equal(s.data.setupNeeded, true);
  const r = await sup('POST', '/api/auth/setup', { name: 'Mark', secret: 'correct horse' });
  assert.equal(r.status, 201);
  const orders = await sup('GET', '/api/work-orders');
  assert.equal(orders.data[0].ref, 1);
  assert.deepEqual(orders.data[0].history, []);
});

test('everything needs a sign-in, and setup only happens once', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/work-orders')).status, 401);
  assert.equal((await anon('POST', '/api/auth/setup', { name: 'Eve', secret: 'longenough' })).status, 409);
});

test('writes must be JSON (blocks cross-site form posts)', async () => {
  const res = await fetch(base + '/api/work-orders', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
});

test('supervisor adds a technician; short PINs are refused', async () => {
  assert.equal((await sup('POST', '/api/users', { name: 'Dave', role: 'tech', secret: '12' })).status, 400);
  assert.equal((await sup('POST', '/api/users', { name: 'Dave', role: 'tech', secret: '4321' })).status, 201);
  assert.equal((await tech('POST', '/api/auth/login', { name: 'dave', secret: '4321' })).status, 200);
  assert.equal((await tech('GET', '/api/users')).status, 403);
});

test('wrong PINs lock the name out', async () => {
  const c = client();
  await sup('POST', '/api/users', { name: 'Lou', role: 'tech', secret: '9999' });
  for (let i = 0; i < 5; i++) assert.equal((await c('POST', '/api/auth/login', { name: 'Lou', secret: '0000' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { name: 'Lou', secret: '9999' })).status, 429);
});

test('quick log creates the order, files parts, sets status, ignores resends', async () => {
  const body = {
    clientId: 'abc-1', date: '2026-10-31', machineName: 'CNC 3', newOrderTitle: 'Coolant pump', orderNumber: '10301',
    notes: 'Impeller cracked', minutes: 60, partsNeeded: [{ name: 'coolant pump', quantity: 1 }], partsUsed: ['hose clamp'],
  };
  const r = await tech('POST', '/api/work-logs', body);
  assert.equal(r.status, 201);
  assert.equal(r.data.createdOrder, true);
  assert.equal(r.data.workOrder.status, 'waiting_parts'); // parts needed => waiting
  assert.equal(r.data.workOrder.assignedTo, 'Dave');
  assert.equal(r.data.log.technician, 'Dave');
  assert.equal(r.data.partsUsed[0].status, 'installed');
  const again = await tech('POST', '/api/work-logs', body);
  assert.equal(again.data.duplicate, true);
  const logs = await sup('GET', '/api/work-logs?from=2026-10-31&to=2026-10-31');
  assert.equal(logs.data.length, 1);
});

test('techs cannot log as someone else; supervisors can', async () => {
  const t = await tech('POST', '/api/work-logs', { technician: 'Mark', date: '2026-10-31', machineName: 'Press 2', notes: 'greased', minutes: 15 });
  assert.equal(t.data.log.technician, 'Dave');
  const s = await sup('POST', '/api/work-logs', { technician: 'Dave', date: '2026-10-31', machineName: 'Press 2', notes: 'checked oil', minutes: 10 });
  assert.equal(s.data.log.technician, 'Dave');
  assert.equal(s.data.log.loggedBy, 'Mark');
});

test('techs can only edit their own entries', async () => {
  const mine = await sup('POST', '/api/work-logs', { date: '2026-11-01', machineName: 'Lathe 1', workOrderId: 'w1', notes: 'Mark work', minutes: 20 });
  assert.equal((await tech('PATCH', '/api/work-logs/' + mine.data.log.id, { notes: 'x' })).status, 403);
  assert.equal((await sup('PATCH', '/api/work-logs/' + mine.data.log.id, { entered: true })).data.entered, true);
});

test('voice entry: one sentence becomes a logged entry; resends are ignored; undo leaves no trace', async () => {
  const say = { text: 'Press two, replaced the drive belt, about an hour and a half, parts used drive belt, parts needed belt guard',
    date: '2026-11-01', clientId: 'v-1', source: 'voice' };
  const r = await tech('POST', '/api/ingest/notes', say);
  assert.equal(r.status, 201);
  assert.equal(r.data.log.minutes, 90);
  assert.equal(r.data.log.source, 'voice');
  assert.equal(r.data.workOrder.status, 'waiting_parts');
  assert.deepEqual(r.data.partsNeeded.map((p) => p.name), ['belt guard']);
  assert.deepEqual(r.data.partsUsed.map((p) => p.name), ['drive belt']);
  assert.equal((await tech('POST', '/api/ingest/notes', say)).data.duplicate, true);

  // A one-off with no "still"/"need" is treated as done, not left open.
  const oneOff = await tech('POST', '/api/ingest/notes', { text: 'Swapped the photo eye on robot cell 2, 20 minutes', date: '2026-11-01', clientId: 'v-2' });
  assert.equal(oneOff.data.workOrder.status, 'completed');
  assert.equal(oneOff.data.log.minutes, 20);

  // Follow-up about the same problem joins that job; unrelated work doesn't.
  const follow = await tech('POST', '/api/ingest/notes', { text: 'Press 2 belt guard came in, installed it, all good', date: '2026-11-01', clientId: 'v-4' });
  assert.equal(follow.data.workOrder.id, r.data.workOrder.id);
  assert.equal(follow.data.workOrder.status, 'completed');
  const other = await tech('POST', '/api/ingest/notes', { text: 'Press 2 hydraulic hose leaking, tightened fitting', date: '2026-11-01', clientId: 'v-5' });
  assert.notEqual(other.data.workOrder.id, r.data.workOrder.id);

  // Undo: deleting the entry removes its parts and the job it opened.
  await tech('DELETE', '/api/work-logs/' + oneOff.data.log.id);
  const orders = (await sup('GET', '/api/work-orders')).data;
  assert.equal(orders.some((w) => w.id === oneOff.data.workOrder.id), false);

  // No time said: still logged, just with no minutes.
  const noTime = await tech('POST', '/api/ingest/notes', { text: 'cleaned up around the shop', date: '2026-11-01', clientId: 'v-3' });
  assert.equal(noTime.data.log.minutes, 0);
  assert.equal(noTime.data.workOrder, null);
});

test('spoken phrasing: times, machine names and status', () => {
  const { parseNotes, extractMinutes } = require('../lib/parser');
  assert.equal(extractMinutes('took about forty-five minutes'), 45);
  assert.equal(extractMinutes('an hour and a half'), 90);
  assert.equal(extractMinutes('two and a half hours'), 150);
  assert.equal(extractMinutes('half an hour'), 30);
  assert.equal(extractMinutes('a couple hours'), 120);
  assert.equal(extractMinutes('2 hours and 15 minutes'), 135);
  assert.equal(extractMinutes('1.5 hrs'), 90);
  assert.equal(extractMinutes('checked press 2'), null);
  const known = ['CNC 3', 'Press 2', 'Conveyor A'];
  assert.equal(parseNotes('cnc3 coolant pump fixed', known).machineName, 'CNC 3');
  assert.equal(parseNotes('greased conveyor a', known).machineName, 'Conveyor A');
  assert.equal(parseNotes('looked at press four', known).machineName, 'Press 4');
  assert.equal(parseNotes('press 2 not fixed yet, coming back tomorrow', known).statusHint, 'in_progress');
  assert.equal(parseNotes('press 2 back up and running', known).statusHint, 'completed');
  assert.equal(parseNotes('press 2 waiting on parts to come in', known).statusHint, 'waiting_parts');
  assert.equal(parseNotes('work order 10288 on press 2', known).orderNumber, '10288');
  assert.deepEqual(parseNotes('parts used belt and tested it', known).partsUsed, ['belt']);
  // A "need" clause after a comma isn't part of what was used.
  const hose = parseNotes('Press 2 replaced the hydraulic hose, parts used hydraulic hose, parts needed seal kit and a pump, about an hour', known);
  assert.deepEqual(hose.partsUsed, ['hydraulic hose']);
  assert.deepEqual(hose.partsNeeded, ['seal kit', 'pump']);
  assert.deepEqual(parseNotes('swapped the fuse, parts used fuse, still waiting on a contactor', known).partsUsed, ['fuse']);

  // Parts used / needed come only after the words "parts used" / "parts needed".
  assert.deepEqual(parseNotes('replaced the belt and swapped the guard', known).partsUsed, []);
  assert.deepEqual(parseNotes('part used: fuse. back up and running', known).partsUsed, ['fuse']);
  const both = parseNotes('cnc 3 parts needed coolant filter parts used o-ring', known);
  assert.deepEqual([both.partsUsed, both.partsNeeded], [['o-ring'], ['coolant filter']]);
  const noPhrase = parseNotes('Press 2 replaced the guard, still need to order a belt guard', known);
  assert.deepEqual(noPhrase.partsNeeded, []);
  assert.equal(noPhrase.statusHint, 'in_progress');
  assert.deepEqual(parseNotes('checked the wiring, need a new contactor', known).partsNeeded, []);
  const spoken = parseNotes('replaced the hose parts used hose parts needed two seal kits and a pump took about an hour', known);
  assert.deepEqual(spoken.partsUsed, ['hose']);
  assert.deepEqual(spoken.partsNeeded, ['2 seal kits', 'pump']);
  assert.equal(spoken.minutes, 60);
  assert.deepEqual(parseNotes('needed parts are a drive chain and a sprocket then greased everything', known).partsNeeded, ['drive chain', 'sprocket']);
  assert.deepEqual(parseNotes('cnc 3 part needed: coolant filter. back up and running', known).partsNeeded, ['coolant filter']);
});

test('weekend report buckets work and parts correctly', async () => {
  const r = (await sup('GET', '/api/reports?from=2026-10-30&to=2026-11-01&tz=UTC')).data;
  assert.equal(r.totals.entries, 8);
  assert.ok(r.workedOpen.some((o) => o.title === 'Coolant pump' && o.status === 'waiting_parts'));
  assert.ok(r.partsNeeded.some((p) => p.name === 'coolant pump'));
  assert.match(r.handoffText, /STILL OPEN — WORKED ON THIS PERIOD/);
  assert.match(r.dailyText, /— CNC 3 — 1 h — WO#10301/);
  const daveOnly = (await sup('GET', '/api/reports?from=2026-10-30&to=2026-11-01&technician=Dave&tz=UTC')).data;
  assert.ok(daveOnly.entries.every((e) => e.technician === 'Dave'));

  await sup('PUT', '/api/reports/notes', { key: r.key, text: 'Press 2 is locked out' });
  const withNote = (await sup('GET', '/api/reports?from=2026-10-30&to=2026-11-01&tz=UTC')).data;
  assert.match(withNote.handoffText, /Press 2 is locked out/);
});

test('report dates follow the viewer time zone, not UTC', () => {
  // 03:30 UTC Sunday is still Saturday evening in Chicago.
  assert.equal(reports.dateIn('2026-11-01T03:30:00Z', 'America/Chicago'), '2026-10-31');
  assert.equal(reports.dateIn('2026-11-01T03:30:00Z', 'UTC'), '2026-11-01');
});

test('PM: due schedule makes one work order; completing it rolls the date forward once', async () => {
  const today = require('../lib/store').localDate();
  const pmRes = await sup('POST', '/api/pm', { title: 'Grease ram', machineName: 'Press 2', intervalDays: 30, leadDays: 2, nextDueDate: today });
  assert.equal(pmRes.status, 201);
  await sup('POST', '/api/pm/run');
  const pmOrders = (await sup('GET', '/api/work-orders')).data.filter((w) => w.pmId === pmRes.data.id);
  assert.equal(pmOrders.length, 1);
  await sup('PATCH', '/api/work-orders/' + pmOrders[0].id, { status: 'completed' });
  await sup('PATCH', '/api/work-orders/' + pmOrders[0].id, { title: 'PM: Grease ram (done)' });
  const pm = (await sup('GET', '/api/pm')).data.find((p) => p.id === pmRes.data.id);
  assert.equal(pm.lastDoneDate, today);
  assert.equal(pm.nextDueDate, require('../lib/store').addDays(today, 30));
  assert.equal(pm.nextDueDate > today, true);
});

test('cannot remove the last supervisor', async () => {
  const users = (await sup('GET', '/api/users')).data;
  const mark = users.find((u) => u.name === 'Mark');
  assert.equal((await sup('PATCH', '/api/users/' + mark.id, { active: false })).status, 400);
});

test('only supervisors delete work orders; export has no secrets', async () => {
  assert.equal((await tech('DELETE', '/api/work-orders/w1')).status, 403);
  const exp = await sup('GET', '/api/export');
  assert.equal(exp.data.sessions, undefined);
  assert.equal(exp.data.users.some((u) => 'hash' in u || 'salt' in u), false);
});

test('static files cannot escape the public folder', async () => {
  const res = await fetch(base + '/..%2fserver.js');
  assert.notEqual(res.status, 200);
});

test('restore from a backup replaces work data but keeps accounts', async () => {
  const backup = (await sup('GET', '/api/export')).data;
  const before = backup.workLogs.length;
  await sup('POST', '/api/ingest/notes', { text: 'extra entry after the backup', date: '2026-11-02', clientId: 'r-1' });
  assert.equal((await tech('POST', '/api/import', { data: backup })).status, 403);
  assert.equal((await sup('POST', '/api/import', { data: { nope: true } })).status, 400);
  const r = await sup('POST', '/api/import', { data: backup });
  assert.equal(r.data.counts.workLogs, before);
  assert.equal((await sup('GET', '/api/work-logs')).data.length, before);
  assert.equal((await tech('GET', '/api/auth/status')).data.user.name, 'Dave'); // still signed in
});

test('editing an entry corrects its parts and the job status', async () => {
  const r = await tech('POST', '/api/ingest/notes', {
    text: 'Conveyor B replaced the drive chain, parts needed sprocket and a guard rail', date: '2026-11-02', clientId: 'e-1',
  });
  const logId = r.data.log.id;
  const woId = r.data.workOrder.id;
  assert.equal(r.data.workOrder.status, 'waiting_parts');
  const partsOf = async () => (await sup('GET', '/api/parts')).data.filter((p) => p.logId === logId);
  const names = (list, used) => list.filter((p) => (p.status === 'installed') === used).map((p) => `${p.quantity}x ${p.name}`).sort();
  assert.deepEqual(names(await partsOf(), false), ['1x guard rail', '1x sprocket']);

  // The sprocket was already ordered; that progress must survive the edit.
  const sprocket = (await partsOf()).find((p) => p.name === 'sprocket');
  await sup('PATCH', '/api/parts/' + sprocket.id, { status: 'ordered' });

  // Misheard: no guard rail, it was 2 sprockets, and a master link was used too.
  const e = await tech('PATCH', '/api/work-logs/' + logId, {
    partsUsed: [{ name: 'drive chain' }, { name: 'master link' }],
    partsNeeded: [{ name: 'sprocket', quantity: 2 }],
  });
  assert.equal(e.status, 200);
  const after = await partsOf();
  assert.deepEqual(names(after, true), ['1x drive chain', '1x master link']);
  assert.deepEqual(names(after, false), ['2x sprocket']);
  assert.equal(after.find((p) => p.name === 'sprocket').status, 'ordered');
  assert.equal(after.find((p) => p.name === 'sprocket').id, sprocket.id);

  // Nothing needed after all: clear it and set the job done.
  await tech('PATCH', '/api/work-logs/' + logId, { partsNeeded: [], statusAfter: 'completed' });
  assert.deepEqual(names(await partsOf(), false), []);
  const wo = (await sup('GET', '/api/work-orders/' + woId)).data.workOrder;
  assert.equal(wo.status, 'completed');

  // An edit that leaves parts out entirely doesn't touch them.
  await tech('PATCH', '/api/work-logs/' + logId, { notes: 'Conveyor B replaced the drive chain' });
  assert.deepEqual(names(await partsOf(), true), ['1x drive chain', '1x master link']);
});

test('"parts needed two seal kits" files 2 × seal kits; no phrase files nothing', async () => {
  const r = await tech('POST', '/api/ingest/notes', {
    text: 'Press 2 replaced the hose parts needed two seal kits and a pump took about an hour', date: '2026-11-03', clientId: 'q-1',
  });
  const needed = r.data.partsNeeded.map((p) => `${p.quantity}x ${p.name}`);
  assert.deepEqual(needed, ['2x seal kits', '1x pump']);
  assert.equal(r.data.workOrder.status, 'waiting_parts');
  const none = await tech('POST', '/api/ingest/notes', {
    text: 'Press 2 checked the wiring, need to order a contactor', date: '2026-11-03', clientId: 'q-2',
  });
  assert.deepEqual(none.data.partsNeeded, []);
});
