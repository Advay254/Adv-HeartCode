const { verifyCsrfToken } = require('../lib/auth');
const { getSessionCookie } = require('./requireAdminSession');

/**
 * Verifies the X-CSRF-Token header against a token derived from the
 * current session cookie. Must run AFTER requireAdminSession on any route
 * that uses it, since it assumes a valid session cookie is present — it
 * doesn't re-verify the session itself, only that the submitted token
 * matches one derived from that session's cookie value.
 */
function requireCsrf(req, res, next) {
  const cookieValue = getSessionCookie(req);
  const submitted = req.headers['x-csrf-token'];

  if (!cookieValue || typeof submitted !== 'string' || !submitted) {
    return res.status(403).json({ error: 'Missing CSRF token' });
  }

  if (!verifyCsrfToken(cookieValue, process.env.SESSION_SECRET, submitted)) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  return next();
}

module.exports = { requireCsrf };
