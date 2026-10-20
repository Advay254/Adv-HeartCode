'use strict';

const path = require('path');
const express = require('express');
const { getSiteSettings } = require('../lib/siteSettings');
const { createRateLimiter } = require('../lib/rateLimit');
const { getRealClientIp } = require('../lib/clientIp');
const analytics = require('../lib/analytics');

// v1.2.16: analytics routes.
//
//   GET  /hc.js          the small first-party loader (only while analytics is on)
//   GET  /hc/s.js        "Serve through this site": the tracker script, fetched
//                        from the address saved in Site Settings and cached
//   POST /hc/api/send    "Serve through this site": receives the tracker's data
//                        and forwards it to the collect address derived from
//                        the saved script address
//
// The two /hc/ routes answer only while analytics AND "Serve through this
// site" are both on. Otherwise they call next(), so they behave exactly as if
// they did not exist. The forward target is never taken from the request.
//
// Mounted in server.js before publicRouter so its catch-all cannot shadow them.

const router = express.Router();

const LOADER_FILE = path.join(__dirname, '..', 'public', 'hc.js');
const LOADER_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';
const SCRIPT_CACHE_CONTROL = 'public, max-age=300, s-maxage=600, stale-while-revalidate=86400, stale-if-error=86400';

// Generous: many visitors can share one address. A limit only drops the data.
const collectLimiter = createRateLimiter({ max: 1200, windowMs: 60 * 1000 });

async function activeConfig() {
  try {
    const cfg = analytics.readConfig(await getSiteSettings());
    return cfg.enabled ? cfg : null;
  } catch (err) {
    return null;
  }
}

router.get('/hc.js', async (req, res, next) => {
  if (!(await activeConfig())) return next();
  res.set('Cache-Control', LOADER_CACHE_CONTROL);
  res.type('application/javascript');
  res.sendFile(LOADER_FILE, (err) => {
    if (err && !res.headersSent) next();
  });
});

router.get('/hc/s.js', async (req, res, next) => {
  const cfg = await activeConfig();
  if (!cfg || !cfg.proxy) return next();
  const body = await analytics.getTrackerScript(cfg);
  res.type('application/javascript');
  if (!body) {
    // Umami is unreachable and there is no earlier copy: answer with an empty
    // script so the page is unaffected, and do not let anything cache it.
    res.set('Cache-Control', 'no-store');
    return res.status(200).send('/* unavailable */');
  }
  res.set('Cache-Control', SCRIPT_CACHE_CONTROL);
  res.send(body);
});

router.post('/hc/api/send', async (req, res, next) => {
  const cfg = await activeConfig();
  if (!cfg || !cfg.proxy) return next();

  const quiet = () => res.status(200).type('application/json').send('{}');
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json') && !type.startsWith('text/plain')) {
    return res.status(415).type('application/json').send('{}');
  }
  if (!collectLimiter.tryConsume(getRealClientIp(req) || 'unknown')) return quiet();

  // Read the body here (not router-wide) so nothing else is affected.
  let parsed;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16 * 1024) return res.status(413).type('application/json').send('{}');
      chunks.push(chunk);
    }
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    return quiet();
  }

  const result = await analytics.forwardCollect(cfg, req, parsed);
  res.set('Cache-Control', 'no-store');
  res.status(result.status).type('application/json').send(result.body);
});

module.exports = router;
