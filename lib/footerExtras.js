const { getPool } = require('../db/init');

// v1.2.2 Parts D+F: cached the same way and for the same reason as
// lib/siteSettings.js / lib/landingContent.js -- this is read on EVERY
// public page request (the footer renders everywhere now, including
// every SEO page), so a per-request DB round trip would be wasteful for
// data that only ever changes from the admin dashboard.
//
// Deliberately a separate cache/module from lib/landingContent.js's
// landing_footer_links, not folded into it -- that one feeds the OLD
// pre-v1.1.3 footer wiring (only views/partials/public-footer.ejs's own
// nav-echo row still reads it); this feeds the NEW site-wide footer
// (views/partials/public-footer-extras.ejs) added this version. Two
// genuinely different lists with different owners (routes/adminLanding.js
// vs. routes/adminSeoPages.js + routes/adminSiteSettings.js).
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
 * Returns { seoPages, customLinks } for the site-wide public footer,
 * cached the same way as getSiteSettings()/getLandingContent(). Falls
 * back to an empty-lists shape (never throws) if the DB read fails and
 * there's no cache yet -- the footer degrading to "no extra links" is
 * fine; the public site must never break outright over this.
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
