const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const crypto = require('crypto');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { getActivePaystackKeys } = require('../lib/paystack');
const { finalizeDeployment } = require('../lib/finalizeDeployment');
const sitePasswordCache = require('../lib/sitePasswordCache');
const { createRateLimiter, createDynamicRateLimiter } = require('../lib/rateLimit');
const { getCurrencyForIp } = require('../lib/geolocation');
const { getRate, convertUsdTo, getChargeCurrencyForCountry, formatMoney } = require('../lib/currency');
const { getSiteSettings } = require('../lib/siteSettings');
const { getActiveScriptsByPlacement } = require('../lib/siteScripts');
const { getLandingContent } = require('../lib/landingContent');
const { getLandingSections } = require('../lib/landingSections');
const { DEFAULT_CONTENT } = require('../lib/landingSectionTypes');
const { escapeHtml } = require('../lib/template');
const { sendResendDetailsEmail } = require('../lib/email');
const { getRealClientIp } = require('../lib/clientIp');

const router = express.Router();

// v1.0.7: every public page's <head> needs site_settings (title/meta/OG/
// favicon), and every public page's layout needs active site_scripts
// grouped by placement — rather than have every single route handler
// below remember to fetch and pass both explicitly to res.render(), this
// runs once per request, before any route, and sets them on res.locals.
// EJS's include() shares the calling template's locals by default, so
// views/partials/public-head.ejs (and the body_start/footer script
// partials) see `siteSettings`/`activeScripts` automatically in every
// view rendered through this router, with no per-route wiring to forget.
// v1.0.8: landingContent/landingFooterLinks joins this same middleware —
// views/partials/public-footer.ejs (shared by landing.ejs AND explore.ejs)
// needs the CMS-driven footer text/links on every public page, not just
// the landing page itself, for the same "don't make every route
// remember to fetch this" reason.
router.use(async (req, res, next) => {
  try {
    const [siteSettings, activeScripts, landing] = await Promise.all([
      getSiteSettings(),
      getActiveScriptsByPlacement(),
      getLandingContent()
    ]);
    res.locals.siteSettings = siteSettings;
    res.locals.activeScripts = activeScripts;
    res.locals.landingContent = landing.content;
    res.locals.landingSteps = landing.steps;
    res.locals.landingFooterLinks = landing.footerLinks;
  } catch (err) {
    // These helpers already catch their own DB errors internally and fall
    // back to safe defaults — this catch is only for something more
    // exotic going wrong. Either way, a page render should never break
    // over site settings/scripts/landing content specifically.
    console.error('[PUBLIC] Failed to load site settings/scripts/landing content for request:', err.message);
  }
  next();
});

// Scoped to the one route that needs a parsed body (below), not applied
// router-wide. This is the actual fix for a bug this version's audit
// caught: an earlier router-wide express.json() here was silently
// consuming the request body for EVERY request that reached this router
// — including, depending on mount order in server.js, requests meant for
// other routes entirely that need the RAW, unparsed body (the Paystack
// webhook's signature check). Scoping the parser to exactly the route
// that needs it means this router can never again do that to a request it
// wasn't supposed to touch, regardless of how mount order in server.js
// changes in the future.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Gap this closes: renderedHtml/sitePassword previously had no length
// bound at all beyond the router's blanket 2MB body limit, and sitePassword
// had no type check before being hashed. 1MB leaves headroom under that
// 2MB ceiling for JSON overhead around the actual string.
const checkoutBodySchema = z.object({
  renderedHtml: z.string().min(1).max(1000000),
  clientEmail: z.string().trim().email().max(254),
  sitePassword: z.string().max(200).optional(),
  // v1.0.8 Part B: the raw form field values from the build page, kept
  // around through checkout so lib/deploySlug.js's pattern resolution has
  // something to substitute {{field_key}} tokens with at actual deploy
  // time (see lib/finalizeDeployment.js) — previously these only existed
  // transiently during the /api/build/:slug/generate call and were never
  // persisted anywhere past that point. Same shape as apiBuild.js's own
  // generateBodySchema catchall: a string for every field type except
  // checkboxes, which submits an array of strings.
  rawFieldValues: z.record(
    z.string(),
    z.union([z.string().max(5000), z.array(z.string().max(500)).max(50)])
  ).optional(),
  // v1.0.9: the AI's own raw output for this submission (present only for
  // AI-enabled types — see routes/apiBuild.js), carried through checkout
  // for the same reason rawFieldValues is: lib/finalizeDeployment.js needs
  // it at deploy time to build the merged variable set a custom email
  // template can reference, and by then the original /generate response is
  // long gone. Shape mirrors ai_output_fields' three possible output
  // types: a flat string, an array of strings, or an array of objects with
  // string sub-properties (object_shape is admin-defined but always
  // string-valued — see routes/adminWebsiteTypes.js's AI output field
  // validation). Note this is, like renderedHtml and rawFieldValues above
  // it, client-supplied and not re-verified against what the AI actually
  // produced — the same trust boundary this whole endpoint has always had
  // for the rendered site content itself, not a new one introduced here.
  aiOutputValues: z.record(
    z.string(),
    z.union([
      z.string().max(5000),
      z.array(z.string().max(2000)).max(200),
      z.array(z.record(z.string(), z.string().max(2000))).max(200)
    ])
  ).optional(),
  // v1.1.0 Part B: the client's anonymous funnel session_id
  // (public/funnel.js), carried through checkout so lib/finalizeDeployment.js
  // can attach it to the server-side 'payment_completed' funnel event —
  // see db/init.js's migration comment on pending_deployments.funnel_session_id
  // for the full "why". Not personally identifying — just an opaque,
  // client-generated string living in sessionStorage.
  sessionId: z.string().trim().min(1).max(200).optional()
});

// Separate budget from the AI-generate limiter — different action,
// different cost, an abusive run on one shouldn't block legitimate use of
// the other.
const checkoutLimiter = createRateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// v1.0.6: builds a synchronous per-type price formatter for the CURRENT
// visitor, doing at most two async lookups total (one geolocation call,
// one exchange-rate/site-setting read) regardless of how many website
// types get formatted with it — avoids an N+1 pattern on the homepage's
// list of types. This is a DISPLAY-only helper; the actual charge
// currency for checkout is determined separately by
// resolveChargeForCheckout below (same underlying rules, computed fresh
// and authoritatively at the point money actually changes hands).
//
// Kenyan visitors: if the kenyan_payment_currency setting is 'KES', KES
// IS the real charge price, shown as the only line. If it's 'USD' (the
// default, until M-Pesa is set up on Paystack), USD is the real price,
// shown as the primary line, with a KES estimate underneath purely for
// reference.
//
// Everyone else: price_usd converted to the visitor's own local currency
// for display, correctly labeled with that currency's real code/symbol —
// gracefully falls back to plain USD (never a raw number mislabeled under
// the wrong currency) if no rate is cached for it yet.
async function resolveVisitorPricing(req) {
  // v1.1.9 hotfix Part 3: master on/off switch for this DISPLAY-only
  // conversion, admin-controlled via the Payments page (routes/
  // adminSettings.js's GET/PUT /currency-conversion). Off (the default)
  // short-circuits straight to plain USD for EVERY visitor, Kenyan or
  // not, with no geolocation lookup even attempted -- this is
  // deliberately absolute (it does NOT fall through to the Kenyan
  // reference-currency line below either) because the ask behind this
  // toggle is "show $ to literally everyone," not "show $ to everyone
  // except the one existing special case."
  //
  // NOTE for later: if kenyan_payment_currency (above/below) is ever
  // flipped to 'KES' while this toggle is off, the browsing-page estimate
  // will show USD while the actual checkout charge (resolveChargeForCheckout,
  // which does NOT consult this toggle) will be KES -- a real, deliberate
  // display/charge mismatch this toggle can create in that combination.
  // Not a bug: it's the direct consequence of "off means $ for everyone,
  // no exceptions." Worth revisiting only if that combination becomes
  // real (M-Pesa going live on Paystack is still an open item as of this
  // version).
  const pool = getPool();
  const conversionSetting = await pool.query(
    "SELECT value FROM site_settings WHERE key = 'currency_conversion_enabled'"
  );
  const conversionEnabled = conversionSetting.rowCount > 0 && conversionSetting.rows[0].value === 'true';

  if (!conversionEnabled) {
    return function (priceUsd) {
      return { displayPrimary: formatMoney(priceUsd, 'USD'), displaySecondary: null };
    };
  }

  // v1.1.9 hotfix Part 2: see lib/clientIp.js -- req.ip alone can resolve
  // to Cloudflare's own edge address rather than the visitor's, which is
  // exactly what caused a Kenyan visitor to be priced in EUR.
  const geo = await getCurrencyForIp(getRealClientIp(req));
  const isKenyan = geo.countryCode === 'KE';

  if (isKenyan) {
    const kenyanCurrency = await getChargeCurrencyForCountry('KE');
    const kesRate = await getRate('KES');

    if (kenyanCurrency === 'KES') {
      return function (priceUsd) {
        const primary = kesRate != null
          ? { amount: round2(priceUsd * kesRate), currency: 'KES' }
          : { amount: priceUsd, currency: 'USD' }; // graceful fallback, never mislabeled
        return { displayPrimary: formatMoney(primary.amount, primary.currency), displaySecondary: null };
      };
    }

    return function (priceUsd) {
      const secondary = kesRate != null ? formatMoney(round2(priceUsd * kesRate), 'KES') : null;
      return {
        displayPrimary: formatMoney(priceUsd, 'USD'),
        displaySecondary: secondary ? `\u2248 ${secondary} (reference only)` : null
      };
    };
  }

  const localCurrency = geo.currency;
  const rate = localCurrency === 'USD' ? 1 : await getRate(localCurrency);
  return function (priceUsd) {
    const primary = (localCurrency !== 'USD' && rate != null)
      ? { amount: round2(priceUsd * rate), currency: localCurrency }
      : { amount: priceUsd, currency: 'USD' };
    return { displayPrimary: formatMoney(primary.amount, primary.currency), displaySecondary: null };
  };
}

// v1.0.6: the AUTHORITATIVE version of the pricing decision above — used
// both to show the confirmation price on the checkout page and, in POST
// /build/:slug/checkout, to decide exactly what to snapshot and charge.
// USD for everyone except Kenyan visitors when kenyan_payment_currency is
// explicitly 'KES'. Server-side only; never trusts anything from the
// client about currency or country.
async function resolveChargeForCheckout(req, priceUsd) {
  // v1.1.9 hotfix Part 2: see lib/clientIp.js -- same fix as
  // resolveVisitorPricing above, this decides the ACTUAL charge currency
  // so it must resolve the real visitor IP too.
  const geo = await getCurrencyForIp(getRealClientIp(req));
  const currency = await getChargeCurrencyForCountry(geo.countryCode);
  return convertUsdTo(priceUsd, currency); // { amount, currency, rate }
}

// v1.1.2 Part A: dynamically generated from live DB state on every
// request — no caching, deliberately, at this scale (a handful of active
// website types, changing rarely) a fresh query per request is simpler
// and cheaper than reasoning about cache invalidation for something a
// crawler hits infrequently anyway. Only currently-ACTIVE website types
// are listed — an inactive type's /build/:slug page 404s (see that route
// below), so listing it in the sitemap would just be an invitation for a
// crawler to index a dead end.
router.get('/sitemap.xml', asyncHandler(async (req, res) => {
  const rootUrl = `${req.protocol}://${req.get('host')}`;
  const pool = getPool();
  const result = await pool.query(
    'SELECT slug, updated_at FROM website_types WHERE is_active = true ORDER BY display_order ASC, id ASC'
  );

  const urls = [
    { loc: `${rootUrl}/`, changefreq: 'weekly', priority: '1.0' },
    { loc: `${rootUrl}/explore`, changefreq: 'weekly', priority: '0.8' },
    ...result.rows.map(t => ({
      loc: `${rootUrl}/build/${t.slug}`,
      changefreq: 'weekly',
      priority: '0.7',
      lastmod: t.updated_at ? new Date(t.updated_at).toISOString().slice(0, 10) : null
    }))
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => (
    `  <url>\n    <loc>${escapeHtml(u.loc)}</loc>\n` +
    (u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : '') +
    `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
  )).join('\n')}\n</urlset>`;

  res.set('Content-Type', 'application/xml');
  res.send(xml);
}));

// Revised per Advay's explicit choice: the admin path is deliberately NOT
// listed here (see middleware/adminSlug.js for where "keep it out of
// Google" is now actually handled instead, via an X-Robots-Tag header
// sent on every admin response). robots.txt is a public, unauthenticated
// file — anyone can fetch it, not just crawlers — so listing the exact
// secret slug here would hand it to anyone who thinks to check, which is
// exactly the tradeoff this revision avoids. Plain "/admin" is still
// listed below purely as a courtesy/red-herring for the well-known
// generic path — it was never real (see middleware/adminSlug.js's own
// comment: /admin and /__internal_admin always 404), so there's nothing
// to leak by naming it.
router.get('/robots.txt', (req, res) => {
  const rootUrl = `${req.protocol}://${req.get('host')}`;

  const publicPathRules = [
    'Allow: /',
    'Disallow: /api/*',
    'Disallow: /admin',
    'Disallow: /build/*/preview',
    'Disallow: /build/*/checkout',
    'Disallow: /build/*/checkout/callback'
  ];

  const lines = [
    'User-agent: *',
    ...publicPathRules,
    '',
    // v1.1.9 Part C: explicit AI-crawler allow rules, rather than leaving
    // these to fall through to the wildcard block above. Functionally
    // that wildcard already permits them (Allow: / with the same path
    // exclusions) -- these lines exist to make the intent unambiguous to
    // anyone (or any tool) auditing this file specifically for AI-crawler
    // policy, and to insulate these agents from ever being caught by a
    // FUTURE blanket AI-blocking change to the wildcard block without
    // that change's author having to remember these exist. Being cited
    // by an AI answer engine is free visibility worth inviting, not
    // something to guard against.
    //
    // Per robots.txt's own spec, a crawler matching a SPECIFIC
    // User-agent block does not also fall back to the wildcard block --
    // so this repeats the exact same path exclusions as above, rather
    // than a bare "Allow: /" that would inadvertently reopen /admin,
    // /api/*, and the in-progress checkout/preview flow specifically for
    // these agents. Multiple consecutive User-agent lines sharing one
    // rule set is valid syntax (RFC 9309) -- grouped here by operator for
    // readability, all given the same treatment since this project isn't
    // taking a position on training vs. citation/search use, just
    // inviting AI visibility generally.
    '# OpenAI',
    'User-agent: GPTBot',
    'User-agent: OAI-SearchBot',
    'User-agent: ChatGPT-User',
    ...publicPathRules,
    '',
    '# Anthropic (Claude)',
    'User-agent: ClaudeBot',
    'User-agent: Claude-SearchBot',
    'User-agent: Claude-User',
    ...publicPathRules,
    '',
    '# Perplexity',
    'User-agent: PerplexityBot',
    'User-agent: Perplexity-User',
    ...publicPathRules,
    '',
    '# Google (AI training/answer surfaces -- Googlebot itself is already covered by the wildcard block above)',
    'User-agent: Google-Extended',
    ...publicPathRules,
    '',
    '# Apple',
    'User-agent: Applebot-Extended',
    ...publicPathRules,
    '',
    '# Amazon',
    'User-agent: Amazonbot',
    ...publicPathRules,
    '',
    '# Meta',
    'User-agent: Meta-ExternalAgent',
    ...publicPathRules,
    '',
    `Sitemap: ${rootUrl}/sitemap.xml`
  ];

  res.set('Content-Type', 'text/plain');
  res.send(lines.join('\n'));
});

// v1.1.9 Part C: llms.txt -- an emerging, not-yet-fully-standardized
// convention some AI crawlers/assistants reportedly consult for a
// plain-text, human-and-AI-readable summary of what a site is and where
// its key pages live (distinct from robots.txt, which only governs
// crawl permissions, and from the JSON-LD structured data above, which
// is machine-only). Cheap to add, no real downside, and consistent with
// this version's general "invite AI visibility" stance. Built from the
// same siteSettings already loaded onto res.locals by this router's own
// middleware above -- no new admin input required for this to work out
// of the box, same approach the homepage's Organization/WebSite JSON-LD
// already takes.
router.get('/llms.txt', (req, res) => {
  const rootUrl = `${req.protocol}://${req.get('host')}`;
  const siteTitle = res.locals.siteSettings.site_title;
  const metaDescription = res.locals.siteSettings.meta_description;

  const lines = [
    `# ${siteTitle}`,
    '',
    `> ${metaDescription}`,
    '',
    `${siteTitle} is a client-facing website builder. A visitor picks a website type, fills in a short form, gets AI-polished copy dropped into a live preview, and pays to have the finished site deployed live -- no design or coding skill needed.`,
    '',
    '## Pages',
    '',
    `- [Home](${rootUrl}/): overview, how it works, and pricing`,
    `- [How it works](${rootUrl}/#how-it-works): the three-step build -> preview -> pay flow`,
    `- [Browse website types](${rootUrl}/explore): every website type currently available to build`
  ];

  res.set('Content-Type', 'text/plain');
  res.send(lines.join('\n'));
});

router.get('/', asyncHandler(async (req, res) => {
  const pool = getPool();
  const priceFor = await resolveVisitorPricing(req);

  // Sanitized to digits only for the count-up widget (public/site-interactions.js
  // does its own parseInt/isFinite guard too, but a clean value server-side
  // means a stray non-numeric character the admin might type into the Site
  // Settings form — "4,500" or "4500 sites" — never even reaches the DOM
  // attribute in a form that could confuse it).
  const statsNumber = String(res.locals.siteSettings.manual_stats_number || '').replace(/[^0-9]/g, '') || '0';

  // v1.1.2 Part A: Organization + WebSite JSON-LD on the homepage only —
  // this is the canonical page for "what is this business/site", which is
  // exactly what these two schema.org types describe. Built entirely from
  // existing site_settings values (already loaded onto res.locals by this
  // router's own middleware above) plus the request's own root URL — no
  // new admin input required for this to work out of the box.
  //
  // v1.1.6 Part D: Organization gains logo/description/sameAs/contactPoint,
  // each ONLY included when the admin has actually set the underlying
  // site_settings value — an unset optional field is omitted from the
  // object entirely (never emitted as an empty string), so a fresh
  // install's Organization entity is unchanged from before this version
  // until an admin fills something in on the Site Settings page. logo
  // prefers the new dedicated logo_url over og_image_url (kept as a
  // fallback purely for continuity with any install that already set an
  // OG image before logo_url existed) — see db/init.js's migration
  // comment for why the two are deliberately separate fields, not one
  // reused for both purposes.
  const rootUrl = `${req.protocol}://${req.get('host')}`;
  const orgLogo = res.locals.siteSettings.logo_url || res.locals.siteSettings.og_image_url || '';
  const sameAs = [
    res.locals.siteSettings.social_twitter_url,
    res.locals.siteSettings.social_facebook_url,
    res.locals.siteSettings.social_instagram_url,
    res.locals.siteSettings.social_linkedin_url
  ].filter(Boolean);
  const structuredData = [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: res.locals.siteSettings.site_title,
      url: rootUrl,
      ...(res.locals.siteSettings.meta_description ? { description: res.locals.siteSettings.meta_description } : {}),
      ...(orgLogo ? { logo: orgLogo } : {}),
      ...(sameAs.length > 0 ? { sameAs } : {}),
      ...(res.locals.siteSettings.contact_email ? {
        contactPoint: {
          '@type': 'ContactPoint',
          email: res.locals.siteSettings.contact_email,
          contactType: 'customer support'
        }
      } : {})
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: res.locals.siteSettings.site_title,
      url: rootUrl,
      description: res.locals.siteSettings.meta_description
    }
  ];

  // v1.1.6 Part D: FAQPage JSON-LD, built from the SAME query result the
  // 'faq' landing section's partial renders from (faqEntries, passed to
  // res.render below) — one shared source, so the structured data can
  // never list a question the visible page doesn't, or vice versa.
  // Entirely absent from `structuredData` (not emitted as an empty
  // FAQPage) when there are zero active entries — Google's own guidance
  // for FAQPage markup is that it should mirror visible on-page content,
  // and there's nothing visible to mirror in that case (see
  // views/partials/landing-sections/faq.ejs's own empty-state branch).
  const faqEntriesResult = await pool.query(
    'SELECT question, answer FROM faq_entries WHERE is_active = true ORDER BY display_order ASC, id ASC'
  );
  const faqEntries = faqEntriesResult.rows;
  if (faqEntries.length > 0) {
    structuredData.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqEntries.map(entry => ({
        '@type': 'Question',
        name: entry.question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: entry.answer
        }
      }))
    });
  }

  // v1.1.5 Part B: the section formerly known as the fixed, non-CMS
  // "website type teaser" (hardcoded directly in this view since v1.1.3)
  // is now a real landing_sections row (section_type 'category_teaser')
  // — its own admin-editable eyebrow/heading copy comes through
  // middleSections below like any other section. What it still needs
  // from HERE, at render time, is the live category/type DATA to show —
  // that's never admin content, so it's computed fresh on every request,
  // the same separation of concerns the old typeTeasers local already
  // used (just narrower in scope now: up to 2 items, not 6, to match the
  // new section's compact 2-card layout — see this version's delivery
  // notes on that specific call).
  //
  // Primary: first 2 ACTIVE categories by display_order, each carrying
  // its cheapest active type's price as a single representative "From
  // $X" figure (chosen over a min–max range — simpler to read at a
  // glance in a small teaser card, and a range needs two numbers'
  // worth of visual space this card doesn't have).
  //
  // Fallback (zero active categories — a pre-v1.1.4 install, or an
  // admin who hasn't set any up yet): up to 2 active website TYPES
  // directly, same non-breaking "don't let an empty category list hide
  // real content" principle already used for /explore itself in v1.1.4.
  const categoriesResult = await pool.query(
    'SELECT * FROM website_categories WHERE is_active = true ORDER BY display_order ASC, id ASC LIMIT 2'
  );

  let categoryTeaserCategories = [];
  let categoryTeaserFallbackTypes = [];

  if (categoriesResult.rowCount > 0) {
    const categoryIds = categoriesResult.rows.map(c => c.id);
    // DISTINCT ON + ORDER BY price_usd ASC picks exactly one row per
    // category — its cheapest active type — in a single query rather
    // than one query per category.
    const cheapestTypesResult = await pool.query(
      `SELECT DISTINCT ON (category_id) *
       FROM website_types
       WHERE is_active = true AND category_id = ANY($1)
       ORDER BY category_id, price_usd ASC, id ASC`,
      [categoryIds]
    );
    const cheapestByCategory = new Map(cheapestTypesResult.rows.map(t => [t.category_id, t]));

    categoryTeaserCategories = categoriesResult.rows.map(c => {
      const cheapest = cheapestByCategory.get(c.id);
      return {
        slug: c.slug,
        name: c.name,
        description: c.description,
        iconName: c.icon_name,
        // A category with zero active types in it yet (admin created it
        // but hasn't assigned/activated anything) has no price to show —
        // the partial renders the card without a price line rather than
        // a misleading "$0" in that case.
        ...(cheapest ? priceFor(Number(cheapest.price_usd) || 0) : {})
      };
    });
  } else {
    const fallbackTypesResult = await pool.query(
      'SELECT * FROM website_types WHERE is_active = true ORDER BY display_order ASC, id ASC LIMIT 2'
    );
    categoryTeaserFallbackTypes = fallbackTypesResult.rows.map(t => {
      const priceUsd = Number(t.price_usd) || 0;
      return {
        slug: t.slug,
        name: t.name,
        description: t.description,
        iconName: t.icon_name,
        ...priceFor(priceUsd)
      };
    });
  }

  // v1.1.3: the Skilline-redesigned landing page renders from
  // landing_sections (lib/landingSections.js), not the old
  // landingContent/landingSteps setup that res.locals already carries
  // (that stays wired up only for /explore's shared footer partial — see
  // db/init.js's migration comment). The hero and footer sections are
  // pulled out and passed separately from "everything else" so the view
  // can place the always-present stats counter right after the hero
  // without depending on admin-set display_order, and so the footer
  // reliably renders last regardless of where it sits in that order. Per
  // the build brief's "never completely blank" requirement, a fresh
  // install with zero rows (or a full landing_sections read failure —
  // getLandingSections() never throws, just returns []) falls back to a
  // minimal hardcoded hero built from DEFAULT_CONTENT.hero; the stats
  // counter below is independent of landing_sections entirely, so it
  // still renders either way.
  //
  // v1.1.5: category_teaser now flows through middleSections like every
  // other section type — it's no longer pulled out and hardcoded
  // separately the way the old fixed teaser was.
  const landingSections = await getLandingSections();
  const heroSection = landingSections.find(s => s.sectionType === 'hero') || {
    id: 0, sectionType: 'hero', content: DEFAULT_CONTENT.hero, displayOrder: 1, isActive: true
  };
  const footerSection = landingSections.find(s => s.sectionType === 'footer') || null;
  const middleSections = landingSections.filter(s => s.sectionType !== 'hero' && s.sectionType !== 'footer');

  res.render('public/landing', {
    pageTitle: null,
    statsNumber,
    structuredData,
    heroSection,
    middleSections,
    footerSection,
    categoryTeaserCategories,
    categoryTeaserFallbackTypes,
    faqEntries
  });
}));

// v1.1.4 Part D: shared by GET /explore and GET /explore/:categorySlug so
// both format a website_types row into the exact same shape the card
// partial/view expects — one source of truth for that mapping rather than
// two near-identical inline .map() calls drifting apart over time.
function formatExploreType(t, priceFor) {
  const priceUsd = Number(t.price_usd) || 0;
  return {
    slug: t.slug,
    name: t.name,
    description: t.description,
    iconName: t.icon_name,
    ...priceFor(priceUsd)
  };
}

router.get('/explore', asyncHandler(async (req, res) => {
  const pool = getPool();

  // v1.1.4 Part D: categories are fetched regardless — the view itself
  // decides how to render based on whether any exist (see
  // views/public/explore.ejs). This is deliberate: an install with zero
  // categories must render EXACTLY as it did before this version (flat
  // list, no category UI at all), not a "0 categories" empty-state
  // variant of the new UI — see this version's delivery notes, item 4.
  const [typesResult, categoriesResult] = await Promise.all([
    pool.query('SELECT * FROM website_types WHERE is_active = true ORDER BY display_order ASC, id ASC'),
    pool.query('SELECT * FROM website_categories WHERE is_active = true ORDER BY display_order ASC, id ASC')
  ]);

  const priceFor = await resolveVisitorPricing(req);
  const allTypes = typesResult.rows.map(t => ({ ...formatExploreType(t, priceFor), categoryId: t.category_id }));

  // Every active type with NO category (category_id NULL, OR pointing at
  // a category that isn't active) shows in the "More Website Types"
  // fallback section — this is the specific mechanism that prevents an
  // uncategorized (or since-deactivated-category) type from silently
  // disappearing the moment this version ships. A type is only ever
  // considered "categorized" here if its category is BOTH assigned and
  // currently active — an inactive category's card doesn't render, so a
  // type left pointing at one would otherwise vanish from the page
  // entirely, which is exactly the failure mode this fallback exists to
  // prevent.
  const activeCategoryIds = new Set(categoriesResult.rows.map(c => c.id));
  const categorizedTypes = allTypes.filter(t => t.categoryId && activeCategoryIds.has(t.categoryId));
  const uncategorizedTypes = allTypes.filter(t => !t.categoryId || !activeCategoryIds.has(t.categoryId));

  const categories = categoriesResult.rows.map(c => ({
    slug: c.slug,
    name: c.name,
    description: c.description,
    iconName: c.icon_name,
    typeCount: categorizedTypes.filter(t => t.categoryId === c.id).length
  }));

  res.render('public/explore', {
    pageTitle: 'Explore website types',
    // Zero categories at all -> render exactly as before: the plain flat
    // list, no category cards, no "More Website Types" heading. Non-empty
    // -> category cards first, then the fallback section (only rendered
    // if it actually has anything in it).
    categories,
    uncategorizedTypes,
    // Kept for the zero-categories flat-list branch, which needs every
    // active type regardless of category — same query result, just not
    // filtered.
    websiteTypes: allTypes
  });
}));

router.get('/explore/:categorySlug', asyncHandler(async (req, res) => {
  const pool = getPool();
  const categoryResult = await pool.query(
    'SELECT * FROM website_categories WHERE slug = $1 AND is_active = true',
    [req.params.categorySlug]
  );

  if (categoryResult.rowCount === 0) {
    return res.status(404).render('public/not-found', {
      pageTitle: 'Not found',
      message: 'That category is not available.'
    });
  }
  const category = categoryResult.rows[0];

  const typesResult = await pool.query(
    'SELECT * FROM website_types WHERE is_active = true AND category_id = $1 ORDER BY display_order ASC, id ASC',
    [category.id]
  );

  const priceFor = await resolveVisitorPricing(req);

  res.render('public/explore-category', {
    pageTitle: category.name,
    category: { name: category.name, description: category.description, iconName: category.icon_name },
    websiteTypes: typesResult.rows.map(t => formatExploreType(t, priceFor))
  });
}));

router.get('/build/:slug', asyncHandler(async (req, res) => {
  const pool = getPool();
  const typeResult = await pool.query(
    'SELECT * FROM website_types WHERE slug = $1 AND is_active = true',
    [req.params.slug]
  );

  if (typeResult.rowCount === 0) {
    return res.status(404).render('public/not-found', {
      pageTitle: 'Not found',
      message: 'That website type is not available.'
    });
  }

  const websiteType = typeResult.rows[0];
  const fieldsResult = await pool.query(
    'SELECT * FROM template_fields WHERE website_type_id = $1 ORDER BY display_order ASC, id ASC',
    [websiteType.id]
  );

  const priceFor = await resolveVisitorPricing(req);
  const priceUsd = Number(websiteType.price_usd) || 0;

  // v1.1.2 Part A: per-type SEO overrides, falling back to nothing (which
  // views/partials/public-head.ejs itself then falls back from — pageTitle
  // to the global site_title, pageDescription to the global
  // meta_description) if the admin hasn't set one for this specific type.
  // Product JSON-LD ALWAYS uses the real, canonical USD price — unlike
  // priceFor() above (which adjusts display for the visitor's local
  // currency), search engines indexing this markup need one stable,
  // currency-explicit value, not something that varies by who/where the
  // crawler happens to be.
  const rootUrl = `${req.protocol}://${req.get('host')}`;
  const structuredData = [
    {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: websiteType.name,
      description: websiteType.seo_description || websiteType.description || '',
      url: `${rootUrl}/build/${websiteType.slug}`,
      offers: {
        '@type': 'Offer',
        price: priceUsd.toFixed(2),
        priceCurrency: 'USD',
        url: `${rootUrl}/build/${websiteType.slug}`
      }
    }
  ];

  res.render('public/build', {
    pageTitle: websiteType.seo_title || websiteType.name,
    pageDescription: websiteType.seo_description || null,
    structuredData,
    websiteType: { id: websiteType.id, slug: websiteType.slug, name: websiteType.name, ...priceFor(priceUsd) },
    fields: fieldsResult.rows.map(f => ({
      fieldKey: f.field_key,
      fieldLabel: f.field_label,
      fieldType: f.field_type,
      placeholderText: f.placeholder_text,
      isRequired: f.is_required,
      dropdownOptions: f.dropdown_options
    }))
  });
}));

router.get('/build/:slug/preview', asyncHandler(async (req, res) => {
  const pool = getPool();
  const typeResult = await pool.query(
    'SELECT * FROM website_types WHERE slug = $1 AND is_active = true',
    [req.params.slug]
  );

  if (typeResult.rowCount === 0) {
    return res.status(404).render('public/not-found', {
      pageTitle: 'Not found',
      message: 'That website type is not available.'
    });
  }

  res.render('public/preview', {
    pageTitle: `Preview — ${typeResult.rows[0].name}`,
    websiteType: { slug: typeResult.rows[0].slug, name: typeResult.rows[0].name }
  });
}));

router.get('/build/:slug/checkout', asyncHandler(async (req, res) => {
  const pool = getPool();
  const typeResult = await pool.query(
    'SELECT * FROM website_types WHERE slug = $1 AND is_active = true',
    [req.params.slug]
  );

  if (typeResult.rowCount === 0) {
    return res.status(404).render('public/not-found', {
      pageTitle: 'Not found',
      message: 'That website type is not available.'
    });
  }

  const t = typeResult.rows[0];
  const priceUsd = Number(t.price_usd) || 0;
  // Unlike the display-only estimate on the homepage/build pages, this is
  // the AUTHORITATIVE charge currency/amount (same resolution POST
  // /build/:slug/checkout will use moments later) — this page is the
  // payment confirmation, so what's shown here must be what actually gets
  // charged, not a browsing-convenience estimate in the visitor's local
  // currency.
  const charge = await resolveChargeForCheckout(req, priceUsd);

  res.render('public/checkout', {
    pageTitle: `Checkout — ${t.name}`,
    websiteType: { id: t.id, slug: t.slug, name: t.name, chargeDisplay: formatMoney(charge.amount, charge.currency) }
  });
}));

// Checkout initiation: takes the already-generated site HTML, client
// email, and an optional site password; stores a pending_deployments row;
// asks Paystack to initialize a transaction; returns the URL to redirect
// the browser to. Nothing is deployed yet — that only happens once
// payment is confirmed, via the webhook or the callback page below.
router.post('/build/:slug/checkout', express.json({ limit: '2mb' }), asyncHandler(async (req, res) => {
  // v1.1.9 hotfix Part 2: see lib/clientIp.js -- keyed off the real
  // visitor IP, not Cloudflare's edge address.
  const ip = getRealClientIp(req);
  if (!checkoutLimiter.tryConsume(ip)) {
    return res.status(429).json({ error: 'Too many checkout attempts, please try again later' });
  }

  const pool = getPool();
  const typeResult = await pool.query(
    'SELECT * FROM website_types WHERE slug = $1 AND is_active = true',
    [req.params.slug]
  );
  if (typeResult.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }
  const websiteType = typeResult.rows[0];

  const parsed = checkoutBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue ? firstIssue.path[0] : 'request';
    return res.status(400).json({ error: `Invalid ${field}` });
  }
  const { renderedHtml, clientEmail: email, sitePassword, rawFieldValues, aiOutputValues, sessionId } = parsed.data;

  if (!EMAIL_RE.test(email)) {
    // zod's .email() already validated this; the house regex is kept as
    // a belt-and-suspenders check on the exact shape the rest of the
    // system expects, same reasoning as routes/apiBuild.js.
    return res.status(400).json({ error: 'A valid clientEmail is required' });
  }

  const keys = await getActivePaystackKeys();
  if (!keys) {
    return res.status(503).json({ error: 'Payments are not configured yet' });
  }

  // Reference doubles as the seed for the ClarityHeart deploy slug later
  // (see lib/clarityheart.js) — generated safe for both uses from the
  // start rather than reformatted downstream.
  const reference = `hc-${crypto.randomBytes(8).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  let sitePasswordHash = null;
  const trimmedPassword = typeof sitePassword === 'string' ? sitePassword.trim() : '';
  if (trimmedPassword) {
    // Only the hash goes to Postgres. The plaintext goes into the
    // in-memory cache so the "site ready" email can include it later —
    // see lib/sitePasswordCache.js for why this needs to exist at all.
    sitePasswordHash = crypto.createHash('sha256').update(trimmedPassword).digest('hex');
    sitePasswordCache.store(reference, trimmedPassword);
  }

  // v1.0.6: the charge currency/amount/rate is resolved ONCE here and
  // snapshotted into pending_deployments — this exact snapshot (never a
  // live recalculation) is what finalizeDeployment.js compares Paystack's
  // verified amount against later, and what deployed_sites' charge_amount
  // ends up holding. This holds even if the cached exchange rate refreshes
  // between now and webhook/callback time, since neither of those paths
  // ever re-derives the amount — they only read what's stored here.
  const priceUsd = Number(websiteType.price_usd) || 0;
  const charge = await resolveChargeForCheckout(req, priceUsd);

  await pool.query(
    `INSERT INTO pending_deployments
       (reference, website_type_id, client_email, site_password_hash, rendered_html,
        charge_currency, charge_amount, exchange_rate_snapshot, expires_at, raw_field_values,
        ai_output_values, funnel_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [reference, websiteType.id, email, sitePasswordHash, renderedHtml,
      charge.currency, charge.amount, charge.rate, expiresAt,
      rawFieldValues ? JSON.stringify(rawFieldValues) : null,
      aiOutputValues ? JSON.stringify(aiOutputValues) : null,
      sessionId || null]
  );

  const callbackUrl = `${req.protocol}://${req.get('host')}/build/${websiteType.slug}/checkout/callback`;

  let initData;
  try {
    const initRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keys.secretKey}`
      },
      body: JSON.stringify({
        email,
        // Paystack's `amount` is always in the currency's minor unit
        // (cents) — both USD and KES use 2 decimal places, so *100 is
        // correct for either. `currency` is now sent EXPLICITLY — v1.0.5
        // and earlier never set this at all, meaning Paystack silently
        // charged in the merchant account's own DEFAULT currency
        // regardless of what number was sent as `amount`. That's a real,
        // separate bug beyond the display-only mislabeling this version
        // set out to fix: the amount sent was always the raw price_kes
        // number, but the actual currency it was charged in depended
        // entirely on how the Paystack account itself was configured. Now
        // that a real, resolved charge currency exists, it's passed
        // explicitly so the transaction is unambiguous.
        amount: Math.round(charge.amount * 100),
        currency: charge.currency,
        reference,
        callback_url: callbackUrl
      })
    });
    initData = await initRes.json();
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach Paystack' });
  }

  if (!initData || !initData.status || !initData.data || !initData.data.authorization_url) {
    console.error('[CHECKOUT] Paystack initialize failed:', JSON.stringify(initData));
    return res.status(502).json({ error: 'Paystack could not initialize this transaction' });
  }

  res.json({ authorizationUrl: initData.data.authorization_url, reference });
}));

// Paystack redirects the browser here after payment. finalizeDeployment()
// is idempotent (see lib/finalizeDeployment.js) — this may be the FIRST
// thing to finalize the deployment, or it may run after (or concurrently
// with) the webhook already having done so; either way exactly one
// deployment and one email happen, and this page just shows the result.
router.get('/build/:slug/checkout/callback', asyncHandler(async (req, res) => {
  const reference = req.query.reference;

  if (!reference || typeof reference !== 'string') {
    return res.status(400).render('public/checkout-callback', {
      outcome: 'not_found',
      siteUrl: null,
      reference: null,
      slug: req.params.slug
    });
  }

  const result = await finalizeDeployment(reference);

  let outcome = 'error';
  let siteUrl = null;

  if (result.status === 'deployed' || result.status === 'already_deployed') {
    outcome = 'success';
    siteUrl = result.site.site_url;
  } else if (result.status === 'not_paid' || result.status === 'expired' || result.status === 'not_found') {
    outcome = result.status;
  } else if (result.error) {
    console.error(`[CALLBACK] finalizeDeployment error for ${reference}:`, result.error);
  }

  res.render('public/checkout-callback', { pageTitle: 'Checkout result', outcome, siteUrl, reference, slug: req.params.slug });
}));

// v1.1.2 Part C: resend site details, client self-service, no account
// system needed. Rate limited per IP using an ADMIN-CONFIGURABLE daily cap
// (site_settings' resend_details_rate_limit_per_day, default '1') — read
// fresh from the DB on every single request via createDynamicRateLimiter
// (see lib/rateLimit.js), never cached, so a change the admin makes on the
// Site Settings page takes effect on the very next request.
const resendDetailsLimiter = createDynamicRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  getMax: async () => {
    const pool = getPool();
    const result = await pool.query(
      "SELECT value FROM site_settings WHERE key = 'resend_details_rate_limit_per_day'"
    );
    const raw = result.rowCount > 0 ? result.rows[0].value : '1';
    const parsed = parseInt(raw, 10);
    // A corrupted/non-numeric setting value fails safe to the strict
    // original default (1) rather than either rejecting every request
    // (parsed <= 0 would make tryConsume impossible to satisfy) or, worse,
    // silently becoming unlimited.
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }
});

router.get('/resend-details', (req, res) => {
  res.render('public/resend-details', { pageTitle: 'Resend site details' });
});

const resendDetailsBodySchema = z.object({
  email: z.string().trim().email().max(254)
});

// ANTI-ENUMERATION, read this before changing anything below: the
// response body and status code for a MATCH and a NO-MATCH must be
// BYTE-FOR-BYTE IDENTICAL (both 200, both this exact message). If they
// ever differ, this endpoint becomes a free tool for checking whether any
// given email address has ever purchased a site here — a match/no-match
// oracle is exactly the kind of information this form must never reveal.
// This is why: the try/catch below swallows a DB error or an email-send
// failure into the SAME generic response rather than surfacing a
// different one, and why there is deliberately no "email not found"
// branch anywhere in this handler. A future edit that makes this message
// "more helpful" by being specific about whether a match was found would
// reintroduce exactly this leak — don't.
const RESEND_DETAILS_GENERIC_MESSAGE =
  "If that email matches a site we've deployed, we've sent the details to it — check your spam folder if it doesn't arrive shortly.";

router.post('/api/resend-details', express.json({ limit: '10kb' }), asyncHandler(async (req, res) => {
  // v1.1.9 hotfix Part 2: see lib/clientIp.js -- keyed off the real
  // visitor IP, not Cloudflare's edge address.
  if (!(await resendDetailsLimiter.tryConsume(getRealClientIp(req)))) {
    return res.status(429).json({
      error: "You've reached today's check limit — try again tomorrow."
    });
  }

  const parsed = resendDetailsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    // A malformed EMAIL FORMAT (not "no matching account") is a genuinely
    // different, safe-to-reveal kind of error — it says nothing about
    // whether any real address has ever purchased anything here, so this
    // one case is allowed to respond differently from the generic message
    // above without reintroducing the enumeration risk that message
    // exists to prevent.
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  const email = parsed.data.email;

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT ds.*, wt.name AS website_type_name
       FROM deployed_sites ds
       LEFT JOIN website_types wt ON wt.id = ds.website_type_id
       WHERE ds.client_email = $1
       ORDER BY ds.deployed_at DESC`,
      [email]
    );

    if (result.rowCount > 0) {
      try {
        await sendResendDetailsEmail(email, result.rows);
      } catch (err) {
        console.error('[RESEND-DETAILS] Failed to send resend-details email:', err.message);
        // Deliberately falls through to the SAME generic response below —
        // see the anti-enumeration comment above. A delivery failure here
        // is a real, worth-fixing problem (logged), but the requester
        // must never be able to distinguish it from "no match found."
      }
    }
  } catch (err) {
    console.error('[RESEND-DETAILS] Lookup failed:', err.message);
    // Same reasoning — a DB hiccup must not produce a response
    // distinguishable from "no match," or its mere occurrence becomes a
    // signal in itself. Fails safe to the generic message either way.
  }

  res.status(200).json({ message: RESEND_DETAILS_GENERIC_MESSAGE });
}));

module.exports = router;
