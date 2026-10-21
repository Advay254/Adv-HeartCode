'use strict';

// v1.2.17: the short-lived step between a correct password and the code.
//
// After the password is right and two-step login is on, no session exists yet.
// This holds a random, single-use token for about 5 minutes. The token is
// returned to the login page in the response body (never as a cookie), so it
// cannot be used as a session anywhere: only POST /api/admin/login/code
// accepts it. At most MAX_TRIES wrong codes are allowed per token, then it is
// destroyed and the password must be entered again.
//
// In memory, bounded, per running copy of the app (a restart or a second copy
// simply asks for the password again).

const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;
const MAX_TRIES = 5;
const MAX_PENDING = 200;

const pending = new Map(); // token -> { expiresAt, tries }

function sweep(now = Date.now()) {
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
}

function createPending() {
  const now = Date.now();
  sweep(now);
  while (pending.size >= MAX_PENDING) {
    pending.delete(pending.keys().next().value);
  }
  const token = crypto.randomBytes(32).toString('hex');
  pending.set(token, { expiresAt: now + TTL_MS, tries: 0 });
  return { token, expiresInSeconds: TTL_MS / 1000 };
}

/** True if the token exists and has not expired. Does not use it up. */
function hasPending(token) {
  const entry = typeof token === 'string' ? pending.get(token) : null;
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    pending.delete(token);
    return false;
  }
  return true;
}

/** Counts one wrong code. Destroys the token after MAX_TRIES. */
function recordWrongCode(token) {
  const entry = pending.get(token);
  if (!entry) return;
  entry.tries += 1;
  if (entry.tries >= MAX_TRIES) pending.delete(token);
}

/** Uses the token up (one use). */
function consumePending(token) {
  return pending.delete(token);
}

module.exports = { createPending, hasPending, recordWrongCode, consumePending, TTL_MS, MAX_TRIES };
