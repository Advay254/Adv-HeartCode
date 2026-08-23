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

    // v1.1.2 (revised): tells any well-behaved crawler not to index this
    // page, WITHOUT ever publishing the admin path anywhere public — the
    // alternative (listing it in robots.txt's Disallow rules) works for
    // the same "keep it out of Google" goal, but robots.txt is a public,
    // unauthenticated file, so that approach hands the exact "secret"
    // path to anyone who thinks to check, not just search crawlers. This
    // header achieves the same outcome with no such disclosure: only
    // someone who already reached this exact URL (i.e. already knows the
    // slug) ever sees it, since it's set here — after the slug match
    // above already succeeded — not on some public, guessable route.
    // Applied unconditionally at this single point (before auth is even
    // checked) so it covers the login page itself, not just pages behind
    // a session — the login page is the one actually reachable, and
    // therefore indexable, without credentials.
    res.set('X-Robots-Tag', 'noindex, nofollow');

    return adminPageRouter(req, res, next);
  };
}

module.exports = { adminSlugMiddleware, INTERNAL_ADMIN_PREFIX };
