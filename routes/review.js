'use strict';

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const { asyncHandler } = require('../lib/asyncHandler');
const { hmacSign, timingSafeEqual } = require('../lib/auth');
const { createRateLimiter } = require('../lib/rateLimit');
const { getRealClientIp } = require('../lib/clientIp');
const { TOKEN_RE, findValidLink, submitReviewWithLink, buildAdminReviewsUrl } = require('../lib/reviews');
const { validateReviewSubmission, NAME_MAX, TESTIMONIAL_MAX, TESTIMONIAL_MIN } = require('../lib/reviewValidation');
const { prepareReviewImage, REVIEW_IMAGE_MAX_BYTES, ALLOWED_DECLARED_TYPES } = require('../lib/reviewImage');
const { uploadImageToClarityHeart, deleteImageFromClarityHeart } = require('../lib/clarityheart');
const { notifyReviewSubmitted } = require('../lib/notifications');

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
// The image upload call is the expensive one (decode, re-encode, outbound
// request to ClarityHeart), so it gets its own tighter ceiling.
const imageUploadLimiter = createRateLimiter({ max: 5, windowMs: 10 * 60 * 1000 });

// ---- Content-Security-Policy for the review page ----
// Blocks inline scripts and any third-party script. This page is a
// standalone view that loads only /review.js and the compiled site
// stylesheet, so it does not depend on any of the scripts the rest of the
// public site injects (analytics snippets, funnel.js, site-interactions.js),
// which is exactly why the strict policy does not break anything here. The
// review page deliberately does NOT include those scripts: they would see
// the review token in the URL. blob: in img-src is for previewing the
// chosen photo locally before upload.
const cspDefaults = helmet.contentSecurityPolicy.getDefaultDirectives();
const reviewCsp = helmet.contentSecurityPolicy({
  directives: {
    ...cspDefaults,
    'script-src': ["'self'"],
    'script-src-attr': ["'none'"],
    'connect-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'blob:'],
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
      testimonialMin: TESTIMONIAL_MIN,
      imageMaxBytes: REVIEW_IMAGE_MAX_BYTES
    }
  });
}));

// ---- multer: one image at most, size-capped before processing ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: REVIEW_IMAGE_MAX_BYTES,
    files: 1,
    fields: 6,
    fieldSize: 8 * 1024,
    parts: 8
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname !== 'image' || !ALLOWED_DECLARED_TYPES.includes(file.mimetype)) {
      const err = new Error('bad_image_type');
      err.code = 'BAD_IMAGE_TYPE';
      return cb(err);
    }
    cb(null, true);
  }
});

function runUpload(req, res) {
  return new Promise((resolve) => {
    upload.single('image')(req, res, (err) => resolve(err || null));
  });
}

function multerErrorToMessage(err) {
  if (!err) return null;
  if (err.code === 'LIMIT_FILE_SIZE') return 'The photo is too large. Please choose one under 5 MB.';
  if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') return 'Only one photo can be added.';
  if (err.code === 'BAD_IMAGE_TYPE') return 'The photo must be a JPEG, PNG or WebP image.';
  return 'Your submission could not be read. Please try again.';
}

async function removeUploadedImageQuietly(url) {
  try {
    await deleteImageFromClarityHeart(url);
  } catch (err) {
    console.error('[REVIEWS] Could not remove an orphaned uploaded image:', err.message);
  }
}

// ---- POST /api/review/:token ----
router.post('/api/review/:token', asyncHandler(async (req, res) => {
  const ip = getRealClientIp(req);
  if (!submitLimiter.tryConsume(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.', code: 'rate_limited' });
  }

  const token = req.params.token;
  if (!TOKEN_RE.test(token)) return sendInvalidJson(res);

  // CSRF before anything expensive (and before multer reads an upload).
  if (!csrfIsValid(req, token)) {
    return res.status(403).json({ error: 'This page has expired. Please reload it and try again.', code: 'bad_csrf' });
  }

  const uploadError = await runUpload(req, res);
  if (uploadError) {
    return res.status(422).json({
      error: multerErrorToMessage(uploadError),
      errors: { image: multerErrorToMessage(uploadError) },
      code: 'invalid_input'
    });
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

  // Optional photo. The URL is ALWAYS the one ClarityHeart returns to this
  // server; nothing named imageUrl (or similar) is read from the browser.
  let imageUrl = null;
  if (req.file) {
    if (!imageUploadLimiter.tryConsume(ip)) {
      return res.status(429).json({ error: 'Too many photo uploads. Please wait a few minutes and try again.', code: 'rate_limited' });
    }

    const prepared = await prepareReviewImage(req.file.buffer, req.file.mimetype);
    if (!prepared.ok) {
      return res.status(422).json({
        error: prepared.error,
        errors: { image: prepared.error },
        code: 'invalid_input'
      });
    }

    try {
      const uploaded = await uploadImageToClarityHeart(prepared.buffer, prepared.contentType);
      imageUrl = uploaded.url;
    } catch (err) {
      console.error('[REVIEWS] Review photo upload to ClarityHeart failed:', err.message);
      // Tell the reviewer plainly, keep everything they typed (the browser
      // still has the form), and let them submit again without the photo.
      return res.status(502).json({
        error: 'Your photo could not be uploaded. You can send your review without it, or try the photo again.',
        code: 'image_upload_failed'
      });
    }
  }

  // Link row is deleted in the same transaction that saves the review.
  const result = await submitReviewWithLink({
    token,
    name: checked.values.name,
    rating: checked.values.rating,
    testimonial: checked.values.testimonial,
    imageUrl
  });

  if (!result.ok) {
    // Lost a race with another submission on the same link (or it expired in
    // the last moment). Do not leave the freshly uploaded photo behind.
    if (imageUrl) await removeUploadedImageQuietly(imageUrl);
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

  res.status(201).json({ ok: true });
}));

module.exports = router;
