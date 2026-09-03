const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const {
  timingSafeEqual,
  createSession,
  destroySession,
  sessionCookieOptions
} = require('../lib/auth');
const { requireAdminSession, COOKIE_NAME, getSessionCookie } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { INTERNAL_ADMIN_PREFIX } = require('../middleware/adminSlug');
const { getRealClientIp } = require('../lib/clientIp');

// v1.1.4: shortened from 7 days to 24 hours -- deliberate security
// hardening (the admin panel controls real payment and AI provider
// credentials), not a bug fix. Must stay in lock-step with
// lib/auth.js's createSession() expiresAt calculation -- both are changed
// together here so the DB-stored session expiry and the cookie's maxAge
// never drift apart into a confusing "one expires before the other" state.
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

// Gap this closes: previously just `typeof username === 'string'`, with no
// length bound at all — an unbounded string could be sent as either field
// before the rate limiter even has a chance to matter for THIS request
// (bcrypt is already gone, but wasted work on a huge string is still
// wasted work). 200 chars is generous headroom past any real credential.
const loginBodySchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(200)
});

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

apiRouter.post('/login', asyncHandler(async (req, res) => {
  // v1.1.9 hotfix Part 2: see lib/clientIp.js -- the lockout must key off
  // the real visitor IP, not Cloudflare's edge address, or every visitor
  // behind Cloudflare would share one lockout bucket.
  const ip = getRealClientIp(req);

  if (isLockedOut(ip)) {
    return res.status(429).json({ error: 'Too many attempts, try again later' });
  }

  const parsed = loginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const { username, password } = parsed.data;

  // Both checks always run (no short-circuit on username first), and both
  // use timingSafeEqual — constant-time comparison against a single
  // ADMIN_PASSWORD env var, no manual hashing step required. bcrypt exists
  // to protect a *stored* credential (e.g. a database of many users'
  // hashed passwords) from offline cracking if that storage leaks. There's
  // no such storage here: this is one admin credential living only in
  // Render's env vars, never written to a database — if that env var
  // itself ever leaked, hashing it after the fact wouldn't have protected
  // the original plaintext sitting in Render's dashboard either way. Rate
  // limiting below is what actually protects against online brute-forcing,
  // which is the threat that applies to this shape of credential.
  //
  // .trim() guards against invisible leading/trailing whitespace ending up
  // in the env var — an easy silent failure mode when values are
  // copy-pasted on mobile (e.g. into Render's dashboard) rather than typed.
  const usernameOk = timingSafeEqual(username, (process.env.ADMIN_USERNAME || '').trim());
  const passwordOk = timingSafeEqual(password, (process.env.ADMIN_PASSWORD || '').trim());

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
}));

apiRouter.post('/logout', requireAdminSession, requireCsrf, asyncHandler(async (req, res) => {
  const pool = getPool();
  const cookieValue = getSessionCookie(req);
  await destroySession(pool, cookieValue);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ success: true });
}));

apiRouter.get('/me', requireAdminSession, (req, res) => {
  res.json({ authenticated: true });
});

module.exports = { pageRouter, apiRouter };
