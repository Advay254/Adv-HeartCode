const { Pool } = require('pg');

let pool = null;

/**
 * Lazily creates and returns a single shared pg.Pool instance.
 * ssl.rejectUnauthorized is disabled to support Supabase/Aiven pooled connections.
 */
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

// Bootstrap tables only. Anything beyond these two belongs in a later version.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schema_version (
  id SERIAL PRIMARY KEY,
  version TEXT NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
`;

// Kept as a separate block from SCHEMA on purpose: future versions append
// `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` statements here without
// ever touching the base CREATE TABLE statements above.
const MIGRATIONS = `
-- No migrations yet. Placeholder for v1.0.1+.
-- Example (future): ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS category TEXT;
`;

const CURRENT_VERSION = '1.0.0';

/**
 * Runs schema + migrations, then records the current schema_version once.
 * Safe to call on every server boot. Throws (after logging) on any failure
 * so the caller can fail fast instead of serving traffic against a broken DB.
 */
async function initDB() {
  console.log('[DB] Connecting...');
  const db = getPool();

  try {
    await db.query('SELECT 1');
    console.log('[DB] Connected.');

    console.log('[DB] Running schema...');
    await db.query(SCHEMA);
    console.log('[DB] Schema ready.');

    console.log('[DB] Running migrations...');
    await db.query(MIGRATIONS);
    console.log('[DB] Migrations ready.');

    const existing = await db.query(
      'SELECT id FROM schema_version WHERE version = $1',
      [CURRENT_VERSION]
    );

    if (existing.rowCount === 0) {
      await db.query(
        'INSERT INTO schema_version (version) VALUES ($1)',
        [CURRENT_VERSION]
      );
      console.log(`[DB] Recorded schema_version ${CURRENT_VERSION}.`);
    } else {
      console.log(`[DB] schema_version ${CURRENT_VERSION} already recorded, skipping insert.`);
    }

    console.log('[DB] Init complete.');
  } catch (err) {
    console.error('[DB] Error during initDB:', err.message);
    throw err;
  }
}

module.exports = { getPool, initDB };
