'use strict';

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const { asyncHandler } = require('../lib/asyncHandler');
const { hmacSign, timingSafeEqual } = require('../lib/auth');
const { createRateLimiter } = require('../lib/rateLimit');
const { getRealClientIp } = require('../lib/clientIp');
const { TOKEN_RE, findValidLink, submitReviewWithLink, buildAdminReviewsUrl } = require('../lib/reviews');
const { validateReviewSubmission, NAME_MAX, TESTIMONIAL_MAX, TESTIMONIAL_MIN } = require('../lib/reviewValidation');
const { notifyReviewSubmitted } = require('../lib/notifications');
const analytics = require('../lib/analytics');

// v1.2.11: the public review form (GET /review/:token) and its submit
// endpoint (POST /api/review/:token).
//
// The server re-verifies the token on EVERY request, on both the page load
// and the submit. Nothing the browser sends (a hidden field, the page it
// loaded, a cookie) is ever treated as proof a link is valid: the only proof
// is a live database row that has not expired.
//
// Used, expired and never-existed links all produce the exact same generic
// 404 page / JSON, so the response never reveals which of the three it was.

const router = express.Router();

const CSRF_COOKIE = 'hc_review_csrf';
const CSRF_COOKIE_PATH = '/api/review';

// ---- rate limits, all keyed by the real client IP ----
const pageLimiter = createRateLimiter({ max: 30, windowMs: 60 * 1000 });
const submitLimiter = createRateLimiter({ max: 10, windowMs: 10 * 60 * 1000 });

// ---- Content-Security-Policy for the review page ----
// Blocks inline scripts and any third-party script. This page is a
// standalone view that loads only /review.js and the compiled site
// stylesheet, so it does not depend on any of the scripts the rest of the
// public site injects (analytics snippets, funnel.js, site-interactions.js),
// which is exactly why the strict policy does not break anything here. The
// review page deliberately does NOT include those scripts: they would see
// the review token in the URL.
const cspDefaults = helmet.contentSecurityPolicy.getDefaultDirectives();
const reviewCsp = helmet.contentSecurityPolicy({
  directives: {
    ...cspDefaults,
    'script-src': ["'self'"],
    'script-src-attr': ["'none'"],
    'connect-src': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"]
  }
});

function privatePageHeaders(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
}

router.use(['/review', '/api/review'], reviewCsp, privatePageHeaders);

// ---- CSRF ----
// Double-submit with a server secret: the page sets a random nonce in an
// HttpOnly, SameSite=Strict cookie scoped to the submit path, and embeds
// HMAC(secret, nonce + token) in the form. The submit must send that value
// back in X-CSRF-Token AND still carry the cookie. A forged cross-site
// request has neither the cookie (SameSite) nor a way to compute the value.
// Bound to the review token, so a value from one link is useless on another.
function csrfValueFor(nonce, token) {
  return hmacSign(`review-csrf:${nonce}:${token}`, process.env.SESSION_SECRET);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return part.slice(idx + 1).trim();
    }
  }
  return '';
}

function csrfIsValid(req, token) {
  const nonce = readCookie(req, CSRF_COOKIE);
  const submitted = req.get('X-CSRF-Token') || '';
  if (!/^[a-f0-9]{32}$/.test(nonce) || !submitted) return false;
  return timingSafeEqual(csrfValueFor(nonce, token), submitted);
}

// ---- generic invalid-link responses (identical for used/expired/unknown) ----
function sendInvalidPage(res) {
  return res.status(404).render('public/review-invalid');
}
function sendInvalidJson(res) {
  return res.status(404).json({ error: 'This review link is no longer valid.', code: 'invalid_link' });
}

// ---- GET /review/:token ----
router.get('/review/:token', asyncHandler(async (req, res) => {
  if (!pageLimiter.tryConsume(getRealClientIp(req))) {
    return res.status(429).type('text/plain').send('Too many requests. Please try again in a minute.');
  }

  const token = req.params.token;
  if (!TOKEN_RE.test(token)) return sendInvalidPage(res);

  const link = await findValidLink(token);
  if (!link) return sendInvalidPage(res);

  const nonce = crypto.randomBytes(16).toString('hex');
  res.cookie(CSRF_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    path: CSRF_COOKIE_PATH,
    maxAge: 2 * 60 * 60 * 1000
  });

  res.render('public/review', {
    token,
    csrfValue: csrfValueFor(nonce, token),
    limits: {
      nameMax: NAME_MAX,
      testimonialMax: TESTIMONIAL_MAX,
      testimonialMin: TESTIMONIAL_MIN
    }
  });
}));

// The form posts a tiny JSON body. The parser is scoped to this one route
// and capped, per the project rule that body parsers are never router-wide.
const parseJson = express.json({ limit: '8kb', inflate: false });

// ---- POST /api/review/:token ----
router.post('/api/review/:token', parseJson, asyncHandler(async (req, res) => {
  const ip = getRealClientIp(req);
  if (!submitLimiter.tryConsume(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.', code: 'rate_limited' });
  }

  const token = req.params.token;
  if (!TOKEN_RE.test(token)) return sendInvalidJson(res);

  // CSRF before anything else is looked at.
  if (!csrfIsValid(req, token)) {
    return res.status(403).json({ error: 'This page has expired. Please reload it and try again.', code: 'bad_csrf' });
  }

  // Verified again here, server side, on the submit itself.
  const link = await findValidLink(token);
  if (!link) return sendInvalidJson(res);

  const body = req.body || {};
  const checked = validateReviewSubmission({
    name: body.name,
    testimonial: body.testimonial,
    rating: body.rating
  });
  if (!checked.ok) {
    return res.status(422).json({
      error: 'Please fix the highlighted fields.',
      errors: checked.errors,
      code: 'invalid_input'
    });
  }

  // Link row is deleted in the same transaction that saves the review.
  const result = await submitReviewWithLink({
    token,
    name: checked.values.name,
    rating: checked.values.rating,
    testimonial: checked.values.testimonial
  });

  if (!result.ok) {
    // Lost a race with another submission on the same link (or it expired in
    // the last moment).
    return sendInvalidJson(res);
  }

  // Admin notification (webhook and Gotify only). Not awaited and fully
  // caught: a failure here can never affect the review that is already saved.
  try {
    notifyReviewSubmitted({
      reviewerName: result.review.reviewer_name,
      rating: result.review.rating,
      adminUrl: buildAdminReviewsUrl()
    }).catch((err) => {
      console.error('[REVIEWS] Review notification failed (the review itself was saved):', err.message);
    });
  } catch (err) {
    console.error('[REVIEWS] Review notification failed to start (the review itself was saved):', err.message);
  }

  // v1.2.16: this page never loads the tracker (its address carries a private
  // token), so the submission is counted from here. No data, no token, and the
  // address sent is the fixed /review, never the real one.
  analytics.fireFromRequest(req, { name: 'review_submitted', url: '/review' });

  res.status(201).json({ ok: true });
}));

module.exports = router;
