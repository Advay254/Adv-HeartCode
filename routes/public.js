const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { getActivePaystackKeys } = require('../lib/paystack');
const { finalizeDeployment } = require('../lib/finalizeDeployment');
const sitePasswordCache = require('../lib/sitePasswordCache');
const { createRateLimiter } = require('../lib/rateLimit');

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

router.get('/', async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM website_types WHERE is_active = true ORDER BY display_order ASC, id ASC'
  );

  res.render('public/home', {
    websiteTypes: result.rows.map(t => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      priceKes: t.price_kes
    }))
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

  res.render('public/build', {
    websiteType: { slug: websiteType.slug, name: websiteType.name, priceKes: websiteType.price_kes },
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
  res.render('public/checkout', {
    websiteType: { slug: t.slug, name: t.name, priceKes: t.price_kes }
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

  await pool.query(
    `INSERT INTO pending_deployments (reference, website_type_id, client_email, site_password_hash, rendered_html, amount_kes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [reference, websiteType.id, email, sitePasswordHash, renderedHtml, websiteType.price_kes, expiresAt]
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
        amount: websiteType.price_kes * 100,
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
