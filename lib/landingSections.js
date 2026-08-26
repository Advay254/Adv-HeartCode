const { getPool } = require('../db/init');

const CACHE_TTL_MS = 60 * 1000; // same reasoning as lib/landingContent.js / lib/siteSettings.js

let cached = null;
let cachedAt = 0;

function formatSection(row) {
  return {
    id: row.id,
    sectionType: row.section_type,
    content: row.content,
    displayOrder: row.display_order,
    isActive: row.is_active
  };
}

async function fetchActiveFromDb() {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM landing_sections WHERE is_active = true ORDER BY display_order ASC, id ASC'
  );
  return result.rows.map(formatSection);
}

/**
 * Returns the ordered array of ACTIVE landing_sections rows for the
 * public landing page, cached the same way lib/landingContent.js is.
 * Falls back to an empty array (never throws) if the DB read fails and
 * there's no cache yet — routes/public.js's GET / route falls back to a
 * minimal hero-only default in that case, per the build brief's "never
 * completely blank" requirement — see views/public/landing.ejs.
 */
async function getLandingSections() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    cached = await fetchActiveFromDb();
    cachedAt = now;
  } catch (err) {
    console.error('[LANDING SECTIONS] Failed to read landing sections, serving last-known values:', err.message);
    if (!cached) cached = [];
  }

  return cached;
}

async function refreshLandingSectionsCache() {
  try {
    cached = await fetchActiveFromDb();
    cachedAt = Date.now();
  } catch (err) {
    console.error('[LANDING SECTIONS] Failed to refresh cache after save:', err.message);
  }
  return cached;
}

module.exports = { getLandingSections, refreshLandingSectionsCache, formatSection };
