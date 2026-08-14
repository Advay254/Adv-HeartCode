const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { getActivePaystackKeys } = require('../lib/paystack');
const { finalizeDeployment } = require('../lib/finalizeDeployment');
const sitePasswordCache = require('../lib/sitePasswordCache');
const { createRateLimiter } = require('../lib/rateLimit');
const { getCurrencyForIp } = require('../lib/geolocation');
const { getRate, convertUsdTo, getChargeCurrencyForCountry, formatMoney } = require('../lib/currency');

const router = express.Router();
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
  sitePassword: z.string().max(200).optional()
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

router.get('/', async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM website_types WHERE is_active = true ORDER BY display_order ASC, id ASC'
  );

  const priceFor = await resolveVisitorPricing(req);

  res.render('public/home', {
    websiteTypes: result.rows.map(t => {
      const priceUsd = Number(t.price_usd) || 0;
      return {
        slug: t.slug,
        name: t.name,
        description: t.description,
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

  res.render('public/build', {
    websiteType: { slug: websiteType.slug, name: websiteType.name, ...priceFor(priceUsd) },
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
      message: 'That website type is not available.'
    });
  }

  res.render('public/preview', {
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
    websiteType: { slug: t.slug, name: t.name, chargeDisplay: formatMoney(charge.amount, charge.currency) }
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
  const { renderedHtml, clientEmail: email, sitePassword } = parsed.data;

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
        charge_currency, charge_amount, exchange_rate_snapshot, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [reference, websiteType.id, email, sitePasswordHash, renderedHtml,
      charge.currency, charge.amount, charge.rate, expiresAt]
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

  res.render('public/checkout-callback', { outcome, siteUrl, reference, slug: req.params.slug });
});

module.exports = router;
