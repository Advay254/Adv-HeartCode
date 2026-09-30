const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { asyncHandler } = require('../lib/asyncHandler');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { generateSite, handleImageUpload } = require('../lib/buildGeneration');
const { resolveDeploySeed, forceTestSuffix, TEST_SLUG_SUFFIX } = require('../lib/deploySlug');
const { deployToClarityHeart } = require('../lib/clarityheart');
const { injectPasswordGate } = require('../lib/finalizeDeployment');
const { sendDeploymentConfirmationEmail } = require('../lib/deploymentEmail');
const { addTargetBlankToExternalLinks } = require('../lib/externalLinks');
const { logEvent } = require('../lib/activityEvents');

/**
 * v1.2.7: ADMIN TEST DEPLOY -- POST /api/admin/test-deploy/:slug
 *
 * Runs a full, REAL deployment for a website type (form validation, AI
 * fill if the type has it on, template substitution, deploy to
 * ClarityHeart, confirmation email) without going through Paystack -- so
 * testing a new or edited type never requires flipping the whole site's
 * payment mode or risking a real visitor landing on a test checkout.
 *
 * WHAT MAKES THIS SAFE TO EXIST
 * This is a free-deployment endpoint by nature, so who can reach it is the
 * whole security story:
 *   1. requireAdminSession is the FIRST thing that runs on this router --
 *      before CSRF, before multer touches the request body, before any DB
 *      lookup. No valid session cookie => 401 JSON and nothing else
 *      happens (no upload parsing, no AI call, no deploy, no email).
 *   2. requireCsrf runs next, so even a logged-in admin's browser can't be
 *      driven into a test deployment by another site.
 *   3. It is mounted under /api/admin only (server.js) and the matching
 *      page lives only behind the ADMIN_PATH_SLUG gate (routes/adminPages.js).
 *      There is no public route anywhere that reaches this code.
 *
 * WHAT A TEST DEPLOYMENT IS (AND ISN'T)
 *   - slug: the type's deploy_slug_pattern resolves exactly as it would for
 *     a real deployment, then lib/deploySlug.js's forceTestSuffix makes the
 *     requested slug end in "-test" (and fit ClarityHeart's 63-char limit
 *     WITH that suffix).
 *   - email: sent through the type's real email template (or the generic
 *     fallback) with "[TEST] " prepended to the subject.
 *   - row: a deployed_sites row with is_test = true and a $0 amount, so it
 *     can never add to revenue/analytics (every such query also filters
 *     is_test = false -- belt and braces).
 *   - NOT done, on purpose: no Paystack, no payment_received /
 *     deployment_completed activity events (a single test_deployment_completed
 *     event instead), no sale notifications (email/webhook/Gotify -- "you got
 *     a sale" for a test would be actively misleading), no subscriber_emails
 *     insert (a test address would pollute the subscriber list and the
 *     new-subscribers analytics), no funnel event.
 */

const router = express.Router();

// ORDER MATTERS. Session first, everything else after (see above).
router.use(requireAdminSession);

const slugParamSchema = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/) });

// The one non-form value a test deploy accepts: an optional site password,
// so the type's Password Page template (and the {{site_password}} email
// variable) can be exercised too. Travels inside the same JSON/multipart
// payload as the form values under a reserved key that cannot collide with
// a real field_key (field keys never start with two underscores), and is
// stripped before the payload reaches the generator.
const PASSWORD_KEY = '__sitePassword';
const MAX_PASSWORD_LENGTH = 200;

function readAndStripPassword(body, isMultipart) {
  if (isMultipart) {
    if (typeof body.payload !== 'string') return { password: '', body };
    try {
      const parsed = JSON.parse(body.payload);
      const pw = typeof parsed[PASSWORD_KEY] === 'string' ? parsed[PASSWORD_KEY] : '';
      delete parsed[PASSWORD_KEY];
      return { password: pw, body: { ...body, payload: JSON.stringify(parsed) } };
    } catch (err) {
      return { password: '', body }; // generateSite reports the malformed payload itself
    }
  }
  const pw = body && typeof body[PASSWORD_KEY] === 'string' ? body[PASSWORD_KEY] : '';
  const rest = { ...(body || {}) };
  delete rest[PASSWORD_KEY];
  return { password: pw, body: rest };
}

/**
 * Picks the slug to REQUEST from ClarityHeart. Starts from the plain
 * "<resolved>-test" form; if a deployment already owns that exact slug (the
 * usual case: an admin re-testing with the same values, which resolves the
 * same pattern to the same slug again), splices a short random token in
 * BEFORE the suffix ("<resolved>-ab12-test") so the request is unique and
 * the result still ends in "-test". Without this, a repeat test would rely
 * on ClarityHeart's own collision handling, which may rename the slug
 * without the suffix -- see the post-deploy check below.
 */
async function pickTestSlug(pool, seed) {
  let candidate = forceTestSuffix(seed);
  for (let attempt = 0; attempt < 6; attempt++) {
    const taken = await pool.query('SELECT 1 FROM deployed_sites WHERE deployed_slug = $1 LIMIT 1', [candidate]);
    if (taken.rowCount === 0) return candidate;
    candidate = forceTestSuffix(seed, { unique: crypto.randomBytes(2).toString('hex') });
  }
  return candidate;
}

router.post('/:slug', requireCsrf, handleImageUpload, asyncHandler(async (req, res) => {
  const slugParsed = slugParamSchema.safeParse(req.params);
  if (!slugParsed.success) {
    return res.status(400).json({ error: 'Invalid website type slug' });
  }

  const pool = getPool();

  // Deliberately NO is_active filter (the public flow requires it): a
  // primary reason to test-deploy is to try a new or edited type BEFORE
  // switching it on for visitors.
  const typeResult = await pool.query('SELECT * FROM website_types WHERE slug = $1 AND is_deleted_placeholder = false', [slugParsed.data.slug]);
  if (typeResult.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }
  const websiteType = typeResult.rows[0];

  const isMultipart = Boolean(req.is('multipart/form-data'));
  const { password, body } = readAndStripPassword(req.body, isMultipart);
  const sitePassword = password.trim();
  if (sitePassword.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Site password must be ${MAX_PASSWORD_LENGTH} characters or fewer.` });
  }

  // Same generation pipeline as the public build flow (lib/buildGeneration.js):
  // same validation and required-field enforcement, and, if the type has AI
  // enabled, a REAL provider call that spends real tokens -- testing the
  // configured behavior is the point.
  const generated = await generateSite(websiteType, {
    body,
    isMultipart,
    files: req.files || [],
    rejectedImageFields: req.hcRejectedImageFields || []
  });
  if (!generated.ok) {
    return res.status(generated.status).json(generated.body);
  }

  const clientEmail = String(isMultipart ? JSON.parse(body.payload).client_email : body.client_email).trim();

  // ---- slug: real pattern resolution, then the forced "-test" suffix ----
  const reference = `hctest-${crypto.randomBytes(8).toString('hex')}`;
  const seed = resolveDeploySeed(reference, websiteType.deploy_slug_pattern, generated.rawFieldValues);
  const requestedSlug = await pickTestSlug(pool, seed);

  // ---- html: same post-processing a real deployment applies ----
  let htmlToDeploy = addTargetBlankToExternalLinks(generated.html);
  if (sitePassword) {
    const hash = crypto.createHash('sha256').update(sitePassword).digest('hex');
    htmlToDeploy = await injectPasswordGate(htmlToDeploy, hash, websiteType.id, websiteType.name);
  }

  // ---- deploy: the existing function, no new deploy logic ----
  let deployResult;
  try {
    deployResult = await deployToClarityHeart(requestedSlug, htmlToDeploy);
  } catch (err) {
    console.error(`[TEST-DEPLOY] Deploy failed for "${websiteType.slug}":`, err.message);
    return res.status(502).json({ error: `Deployment failed: ${err.message}` });
  }

  // ---- record: is_test = true, $0 (charge_amount / charge_amount_usd = 0,
  // not NULL, so even a future query that forgot the is_test filter would
  // add 0 to a revenue sum rather than a phantom price) ----
  const insert = await pool.query(
    `INSERT INTO deployed_sites
       (reference, website_type_id, client_email, site_url, deployed_slug,
        charge_currency, charge_amount, charge_amount_usd, has_password, is_test)
     VALUES ($1, $2, $3, $4, $5, 'USD', 0, 0, $6, true) RETURNING *`,
    [reference, websiteType.id, clientEmail, deployResult.url, deployResult.slug, Boolean(sitePassword)]
  );
  const site = insert.rows[0];

  // ---- email: the real per-type template system, "[TEST] " subject ----
  // Unlike the real pipeline (which swallows a send failure because the
  // customer's site is already live and nobody is watching), the admin
  // running a test IS watching -- finding out the email didn't send is part
  // of what they're testing -- so the outcome is reported back.
  let emailResult;
  try {
    const { sentCustom } = await sendDeploymentConfirmationEmail({
      websiteTypeId: websiteType.id,
      websiteTypeName: websiteType.name,
      clientEmail,
      siteUrl: deployResult.url,
      deployedAt: site.deployed_at,
      sitePassword,
      rawFieldValues: generated.rawFieldValues,
      aiOutputValues: generated.aiOutputValues,
      subjectPrefix: '[TEST] '
    });
    emailResult = { status: 'sent', template: sentCustom ? 'custom' : 'generic' };
  } catch (err) {
    console.error(`[TEST-DEPLOY] Confirmation email failed for "${websiteType.slug}":`, err.message);
    emailResult = { status: 'failed', error: err.message };
  }

  // NOTE what is deliberately absent here: notifySaleCompleted() (sale
  // channels), subscriber_emails insert, funnel_events insert,
  // payment_received / deployment_completed events. See the file header.
  await logEvent(pool, {
    eventType: 'test_deployment_completed',
    title: `Test deploy: ${websiteType.name}`,
    detail: deployResult.url,
    reference: site.reference,
    metadata: {
      websiteTypeId: websiteType.id,
      websiteTypeName: websiteType.name,
      slug: deployResult.slug,
      emailStatus: emailResult.status
    }
  });

  const slugEndsInTest = deployResult.slug.endsWith(TEST_SLUG_SUFFIX);
  res.json({
    success: true,
    site: {
      reference: site.reference,
      url: deployResult.url,
      slug: deployResult.slug,
      requestedSlug,
      hasPassword: Boolean(sitePassword),
      aiUsed: Boolean(generated.aiOutputValues)
    },
    email: emailResult,
    // ClarityHeart owns final slug uniqueness and reports the slug it
    // actually used (see lib/clarityheart.js). requestedSlug always ends in
    // "-test"; if ClarityHeart ever renames it on a collision the returned
    // slug might not, and the admin is told rather than shown a silent
    // success.
    warning: slugEndsInTest
      ? null
      : `ClarityHeart changed the requested slug to "${deployResult.slug}", which does not end in "-test". The site is live under that address.`
  });
}));

module.exports = router;
