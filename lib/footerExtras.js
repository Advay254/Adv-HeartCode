const { getPool } = require('../db/init');

// v1.2.2 Part F (customLinks) + v1.2.3 Part D (seoPages): cached the same
// way and for the same reason as lib/siteSettings.js / lib/landingContent.js
// -- seoPages is read on every homepage request (its nav's hamburger
// dropdown), customLinks on every public page request (the footer), so a
// per-request DB round trip would be wasteful for data that only ever
// changes from the admin dashboard. Both still live in this one module/
// cache even though seoPages moved from the footer to the nav in v1.2.3
// (real user feedback after v1.2.2 shipped it in the wrong place) --
// they're refreshed together, by the same two write-side callers
// (routes/adminSeoPages.js, routes/adminSiteSettings.js), so splitting
// the cache itself would just be two round trips instead of one for no
// real benefit.
//
// Deliberately a separate cache/module from lib/landingContent.js's
// landing_footer_links, not folded into it -- that one feeds the OLD
// pre-v1.1.3 footer wiring (only views/partials/public-footer.ejs's own
// nav-echo row still reads it); this feeds the NEW nav Pages list +
// site-wide footer contact/social/custom-links row added in v1.2.2/v1.2.3.
// Two genuinely different lists with different owners
// (routes/adminLanding.js vs. routes/adminSeoPages.js + routes/adminSiteSettings.js).
const CACHE_TTL_MS = 60 * 1000;

let cached = null;
let cachedAt = 0;

async function fetchFromDb() {
  const pool = getPool();

  const [seoPagesResult, customLinksResult] = await Promise.all([
    pool.query(
      'SELECT slug, page_title FROM seo_pages WHERE is_active = true ORDER BY page_title ASC, id ASC'
    ),
    pool.query('SELECT id, label, url FROM custom_footer_links ORDER BY display_order ASC, id ASC')
  ]);

  return {
    seoPages: seoPagesResult.rows.map(p => ({ slug: p.slug, pageTitle: p.page_title })),
    customLinks: customLinksResult.rows.map(l => ({ id: l.id, label: l.label, url: l.url }))
  };
}

/**
 * Returns { seoPages, customLinks } -- seoPages for the homepage nav's
 * "Pages" dropdown, customLinks for the site-wide public footer. Cached
 * the same way as getSiteSettings()/getLandingContent(). Falls back to
 * an empty-lists shape (never throws) if the DB read fails and there's
 * no cache yet -- degrading to "no extra links" is fine; the public site
 * must never break outright over this.
 */
async function getFooterExtras() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    cached = await fetchFromDb();
    cachedAt = now;
  } catch (err) {
    console.error('[FOOTER EXTRAS] Failed to read footer extras, serving last-known values:', err.message);
    if (!cached) {
      cached = { seoPages: [], customLinks: [] };
    }
  }

  return cached;
}

async function refreshFooterExtrasCache() {
  try {
    cached = await fetchFromDb();
    cachedAt = Date.now();
  } catch (err) {
    console.error('[FOOTER EXTRAS] Failed to refresh cache after save:', err.message);
  }
  return cached;
}

module.exports = { getFooterExtras, refreshFooterExtrasCache };
