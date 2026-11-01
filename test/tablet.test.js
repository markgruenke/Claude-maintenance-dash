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
  src += '\n;({ startEngine, request, flush });';
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
              }),
            };
            return tx;
          },
          createObjectStore() {},
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
    crypto: globalThis.crypto,
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

  r = await engine.request('GET', '/api/nope');
  assert.equal(r.status, 404);
});
