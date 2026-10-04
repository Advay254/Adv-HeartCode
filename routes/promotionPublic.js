'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { createRateLimiter } = require('../lib/rateLimit');
const { getRealClientIp } = require('../lib/clientIp');
const promotions = require('../lib/promotions');
const { renderFramePage, pickItem } = require('../lib/promoRender');

// v1.2.13: the public side of promotions. Five routes, all stateless and
// cookie-free:
//
//   GET  /embed.js                       the embeddable script (static file)
//   GET  /api/embed/config/:token        the small config response it fetches
//   POST /api/embed/impression/:token    one tiny count per page view
//   GET  /go/:token/:slug?               count one click, then redirect
//   GET  /embed/frame/:token             the iframe variant's page
//
// Mounted in server.js BEFORE publicRouter so none of these can be shadowed
// by its catch-all /:seoSlug route.
//
// Counting stores only a daily total per campaign. No cookies are set, no
// IP address is stored (an IP is only used as an in-memory rate limit key,
// which is lost on restart), and nothing is written to the visitor's browser.

const router = express.Router();

const EMBED_FILE = path.join(__dirname, '..', 'public', 'embed.js');

// Short, shared caching for the config response. Most views are served from
// a cache and never reach the server. max-age is the window in which a
// campaign switched on or off takes effect; stale-while-revalidate lets a
// cache answer instantly while it refreshes in the background.
const CONFIG_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=120';
// The script itself changes rarely. An hour of freshness, then a stale copy
// may be served while a new one is fetched.
const SCRIPT_CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400';

const impressionLimiter = createRateLimiter({ max: 60, windowMs: 60 * 1000 });
const clickLimiter = createRateLimiter({ max: 60, windowMs: 60 * 1000 });

// The embed file is tiny. Read it once and keep it, re-reading only when the
// file's modified time changes.
let scriptCache = { mtimeMs: 0, body: null };
function readEmbedScript() {
  const stat = fs.statSync(EMBED_FILE);
  if (!scriptCache.body || stat.mtimeMs !== scriptCache.mtimeMs) {
    scriptCache = { mtimeMs: stat.mtimeMs, body: fs.readFileSync(EMBED_FILE) };
  }
  return scriptCache.body;
}

function crossOriginHeaders(res) {
  // Helmet's default would block another site from loading these.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
}

// ---- the script ----
router.get('/embed.js', (req, res) => {
  let body;
  try {
    body = readEmbedScript();
  } catch (err) {
    console.error('[PROMOTIONS] Could not read embed.js:', err.message);
    return res.status(404).type('text/plain').send('Not found');
  }
  crossOriginHeaders(res);
  res.set('Cache-Control', SCRIPT_CACHE_CONTROL);
  res.type('application/javascript; charset=utf-8');
  res.send(body);
});

// ---- config ----
router.get('/api/embed/config/:token', asyncHandler(async (req, res) => {
  const token = req.params.token;
  // An unknown, malformed or deleted token is not an error: it gets the
  // general promotion, uncounted (see lib/promotions.js).
  const campaign = await promotions.getCampaignByToken(token);
  const { config } = await promotions.buildConfig(campaign, token);

  crossOriginHeaders(res);
  // Public, permissive cross-origin access for GET only. No cookies are set.
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', CONFIG_CACHE_CONTROL);
  res.json(config);
}));

// ---- impression ----
router.post('/api/embed/impression/:token', asyncHandler(async (req, res) => {
  if (impressionLimiter.tryConsume(getRealClientIp(req))) {
    try {
      await promotions.recordImpression(req.params.token);
    } catch (err) {
      console.error('[PROMOTIONS] Could not record an impression:', err.message);
    }
  }
  // The beacon's response is never read, but without this header the browser
  // reports it as blocked in the host page's console.
  crossOriginHeaders(res);
  res.set('Cache-Control', 'no-store');
  res.status(204).end();
}));

// ---- click and redirect ----
//
// The redirect target is built here, from a fixed path plus a slug that has
// just been checked against the database as an active website type. Nothing
// from the request (no query value, no header, no host) is ever used as an
// address, and the target is a relative path on this same site, so this
// route cannot be used as an open redirect.
router.get('/go/:token/:slug?', asyncHandler(async (req, res) => {
  let target = '/';
  if (req.params.slug && await promotions.isActiveTypeSlug(req.params.slug)) {
    target = `/build/${req.params.slug}`;
  }

  // Count real visits only (not HEAD checks), and never let counting stand
  // between a visitor and the site: any failure or rate limit still redirects.
  if (req.method === 'GET' && clickLimiter.tryConsume(getRealClientIp(req))) {
    try {
      await promotions.recordClick(req.params.token);
    } catch (err) {
      console.error('[PROMOTIONS] Could not record a click:', err.message);
    }
  }

  res.set('Cache-Control', 'no-store');
  res.redirect(302, target);
}));

// ---- iframe page ----
//
// The only route on this site that may be framed by other sites. Helmet sets
// X-Frame-Options: DENY and a CSP with frame-ancestors 'none' for every
// response (server.js), so both are replaced here, for this route only, with
// a CSP that allows framing and nothing else: no scripts, no images, no
// connections, no forms.
router.get('/embed/frame/:token', asyncHandler(async (req, res) => {
  const token = req.params.token;
  const campaign = await promotions.getCampaignByToken(token);
  const { config } = await promotions.buildConfig(campaign, token);
  const item = config.off ? null : pickItem(config.items);

  // Impressions for the iframe variant are counted when the frame loads.
  if (!config.off && campaign && req.method === 'GET' && impressionLimiter.tryConsume(getRealClientIp(req))) {
    try {
      await promotions.recordImpression(token);
    } catch (err) {
      console.error('[PROMOTIONS] Could not record a frame impression:', err.message);
    }
  }

  // Links in the frame are relative paths. A document's relative links resolve
  // against the address it was loaded from, even inside a sandboxed frame, so
  // no host value from the request is needed or used.
  res.removeHeader('X-Frame-Options');
  // Helmet asks for origin-keying on every page. A frame on another site
  // that does so after this origin was already loaded another way makes the
  // browser print a warning in the host page's console, so opt out here.
  res.set('Origin-Agent-Cluster', '?0');
  res.set('Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors *");
  crossOriginHeaders(res);
  // Every view is a new page view with its own random item and its own count.
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderFramePage(config, item));
}));

module.exports = router;
