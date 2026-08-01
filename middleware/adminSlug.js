// The internal path the admin page router's routes are defined against.
// This is a naming convention only — it is NEVER passed to app.use(), so
// Express never registers a route table entry for it. Direct requests to
// /admin or /__internal_admin therefore match nothing and fall through to
// the app's normal 404 handling. The only way in is through this middleware
// recognizing the configured slug and dispatching to the router directly.
const INTERNAL_ADMIN_PREFIX = '/__internal_admin';

/**
 * Returns middleware that, given the real admin page router, forwards
 * requests whose path starts with /${ADMIN_PATH_SLUG} to that router
 * (after rewriting req.url onto INTERNAL_ADMIN_PREFIX), and passes
 * everything else through untouched.
 */
function adminSlugMiddleware(adminPageRouter) {
  return function (req, res, next) {
    const slug = process.env.ADMIN_PATH_SLUG;

    if (!slug) {
      // Misconfigured deployment: refuse to expose any admin surface
      // rather than silently falling back to a guessable default path.
      return next();
    }

    const slugPrefix = `/${slug}`;
    const matchesSlug = req.path === slugPrefix || req.path.startsWith(`${slugPrefix}/`);

    if (!matchesSlug) {
      return next();
    }

    const remainder = req.path.slice(slugPrefix.length) || '/';
    const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = INTERNAL_ADMIN_PREFIX + remainder + queryString;

    return adminPageRouter(req, res, next);
  };
}

module.exports = { adminSlugMiddleware, INTERNAL_ADMIN_PREFIX };
