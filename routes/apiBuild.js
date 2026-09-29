const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { getPool } = require('../db/init');
const { createRateLimiter } = require('../lib/rateLimit');
const { getRealClientIp } = require('../lib/clientIp');
const { generateSite, handleImageUpload } = require('../lib/buildGeneration');

const router = express.Router();

// v1.2.7: everything that used to live in this file below the rate limiter
// (form validation, image processing, AI content-fill, template
// substitution -- plus the multer upload middleware) moved, unchanged, into
// lib/buildGeneration.js so the admin test-deploy flow
// (routes/adminTestDeploy.js) runs the exact same pipeline. What stays here
// is what is specific to the PUBLIC route: only active types are buildable,
// per-visitor-IP rate limiting, and shaping the JSON response.

// v1.0.6: two separate limiters, chosen per-request based on whether the
// REQUESTED website type actually costs AI tokens (websiteType.ai_enabled)
// — not one blanket limiter for every hit on this route. A type with AI
// off just substitutes raw form values into the template; it costs
// nothing but a DB read, so it gets the more generous limiter. A type with
// AI on reaches a real provider and costs real money per request, so it
// keeps the original, tighter budget.
const aiGenerateLimiter = createRateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
const basicGenerateLimiter = createRateLimiter({ max: 20, windowMs: 60 * 60 * 1000 });

router.post('/:slug/generate', handleImageUpload, express.json(), asyncHandler(async (req, res) => {
  // v1.1.9 hotfix Part 2: see lib/clientIp.js -- keyed off the real
  // visitor IP, not Cloudflare's edge address.
  const ip = getRealClientIp(req);
  const pool = getPool();

  const typeResult = await pool.query(
    'SELECT * FROM website_types WHERE slug = $1 AND is_active = true',
    [req.params.slug]
  );
  if (typeResult.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }
  const websiteType = typeResult.rows[0];

  // v1.0.6: which limiter applies depends on this type's ai_enabled flag,
  // so the DB lookup above has to happen before rate limiting can be
  // applied — a deliberate, small tradeoff (a flood of requests against a
  // bogus/nonexistent slug now costs one query before being limited)
  // accepted so an AI-enabled type's tighter, cost-protecting budget can't
  // be evaded by requests that never even needed it. The global rate
  // limiter in server.js still bounds raw request volume regardless.
  const limiter = websiteType.ai_enabled ? aiGenerateLimiter : basicGenerateLimiter;
  const limiterMessage = websiteType.ai_enabled
    ? 'Too many generation requests, please try again later'
    : 'Too many requests, please try again later';
  if (!limiter.tryConsume(ip)) {
    return res.status(429).json({ error: limiterMessage });
  }

  const result = await generateSite(websiteType, {
    body: req.body,
    isMultipart: Boolean(req.is('multipart/form-data')),
    files: req.files || [],
    rejectedImageFields: req.hcRejectedImageFields || []
  });

  if (!result.ok) {
    return res.status(result.status).json(result.body);
  }

  // v1.0.9: aiOutputValues (the AI's raw parsed JSON, unescaped) is handed
  // back alongside the rendered html ONLY when AI actually ran -- the
  // client carries it through checkout so the email template can use it
  // (see public/site.js and lib/emailTemplates.js). A non-AI build returns
  // just { html }, exactly as before.
  if (result.aiOutputValues) {
    return res.json({ html: result.html, aiOutputValues: result.aiOutputValues });
  }
  res.json({ html: result.html });
}));

module.exports = router;
