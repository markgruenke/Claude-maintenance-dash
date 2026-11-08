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
const IDB_STORE = 'kv';       // the log (one JSON document)
const PHOTO_STORE = 'photos'; // photo images: { full: Blob, thumb: Blob } per photo id
const KEY = 'db';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      const names = db.objectStoreNames;
      const has = (n) => (names.contains ? names.contains(n) : [...(names || [])].includes(n));
      if (!has(IDB_STORE)) db.createObjectStore(IDB_STORE);
      if (!has(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(idb, key, storeName = IDB_STORE) {
  return new Promise((resolve, reject) => {
    const req = idb.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function idbWrite(idb, storeName, fn) {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(storeName, 'readwrite');
    fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const idbPut = (idb, key, value, storeName = IDB_STORE) => idbWrite(idb, storeName, (os) => os.put(value, key));
const idbDelete = (idb, key, storeName) => idbWrite(idb, storeName, (os) => os.delete(key));

function dataUrlToBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(',');
  const mime = (head.match(/^data:([^;]+)/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}`;
}

let idb = null;
let writing = Promise.resolve();
let pendingJson = null;
let lastError = null;

// Photos just saved are kept in memory too, so they show at once.
const photoMemory = new Map(); // id -> { full: Blob, thumb: Blob|null }
const photoUrls = new Map();   // "id:full" / "id:thumb" -> object URL

function queuePhotoWrite(task) {
  writing = writing.then(task).catch((err) => {
    lastError = err;
    console.error('Could not save a photo to tablet storage', err);
  });
  return writing;
}

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
    savePhotoFiles(id, files) {
      const entry = { full: dataUrlToBlob(files.full), thumb: files.thumb ? dataUrlToBlob(files.thumb) : null };
      photoMemory.set(id, entry);
      queuePhotoWrite(() => idbPut(idb, id, entry, PHOTO_STORE));
    },
    deletePhotoFiles(id) {
      photoMemory.delete(id);
      for (const k of [`${id}:full`, `${id}:thumb`]) {
        if (photoUrls.has(k)) { URL.revokeObjectURL(photoUrls.get(k)); photoUrls.delete(k); }
      }
      queuePhotoWrite(() => idbDelete(idb, id, PHOTO_STORE));
    },
  });
  store.load();
  api.chores();
  // Make sure the last change is on disk when the app is put away.
  document.addEventListener('visibilitychange', () => { if (document.hidden) store.saveNow(); });
  window.addEventListener('pagehide', () => store.saveNow());
}

async function photoBlobs(id) {
  if (photoMemory.has(id)) return photoMemory.get(id);
  const entry = await idbGet(idb, id, PHOTO_STORE);
  if (entry) photoMemory.set(id, entry);
  return entry;
}

/** A URL an <img> can show for a photo (thumbnail or full size), or '' if missing. */
export async function photoURL(id, thumb = false) {
  const key = `${id}:${thumb ? 'thumb' : 'full'}`;
  if (photoUrls.has(key)) return photoUrls.get(key);
  const entry = await photoBlobs(id);
  const blob = entry && ((thumb && entry.thumb) || entry.full);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  photoUrls.set(key, url);
  return url;
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
    // Backups with photos: the images are in IndexedDB, read them in here.
    if (method === 'GET' && seg[1] === 'export' && u.searchParams.get('photos') === '1' && out.data) {
      await writing;
      out.data.photoFiles = {};
      for (const ph of out.data.photos || []) {
        const entry = await photoBlobs(ph.id);
        if (!entry || !entry.full) continue;
        out.data.photoFiles[ph.id] = { full: await blobToDataUrl(entry.full), thumb: entry.thumb ? await blobToDataUrl(entry.thumb) : null };
      }
    }
    return { status: out.status, data: out.data === undefined ? undefined : JSON.parse(JSON.stringify(out.data)) };
  } catch (err) {
    if (err instanceof api.HttpError) return { status: err.status, data: { error: err.message } };
    console.error(err);
    return { status: 500, data: { error: 'Something went wrong: ' + err.message } };
  }
}
