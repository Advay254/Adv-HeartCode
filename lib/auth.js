const crypto = require('crypto');

// v1.2.17: the one place the session lifetime is defined. createSession() below
// (the database expiry) and routes/adminAuth.js (the cookie's maxAge) both use
// this constant, so the two can never drift apart.
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

// v1.2.17: a session not used for this long is treated as expired, on top of
// the 24 hour maximum. ADMIN_SESSION_IDLE_MINUTES changes it (5 to 1440).
const DEFAULT_IDLE_MINUTES = 120;
function getIdleTimeoutMs() {
  const n = parseInt(process.env.ADMIN_SESSION_IDLE_MINUTES, 10);
  const minutes = Number.isFinite(n) ? Math.min(1440, Math.max(5, n)) : DEFAULT_IDLE_MINUTES;
  return minutes * 60 * 1000;
}

// "Last used" is written at most about once a minute per session, so normal
// browsing does not cause a database write on every request.
const TOUCH_INTERVAL_MS = 60 * 1000;
const lastTouchByToken = new Map(); // token -> ms of the last write (bounded)
const MAX_TOUCH_ENTRIES = 500;

/**
 * Constant-time string comparison for signature/credential checks.
 * If lengths differ we still run a same-length dummy comparison rather than
 * returning immediately, so a length mismatch doesn't create an obviously
 * faster timing path than a full mismatch does.
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');

  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * HMAC-SHA256 over `value` using `secret`, returned as a hex digest.
 */
function hmacSign(value, secret) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

/**
 * Creates a new admin session: random UUID token stored in admin_sessions
 * (expires in 24 hours), returned to the caller as a signed "token.signature"
 * cookie value. The signature lets verifySession reject tampered/garbage
 * cookies before ever touching the DB.
 *
 * v1.1.4: deliberately shortened from 7 days to 24 hours -- security
 * hardening given the admin panel controls real payment and AI provider
 * credentials, not a bug fix. A 7-day session significantly widened the
 * window of risk if a device was shared, lost, or left logged in
 * somewhere. This constant must stay in lock-step with
 * routes/adminAuth.js's SESSION_MAX_AGE_SECONDS (the cookie's maxAge) --
 * see that file's own comment. A mismatch between the two would create a
 * confusing state where one expires before the other.
 */
async function createSession(pool, secret) {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  await pool.query(
    'INSERT INTO admin_sessions (token, expires_at, last_used_at) VALUES ($1, $2, NOW())',
    [token, expiresAt]
  );
  lastTouchByToken.set(token, Date.now());

  const signature = hmacSign(token, secret);
  return { cookieValue: `${token}.${signature}`, expiresAt };
}

/**
 * Verifies a "token.signature" cookie value. Signature is checked FIRST
 * (cheap, no DB hit) so a forged or malformed cookie is rejected before we
 * ever query admin_sessions. Only after that does it check the token exists
 * and hasn't expired — expired sessions are deleted on the way out.
 */
async function verifySession(pool, secret, cookieValue) {
  if (typeof cookieValue !== 'string') return false;

  const parts = cookieValue.split('.');
  if (parts.length !== 2) return false;

  const [token, signature] = parts;
  if (!token || !signature) return false;

  const expectedSignature = hmacSign(token, secret);
  if (!timingSafeEqual(signature, expectedSignature)) {
    return false;
  }

  const result = await pool.query(
    'SELECT expires_at, last_used_at FROM admin_sessions WHERE token = $1',
    [token]
  );

  if (result.rowCount === 0) return false;

  const now = Date.now();
  const expiresAt = new Date(result.rows[0].expires_at);
  const lastUsedAt = new Date(result.rows[0].last_used_at).getTime();
  const idle = Number.isFinite(lastUsedAt) && now - lastUsedAt > getIdleTimeoutMs();
  if (expiresAt.getTime() < now || idle) {
    await pool.query('DELETE FROM admin_sessions WHERE token = $1', [token]);
    lastTouchByToken.delete(token);
    return false;
  }

  // Record use, at most once a minute per session.
  const lastTouch = lastTouchByToken.get(token) || 0;
  if (now - lastTouch >= TOUCH_INTERVAL_MS) {
    if (lastTouchByToken.size >= MAX_TOUCH_ENTRIES) {
      lastTouchByToken.delete(lastTouchByToken.keys().next().value);
    }
    lastTouchByToken.set(token, now);
    pool.query('UPDATE admin_sessions SET last_used_at = NOW() WHERE token = $1', [token]).catch((err) => {
      console.error('[AUTH] Could not record session use:', err.message);
    });
  }

  return true;
}

/** Ends every session, including the one making the request. Returns how many. */
async function destroyAllSessions(pool) {
  lastTouchByToken.clear();
  const result = await pool.query('DELETE FROM admin_sessions');
  return result.rowCount;
}

/** Ends every session except the one for this cookie. Returns how many. */
async function destroyOtherSessions(pool, cookieValue) {
  const [token] = String(cookieValue || '').split('.');
  for (const key of [...lastTouchByToken.keys()]) {
    if (key !== token) lastTouchByToken.delete(key);
  }
  const result = await pool.query('DELETE FROM admin_sessions WHERE token <> $1', [token || '']);
  return result.rowCount;
}

/** Scheduled cleanup: removes expired and idle sessions. Returns how many. */
async function cleanupSessions(pool) {
  const idleCutoff = new Date(Date.now() - getIdleTimeoutMs());
  const result = await pool.query(
    'DELETE FROM admin_sessions WHERE expires_at < NOW() OR last_used_at < $1',
    [idleCutoff]
  );
  return result.rowCount;
}

async function countSessions(pool) {
  const result = await pool.query('SELECT COUNT(*)::int AS n FROM admin_sessions WHERE expires_at > NOW()');
  return result.rows[0].n;
}

/**
 * Deletes the session row backing a given cookie value (logout).
 */
async function destroySession(pool, cookieValue) {
  if (typeof cookieValue !== 'string') return;
  const [token] = cookieValue.split('.');
  if (!token) return;
  lastTouchByToken.delete(token);
  await pool.query('DELETE FROM admin_sessions WHERE token = $1', [token]);
}

/**
 * Standard cookie options for the admin session cookie.
 * NOTE: maxAge is returned in the same unit passed in (seconds, per the
 * `maxAgeSeconds` param name) to match the specified shape exactly.
 * Express's res.cookie() expects maxAge in milliseconds, so callers using
 * res.cookie() must multiply this value by 1000 at the call site — see the
 * comment in routes/adminAuth.js where it's actually used.
 */
function sessionCookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSeconds
  };
}

/**
 * Derives a CSRF token bound to a specific session cookie value, so the
 * token is useless without a matching valid session.
 */
function deriveCsrfToken(sessionCookieValue, secret) {
  return hmacSign(`csrf:${sessionCookieValue}`, secret);
}

/**
 * Recomputes the expected CSRF token for a session and compares it to what
 * was submitted, in constant time.
 */
function verifyCsrfToken(sessionCookieValue, secret, submittedToken) {
  const expected = deriveCsrfToken(sessionCookieValue, secret);
  return timingSafeEqual(expected, submittedToken);
}

module.exports = {
  timingSafeEqual,
  hmacSign,
  createSession,
  verifySession,
  destroySession,
  destroyAllSessions,
  destroyOtherSessions,
  cleanupSessions,
  countSessions,
  getIdleTimeoutMs,
  SESSION_MAX_AGE_SECONDS,
  sessionCookieOptions,
  deriveCsrfToken,
  verifyCsrfToken
};
