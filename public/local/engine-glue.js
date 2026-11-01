// ---------------------------------------------------------------------------
// Tablet engine glue (appended to the bundled lib/*.js by build-tablet.js).
//
// Runs the tracker's API in the browser, keeps the data in IndexedDB on the
// tablet, and answers the app's /api/... calls in-process. There is one
// person here (the tablet's owner), who can do everything.
// ---------------------------------------------------------------------------

const store = require('./store');
const api = require('./api');

const IDB_NAME = 'maintenance-log';
const IDB_STORE = 'kv';
const KEY = 'db';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(idb, key) {
  return new Promise((resolve, reject) => {
    const req = idb.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(idb, key, value) {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let idb = null;
let writing = Promise.resolve();
let pendingJson = null;
let lastError = null;

/** Queue the latest copy for IndexedDB; only the newest pending copy is written. */
function persist(json) {
  pendingJson = json;
  writing = writing.then(async () => {
    if (pendingJson === null) return;
    const toWrite = pendingJson;
    pendingJson = null;
    try {
      await idbPut(idb, KEY, toWrite);
      lastError = null;
    } catch (err) {
      lastError = err;
      console.error('Could not save to tablet storage', err);
    }
  });
  return writing;
}

export async function startEngine() {
  idb = await openIdb();
  let raw = await idbGet(idb, KEY);
  store.setBackend({
    read: () => raw,
    write: (json) => { raw = json; persist(json); },
    exists: () => !!raw,
  });
  store.load();
  api.chores();
  // Make sure the last change is on disk when the app is put away.
  document.addEventListener('visibilitychange', () => { if (document.hidden) store.saveNow(); });
  window.addEventListener('pagehide', () => store.saveNow());
}

/** Wait until everything is written (used before showing "backed up"). */
export function flush() {
  store.saveNow();
  return writing;
}

export function storageError() {
  return lastError ? String(lastError.message || lastError) : '';
}

function owner() {
  const d = store.load();
  const name = d.meta.ownerName || '';
  return { id: 'local', name: name || 'Me', role: 'supervisor', active: true, createdAt: d.meta.createdAt || null };
}

/**
 * Answer one /api/... call. Returns { status, data } like the server would.
 * @param {string} method
 * @param {string} url   e.g. "/api/work-logs?from=2026-11-01"
 * @param {object} [body]
 */
export async function request(method, url, body = {}) {
  const u = new URL(url, 'https://tablet.local');
  const seg = u.pathname.split('/').filter(Boolean);
  try {
    const d = store.load();
    // Accounts don't exist on the tablet: just the owner's name.
    if (seg[1] === 'auth') {
      if (seg[2] === 'status') return { status: 200, data: { setupNeeded: !d.meta.ownerName, user: d.meta.ownerName ? owner() : null, local: true } };
      if (seg[2] === 'setup' && method === 'POST') {
        const name = String(body.name || '').trim().replace(/\s+/g, ' ');
        if (!name) return { status: 400, data: { error: 'Enter your name' } };
        d.meta.ownerName = name;
        d.meta.createdAt = d.meta.createdAt || new Date().toISOString();
        store.saveNow();
        return { status: 201, data: { user: owner() } };
      }
      if (seg[2] === 'logout') return { status: 200, data: { ok: true } };
    }
    if (seg[1] === 'me') {
      if (method === 'PATCH' && body.name && String(body.name).trim()) {
        const old = d.meta.ownerName;
        d.meta.ownerName = String(body.name).trim().replace(/\s+/g, ' ');
        // Keep the owner's past entries and jobs under the new name.
        for (const l of d.workLogs) if (l.technician === old) l.technician = d.meta.ownerName;
        for (const w of d.workOrders) if (w.assignedTo === old) w.assignedTo = d.meta.ownerName;
        store.saveNow();
      }
      return { status: 200, data: owner() };
    }
    if (seg[1] === 'users') return { status: 200, data: [] };

    // Copy the body in and the answer out, exactly as a trip over the network
    // would, so the screens never hold live references into the stored data.
    const out = await api.handle({ method, seg, query: u.searchParams, body: JSON.parse(JSON.stringify(body ?? {})), user: owner() });
    return { status: out.status, data: out.data === undefined ? undefined : JSON.parse(JSON.stringify(out.data)) };
  } catch (err) {
    if (err instanceof api.HttpError) return { status: err.status, data: { error: err.message } };
    console.error(err);
    return { status: 500, data: { error: 'Something went wrong: ' + err.message } };
  }
}
