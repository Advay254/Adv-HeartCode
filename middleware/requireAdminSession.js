const { getPool } = require('../db/init');
const { verifySession } = require('../lib/auth');

const COOKIE_NAME = 'heartcode_admin_session';

// Minimal manual cookie parsing so we don't have to pull in the
// `cookie-parser` package just to read one cookie. The project's dependency
// list has been kept deliberately short (express, pg, dotenv, ejs) — swap
// this for cookie-parser later if cookie handling grows beyond this single
// read.
function getSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === COOKIE_NAME) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }

  return undefined;
}

/**
 * Verifies the admin session cookie.
 * - /api/admin/* routes (checked via req.originalUrl, since req.path is
 *   relative once mounted under a router) get a 401 JSON response.
 * - Page routes get redirected to the login page via the currently
 *   configured slug.
 * On success, attaches req.admin = { authenticated: true } and continues.
 */
async function requireAdminSession(req, res, next) {
  try {
    const cookieValue = getSessionCookie(req);
    const pool = getPool();
    const valid = cookieValue
      ? await verifySession(pool, process.env.SESSION_SECRET, cookieValue)
      : false;

    if (!valid) {
      if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const slug = process.env.ADMIN_PATH_SLUG;
      return res.redirect(slug ? `/${slug}/login` : '/');
    }

    req.admin = { authenticated: true };
    return next();
  } catch (err) {
    console.error('[AUTH] Session verification error:', err.message);
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/');
  }
}

module.exports = { requireAdminSession, COOKIE_NAME, getSessionCookie };
