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

-- v1.0.6: real currency conversion (website_types.price_kes was never
-- really KES to begin with -- it was a raw number with a hardcoded "KES"
-- label and no actual conversion anywhere. price_usd is the new source of
-- truth; price_kes is left in place, populated once below, but nothing in
-- the application reads it after this version.
ALTER TABLE website_types ADD COLUMN IF NOT EXISTS price_usd NUMERIC(10,2);

-- One-time backfill, NO conversion math: the old numeric value becomes the
-- new price_usd as-is, since it was already effectively the intended price
-- (just mislabeled). Only touches rows that haven't been backfilled yet
-- (price_usd IS NULL) so this stays safe to run on every boot -- it will
-- never re-clobber a price an admin has since edited via the new UI.
UPDATE website_types SET price_usd = price_kes WHERE price_usd IS NULL;

CREATE TABLE IF NOT EXISTS exchange_rates (
  base_currency TEXT NOT NULL DEFAULT 'USD',
  target_currency TEXT NOT NULL,
  rate NUMERIC(18,6) NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (base_currency, target_currency)
);

-- Toggle Advay flips once M-Pesa is actually enabled on his Paystack
-- account. Until then, Kenyan visitors are charged in USD by card, same as
-- everyone else. ON CONFLICT DO NOTHING so this seed never clobbers a
-- value an admin has already set via the dashboard.
INSERT INTO site_settings (key, value) VALUES ('kenyan_payment_currency', 'USD')
  ON CONFLICT (key) DO NOTHING;

-- pending_deployments/deployed_sites.amount_kes was the same
-- raw-number-mislabeled-as-KES value as website_types.price_kes, snapshotted
-- at checkout time. The new charge_currency/charge_amount(_usd) columns
-- below are the real, currency-aware replacement for it going forward.
-- amount_kes is left in place (NOT NULL relaxed so new rows can omit it)
-- purely so historical rows from before this version keep their original
-- value -- nothing in the application writes to it anymore after this
-- version. Safe to run every boot: dropping NOT NULL from an
-- already-nullable column is a no-op.
ALTER TABLE pending_deployments ADD COLUMN IF NOT EXISTS charge_currency TEXT;
ALTER TABLE pending_deployments ADD COLUMN IF NOT EXISTS charge_amount NUMERIC(12,2);
ALTER TABLE pending_deployments ADD COLUMN IF NOT EXISTS exchange_rate_snapshot NUMERIC(18,6);
ALTER TABLE pending_deployments ALTER COLUMN amount_kes DROP NOT NULL;

ALTER TABLE deployed_sites ADD COLUMN IF NOT EXISTS charge_currency TEXT;
ALTER TABLE deployed_sites ADD COLUMN IF NOT EXISTS charge_amount NUMERIC(12,2);
ALTER TABLE deployed_sites ADD COLUMN IF NOT EXISTS charge_amount_usd NUMERIC(10,2);
ALTER TABLE deployed_sites ALTER COLUMN amount_kes DROP NOT NULL;

-- v1.0.6: per-website-type AI configuration. AI is OFF by default for
-- every type (ai_enabled defaults false) -- the admin opts each type in
-- explicitly and configures it like a node: a system prompt, a
-- user-prompt template built from the type's own raw fields, and a set of
-- output fields (ai_output_fields below) describing exactly what
-- structured JSON to request back.
ALTER TABLE website_types ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN DEFAULT false;
ALTER TABLE website_types ADD COLUMN IF NOT EXISTS ai_system_prompt TEXT DEFAULT '';
ALTER TABLE website_types ADD COLUMN IF NOT EXISTS ai_user_prompt_template TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS ai_output_fields (
  id SERIAL PRIMARY KEY,
  website_type_id INTEGER NOT NULL REFERENCES website_types(id) ON DELETE CASCADE,
  output_key TEXT NOT NULL,
  output_type TEXT NOT NULL DEFAULT 'string' CHECK (output_type IN ('string', 'array_of_strings', 'array_of_objects')),
  description TEXT DEFAULT '',
  object_shape JSONB DEFAULT NULL,
  display_order INTEGER DEFAULT 0,
  UNIQUE(website_type_id, output_key)
);

-- v1.0.7: design system + landing page + type gallery + script manager.
-- site_settings reuses the existing generic key-value table -- no schema
-- change needed there, just seeding sensible defaults below so the
-- landing page and every page's <head> have something real to render
-- before the admin ever visits the new Site Settings page. ON CONFLICT DO
-- NOTHING throughout so this never clobbers a value an admin has already
-- customized, on this or any future boot.
INSERT INTO site_settings (key, value) VALUES
  ('manual_stats_number', '4500'),
  ('manual_stats_label', 'Sites built and counting'),
  ('favicon_url', ''),
  ('og_image_url', ''),
  ('meta_description', 'Pick a website type, fill in your details, and get a live site in minutes.'),
  ('site_title', 'HeartCode')
ON CONFLICT (key) DO NOTHING;

-- Curated icon name (matches a filename in public/icons/, see
-- routes/adminWebsiteTypes.js's ICON_NAMES allow-list) shown on the type
-- gallery and landing page's type teaser cards. Defaults every existing
-- row to a real, sensible icon rather than leaving it null and having to
-- special-case "no icon" rendering on every card.
ALTER TABLE website_types ADD COLUMN IF NOT EXISTS icon_name TEXT NOT NULL DEFAULT 'sparkles';

CREATE TABLE IF NOT EXISTS site_scripts (
  id SERIAL PRIMARY KEY,
  placement TEXT NOT NULL CHECK (placement IN ('head', 'body_start', 'footer')),
  name TEXT NOT NULL,
  script_content TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

const CURRENT_VERSION = '1.0.7';

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
