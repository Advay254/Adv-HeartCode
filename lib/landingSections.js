const { getPool } = require('../db/init');

const CACHE_TTL_MS = 60 * 1000; // same reasoning as lib/landingContent.js / lib/siteSettings.js

// v1.2.0: was a single shared array (`cached`/`cachedAt`) when there was
// only ever one page. Now a Map keyed by page_slug -- every SEO page gets
// its own independent cache entry with its own independent TTL, so
// refreshing one page's sections (an admin editing /thank-you-website)
// can never invalidate or interact with another page's (the homepage, or
// any other SEO page) already-cached entry.
const cache = new Map();

function formatSection(row) {
  return {
    id: row.id,
    sectionType: row.section_type,
    content: row.content,
    displayOrder: row.display_order,
    isActive: row.is_active,
    pageSlug: row.page_slug
  };
}

async function fetchActiveFromDb(pageSlug) {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM landing_sections WHERE is_active = true AND page_slug = $1 ORDER BY display_order ASC, id ASC',
    [pageSlug]
  );
  return result.rows.map(formatSection);
}

/**
 * Returns the ordered array of ACTIVE landing_sections rows for a given
 * page's public rendering, cached the same way lib/landingContent.js is.
 * `pageSlug` defaults to 'home' so every existing call site (from before
 * v1.2.0 added other pages) keeps working unchanged with zero call-site
 * edits required.
 *
 * Falls back to an empty array (never throws) if the DB read fails and
 * there's no cache yet for this specific page — routes/public.js's
 * renderLandingPage() falls back to a minimal hero-only default in that
 * case, per the v1.1.3 build brief's "never completely blank"
 * requirement, carried forward unchanged to every page this now serves.
 */
async function getLandingSections(pageSlug = 'home') {
  const now = Date.now();
  const entry = cache.get(pageSlug);
  if (entry && now - entry.cachedAt < CACHE_TTL_MS) {
    return entry.data;
  }

  try {
    const data = await fetchActiveFromDb(pageSlug);
    cache.set(pageSlug, { data, cachedAt: now });
    return data;
  } catch (err) {
    console.error(`[LANDING SECTIONS] Failed to read sections for page "${pageSlug}", serving last-known values:`, err.message);
    if (entry) return entry.data;
    cache.set(pageSlug, { data: [], cachedAt: now });
    return [];
  }
}

/**
 * Refreshes the cache after an admin write. `pageSlug` should always be
 * passed by every routes/adminLandingSections.js call site (it always
 * knows which page it just touched) -- omitting it clears every page's
 * cache entry instead, which is always safe (just means the next read of
 * any page takes one extra DB round trip within its own TTL window), used
 * as a defensive fallback rather than a normal call pattern.
 */
async function refreshLandingSectionsCache(pageSlug) {
  if (!pageSlug) {
    cache.clear();
    return;
  }
  try {
    const data = await fetchActiveFromDb(pageSlug);
    cache.set(pageSlug, { data, cachedAt: Date.now() });
    return data;
  } catch (err) {
    console.error(`[LANDING SECTIONS] Failed to refresh cache for page "${pageSlug}" after save:`, err.message);
  }
}

module.exports = { getLandingSections, refreshLandingSectionsCache, formatSection };
