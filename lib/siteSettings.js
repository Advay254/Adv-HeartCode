const { getPool } = require('../db/init');

// v1.0.7: the site_settings keys that feed the landing page and every
// public page's <head>. Sensible defaults here mirror the seed values in
// db/init.js's MIGRATIONS block -- these only ever get used if a row is
// somehow missing (shouldn't happen after the seed runs, but a page
// render should never break over a missing settings row either way).
const DEFAULTS = {
  manual_stats_number: '4500',
  manual_stats_label: 'Sites built and counting',
  favicon_url: '',
  og_image_url: '',
  meta_description: 'Pick a website type, fill in your details, and get a live site in minutes.',
  site_title: 'HeartCode'
};

const KEYS = Object.keys(DEFAULTS);
const CACHE_TTL_MS = 60 * 1000; // 60s -- these change rarely (admin-edited, infrequently), see routes/adminSiteSettings.js for the write side, which also actively invalidates this on save rather than waiting out the TTL.

let cached = null;
let cachedAt = 0;

async function fetchFromDb() {
  const pool = getPool();
  const result = await pool.query(
    'SELECT key, value FROM site_settings WHERE key = ANY($1)',
    [KEYS]
  );
  const values = { ...DEFAULTS };
  for (const row of result.rows) {
    if (row.value !== null && row.value !== undefined) {
      values[row.key] = row.value;
    }
  }
  return values;
}

/**
 * Returns the public site settings object, cached in-memory for up to
 * CACHE_TTL_MS. A page render is never made to wait on a fresh DB read for
 * values that change maybe a few times a year -- and if the read itself
 * ever fails, this falls back to the last-known-good cached copy (or the
 * hardcoded DEFAULTS, if there's no cache yet at all) rather than breaking
 * every public page render over a transient DB hiccup on a purely
 * cosmetic feature.
 */
async function getSiteSettings() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    cached = await fetchFromDb();
    cachedAt = now;
  } catch (err) {
    console.error('[SITE SETTINGS] Failed to read site_settings, serving last-known values:', err.message);
    if (!cached) cached = { ...DEFAULTS };
  }

  return cached;
}

/**
 * Forces a fresh read and updates the cache immediately -- called by the
 * admin Site Settings save route so a change is visible on the very next
 * public page load instead of waiting out the cache's TTL.
 */
async function refreshSiteSettingsCache() {
  try {
    cached = await fetchFromDb();
    cachedAt = Date.now();
  } catch (err) {
    console.error('[SITE SETTINGS] Failed to refresh cache after save:', err.message);
  }
  return cached;
}

module.exports = { getSiteSettings, refreshSiteSettingsCache, DEFAULTS };
