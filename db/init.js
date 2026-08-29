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

-- v1.1.1 Part C: multi-provider email configuration, moving email sending
-- off the single hardcoded RESEND_API_KEY env var and into the admin
-- dashboard — same "admin adds one or more, picks one active, tests
-- before relying on it" shape as ai_providers above, not a new pattern.
--
-- config is JSONB because the two provider_types genuinely need
-- different shapes (a bare API key + from address vs. a full SMTP host/
-- port/credentials/security tuple) — see lib/emailProvider.js for exactly
-- which sub-fields each type expects. Only the SENSITIVE sub-field(s)
-- within config are encrypted (api_key_encrypted / password_encrypted, via
-- the existing lib/crypto.js) — non-sensitive fields (host, port, from
-- address) are left as plain JSON so they stay readable/editable in the
-- admin UI without a decrypt round-trip, exactly like paystack_config's
-- public keys sitting alongside its encrypted secret keys.
--
-- is_active enforcement follows ai_providers' existing pattern: SELECT ...
-- FOR UPDATE inside a transaction in routes/adminEmailProviders.js, not a
-- DB-level constraint here.
--
-- Graceful migration (see lib/emailProvider.js's seedEmailProviderFromEnvIfNeeded,
-- called once at server boot in server.js): if this table has zero rows
-- AND process.env.RESEND_API_KEY is set, one 'resend' row is auto-seeded
-- from that env var, marked active, labeled "Resend (migrated from
-- environment)" — so upgrading to this version doesn't silently stop email
-- from sending for anyone who already had RESEND_API_KEY configured. That
-- seed check runs on EVERY boot (not just once-ever) since it's driven by
-- "does this table currently have zero rows", the same idempotency style
-- as every other seed in this file (e.g. the landing_content/landing_steps
-- seeds above) — see server.js and this version's delivery notes for the
-- one real consequence worth knowing: if every provider row is later
-- deleted while RESEND_API_KEY is still set in Render's environment, it
-- WILL be re-seeded on the next restart. That's a deliberate safety net,
-- not a bug — remove the env var once you're fully relying on DB-configured
-- providers if you don't want this fallback anymore.
CREATE TABLE IF NOT EXISTS email_providers (
  id SERIAL PRIMARY KEY,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('resend', 'smtp')),
  label TEXT NOT NULL,
  config JSONB NOT NULL,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- v1.1.2 Part A: per-website-type SEO overrides. Both NULL by default and
-- left NULL for every existing row -- routes/public.js's GET /build/:slug
-- falls back to site_settings' global site_title/meta_description when
-- either is unset, so this is purely additive: an admin doesn't have to
-- fill these in for a single existing type for anything to keep working
-- exactly as it already does today.
ALTER TABLE website_types ADD COLUMN IF NOT EXISTS seo_title TEXT DEFAULT NULL;
ALTER TABLE website_types ADD COLUMN IF NOT EXISTS seo_description TEXT DEFAULT NULL;

-- v1.1.2 Part C: a real, pre-existing gap found while building the resend-
-- details feature, not something this feature introduces -- flagged here
-- rather than silently worked around. deployed_sites has NEVER recorded
-- whether a site was password-protected: the only copy of that fact was
-- pending_deployments.site_password_hash, and that row is deleted the
-- moment a deployment finalizes (see lib/finalizeDeployment.js's final
-- DELETE, right before COMMIT). The password gate itself never needed a
-- database copy to keep working post-deployment -- the hash is baked
-- directly into the deployed static HTML and checked client-side (see
-- injectPasswordGate in lib/finalizeDeployment.js) -- so this was never a
-- problem until now, when a genuinely new use case (telling a client via
-- the resend-details email whether their site has a password) needs to
-- know that fact long after the original checkout. Populated going
-- forward at deploy time (lib/finalizeDeployment.js's INSERT); defaults to
-- false for every row that already exists. HONEST LIMITATION, stated
-- plainly rather than glossed over: there is no way to retroactively know
-- whether a site deployed BEFORE this column existed had a password set —
-- the original hash is long gone for those rows. Any resend-details email
-- covering a pre-v1.1.2 password-protected site will incorrectly omit the
-- "password can't be recovered" notice, not because the code is wrong, but
-- because the underlying fact was never persisted anywhere retrievable.
ALTER TABLE deployed_sites ADD COLUMN IF NOT EXISTS has_password BOOLEAN NOT NULL DEFAULT false;

-- v1.1.2 Part B: real-time admin sale notifications, across up to three
-- simultaneous channel types. Same "config JSONB, encrypt only the
-- sensitive sub-field(s)" shape as email_providers above:
--   - email:   { address }                              -- nothing sensitive to encrypt
--   - webhook: { url_encrypted }                         -- the URL itself may embed a secret token in its query string
--   - gotify:  { server_url, token_encrypted }           -- server_url is not sensitive on its own, the token is
-- is_active here means "included when a sale notification fires" (an
-- enable/disable toggle per channel, per the admin UI spec) -- NOT a
-- single-active-row invariant like ai_providers/email_providers. Multiple
-- channels, of mixed types, can be active simultaneously by design: the
-- whole point of this feature is fanning one event out to up to three
-- channels at once, not picking exactly one.
-- Per-type row caps (3 email / 1 webhook / 1 gotify) are enforced in
-- routes/adminNotifications.js at insert time via the same row-locked
-- count-then-insert pattern as v1.0.7's script manager (site_scripts,
-- MAX_PER_PLACEMENT = 3) -- not a DB-level constraint here, consistent
-- with how every other per-type cap in this app is enforced.
CREATE TABLE IF NOT EXISTS notification_channels (
  id SERIAL PRIMARY KEY,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('email', 'webhook', 'gotify')),
  label TEXT NOT NULL,
  config JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- v1.1.2 Part C: admin-configurable daily cap on GET/POST /resend-details
-- lookups per IP -- deliberately a real site_settings row (read fresh at
-- request time by lib/rateLimit.js's new createDynamicRateLimiter) rather
-- than a hardcoded constant, since this is the first rate limit in the
-- app an admin can actually tune without a code change. Default of 1 is
-- deliberately strict: this endpoint's whole purpose is looking up
-- deployment history by email address, so a low default cap matters more
-- for anti-enumeration/anti-abuse here than it would for, say, a checkout
-- attempt limiter.
INSERT INTO site_settings (key, value) VALUES ('resend_details_rate_limit_per_day', '1')
ON CONFLICT (key) DO NOTHING;

-- v1.1.3: flexible section-based landing page CMS (Skilline template
-- redesign). This is the new source of truth for the LANDING PAGE ITSELF
-- (routes/public.js's GET / now renders an ordered loop of these rows —
-- see lib/landingSections.js). One row per visual section; 'content''s
-- shape depends on 'section_type' — see lib/landingSectionTypes.js for
-- the full per-type zod schema, which is the single source of truth both
-- the admin API (routes/adminLandingSections.js) and this migration's
-- seed below are kept consistent with by hand.
--
-- Deliberately NOT dropping or ceasing to populate landing_content /
-- landing_steps / landing_footer_links (all three stay exactly as they
-- were before this version, still read by lib/landingContent.js): this
-- version's scope is the landing page ONLY — /explore is untouched, and
-- views/partials/public-footer.ejs (shared by /explore) still reads its
-- footer text/links from those old tables. Migrating landing_sections
-- OFF of them and then leaving them stale would be invisible today but
-- wrong the moment /explore's own redesign eventually lands and someone
-- assumes those tables are dead. They're not — only the LANDING page
-- stopped reading them. See this version's delivery notes and
-- views/partials/nav.ejs's comment for the admin-UI side of this same
-- decision (the old "Landing Page" admin screen is kept, relabeled,
-- rather than removed, specifically so /explore's footer stays editable).
CREATE TABLE IF NOT EXISTS landing_sections (
  id SERIAL PRIMARY KEY,
  section_type TEXT NOT NULL CHECK (section_type IN
    ('hero', 'feature_cards', 'split_image_text', 'cta_image_cards', 'bullet_list', 'testimonials', 'footer')),
  content JSONB NOT NULL,
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One-time seed, guarded on the WHOLE landing_sections TABLE being empty
-- (matches this file's existing convention for every other first-boot
-- seed above — e.g. landing_steps — so an admin deliberately deleting
-- every section later does NOT cause a silent reseed on the next
-- restart). All three branches share that single guard by being ONE
-- statement (UNION ALL, not three separate INSERTs) — evaluating the
-- guard three times separately would have a real bug: the first branch's
-- INSERT would make the table non-empty before the second branch's own
-- WHERE NOT EXISTS check ran, silently skipping it.
--
-- Migrates the CURRENT LIVE landing_content / landing_steps /
-- landing_footer_links data (never Skilline's own placeholder marketing
-- copy) so an existing install's actual hero text/steps/footer links
-- keep showing on the redesigned page rather than reverting to empty —
-- see this version's delivery notes, item 2.
--
-- landing_steps -> a 'feature_cards' section, not 'bullet_list': each
-- existing step already has an icon + title + description, which is
-- exactly feature_cards' per-card shape (bullet_list's items are a
-- shorter icon+text pair with no separate title), so this is the closer
-- structural match, not an arbitrary pick between the two options the
-- build prompt allowed.
--
-- icon_color cycles through three of the new blue/yellow-derived accent
-- tokens (see tailwind.config.js) so the migrated cards don't all render
-- with the same flat color. icon_name is included alongside icon_color —
-- a deliberate, additive extension beyond the shape as literally
-- specified (which only listed icon_color): with no icon name field at
-- all, there would be no way to pick WHICH curated icon a card shows,
-- which contradicts the instruction to reuse the curated Lucide set per
-- card. Flagged clearly in the delivery notes, not silently changed.
--
-- v1.1.3 correction: the hero branch below no longer writes a
-- 'hero_image_url' key at all (an earlier pass through this migration
-- did, pointing at a path that was never actually populated with a real
-- file). The hero image is now hardcoded directly into
-- views/partials/landing-sections/hero.ejs — see lib/landingSectionTypes.js's
-- comment on heroSchema for why the content JSON has no image field at
-- all for this type.
--
-- Six NEW 'split_image_text' rows, one 'cta_image_cards' row, one
-- 'bullet_list' row, and one empty 'testimonials' row are seeded below
-- alongside the three migrated sections — these have no prior HeartCode
-- content to migrate FROM (landing_content/landing_steps/landing_footer_links
-- never had anything shaped like them), so they're seeded with fresh copy
-- written for HeartCode's actual product (building/deploying a website),
-- NOT Skilline's own virtual-classroom marketing copy — only the
-- template's IMAGES are reused as-is, per the build brief's explicit
-- "only colors and text content are meant to be swapped" instruction.
-- Each 'image_asset_key' value below matches a key in
-- lib/landingImageAssets.js's LANDING_IMAGE_ASSETS map.
INSERT INTO landing_sections (section_type, content, display_order)
SELECT 'hero', jsonb_build_object(
    'headline', COALESCE((SELECT hero_headline FROM landing_content ORDER BY id ASC LIMIT 1), 'HeartCode'),
    'highlighted_word', '',
    'tagline', COALESCE((SELECT hero_tagline FROM landing_content ORDER BY id ASC LIMIT 1), ''),
    'primary_cta_text', COALESCE((SELECT hero_cta_text FROM landing_content ORDER BY id ASC LIMIT 1), 'Explore website types'),
    'primary_cta_url', '/explore',
    'secondary_cta_text', '',
    'secondary_cta_url', ''
  ), 1
WHERE NOT EXISTS (SELECT 1 FROM landing_sections)
UNION ALL
SELECT 'feature_cards', jsonb_build_object(
    'heading', 'Three steps. One live site.',
    'highlighted_word', 'live site',
    'cards', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'icon_name', sub.icon_name,
          'icon_color', (ARRAY['sk-blue', 'sk-yellow-deep', 'sk-blue-soft'])[((sub.rn - 1) % 3) + 1],
          'title', sub.title,
          'description', sub.description
        ) ORDER BY sub.rn)
      FROM (
        SELECT icon_name, title, description,
               row_number() OVER (ORDER BY display_order ASC, id ASC) AS rn
        FROM landing_steps
      ) sub
    ), '[]'::jsonb)
  ), 2
WHERE NOT EXISTS (SELECT 1 FROM landing_sections)
UNION ALL
SELECT 'split_image_text', jsonb_build_object(
    'heading', 'Everything you need to launch, in one guided flow',
    'highlighted_word', 'one guided flow',
    'body_text', 'Pick a website type, answer a short form, and let AI turn your answers into real copy - no design software, no code editor, and no blank page to stare at.',
    'image_side', 'right',
    'cta_text', 'See how it works',
    'cta_url', '/explore',
    'decorative_accent_color', 'sk-blue',
    'image_asset_key', 'teacher-explaining'
  ), 3
WHERE NOT EXISTS (SELECT 1 FROM landing_sections)
UNION ALL
SELECT 'split_image_text', jsonb_build_object(
    'heading', 'Built for people who have never built a website before',
    'highlighted_word', 'never built a website',
    'body_text', 'Every field is explained in plain language, every step shows what happens next, and there is always a live preview before you pay for anything.',
    'image_side', 'right',
    'cta_text', '',
    'cta_url', '',
    'decorative_accent_color', 'sk-yellow',
    'image_asset_key', 'girl-with-books'
  ), 4
WHERE NOT EXISTS (SELECT 1 FROM landing_sections)
UNION ALL
SELECT 'split_image_text', jsonb_build_object(
    'heading', 'Know exactly what you are getting before you pay',
    'highlighted_word', 'before you pay',
    'body_text', 'Your AI-generated copy renders in a real preview first. Nothing goes live, and nothing gets charged, until you are happy with what you see.',
    'image_side', 'left',
    'cta_text', '',
    'cta_url', '',
    'decorative_accent_color', 'sk-blue-soft',
    'image_asset_key', 'true-false'
  ), 5
WHERE NOT EXISTS (SELECT 1 FROM landing_sections)
UNION ALL
SELECT 'split_image_text', jsonb_build_object(
    'heading', 'Manage your live site without a developer',
    'highlighted_word', 'without a developer',
    'body_text', 'Update copy, swap images, and adjust settings for your published site whenever you need to - no ticket, no waiting on someone else.',
    'image_side', 'right',
    'cta_text', '',
    'cta_url', '',
    'decorative_accent_color', 'sk-yellow-deep',
    'image_asset_key', 'gradebook'
  ), 6
WHERE NOT EXISTS (SELECT 1 FROM landing_sections)
UNION ALL
SELECT 'split_image_text', jsonb_build_object(
    'heading', 'Real support when something does not look right',
    'highlighted_word', 'Real support',
    'body_text', 'If a deployment stalls or an email does not arrive, you can reach out and get a real answer, not a bot loop.',
    'image_side', 'left',
    'cta_text', '',
    'cta_url', '',
    'decorative_accent_color', 'sk-blue-pale',
    'image_asset_key', 'discussion'
  ), 7
WHERE NOT EXISTS (SELECT 1 FROM landing_sections)
UNION ALL
SELECT 'split_image_text', jsonb_build_object(
    'heading', 'Payments, hosting, and email, already connected',
    'highlighted_word', 'already connected',
    'body_text', 'Every site launches on fast, reliable infrastructure with secure checkout and an automatic confirmation email - nothing extra to wire up yourself.',
    'image_side', 'left',
    'cta_text', '',
    'cta_url', '',
    'decorative_accent_color', 'sk-yellow-soft',
    'image_asset_key', 'integrations'
  ), 8
WHERE NOT EXISTS (SELECT 1 FROM landing_sections)
UNION ALL
SELECT 'cta_image_cards', jsonb_build_object(
    'heading', 'Two ways to get started',
    'cards', jsonb_build_array(
      jsonb_build_object(
        'image_asset_key', 'for-instructors',
        'overlay_label', 'BUSINESSES AND CREATORS',
        'button_text', 'Explore website types',
        'button_url', '/explore'
      ),
      jsonb_build_object(
        'image_asset_key', 'for-students',
        'overlay_label', 'ALREADY PAID',
        'button_text', 'Find your site details',
        'button_url', '/resend-details'
      )
    )
  ), 9
WHERE NOT EXISTS (SELECT 1 FROM landing_sections)
UNION ALL
SELECT 'bullet_list', jsonb_build_object(
    'heading', 'A build flow designed for people with no time to waste',
    'highlighted_word', 'no time to waste',
    'body_text', 'Every screen is built mobile-first and gets straight to the point.',
    'items', jsonb_build_array(
      jsonb_build_object('icon_color', 'sk-blue', 'text', 'Fill out one short form - most types take under five minutes.'),
      jsonb_build_object('icon_color', 'sk-yellow-deep', 'text', 'See your AI-written copy in a live preview before paying anything.'),
      jsonb_build_object('icon_color', 'sk-blue-soft', 'text', 'Get a working, deployed site and a confirmation email within minutes of checkout.')
    ),
    'image_asset_key', 'vcall'
  ), 10
WHERE NOT EXISTS (SELECT 1 FROM landing_sections)
UNION ALL
SELECT 'testimonials', jsonb_build_object(
    'heading', 'What people say',
    'eyebrow_text', 'TESTIMONIALS',
    'items', '[]'::jsonb
  ), 11
WHERE NOT EXISTS (SELECT 1 FROM landing_sections)
UNION ALL
SELECT 'footer', jsonb_build_object(
    'tagline', COALESCE((SELECT footer_text FROM landing_content ORDER BY id ASC LIMIT 1), ''),
    'link_columns', jsonb_build_array(jsonb_build_object(
      'heading', 'Links',
      'links', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('label', lfl.label, 'url', lfl.url) ORDER BY lfl.display_order ASC, lfl.id ASC)
        FROM landing_footer_links lfl
      ), '[]'::jsonb)
    ))
  ), 99
WHERE NOT EXISTS (SELECT 1 FROM landing_sections);

-- v1.1.4 Part C: per-website-type password page CMS. Same versioning
-- discipline as templates/email_templates above -- saving a new version
-- inserts a new row and deactivates the previous active one, rollback is
-- a pointer-flip, nothing is ever deleted. A type with no row here at all
-- (the default, for every existing type until an admin visits the new
-- Password Page tab) falls back to the original hardcoded generic gate
-- design baked into lib/finalizeDeployment.js -- same non-breaking
-- fallback pattern already used for Email templates in v1.0.9. See
-- lib/passwordPageTemplates.js for the small, dedicated (NOT the full
-- raw/AI field) placeholder set this table's html_content supports.
CREATE TABLE IF NOT EXISTS password_page_templates (
  id SERIAL PRIMARY KEY,
  website_type_id INTEGER NOT NULL REFERENCES website_types(id) ON DELETE CASCADE,
  html_content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- v1.1.4 Part D: an organizational layer above website types (e.g.
-- "Birthday", "Valentine's") so /explore can group types into cards
-- instead of showing one long flat list -- see routes/adminCategories.js
-- and routes/public.js's GET /explore.
--
-- website_types.category_id is nullable, and ON DELETE SET NULL rather
-- than CASCADE: deleting a category must never delete or orphan the
-- types inside it, only uncategorize them -- same "never silently
-- destroy content the admin didn't explicitly ask to delete" posture as
-- every other FK relationship in this schema. Every existing
-- website_types row is simply uncategorized (category_id NULL) the
-- moment this migration runs on an existing install -- see this
-- version's delivery notes and GET /explore's fallback section for why
-- that does NOT mean an existing type silently disappears from the
-- public site.
CREATE TABLE IF NOT EXISTS website_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  icon_name TEXT NOT NULL DEFAULT 'sparkles',
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE website_types ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES website_categories(id) ON DELETE SET NULL;

-- v1.1.5 Part B: widened to allow the new 'category_teaser' section type
-- (replaces the old fixed, non-CMS website-type-teaser section — see
-- lib/landingSectionTypes.js's comment on categoryTeaserSchema). Same
-- drop-and-recreate-every-boot pattern already established for
-- template_fields.field_type in v1.0.8 — cheap, and simpler than
-- tracking whether the constraint definition already matches; a fresh DB
-- gets the same constraint from SCHEMA above anyway, so this is only
-- ever doing real work on a pre-1.1.5 database.
ALTER TABLE landing_sections DROP CONSTRAINT IF EXISTS landing_sections_section_type_check;
ALTER TABLE landing_sections ADD CONSTRAINT landing_sections_section_type_check
  CHECK (section_type IN ('hero', 'feature_cards', 'split_image_text', 'cta_image_cards', 'bullet_list', 'testimonials', 'footer', 'category_teaser'));

-- v1.1.5 Part B: seeds the new category_teaser row with corrected copy
-- (no "business" wording — see this version's delivery notes) into an
-- ALREADY-populated landing_sections table, unlike the v1.1.3 seed block
-- above (which only ever fires once, on a truly empty table). Guarded on
-- the section_type itself existing yet, not on the table being empty, so
-- this correctly fires exactly once whether hit on a fresh install
-- (moments after the v1.1.3 seed just populated the table earlier in
-- this same migration run) or on an existing install upgrading from
-- v1.1.4.
--
-- The UPDATE shifts every existing row at display_order 2 or higher
-- (EXCLUDING the footer's fixed 99, which always renders in its own
-- guaranteed slot regardless of display_order — see
-- views/public/landing.ejs) up by one BEFORE the INSERT claims order 2 —
-- so on an upgrading install this section lands in the exact same visual
-- position the old fixed teaser occupied (directly after hero, before
-- feature_cards), not appended to the end where an admin would have to
-- notice and manually reorder it. Both statements share the identical
-- guard condition so they either both fire (first time) or both no-op
-- (every time after).
UPDATE landing_sections SET display_order = display_order + 1
WHERE display_order >= 2 AND display_order < 99
  AND NOT EXISTS (SELECT 1 FROM landing_sections WHERE section_type = 'category_teaser');

INSERT INTO landing_sections (section_type, content, display_order)
SELECT 'category_teaser', jsonb_build_object(
    'eyebrow_text', 'Website categories',
    'heading', 'Built for whoever you are building this for',
    'highlighted_word', 'whoever you are building this for'
  ), 2
WHERE NOT EXISTS (SELECT 1 FROM landing_sections WHERE section_type = 'category_teaser');
`;

const CURRENT_VERSION = '1.1.5';

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
