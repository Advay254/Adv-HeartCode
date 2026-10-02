'use strict';

const express = require('express');
const helmet = require('helmet');
const { asyncHandler } = require('../lib/asyncHandler');
const { listApprovedPage } = require('../lib/publicReviews');
const { getActiveBroadcast } = require('../lib/broadcast');

// v1.2.12: the public /testimonials page. Mounted inside routes/public.js
// (before its catch-all /:seoSlug route) so the router-wide middleware there
// has already put siteSettings on res.locals.
//
// The page is controlled by ONE switch (site setting testimonials_page_enabled,
// default off). Off means a clean 404 here, no sitemap entry, and no links to
// it anywhere. The switch touches nothing else: review collection, approval,
// reminders, auto-publish, build-page reviews and landing-block reviews never
// read it.

const router = express.Router();

const PAGE_SIZE = 12;

// Strict Content-Security-Policy for this page: no inline scripts and no
// third-party scripts. The site's own scripts (/site.js, /site-interactions.js,
// /funnel.js, /testimonials.js) are same-origin and keep working. What this
// DOES block is the admin-pasted script slots (head/body/footer), for example
// an analytics snippet: those are deliberately not rendered on this page, so
// such a snippet does not run here. Review photos come from ClarityHeart over
// https, hence https: in img-src.
const cspDefaults = helmet.contentSecurityPolicy.getDefaultDirectives();
const testimonialsCsp = helmet.contentSecurityPolicy({
  directives: {
    ...cspDefaults,
    'script-src': ["'self'"],
    'script-src-attr': ["'none'"],
    'connect-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'https:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"]
  }
});

function isPageOn(res) {
  return Boolean(res.locals.siteSettings) && res.locals.siteSettings.testimonials_page_enabled === 'true';
}

router.get('/testimonials', testimonialsCsp, asyncHandler(async (req, res) => {
  if (!isPageOn(res)) {
    return res.status(404).render('public/not-found', {
      pageTitle: 'Not found',
      message: 'That page is not available.'
    });
  }

  const requested = parseInt(req.query.page, 10);
  const [list, broadcast] = await Promise.all([
    listApprovedPage(Number.isInteger(requested) && requested > 0 ? requested : 1, PAGE_SIZE),
    getActiveBroadcast()
  ]);

  res.render('public/testimonials', {
    reviews: list.reviews,
    page: list.page,
    totalPages: list.totalPages,
    broadcast
  });
}));

module.exports = router;
