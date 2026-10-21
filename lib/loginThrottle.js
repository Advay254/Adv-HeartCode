'use strict';

// v1.2.17: everything that slows down or blocks wrong admin logins.
//
// Two layers, both in memory:
//
// 1. Per address (counting key from lib/clientIp.js getRateLimitKey):
//    5 failures in 15 minutes lock that address out for 15 minutes.
//    Unchanged from before, but now bounded: at most MAX_TRACKED addresses are
//    kept (the oldest is dropped first) and old entries are swept on a timer,
//    not only when the same address comes back.
//
// 2. Global slow mode: failures from ALL addresses are counted in a rolling
//    window. Past the threshold (default 20 in 15 minutes, set with
//    LOGIN_SLOW_MODE_THRESHOLD) every login attempt from any address waits
//    SLOW_DELAY_MS before it is answered. The login is never locked: a correct
//    login still works, only later. One alert is sent when slow mode starts
//    and one when it ends.
//
// Nothing here ever sees, stores or logs a username, password or code. Only
// counts and timestamps.
//
// Limits of this design: it lives in the memory of one running copy of the
// app and resets when that copy restarts, exactly as the old limiter did.
// If several copies of the app run side by side, each has its own counts, so
// an attacker gets the limit once per copy. To share the counts across copies,
// keep them in a shared store (the Postgres database this app already uses, or
// Redis) behind the same function names in this file.

const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_TRACKED = 10000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const BUCKET_MS = 60 * 1000;
const SLOW_DELAY_MS = 2000;
const DEFAULT_SLOW_THRESHOLD = 20;

const attemptsByKey = new Map(); // key -> { count, firstAttemptAt, lockedUntil }
let buckets = new Map(); // minute number -> failure count (all addresses)
let slowActive = false;
let notifier = null;

function slowThreshold() {
  const n = parseInt(process.env.LOGIN_SLOW_MODE_THRESHOLD, 10);
  return Number.isFinite(n) && n >= 3 && n <= 100000 ? n : DEFAULT_SLOW_THRESHOLD;
}

function currentMinute(now) {
  return Math.floor(now / BUCKET_MS);
}

function globalFailureCount(now) {
  const oldest = currentMinute(now) - Math.ceil(WINDOW_MS / BUCKET_MS) + 1;
  let total = 0;
  for (const [minute, count] of buckets) {
    if (minute < oldest) buckets.delete(minute);
    else total += count;
  }
  return total;
}

function sendAlert(kind, count) {
  if (!notifier) return;
  const threshold = slowThreshold();
  const minutes = WINDOW_MS / 60000;
  const payload = kind === 'start'
    ? {
        event: 'login_slow_mode_started',
        title: 'Admin login slowed down',
        message: `${count} failed admin logins in the last ${minutes} minutes (limit ${threshold}). Every login attempt now waits a couple of seconds. A correct login still works.`
      }
    : {
        event: 'login_slow_mode_ended',
        title: 'Admin login back to normal',
        message: `Failed admin logins dropped below ${threshold} in ${minutes} minutes. Login speed is back to normal.`
      };
  try {
    Promise.resolve(notifier(payload)).catch(() => {});
  } catch (err) { /* an alert never affects a login */ }
}

/** Re-evaluates slow mode and sends the start or end alert when it flips. */
function evaluateSlowMode(now = Date.now()) {
  const count = globalFailureCount(now);
  const threshold = slowThreshold();
  if (!slowActive && count >= threshold) {
    slowActive = true;
    sendAlert('start', count);
  } else if (slowActive && count < threshold) {
    slowActive = false;
    sendAlert('end', count);
  }
  return slowActive;
}

// ---- per address ----

function isLockedOut(key, now = Date.now()) {
  const record = attemptsByKey.get(key);
  if (!record) return false;
  if (record.lockedUntil) {
    if (now < record.lockedUntil) return true;
    attemptsByKey.delete(key);
    return false;
  }
  if (now - record.firstAttemptAt > WINDOW_MS) {
    attemptsByKey.delete(key);
  }
  return false;
}

function recordFailure(key, now = Date.now()) {
  // Global count first, so slow mode sees every failure whatever its address.
  const minute = currentMinute(now);
  buckets.set(minute, (buckets.get(minute) || 0) + 1);

  const record = attemptsByKey.get(key);
  if (!record || now - record.firstAttemptAt > WINDOW_MS) {
    if (!record && attemptsByKey.size >= MAX_TRACKED) {
      // Map keeps insertion order, so the first key is the oldest.
      attemptsByKey.delete(attemptsByKey.keys().next().value);
    }
    attemptsByKey.delete(key);
    attemptsByKey.set(key, { count: 1, firstAttemptAt: now, lockedUntil: null });
  } else {
    record.count += 1;
    if (record.count >= MAX_ATTEMPTS) record.lockedUntil = now + LOCKOUT_MS;
  }
  evaluateSlowMode(now);
}

function clearFailures(key) {
  attemptsByKey.delete(key);
}

/**
 * Waits SLOW_DELAY_MS when slow mode is on. Call before answering any login
 * step, right or wrong, so slow mode cannot be used to tell them apart.
 */
async function applySlowModeDelay() {
  if (evaluateSlowMode()) {
    await new Promise((resolve) => setTimeout(resolve, SLOW_DELAY_MS));
  }
}

function sweep(now = Date.now()) {
  for (const [key, record] of attemptsByKey) {
    const expired = record.lockedUntil ? now >= record.lockedUntil : now - record.firstAttemptAt > WINDOW_MS;
    if (expired) attemptsByKey.delete(key);
  }
  evaluateSlowMode(now);
}

let timer = null;
function startThrottleSweep(sendAlertFn) {
  notifier = sendAlertFn || null;
  if (timer) return;
  timer = setInterval(() => sweep(), SWEEP_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

/** For tests and the Security page. */
function getThrottleStats() {
  return {
    trackedAddresses: attemptsByKey.size,
    maxTracked: MAX_TRACKED,
    recentFailures: globalFailureCount(Date.now()),
    slowModeActive: slowActive,
    slowThreshold: slowThreshold()
  };
}

function resetThrottleForTests() {
  attemptsByKey.clear();
  buckets = new Map();
  slowActive = false;
}

module.exports = {
  isLockedOut,
  recordFailure,
  clearFailures,
  applySlowModeDelay,
  startThrottleSweep,
  getThrottleStats,
  sweep,
  resetThrottleForTests,
  MAX_TRACKED,
  SLOW_DELAY_MS
};
