'use strict';
/**
 * Maintenance tracker server — zero dependencies, plain Node (>= 18).
 *
 *   node server.js            start on http://localhost:3000
 *   PORT=8080 node server.js  pick a port
 *   DATA_DIR=/path node ...   store data somewhere else
 *   TZ=America/Chicago ...    server's local time zone (matters on cloud hosts)
 *   INGEST_TOKEN=secret ...   lets an email forwarder POST /api/ingest/email
 *   SECURE_COOKIES=1 ...      force Secure cookies (auto-on behind an https proxy)
 *
 * Everything under /api requires a signed-in user except the auth routes and
 * the token-protected email webhook. The first visit creates the supervisor
 * account. See README.md for the full API list.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const store = require('./lib/store');
const auth = require('./lib/auth');
const api = require('./lib/api');
const pm = require('./lib/pm');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const { HttpError, fail } = api;

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) { // 1 MB is plenty for any email or note
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new HttpError(400, 'invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  // Only trust X-Forwarded-For when explicitly told we're behind a proxy.
  if (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

const isSupervisor = (user) => user && user.role === 'supervisor';
function requireSupervisor(user) {
  if (!isSupervisor(user)) fail(403, 'Only a supervisor can do that');
}

// ------------------------------------------------------------------ routing

async function handleAuth(req, res, seg) {
  const method = req.method;
  const action = seg[2];

  if (action === 'status' && method === 'GET') {
    const user = auth.userFromRequest(req);
    return sendJson(res, 200, { setupNeeded: store.listUsers().length === 0, user: store.publicUser(user) });
  }
  if (method !== 'POST') fail(404, 'no such endpoint');
  const body = await readBody(req);

  if (action === 'setup') {
    if (store.listUsers().length > 0) fail(409, 'Setup is already done — sign in instead');
    const name = String(body.name || '').trim();
    if (!name) fail(400, 'Enter your name');
    const problem = auth.secretProblem(body.secret, 'supervisor');
    if (problem) fail(400, problem);
    const user = store.createUser({ name, role: 'supervisor', ...auth.hashSecret(body.secret) });
    const token = auth.startSession(user);
    return sendJson(res, 201, { user: store.publicUser(user) }, { 'Set-Cookie': auth.sessionCookie(req, token) });
  }

  if (action === 'login') {
    const name = String(body.name || '').trim();
    const ip = clientIp(req);
    if (auth.isLocked(name, ip)) fail(429, 'Too many wrong tries. Wait 15 minutes and try again.');
    const user = store.findUserByName(name);
    if (!user || !user.active || !auth.verifySecret(body.secret, user)) {
      auth.recordFailure(name, ip);
      fail(401, 'Name or PIN is wrong');
    }
    auth.clearFailures(name);
    const token = auth.startSession(user);
    return sendJson(res, 200, { user: store.publicUser(user) }, { 'Set-Cookie': auth.sessionCookie(req, token) });
  }

  if (action === 'logout') {
    auth.userFromRequest(req);
    auth.endSession(req);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(req) });
  }

  fail(404, 'no such endpoint');
}

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // Every write must be JSON. Browsers can't send that cross-site without a
  // CORS preflight (which we never grant), so this doubles as CSRF defense.
  if (method !== 'GET' && method !== 'HEAD') {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.includes('application/json')) fail(415, 'Send JSON (Content-Type: application/json)');
  }

  if (seg[1] === 'auth') return handleAuth(req, res, seg);

  // Email webhook: allowed with the shared token, no login needed.
  let user = auth.userFromRequest(req);
  if (!user && seg[1] === 'ingest' && seg[2] === 'email' && INGEST_TOKEN) {
    const token = req.headers['x-ingest-token'] || url.searchParams.get('token');
    if (token === INGEST_TOKEN) user = { id: null, name: 'email', role: 'tech' };
  }
  if (!user) fail(401, 'Please sign in');

  // ---------------------------------------------------------------- me
  if (seg[1] === 'me') {
    if (method === 'GET' && !seg[2]) return sendJson(res, 200, store.publicUser(user));
    if (method === 'POST' && seg[2] === 'secret') {
      const body = await readBody(req);
      if (!auth.verifySecret(body.current, user)) fail(400, 'Current PIN/password is wrong');
      const problem = auth.secretProblem(body.next, user.role);
      if (problem) fail(400, problem);
      store.updateUser(user.id, auth.hashSecret(body.next));
      return sendJson(res, 200, { ok: true });
    }
  }

  // ------------------------------------------------------------- users
  if (seg[1] === 'users') {
    requireSupervisor(user);
    if (method === 'GET') return sendJson(res, 200, store.listUsers().map(store.publicUser));
    const body = await readBody(req);
    if (method === 'POST') {
      const name = String(body.name || '').trim();
      if (!name) fail(400, 'Name is required');
      if (store.findUserByName(name)) fail(409, 'Someone with that name already has an account');
      const role = store.ROLES.includes(body.role) ? body.role : 'tech';
      const problem = auth.secretProblem(body.secret, role);
      if (problem) fail(400, problem);
      const u = store.createUser({ name, role, ...auth.hashSecret(body.secret) });
      return sendJson(res, 201, store.publicUser(u));
    }
    if (method === 'PATCH' && seg[2]) {
      const target = store.findUser(seg[2]);
      if (!target) fail(404, 'not found');
      const patch = {};
      if ('role' in body && store.ROLES.includes(body.role)) patch.role = body.role;
      if ('active' in body) patch.active = !!body.active;
      if ('name' in body && String(body.name).trim()) {
        const clash = store.findUserByName(body.name);
        if (clash && clash.id !== target.id) fail(409, 'That name is taken');
        patch.name = String(body.name).trim();
      }
      const finalRole = patch.role || target.role;
      const finalActive = 'active' in patch ? patch.active : target.active;
      if (target.role === 'supervisor' && (finalRole !== 'supervisor' || !finalActive)) {
        const others = store.listUsers().filter((u) => u.id !== target.id && u.role === 'supervisor' && u.active);
        if (!others.length) fail(400, 'Keep at least one active supervisor');
      }
      if (body.secret) {
        const problem = auth.secretProblem(body.secret, finalRole);
        if (problem) fail(400, problem);
        Object.assign(patch, auth.hashSecret(body.secret));
        store.deleteSessions((s) => s.userId === target.id && s.id !== req.sessionId);
      } else if (finalRole === 'supervisor' && target.role !== 'supervisor') {
        fail(400, `Set a new password (${auth.MIN_SUPERVISOR_SECRET}+ characters) when promoting to supervisor`);
      }
      if (patch.active === false) store.deleteSessions((s) => s.userId === target.id);
      return sendJson(res, 200, store.publicUser(store.updateUser(target.id, patch)));
    }
  }

  // Everything else is shared with the tablet app (lib/api.js).
  const body = (method === 'GET' || method === 'HEAD') ? {} : await readBody(req);
  const out = await api.handle({ method, seg, query: url.searchParams, body, user });
  return sendJson(res, out.status, out.data, out.headers);
}

function serveStatic(req, res, url) {
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(decodeURIComponent(filePath)).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); res.end(); return; }
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    return sendJson(res, 500, { error: 'Server error: ' + err.message });
  }
});

// ------------------------------------------------------- background chores

let lastBackupDate = '';
function chores() {
  try {
    store.load();
    pm.generateDue();
    auth.pruneSessions();
    const today = store.localDate();
    if (lastBackupDate !== today && store.dataExists()) {
      store.saveNow();
      store.backupDaily();
      lastBackupDate = today;
    }
  } catch (err) {
    console.error('background chores failed:', err.message);
  }
}

process.on('SIGINT', () => { store.saveNow(); process.exit(0); });
process.on('SIGTERM', () => { store.saveNow(); process.exit(0); });

if (require.main === module) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use — the tracker is probably already running.`);
      console.error(`Open http://localhost:${PORT} in a browser, or start with a different PORT.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, () => {
    console.log(`Maintenance tracker running at http://localhost:${PORT}`);
    chores();
    setInterval(chores, 15 * 60000).unref();
  });
}

module.exports = { server, chores };
