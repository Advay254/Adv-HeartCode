const express = require('express');
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
const { escapeHtml } = require('../lib/template');
const { sendResendDetailsEmail } = require('../lib/email');

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
  const geo = await getCurrencyForIp(req.ip);
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
  const geo = await getCurrencyForIp(req.ip);
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
router.get('/sitemap.xml', async (req, res) => {
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
});

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

  const lines = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/*',
    'Disallow: /admin',
    'Disallow: /build/*/preview',
    'Disallow: /build/*/checkout',
    'Disallow: /build/*/checkout/callback',
    '',
    `Sitemap: ${rootUrl}/sitemap.xml`
  ];

  res.set('Content-Type', 'text/plain');
  res.send(lines.join('\n'));
});

router.get('/', async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM website_types WHERE is_active = true ORDER BY display_order ASC, id ASC LIMIT 6'
  );

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
  const rootUrl = `${req.protocol}://${req.get('host')}`;
  const structuredData = [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: res.locals.siteSettings.site_title,
      url: rootUrl,
      ...(res.locals.siteSettings.og_image_url ? { logo: res.locals.siteSettings.og_image_url } : {})
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: res.locals.siteSettings.site_title,
      url: rootUrl,
      description: res.locals.siteSettings.meta_description
    }
  ];

  res.render('public/landing', {
    pageTitle: null,
    statsNumber,
    structuredData,
    typeTeasers: result.rows.map(t => {
      const priceUsd = Number(t.price_usd) || 0;
      return {
        slug: t.slug,
        name: t.name,
        description: t.description,
        iconName: t.icon_name,
        ...priceFor(priceUsd)
      };
    })
  });
});

router.get('/explore', async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM website_types WHERE is_active = true ORDER BY display_order ASC, id ASC'
  );

  const priceFor = await resolveVisitorPricing(req);

  res.render('public/explore', {
    pageTitle: 'Explore website types',
    websiteTypes: result.rows.map(t => {
      const priceUsd = Number(t.price_usd) || 0;
      return {
        slug: t.slug,
        name: t.name,
        description: t.description,
        iconName: t.icon_name,
        ...priceFor(priceUsd)
      };
    })
  });
});

router.get('/build/:slug', async (req, res) => {
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
});

router.get('/build/:slug/preview', async (req, res) => {
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
});

router.get('/build/:slug/checkout', async (req, res) => {
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
});

// Checkout initiation: takes the already-generated site HTML, client
// email, and an optional site password; stores a pending_deployments row;
// asks Paystack to initialize a transaction; returns the URL to redirect
// the browser to. Nothing is deployed yet — that only happens once
// payment is confirmed, via the webhook or the callback page below.
router.post('/build/:slug/checkout', express.json({ limit: '2mb' }), async (req, res) => {
  const ip = req.ip;
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

  // Reference doubles as the seed for the Cloudflare Pages project name
  // later (see lib/cloudflarePages.js) — generated safe for both uses
  // from the start rather than reformatted downstream.
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
});

// Paystack redirects the browser here after payment. finalizeDeployment()
// is idempotent (see lib/finalizeDeployment.js) — this may be the FIRST
// thing to finalize the deployment, or it may run after (or concurrently
// with) the webhook already having done so; either way exactly one
// deployment and one email happen, and this page just shows the result.
router.get('/build/:slug/checkout/callback', async (req, res) => {
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
});

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

router.post('/api/resend-details', express.json({ limit: '10kb' }), async (req, res) => {
  if (!(await resendDetailsLimiter.tryConsume(req.ip))) {
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
});

module.exports = router;
