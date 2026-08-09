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
// ever touching the base CREATE TABLE statements above. New standalone
// tables (like admin_sessions below) are also fine to land here rather
// than in SCHEMA, since SCHEMA is meant to stay as the original bootstrap set.
const MIGRATIONS = `
-- v1.0.1: admin auth session storage
CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- v1.0.2: Paystack config, AI provider config, website types/fields/templates
CREATE TABLE IF NOT EXISTS paystack_config (
  id SERIAL PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
  public_key_test TEXT DEFAULT '',
  secret_key_test_encrypted TEXT DEFAULT '',
  public_key_live TEXT DEFAULT '',
  secret_key_live_encrypted TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_providers (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  is_active BOOLEAN DEFAULT false,
  selected_model TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_provider_keys (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  key_encrypted TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS website_types (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  price_kes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS template_fields (
  id SERIAL PRIMARY KEY,
  website_type_id INTEGER NOT NULL REFERENCES website_types(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  field_label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text' CHECK (field_type IN ('text', 'textarea', 'email', 'password', 'dropdown')),
  placeholder_text TEXT DEFAULT '',
  is_required BOOLEAN DEFAULT true,
  dropdown_options JSONB DEFAULT NULL,
  display_order INTEGER DEFAULT 0,
  UNIQUE(website_type_id, field_key)
);

CREATE TABLE IF NOT EXISTS templates (
  id SERIAL PRIMARY KEY,
  website_type_id INTEGER NOT NULL REFERENCES website_types(id) ON DELETE CASCADE,
  html_content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- v1.0.4: payment + deployment pipeline
CREATE TABLE IF NOT EXISTS pending_deployments (
  reference TEXT PRIMARY KEY,
  website_type_id INTEGER NOT NULL REFERENCES website_types(id),
  client_email TEXT NOT NULL,
  site_password_hash TEXT DEFAULT NULL,
  rendered_html TEXT NOT NULL,
  amount_kes INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deployed_sites (
  id SERIAL PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  website_type_id INTEGER REFERENCES website_types(id),
  client_email TEXT NOT NULL,
  site_url TEXT NOT NULL,
  cloudflare_project_name TEXT NOT NULL,
  amount_kes INTEGER NOT NULL,
  deployed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriber_emails (
  email TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  opted_out BOOLEAN DEFAULT false
);
`;

const CURRENT_VERSION = '1.0.4';

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
