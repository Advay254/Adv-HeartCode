/**
 * v1.2.1 Part A: read-side helper for the three site-wide legal pages
 * (Privacy Policy, Terms and Conditions, Cookie Policy). The write side
 * (save a new version, roll back) lives in routes/adminLegal.js -- this
 * module only covers what routes/public.js needs: the currently active
 * row for a given page_key, or null if none exists yet (should not
 * happen in practice since db/init.js seeds all three on first boot, but
 * a caller should not assume that and should degrade to a 404 rather
 * than throw if it is ever missing).
 */

const { getPool } = require('../db/init');

async function getActiveLegalPage(pageKey) {
  const pool = getPool();
  const result = await pool.query(
    'SELECT html_content, version, created_at FROM legal_pages WHERE page_key = $1 AND is_active = true LIMIT 1',
    [pageKey]
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

module.exports = { getActiveLegalPage };
