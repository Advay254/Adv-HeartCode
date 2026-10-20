'use strict';

const express = require('express');
const helmet = require('helmet');
const { asyncHandler } = require('../lib/asyncHandler');
const { listApprovedPage } = require('../lib/publicReviews');
const { getActiveBroadcast } = require('../lib/broadcast');
const { cspOrigins } = require('../lib/analytics');

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
// such a snippet does not run here. Images are limited to this site's own
// files and data: URIs, plus the origin of the favicon set in Site Settings
// (the one remote image this page can reference).
const cspDefaults = helmet.contentSecurityPolicy.getDefaultDirectives();
// Directive value helper: helmet calls this per request. Returns the https
// origin of the configured favicon, or a harmless self-only value.
function faviconOrigin(req, res) {
  try {
    const raw = res.locals.siteSettings && res.locals.siteSettings.favicon_url;
    const url = new URL(String(raw || ''));
    if (url.protocol === 'https:') return url.origin;
  } catch (err) { /* no usable favicon address */ }
  return "'self'";
}

// v1.2.16: when analytics is on, this page's strict policy also allows the
// tracker (and the recorder, if on) addresses saved in Site Settings, and
// nothing else. Off, or serving through this site, every slot below is just
// 'self' again. Helmet calls each function per request and needs one source
// per function, hence the numbered slots.
function analyticsSource(kind, index) {
  return (req, res) => {
    try {
      const list = cspOrigins(res.locals.siteSettings, req)[kind];
      return list[index] || "'self'";
    } catch (err) {
      return "'self'";
    }
  };
}

const testimonialsCsp = helmet.contentSecurityPolicy({
  directives: {
    ...cspDefaults,
    'script-src': ["'self'", analyticsSource('script', 0), analyticsSource('script', 1)],
    'script-src-attr': ["'none'"],
    'connect-src': ["'self'", analyticsSource('connect', 0), analyticsSource('connect', 1), analyticsSource('connect', 2)],
    'img-src': ["'self'", 'data:', faviconOrigin],
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
