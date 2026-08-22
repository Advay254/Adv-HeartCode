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

-- v1.0.8 Part A: expanded field types. The original inline CHECK constraint
-- (no explicit name given) got Postgres's auto-generated name
-- "template_fields_field_type_check" -- dropped and re-added with the
-- expanded list every boot. Cheap, and simpler than tracking whether the
-- constraint definition already matches; a fresh DB gets the same
-- constraint from SCHEMA above anyway, so this is only ever doing real
-- work on a pre-1.0.8 database.
ALTER TABLE template_fields DROP CONSTRAINT IF EXISTS template_fields_field_type_check;
ALTER TABLE template_fields ADD CONSTRAINT template_fields_field_type_check
  CHECK (field_type IN ('text', 'textarea', 'email', 'password', 'dropdown', 'number', 'date', 'checkboxes', 'radio'));

-- v1.0.8 Part B: optional per-website-type deploy slug pattern. NULL means
-- "keep today's random-slug behavior" -- see lib/deploySlug.js.
ALTER TABLE website_types ADD COLUMN IF NOT EXISTS deploy_slug_pattern TEXT DEFAULT NULL;

-- Persists the client's raw form field values from checkout through to
-- deploy time -- previously these only ever existed transiently during
-- the /api/build/:slug/generate call and were never stored anywhere, so
-- by the time finalizeDeployment.js actually runs (at payment
-- verification, potentially long after the original form submission) they
-- were already gone. A deploy_slug_pattern needs them at THAT point (to
-- substitute {{field_key}} tokens), which is what this column exists for.
-- Nullable and only meaningfully populated going forward -- historical
-- pre-1.0.8 rows never had this data to begin with, which is fine since
-- deploy_slug_pattern itself defaults to NULL (unused) unless an admin
-- opts a website type into it.
ALTER TABLE pending_deployments ADD COLUMN IF NOT EXISTS raw_field_values JSONB DEFAULT NULL;

-- v1.0.8 Part C: landing page CMS. landing_content is a single-row table
-- (enforced in application code the same way routes/adminPaystack.js
-- enforces paystack_config's single row -- SELECT ... FOR UPDATE inside a
-- transaction, not a DB-level constraint here, consistent with the
-- existing pattern). Seeded with the EXACT v1.0.7 hardcoded landing-page
-- copy so this migration changes zero visual output by itself -- the
-- point of moving this into the DB is that an admin CAN edit it from here
-- on, not that anything looks different the moment this migration runs.
--
-- One deliberate content change from the literal v1.0.7 markup: the trust
-- line was two separate badges ("Secure checkout via Paystack" / "No
-- account or registration required") -- this table has one
-- trust_line_text column, not a list, so those two are combined into one
-- line here and the section is rendered as a single line going forward.
-- Flagged clearly in the delivery notes, not silently changed.
CREATE TABLE IF NOT EXISTS landing_content (
  id SERIAL PRIMARY KEY,
  hero_headline TEXT DEFAULT 'HeartCode',
  hero_tagline TEXT DEFAULT 'Pick a type, answer a short form, and get a real website — copy written, hosted, and live before you close the tab.',
  hero_cta_text TEXT DEFAULT 'Explore website types',
  trust_line_text TEXT DEFAULT 'Secure checkout via Paystack — no account or registration required.',
  footer_text TEXT DEFAULT '© 2026 HeartCode. All rights reserved.',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO landing_content (hero_headline, hero_tagline, hero_cta_text, trust_line_text, footer_text)
SELECT
  'HeartCode',
  'Pick a type, answer a short form, and get a real website — copy written, hosted, and live before you close the tab.',
  'Explore website types',
  'Secure checkout via Paystack — no account or registration required.',
  '© 2026 HeartCode. All rights reserved.'
WHERE NOT EXISTS (SELECT 1 FROM landing_content);

CREATE TABLE IF NOT EXISTS landing_steps (
  id SERIAL PRIMARY KEY,
  icon_name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  display_order INTEGER DEFAULT 0
);

-- Seeded once, only if the table has never had a row -- an admin later
-- deleting every step intentionally (leaving the table empty) must NOT
-- cause it to silently reseed on the next boot.
INSERT INTO landing_steps (icon_name, title, description, display_order)
SELECT * FROM (VALUES
  ('layout-template', 'Pick a type', 'Choose the kind of site that fits your business — bakery, salon, studio, and more.', 1),
  ('pencil', 'Fill in details', 'A short form asks what makes your business yours. Real copy comes back, not a template.', 2),
  ('rocket', 'Get your live site', 'Pay once, and your site deploys live in minutes — no hosting to manage, ever.', 3)
) AS seed(icon_name, title, description, display_order)
WHERE NOT EXISTS (SELECT 1 FROM landing_steps);

CREATE TABLE IF NOT EXISTS landing_footer_links (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  display_order INTEGER DEFAULT 0
);

INSERT INTO landing_footer_links (label, url, display_order)
SELECT * FROM (VALUES
  ('How it works', '/#how-it-works', 1),
  ('Explore types', '/explore', 2)
) AS seed(label, url, display_order)
WHERE NOT EXISTS (SELECT 1 FROM landing_footer_links);

-- v1.0.9 Part A: per-website-type email templates. Same versioning
-- discipline as the site "templates" table above -- saving a new version
-- inserts a new row and deactivates the previous active one for that
-- type, never deletes history. A type with NO row here at all (the
-- default, for every existing type until an admin visits the new Email
-- tab) falls back to the original hardcoded generic email exactly as
-- before -- see lib/finalizeDeployment.js.
CREATE TABLE IF NOT EXISTS email_templates (
  id SERIAL PRIMARY KEY,
  website_type_id INTEGER NOT NULL REFERENCES website_types(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- v1.0.9 Part A: mirrors pending_deployments.raw_field_values (v1.0.8) --
-- the AI's parsed structured output only ever existed transiently during
-- the original /api/build/:slug/generate call, and by the time
-- finalizeDeployment.js actually runs (at payment verification,
-- potentially long after that call) it was already gone. An email
-- template wants the SAME merged variable set the site template already
-- had access to (raw fields + AI output), so this carries the AI's raw
-- JSON output through checkout the same way raw_field_values already
-- carries the raw form submission through. NULL for AI-disabled types,
-- or for any deployment finalized before this version existed.
ALTER TABLE pending_deployments ADD COLUMN IF NOT EXISTS ai_output_values JSONB DEFAULT NULL;

-- v1.1.0 Part A: pending-deployment recovery. server.js's cleanup interval
-- now keeps a pending_deployments row for a full 7 days past expires_at
-- (was: deleted almost immediately) so an admin has a real window to
-- recover a payment that succeeded but whose webhook never fired AND
-- whose client never landed back on the callback page -- see
-- routes/adminRecovery.js. No new table needed for that; expires_at
-- itself is UNCHANGED (still set at checkout time to now + 1 hour) and
-- keeps its original meaning ("is this checkout session still fresh
-- enough for the client's own browser to complete it") -- only the
-- CLEANUP interval's deletion threshold moved. See
-- lib/finalizeDeployment.js's skipExpiryCheck parameter for how the new
-- admin retry path distinguishes "expired for a normal client-facing
-- callback" from "expired but an admin is deliberately asking us to
-- re-check anyway".
--
-- v1.1.0 Part B: carries the client's anonymous funnel session_id
-- (public/funnel.js) through checkout, for exactly the same structural
-- reason raw_field_values (v1.0.8) and ai_output_values (v1.0.9) already
-- carry THEIR data through checkout -- the payment_completed funnel event
-- is fired server-side from inside lib/finalizeDeployment.js (deliberately
-- never trusted from a client-submitted event -- see routes/events.js),
-- which runs later, in a separate request, after the session_id's
-- original point of origin (the build/checkout page load) is long gone
-- unless something carries it forward. NULL-safe: if this wasn't
-- captured (old pending row, JS blocked, sendBeacon unsupported), the
-- payment_completed event for that one deployment is simply skipped
-- rather than inserting a NULL into funnel_events.session_id's NOT NULL
-- column -- an analytics gap, never a reason to fail a real deployment.
ALTER TABLE pending_deployments ADD COLUMN IF NOT EXISTS funnel_session_id TEXT DEFAULT NULL;

-- v1.1.0 Part B: lightweight, first-party, fully anonymous funnel event
-- log. session_id is a random client-generated identifier
-- (crypto.randomUUID(), see public/funnel.js) living only in
-- sessionStorage -- NOT a persistent cookie, NOT tied to an email
-- address, IP, or any other identifying information, gone the moment the
-- browser tab/session ends. Its only purpose is letting the admin Funnel
-- page count how many (anonymous) visits reached each stage of the
-- client journey within a date range -- see routes/adminFunnel.js. No
-- personal data of any kind is ever written to this table.
CREATE TABLE IF NOT EXISTS funnel_events (
  id SERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  website_type_id INTEGER REFERENCES website_types(id),
  session_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Supports both the admin Funnel page's per-stage COUNT(*) queries
-- (filtered by event_type + a created_at range, optionally further
-- filtered by website_type_id) and the periodic 90-day pruning sweep
-- (server.js) that deletes purely by created_at.
CREATE INDEX IF NOT EXISTS idx_funnel_events_type_created ON funnel_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_funnel_events_website_type ON funnel_events(website_type_id);
`;

const CURRENT_VERSION = '1.1.0';

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
