require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { getPool, initDB } = require('./db/init');
const { adminSlugMiddleware } = require('./middleware/adminSlug');
const { pageRouter: adminLoginPageRouter, apiRouter: adminAuthApiRouter } = require('./routes/adminAuth');
const adminPagesRouter = require('./routes/adminPages');
const adminPaystackRouter = require('./routes/adminPaystack');
const adminAiProvidersRouter = require('./routes/adminAiProviders');
const adminWebsiteTypesRouter = require('./routes/adminWebsiteTypes');
const adminDashboardRouter = require('./routes/adminDashboard');
const adminSettingsRouter = require('./routes/adminSettings');
const adminSiteSettingsRouter = require('./routes/adminSiteSettings');
const adminScriptsRouter = require('./routes/adminScripts');
const adminLandingRouter = require('./routes/adminLanding');
const publicRouter = require('./routes/public');
const apiBuildRouter = require('./routes/apiBuild');
const webhooksRouter = require('./routes/webhooks');
const sitePasswordCache = require('./lib/sitePasswordCache');
const { createRateLimiter } = require('./lib/rateLimit');
const { refreshExchangeRates } = require('./lib/currency');
const { getIconSvg } = require('./lib/icons');

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS upstream and proxies requests, so trust the first
// hop's X-Forwarded-* headers. Needed for req.ip (rate limiters) and for
// req.protocol to correctly read "https" (used to build the Paystack
// callback_url in routes/public.js) rather than the raw internal "http".
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// getIconSvg is a pure, synchronous, cached-after-first-read function
// (lib/icons.js) reused across many different views (landing page,
// type gallery, how-it-works steps) — registering it once on app.locals
// makes it available in every EJS template automatically
// (`<%- getIconSvg('sparkles') %>`) without every res.render() call
// needing to remember to pass it explicitly.
app.locals.getIconSvg = getIconSvg;

// ---- security headers ----
// v1.0.7 split the single, site-wide CSP into two separate policies:
//
// - adminCsp: EXACTLY the v1.0.5 policy, unchanged (script-src 'self',
//   frame-ancestors 'none', everything else at helmet's defaults) —
//   applied to every admin-authenticated surface (the slug-gated admin
//   page router AND /api/admin/*).
// - publicCsp: the same policy, but with script-src, connect-src, and
//   img-src deliberately loosened — applied to everything else (public
//   pages, static assets, the public build API, the webhook).
//
// Why: v1.0.7 adds a script injection manager (routes/adminScripts.js) so
// Advay can paste arbitrary third-party snippets (analytics, etc.) that
// render into PUBLIC pages only (see lib/siteScripts.js and the comment
// on adminPageRouter below — site_scripts content is never reached from
// an admin-authenticated render). A strict `script-src 'self'` would
// block those from working at all: it blocks loading a script from any
// non-same-origin src, AND blocks inline <script>...</script> content
// outright, and plenty of real analytics snippets (not just Umami-style
// external-src tags) are inline code blocks, not just a src attribute.
//
// What actually changed, and why each piece is needed for the FEATURE to
// really work (not just for the script tag to load, but for it to
// function) — deliberate, not an oversight:
//   - script-src: 'self' 'unsafe-inline' https:
//     'unsafe-inline' allows inline <script> blocks (needed for snippets
//     that aren't just a src attribute). https: allows loading from any
//     HTTPS host, rather than a hardcoded allow-list that goes stale the
//     moment Advay adds a new tool — the whole point of a general script
//     manager is "any snippet," not "these specific pre-approved vendors."
//     'unsafe-eval' is deliberately NOT added — this is the one thing the
//     brief explicitly draws the line at, and legitimate analytics/tag
//     snippets essentially never need eval()/Function()-based dynamic
//     code execution.
//   - connect-src: 'self' https:
//     Without this, a tracker's script would LOAD fine (script-src covers
//     that) but every fetch()/XHR/sendBeacon() call it makes to actually
//     report analytics data back to its own servers would be silently
//     blocked by the default connect-src 'self' — the feature would look
//     like it works (no console error on load) while doing nothing
//     useful. This is needed for the feature to be genuinely functional,
//     not just technically present.
//   - img-src: 'self' data: https:
//     Some lightweight/legacy trackers report via a 1x1 pixel image
//     request rather than a script; without this they'd be silently
//     blocked the same way.
//
// frame-ancestors stays 'none' in BOTH policies — allowing third-party
// analytics scripts to execute is an unrelated concern from whether other
// sites can iframe this one, and there's no reason to loosen framing
// protection just because script-src loosened.
const cspDefaults = helmet.contentSecurityPolicy.getDefaultDirectives();

const adminCsp = helmet.contentSecurityPolicy({
  directives: {
    ...cspDefaults,
    'frame-ancestors': ["'none'"]
  }
});

const publicCsp = helmet.contentSecurityPolicy({
  directives: {
    ...cspDefaults,
    'frame-ancestors': ["'none'"],
    'script-src': ["'self'", "'unsafe-inline'", 'https:'],
    'connect-src': ["'self'", 'https:'],
    'img-src': ["'self'", 'data:', 'https:']
  }
});

// Non-CSP helmet protections (X-Frame-Options, X-Content-Type-Options,
// etc.) stay global and identical for both admin and public — only CSP
// itself is split, applied per route-group further down.
app.use(helmet({
  contentSecurityPolicy: false,
  xFrameOptions: { action: 'deny' }
}));

// Public CSP is the default for everything that isn't explicitly admin
// (below) — covers the webhook, static assets, public pages, and the
// public build API in one place rather than needing to remember to apply
// it at each of those mount points individually.
app.use(publicCsp);

// ---- global abuse rate limiter ----
// A blunt backstop on top of the existing endpoint-specific limiters
// (login lockout, AI generate, checkout) — not a replacement for them.
// Excludes the Paystack webhook explicitly: that's legitimate
// server-to-server traffic from Paystack's infrastructure, not a client,
// and must never be blocked by a per-IP ceiling meant for basic
// flooding/scanning protection.
const globalLimiter = createRateLimiter({ max: 120, windowMs: 60 * 1000 });

app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhooks/')) {
    return next();
  }
  if (!globalLimiter.tryConsume(req.ip)) {
    return res.status(429).json({ error: 'Too many requests, please slow down' });
  }
  next();
});

// Paystack webhook: mounted BEFORE publicRouter, deliberately. publicRouter
// (below) has its own express.json() with no path restriction, which would
// otherwise consume and parse the request body for EVERY request that
// reaches it — including /api/webhooks/paystack — before this route's own
// express.raw() ever got a chance to capture the untouched raw bytes it
// needs for signature verification. This was a real bug present since
// v1.0.4 (caught here, during this version's audit, by finally testing the
// webhook against the actual full server rather than in isolation — see
// the delivery write-up). Not session-gated, not CSRF-gated (Paystack
// isn't a browser with a session — CSRF doesn't apply), verified instead
// via its own HMAC-SHA512 signature check inside the router.
//
// Deliberately NOT wrapped in cors() — CORS is a browser-enforced
// mechanism (it governs whether a browser lets cross-origin JavaScript
// read a fetch/XHR response). Paystack's webhook delivery is a
// server-to-server HTTP POST with no browser involved and no Origin
// header being enforced by anything; there is no "cross-origin request"
// for CORS to have an opinion about here. Adding cors() to this route
// wouldn't reject anything Paystack sends — it would be inert middleware
// solving a problem that doesn't exist in this context, so it's left off
// rather than added for the sake of pattern-matching the other routes.
app.use('/api/webhooks', webhooksRouter);

// Combine the unauthenticated login page route with the session-gated
// dashboard page routes into one router, then hand the whole thing to
// adminSlugMiddleware. Neither sub-router is ever mounted on a public
// app.use() path — the slug middleware is the only way to reach either.
// adminCsp is applied INSIDE this router (rather than via an app-level
// path prefix, which isn't possible here since the admin path segment is
// a runtime env var, not a fixed string the router tree can match on) —
// it runs after the publicCsp default above for every request that
// actually reaches this router, and since helmet's CSP middleware just
// does a plain res.setHeader() (last call wins), this correctly overrides
// back to the strict policy for every admin page. site_scripts content
// (v1.0.7) is never rendered anywhere in adminPagesRouter or its views —
// nothing in views/admin/** or views/partials/nav.ejs/head.ejs has an
// injection point for it, unlike views/partials/public-head.ejs and the
// public layout wrapper — so third-party trackers pasted into the script
// manager only ever see public, client-facing traffic, never an
// authenticated admin session.
const adminPageRouter = express.Router();
adminPageRouter.use(adminCsp);
adminPageRouter.use(adminLoginPageRouter);
adminPageRouter.use(adminPagesRouter);

app.use(adminSlugMiddleware(adminPageRouter));

// Public client-facing pages (type selection, build form, preview,
// checkout, checkout callback) own the root path space. Mounted before
// static so these dynamic routes always take precedence. CORS here is
// same-origin-only too (origin: false) — the checkout POST endpoint lives
// under this router, and there's no legitimate reason another origin's JS
// needs to read responses from any of these routes. This doesn't affect
// normal page loads/navigation for real visitors — CORS only governs
// whether OTHER sites' JavaScript can read a cross-origin fetch response,
// not whether a browser can render a page it navigated to directly.
app.use(cors({ origin: false }));
app.use(publicRouter);

app.use(express.static(path.join(__dirname, 'public')));

// Admin API surface: not slug-gated (called by fetch from pages the browser
// already loaded), but every route is session-gated and every
// state-changing route is CSRF-gated inside its own router. CORS:
// same-origin only — there's no legitimate reason a browser on another
// domain calls these. adminCsp applied here too (path-scoped is fine for
// this one, since /api/admin is a real fixed prefix, unlike the page
// router above) — doesn't functionally matter for JSON responses, kept
// for consistency with "everything under the admin surface uses the
// strict policy."
app.use('/api/admin', adminCsp);
app.use('/api/admin', cors({ origin: false }));
app.use('/api/admin', express.json());
app.use('/api/admin', adminAuthApiRouter);
app.use('/api/admin/paystack', adminPaystackRouter);
app.use('/api/admin/ai-providers', adminAiProvidersRouter);
app.use('/api/admin/website-types', adminWebsiteTypesRouter);
app.use('/api/admin/dashboard', adminDashboardRouter);
app.use('/api/admin/settings', adminSettingsRouter);
app.use('/api/admin/site-settings', adminSiteSettingsRouter);
app.use('/api/admin/scripts', adminScriptsRouter);
app.use('/api/admin/landing', adminLandingRouter);

// Public build API: not session-gated (there's no session for a client
// filling out a form), rate-limited per IP inside the router instead.
// CORS: same-origin only, same reasoning as /api/admin above.
app.use('/api/build', cors({ origin: false }));
app.use('/api/build', apiBuildRouter);

app.get('/health', async (req, res) => {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', version: '1.0.8' });
  } catch (err) {
    console.error('[HEALTH] DB check failed:', err.message);
    res.status(500).json({ status: 'error', db: 'disconnected', version: '1.0.8' });
  }
});

// Periodic cleanup: sweeps pending_deployments rows past their 1-hour
// expiry (abandoned checkouts that never completed payment) and prunes
// the matching entries out of the in-memory site-password cache. Runs
// every 15 minutes; only started after initDB() succeeds.
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const PENDING_DEPLOYMENT_MAX_AGE_MS = 60 * 60 * 1000;

function startCleanupJob() {
  setInterval(async () => {
    try {
      const pool = getPool();
      const result = await pool.query(
        'DELETE FROM pending_deployments WHERE expires_at < NOW() RETURNING reference'
      );
      if (result.rowCount > 0) {
        console.log(`[CLEANUP] Removed ${result.rowCount} expired pending deployment(s).`);
      }
    } catch (err) {
      console.error('[CLEANUP] Failed to sweep expired pending_deployments:', err.message);
    }
    sitePasswordCache.pruneExpired(PENDING_DEPLOYMENT_MAX_AGE_MS);
  }, CLEANUP_INTERVAL_MS);
}

// v1.0.6: keeps lib/currency.js's exchange_rates table warm. Runs once at
// boot (fire-and-forget — refreshExchangeRates() already catches and logs
// its own errors, so a slow/failed first fetch never delays or blocks
// server startup) and then every 24h, same pattern as the cleanup job
// above.
const EXCHANGE_RATE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

function startExchangeRateRefreshJob() {
  refreshExchangeRates().catch(() => {});
  setInterval(() => {
    refreshExchangeRates().catch(() => {});
  }, EXCHANGE_RATE_REFRESH_INTERVAL_MS);
}

async function start() {
  try {
    await initDB();
  } catch (err) {
    console.error('[SERVER] Database init failed — exiting so we don\'t serve traffic against a broken DB.');
    process.exit(1);
  }

  startCleanupJob();
  startExchangeRateRefreshJob();

  app.listen(PORT, () => {
    console.log(`[SERVER] HeartCode listening on port ${PORT}`);
  });
}

start();
