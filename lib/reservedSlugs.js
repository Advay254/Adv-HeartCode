// v1.2.0: the single place that knows every existing top-level route a
// new seo_pages.slug must never collide with. routes/public.js registers
// GET /:seoSlug LAST, after every one of these specific routes, so a
// literal collision wouldn't corrupt anything at the HTTP layer -- the
// existing, more-specific route always wins over the dynamic one placed
// after it. The real problem a collision would cause is silent: the new
// SEO page would simply be unreachable forever (shadowed by the route
// registered before it), with nothing telling the admin why the page
// they just created 404s or shows something else entirely. Rejecting the
// slug at CREATE time with a clear, specific error is far better than
// that silent dead end -- see routes/adminSeoPages.js's use of this.
//
// Kept as a small list (plus the one dynamic entry below) specifically so
// it's trivial to extend if a new top-level route is ever added later --
// see routes/public.js's own top-level router.get() calls for the
// authoritative current list this must stay in sync with.
const RESERVED_TOP_LEVEL_SLUGS = [
  'explore',
  'build',
  'resend-details',
  'sitemap.xml',
  'robots.txt',
  'llms.txt',
  '.well-known',
  'api'
];

/**
 * True if `slug` collides with a reserved top-level route -- either the
 * static list above, or this specific install's admin dashboard path
 * (ADMIN_PATH_SLUG, an env var, so checked dynamically here rather than
 * hardcoded into the static list, which every install shares).
 */
function isReservedTopLevelSlug(slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) return false;

  if (RESERVED_TOP_LEVEL_SLUGS.includes(normalized)) {
    return true;
  }

  // middleware/adminSlug.js rewrites requests matching this path to the
  // real (never publicly mounted) admin router BEFORE routes/public.js
  // ever runs -- an SEO page slug equal to it would be silently
  // shadowed the exact same way, just one layer earlier.
  const adminSlug = process.env.ADMIN_PATH_SLUG;
  if (adminSlug && normalized === String(adminSlug).trim().toLowerCase()) {
    return true;
  }

  return false;
}

module.exports = { RESERVED_TOP_LEVEL_SLUGS, isReservedTopLevelSlug };
