'use strict';
/**
 * The tablet build: the same lib/*.js bundled for the browser. This checks
 * the bundle runs on its own (no Node modules) and behaves like the server.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { build, OUT } = require('../scripts/build-tablet');

test('tablet build is up to date with the source (rebuild: node scripts/build-tablet.js)', () => {
  const before = fs.readFileSync(path.join(OUT, 'sw.js'), 'utf8');
  build();
  const after = fs.readFileSync(path.join(OUT, 'sw.js'), 'utf8');
  assert.equal(after, before, 'tablet/ was stale; it has now been rebuilt, commit it');
});

test('engine runs with no Node modules: log by voice, report, export, restore', async () => {
  let src = fs.readFileSync(path.join(OUT, 'engine.js'), 'utf8');
  // Load the ES module as a script: turn its exports into a returned object.
  src = src.replace(/^export async function /gm, 'async function ').replace(/^export function /gm, 'function ');
  src += '\n;({ startEngine, request, flush, photoURL });';
  const listeners = {};
  const saved = {};
  const fakeIdb = {
    open() {
      const req = {};
      setTimeout(() => {
        const db = {
          transaction() {
            const tx = {
              objectStore: () => ({
                get: (k) => { const r = {}; setTimeout(() => { r.result = saved[k]; r.onsuccess(); }); return r; },
                put: (v, k) => { saved[k] = v; setTimeout(() => tx.oncomplete && tx.oncomplete()); },
                delete: (k) => { delete saved[k]; setTimeout(() => tx.oncomplete && tx.oncomplete()); },
              }),
            };
            return tx;
          },
          createObjectStore() {},
          objectStoreNames: { contains: () => false },
        };
        req.result = db;
        req.onupgradeneeded && req.onupgradeneeded();
        req.onsuccess();
      });
      return req;
    },
  };
  const ctx = vm.createContext({
    indexedDB: fakeIdb, console, setTimeout, clearTimeout, URL, URLSearchParams, Intl, Date, structuredClone,
    crypto: globalThis.crypto, Blob, atob, btoa, URL: class extends URL { static createObjectURL() { return 'blob:x'; } static revokeObjectURL() {} },
    document: { addEventListener: (t, f) => { listeners[t] = f; }, hidden: false },
    window: { addEventListener: () => {} },
  });
  const engine = vm.runInContext(src, ctx);
  await engine.startEngine();

  let r = await engine.request('GET', '/api/auth/status');
  assert.equal(r.data.setupNeeded, true);
  await engine.request('POST', '/api/auth/setup', { name: 'Mark' });

  r = await engine.request('POST', '/api/ingest/notes', { text: 'Press two, replaced the drive belt, an hour, parts needed belt guard', date: '2026-11-01', clientId: 'x1' });
  assert.equal(r.status, 201);
  assert.equal(r.data.log.minutes, 60);
  assert.equal(r.data.log.technician, 'Mark');

  r = await engine.request('GET', '/api/reports?from=2026-11-01&to=2026-11-01');
  assert.equal(r.data.totals.entries, 1);
  assert.match(r.data.handoffText, /belt guard/);

  await engine.flush();
  assert.match(saved.db, /drive belt/, 'data reached the (fake) IndexedDB');

  const backup = (await engine.request('GET', '/api/export')).data;
  await engine.request('POST', '/api/ingest/notes', { text: 'second entry', date: '2026-11-01', clientId: 'x2' });
  r = await engine.request('POST', '/api/import', { data: JSON.parse(JSON.stringify(backup)) });
  assert.equal(r.data.counts.workLogs, 1);

  // Photos: stored as images in IndexedDB, shown via a URL, included in a
  // backup with ?photos=1, restored, and removed with their entry.
  const img = 'data:image/jpeg;base64,' + Buffer.from('fake jpeg bytes').toString('base64');
  const entry = await engine.request('POST', '/api/ingest/notes', { text: 'Press two greased the ram', date: '2026-11-01', clientId: 'x3' });
  r = await engine.request('POST', '/api/photos', { logId: entry.data.log.id, kind: 'done', full: img, thumb: img });
  assert.equal(r.status, 201);
  const photoId = r.data.id;
  assert.equal(r.data.workOrderId, entry.data.workOrder.id);
  assert.equal(await engine.photoURL(photoId, true), 'blob:x');
  await engine.flush();
  assert.ok(saved[photoId] && saved[photoId].full, 'image reached the (fake) IndexedDB');
  const withPhotos = (await engine.request('GET', '/api/export?photos=1')).data;
  assert.equal(withPhotos.photoFiles[photoId].full, img);
  r = await engine.request('POST', '/api/import', { data: withPhotos });
  assert.equal(r.data.counts.photos, 1);
  await engine.request('DELETE', '/api/work-logs/' + entry.data.log.id);
  await engine.flush();
  assert.equal((await engine.request('GET', '/api/photos')).data.length, 0);
  assert.equal(saved[photoId], undefined, 'undo removed the image too');

  r = await engine.request('GET', '/api/nope');
  assert.equal(r.status, 404);
});

test('data saved by the previous version gets NO_WO numbers on upgrade', () => {
  const store = require('../lib/store');
  const v2 = {
    machines: [], workLogs: [], parts: [], pmSchedules: [],
    workOrders: [
      { id: 'b', ref: 2, orderNumber: '', title: 'second', status: 'completed', createdAt: '2026-11-01T10:00:00Z', history: [] },
      { id: 'a', ref: 1, orderNumber: '', title: 'first', status: 'open', createdAt: '2026-11-01T09:00:00Z', history: [] },
      { id: 'c', ref: 3, orderNumber: '10288', title: 'company', status: 'open', createdAt: '2026-11-01T11:00:00Z', history: [] },
    ],
    meta: { schemaVersion: 2, nextRef: 4, ownerName: 'Mark' },
  };
  let saved = JSON.stringify(v2);
  store.setBackend({ read: () => saved, write: (j) => { saved = j; } });
  const labels = Object.fromEntries(store.listWorkOrders().map((w) => [w.id, store.woLabel(w)]));
  assert.deepEqual(labels, { a: 'NO_WO#001', b: 'NO_WO#002', c: 'WO#10288' });
  const next = store.createWorkOrder({ title: 'new one' });
  assert.equal(store.woLabel(next), 'NO_WO#003');
  assert.equal(store.load().meta.ownerName, 'Mark');
});
