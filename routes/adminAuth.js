const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const {
  timingSafeEqual,
  createSession,
  destroySession,
  sessionCookieOptions,
  SESSION_MAX_AGE_SECONDS
} = require('../lib/auth');
const { requireAdminSession, COOKIE_NAME, getSessionCookie } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { INTERNAL_ADMIN_PREFIX } = require('../middleware/adminSlug');
const { getRateLimitKey } = require('../lib/clientIp');
const throttle = require('../lib/loginThrottle');
const pendingStep = require('../lib/loginPending');
const adminSecurity = require('../lib/adminSecurity');
const { notifyAdminAlert } = require('../lib/notifications');

// The session lifetime (24 hours) lives in lib/auth.js as
// SESSION_MAX_AGE_SECONDS and is used for BOTH the database expiry and this
// cookie's maxAge, so the two cannot drift apart. v1.2.17 adds an idle timeout
// on top (lib/auth.js getIdleTimeoutMs).

// Gap this closes: previously just `typeof username === 'string'`, with no
// length bound at all — an unbounded string could be sent as either field
// before the rate limiter even has a chance to matter for THIS request
// (bcrypt is already gone, but wasted work on a huge string is still
// wasted work). 200 chars is generous headroom past any real credential.
const loginBodySchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(200)
});

// ---- brute-force protection ----
// All of it lives in lib/loginThrottle.js (per address limit, bounded memory,
// global slow mode). It is per running copy of the app and resets on restart.

const codeBodySchema = z.object({
  pendingToken: z.string().min(1).max(200),
  code: z.string().min(1).max(40)
});

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

async function startSession(res) {
  const pool = getPool();
  const { cookieValue } = await createSession(pool, process.env.SESSION_SECRET);
  const cookieOptions = sessionCookieOptions(SESSION_MAX_AGE_SECONDS);

  // sessionCookieOptions() returns maxAge in seconds (matching its
  // maxAgeSeconds parameter name); Express's res.cookie() expects
  // milliseconds, so the conversion happens only here, at the one place
  // that actually calls res.cookie().
  res.cookie(COOKIE_NAME, cookieValue, { ...cookieOptions, maxAge: cookieOptions.maxAge * 1000 });
}

apiRouter.post('/login', asyncHandler(async (req, res) => {
  // v1.2.17: the counting key comes from lib/clientIp.js, which only believes
  // the Cloudflare header when the request really arrived from Cloudflare.
  const key = getRateLimitKey(req);

  if (throttle.isLockedOut(key)) {
    return res.status(429).json({ error: 'Too many attempts, try again later' });
  }

  // Slow mode: when many wrong logins are arriving from anywhere, every
  // attempt waits a couple of seconds, right or wrong. A correct login still
  // works. Same wait whatever the outcome, so it reveals nothing.
  await throttle.applySlowModeDelay();

  const parsed = loginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    throttle.recordFailure(key);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const { username, password } = parsed.data;

  // Both checks always run (no short-circuit on username first), and both
  // use timingSafeEqual — constant-time comparison against a single
  // ADMIN_PASSWORD env var, no manual hashing step required. bcrypt exists
  // to protect a *stored* credential (e.g. a database of many users'
  // hashed passwords) from offline cracking if that storage leaks. There's
  // no such storage here: this is one admin credential living only in
  // the host's environment settings, never written to a database. If that env var
  // itself ever leaked, hashing it after the fact wouldn't have protected
  // the original plaintext sitting in the host's dashboard either way. Rate
  // limiting below is what actually protects against online brute-forcing,
  // which is the threat that applies to this shape of credential.
  //
  // .trim() guards against invisible leading/trailing whitespace ending up
  // in the env var — an easy silent failure mode when values are
  // copy-pasted on mobile (e.g. into a host's dashboard) rather than typed.
  const usernameOk = timingSafeEqual(username, (process.env.ADMIN_USERNAME || '').trim());
  const passwordOk = timingSafeEqual(password, (process.env.ADMIN_PASSWORD || '').trim());

  if (!usernameOk || !passwordOk) {
    throttle.recordFailure(key);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const pool = getPool();
  let twoStep = false;
  try {
    twoStep = await adminSecurity.isTwoStepActive(pool);
  } catch (err) {
    // If the setting cannot be read, fail closed: no session, clear message.
    console.error('[AUTH] Could not read the two-step setting:', err.message);
    return res.status(503).json({ error: 'Login is temporarily unavailable' });
  }

  if (twoStep) {
    // The failure count is NOT cleared here. It is only cleared once the code
    // step also succeeds, so a correct password cannot be used to reset the
    // count between wrong code guesses.
    const step = pendingStep.createPending();
    return res.json({ success: true, needsCode: true, pendingToken: step.token, expiresInSeconds: step.expiresInSeconds });
  }

  throttle.clearFailures(key);
  await startSession(res);
  res.json({ success: true });
}));

// Second step. Accepts an app code or an unused recovery code. A wrong code
// counts as a failed attempt in the same limits as a wrong password.
apiRouter.post('/login/code', asyncHandler(async (req, res) => {
  const key = getRateLimitKey(req);

  if (throttle.isLockedOut(key)) {
    return res.status(429).json({ error: 'Too many attempts, try again later' });
  }
  await throttle.applySlowModeDelay();

  const parsed = codeBodySchema.safeParse(req.body);
  if (!parsed.success || !pendingStep.hasPending(parsed.data.pendingToken)) {
    if (parsed.success) throttle.recordFailure(key);
    return res.status(401).json({ error: 'That sign-in step expired. Enter your username and password again.', restart: true });
  }
  const { pendingToken, code } = parsed.data;

  const pool = getPool();
  const result = await adminSecurity.verifyLoginCode(pool, code);

  if (!result.ok) {
    throttle.recordFailure(key);
    pendingStep.recordWrongCode(pendingToken);
    if (result.reason === 'unreadable') {
      return res.status(401).json({ error: 'Authenticator codes cannot be read right now (the encryption key may have changed). Use a recovery code instead.' });
    }
    return res.status(401).json({ error: 'Invalid code' });
  }

  pendingStep.consumePending(pendingToken);
  throttle.clearFailures(key);
  await startSession(res);

  if (result.method === 'recovery') {
    const row = await adminSecurity.getRow(pool);
    notifyAdminAlert({
      event: 'recovery_code_used',
      title: 'Recovery code used',
      message: `A two-step recovery code was used to log in to the admin. ${adminSecurity.recoveryRemaining(row)} unused recovery codes are left.`
    }).catch(() => {});
  }

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
