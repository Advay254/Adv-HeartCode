const crypto = require('crypto');
const bcrypt = require('bcrypt');

/**
 * bcrypt compare against the stored hash. Never compare plaintext directly.
 */
async function verifyPassword(plainPassword, hash) {
  if (typeof plainPassword !== 'string' || typeof hash !== 'string' || !hash) {
    return false;
  }
  return bcrypt.compare(plainPassword, hash);
}

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
 * (expires in 7 days), returned to the caller as a signed "token.signature"
 * cookie value. The signature lets verifySession reject tampered/garbage
 * cookies before ever touching the DB.
 */
async function createSession(pool, secret) {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await pool.query(
    'INSERT INTO admin_sessions (token, expires_at) VALUES ($1, $2)',
    [token, expiresAt]
  );

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
    'SELECT expires_at FROM admin_sessions WHERE token = $1',
    [token]
  );

  if (result.rowCount === 0) return false;

  const expiresAt = new Date(result.rows[0].expires_at);
  if (expiresAt < new Date()) {
    await pool.query('DELETE FROM admin_sessions WHERE token = $1', [token]);
    return false;
  }

  return true;
}

/**
 * Deletes the session row backing a given cookie value (logout).
 */
async function destroySession(pool, cookieValue) {
  if (typeof cookieValue !== 'string') return;
  const [token] = cookieValue.split('.');
  if (!token) return;
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
  verifyPassword,
  timingSafeEqual,
  hmacSign,
  createSession,
  verifySession,
  destroySession,
  sessionCookieOptions,
  deriveCsrfToken,
  verifyCsrfToken
};
