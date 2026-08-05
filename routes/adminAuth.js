const express = require('express');
const { getPool } = require('../db/init');
const {
  verifyPassword,
  timingSafeEqual,
  createSession,
  destroySession,
  sessionCookieOptions
} = require('../lib/auth');
const { requireAdminSession, COOKIE_NAME, getSessionCookie } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { INTERNAL_ADMIN_PREFIX } = require('../middleware/adminSlug');

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// ---- brute-force protection (in-memory) ----
// Resets on server restart, and only scopes per running process — both
// acceptable at this stage. Move to a DB-backed counter (e.g. a
// login_attempts table keyed by IP) if this becomes a real concern at scale
// or once the app runs across multiple instances.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const attemptsByIp = new Map(); // ip -> { count, firstAttemptAt, lockedUntil }

function isLockedOut(ip) {
  const record = attemptsByIp.get(ip);
  if (!record) return false;

  const now = Date.now();

  if (record.lockedUntil) {
    if (now < record.lockedUntil) return true;
    attemptsByIp.delete(ip);
    return false;
  }

  if (now - record.firstAttemptAt > WINDOW_MS) {
    attemptsByIp.delete(ip);
    return false;
  }

  return false;
}

function recordFailure(ip) {
  const now = Date.now();
  const record = attemptsByIp.get(ip);

  if (!record || now - record.firstAttemptAt > WINDOW_MS) {
    attemptsByIp.set(ip, { count: 1, firstAttemptAt: now, lockedUntil: null });
    return;
  }

  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_MS;
  }
}

function clearFailures(ip) {
  attemptsByIp.delete(ip);
}

// ---- page router ----
// Only ever reached via adminSlugMiddleware — never mounted with app.use(),
// so this route has no public entry point of its own. Unauthenticated by
// design: this IS the login page.
const pageRouter = express.Router();

pageRouter.get(`${INTERNAL_ADMIN_PREFIX}/login`, (req, res) => {
  res.render('admin/login', { slug: process.env.ADMIN_PATH_SLUG });
});

// ---- API router ----
// Mounted normally at /api/admin (not slug-gated). Every route except
// /login is session-gated by requireAdminSession; every state-changing
// route except /login is also CSRF-gated (login has no session yet to
// bind a CSRF token to — see the comment in views/admin/login.ejs).
const apiRouter = express.Router();

apiRouter.post('/login', async (req, res) => {
  const ip = req.ip;

  if (isLockedOut(ip)) {
    return res.status(429).json({ error: 'Too many attempts, try again later' });
  }

  const { username, password } = req.body || {};

  if (typeof username !== 'string' || typeof password !== 'string') {
    recordFailure(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Both checks always run (no short-circuit on username first) so a
  // wrong username doesn't skip the bcrypt compare and create a timing
  // difference between "bad username" and "bad password".
  // .trim() guards against invisible leading/trailing whitespace ending up
  // in the env var — an easy silent failure mode when values are
  // copy-pasted on mobile (e.g. into Render's dashboard) rather than typed.
  const usernameOk = timingSafeEqual(username, (process.env.ADMIN_USERNAME || '').trim());
  const passwordOk = await verifyPassword(password, (process.env.ADMIN_PASSWORD_HASH || '').trim());

  if (!usernameOk || !passwordOk) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  clearFailures(ip);

  const pool = getPool();
  const { cookieValue } = await createSession(pool, process.env.SESSION_SECRET);
  const cookieOptions = sessionCookieOptions(SESSION_MAX_AGE_SECONDS);

  // sessionCookieOptions() returns maxAge in seconds (matching its
  // maxAgeSeconds parameter name); Express's res.cookie() expects
  // milliseconds, so the conversion happens only here, at the one place
  // that actually calls res.cookie().
  res.cookie(COOKIE_NAME, cookieValue, { ...cookieOptions, maxAge: cookieOptions.maxAge * 1000 });
  res.json({ success: true });
});

apiRouter.post('/logout', requireAdminSession, requireCsrf, async (req, res) => {
  const pool = getPool();
  const cookieValue = getSessionCookie(req);
  await destroySession(pool, cookieValue);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ success: true });
});

apiRouter.get('/me', requireAdminSession, (req, res) => {
  res.json({ authenticated: true });
});

module.exports = { pageRouter, apiRouter };
