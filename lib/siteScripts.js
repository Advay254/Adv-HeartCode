const { getPool } = require('../db/init');

const CACHE_TTL_MS = 60 * 1000; // same reasoning as lib/siteSettings.js
const PLACEMENTS = ['head', 'body_start', 'footer'];

let cached = null;
let cachedAt = 0;

async function fetchFromDb() {
  const pool = getPool();
  const result = await pool.query(
    'SELECT placement, script_content FROM site_scripts WHERE is_active = true ORDER BY placement, id ASC'
  );

  const grouped = { head: [], body_start: [], footer: [] };
  for (const row of result.rows) {
    if (grouped[row.placement]) {
      grouped[row.placement].push(row.script_content);
    }
  }
  return grouped;
}

/**
 * Returns { head: [...], body_start: [...], footer: [...] } -- each an
 * array of raw script_content strings for active scripts in that
 * placement, ready to render verbatim into the matching spot in the
 * public page layout (see views/partials/public-head.ejs and the layout
 * wrapper). Cached the same way and for the same reason as
 * lib/siteSettings.js. IMPORTANT: this function, and the cache it
 * populates, is only ever read from routes/public.js's public-facing
 * middleware -- routes/adminPages.js's admin page routes never call this,
 * so site_scripts content never reaches an admin-authenticated render (see
 * that router and views/partials/nav.ejs / head.ejs, which have no
 * injection point for this at all).
 */
async function getActiveScriptsByPlacement() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    cached = await fetchFromDb();
    cachedAt = now;
  } catch (err) {
    console.error('[SITE SCRIPTS] Failed to read site_scripts, serving last-known values:', err.message);
    if (!cached) cached = { head: [], body_start: [], footer: [] };
  }

  return cached;
}

async function refreshSiteScriptsCache() {
  try {
    cached = await fetchFromDb();
    cachedAt = Date.now();
  } catch (err) {
    console.error('[SITE SCRIPTS] Failed to refresh cache after save:', err.message);
  }
  return cached;
}

module.exports = { getActiveScriptsByPlacement, refreshSiteScriptsCache, PLACEMENTS };
