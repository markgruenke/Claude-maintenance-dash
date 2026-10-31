'use strict';
/**
 * Accounts, PIN/password hashing and login sessions — Node built-ins only.
 *
 *  - Secrets are hashed with scrypt + a per-user random salt; the plain PIN
 *    is never stored.
 *  - A login gives the browser a random 32-byte token in an HttpOnly cookie;
 *    only the token's SHA-256 is kept server-side.
 *  - Repeated wrong guesses lock that name (and that IP) out for a while, so
 *    a short tablet PIN can't simply be brute-forced once this is online.
 */

const crypto = require('crypto');
const store = require('./store');

const SESSION_DAYS = 60;              // tablets stay signed in; sliding expiry
const COOKIE = 'mt_session';
const MIN_TECH_SECRET = 4;
const MIN_SUPERVISOR_SECRET = 8;
const LOCK_AFTER = 5;                 // failures ...
const LOCK_WINDOW_MS = 15 * 60000;    // ... within 15 min => locked for 15 min

function hashSecret(secret, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  return { salt, hash };
}

function verifySecret(secret, user) {
  if (!user || !user.salt || !user.hash) return false;
  const { hash } = hashSecret(secret, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function secretProblem(secret, role) {
  const min = role === 'supervisor' ? MIN_SUPERVISOR_SECRET : MIN_TECH_SECRET;
  if (!secret || String(secret).length < min) {
    return role === 'supervisor'
      ? `Supervisor password must be at least ${MIN_SUPERVISOR_SECRET} characters`
      : `PIN must be at least ${MIN_TECH_SECRET} characters`;
  }
  return null;
}

// ------------------------------------------------------------ rate limit

const failures = new Map(); // key -> [timestamps]

function recentFailures(key) {
  const cutoff = Date.now() - LOCK_WINDOW_MS;
  const list = (failures.get(key) || []).filter((t) => t > cutoff);
  failures.set(key, list);
  return list;
}

function isLocked(name, ip) {
  return recentFailures('n:' + store.normalizeName(name)).length >= LOCK_AFTER
    || recentFailures('ip:' + ip).length >= LOCK_AFTER * 4;
}

function recordFailure(name, ip) {
  for (const key of ['n:' + store.normalizeName(name), 'ip:' + ip]) {
    const list = recentFailures(key);
    list.push(Date.now());
    failures.set(key, list);
  }
}

function clearFailures(name) {
  failures.delete('n:' + store.normalizeName(name));
}

// --------------------------------------------------------------- sessions

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function startSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  store.createSession(tokenHash(token), user.id, SESSION_DAYS);
  return token;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** The signed-in, active user for this request, or null. */
function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = store.findSession(tokenHash(token));
  if (!s) return null;
  if (new Date(s.expiresAt).getTime() < Date.now()) {
    store.deleteSessions((x) => x.id === s.id);
    return null;
  }
  const user = store.findUser(s.userId);
  if (!user || !user.active) return null;
  store.touchSession(s, SESSION_DAYS);
  req.sessionId = s.id;
  return user;
}

function endSession(req) {
  if (req.sessionId) store.deleteSessions((s) => s.id === req.sessionId);
}

function isSecureRequest(req) {
  return process.env.SECURE_COOKIES === '1'
    || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86400}`];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(req) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function pruneSessions() {
  const t = Date.now();
  store.deleteSessions((s) => new Date(s.expiresAt).getTime() < t);
}

module.exports = {
  hashSecret, verifySecret, secretProblem,
  isLocked, recordFailure, clearFailures,
  startSession, userFromRequest, endSession, sessionCookie, clearCookie, pruneSessions,
  MIN_TECH_SECRET, MIN_SUPERVISOR_SECRET,
};
