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
const publicRouter = require('./routes/public');
const apiBuildRouter = require('./routes/apiBuild');
const webhooksRouter = require('./routes/webhooks');
const sitePasswordCache = require('./lib/sitePasswordCache');
const { createRateLimiter } = require('./lib/rateLimit');

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS upstream and proxies requests, so trust the first
// hop's X-Forwarded-* headers. Needed for req.ip (rate limiters) and for
// req.protocol to correctly read "https" (used to build the Paystack
// callback_url in routes/public.js) rather than the raw internal "http".
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---- security headers ----
// helmet's own defaults are already a good fit here (script-src 'self',
// script-src-attr 'none', object-src 'none', etc.) — as of this version
// every page-specific script lives in an external file
// (public/dashboard-assets/admin.js, public/site.js), no inline <script>
// blocks or inline event-handler attributes remain anywhere in the EJS
// views (verified by grepping every view file). The one directive
// overridden below is frame-ancestors: helmet defaults to 'self' (blocks
// cross-site framing, allows same-site), this app wants 'none' everywhere
// (blocks ALL framing, including same-site) per spec — this does NOT
// affect the preview page's own <iframe srcdoc sandbox="allow-same-origin">
// (v1.0.3), since frame-ancestors governs whether OTHER pages can embed
// THIS page, not whether this page can embed its own iframe.
//
// Inline style="..." attributes are NOT locked down here (style-src stays
// at helmet's default of 'self' https: 'unsafe-inline') — this pass
// audited and eliminated inline SCRIPT specifically, not inline styles,
// which are used extensively throughout the views for one-off layout
// tweaks. CSS-based attacks are a materially narrower, lower-severity
// concern than script injection; locking this down too would mean
// rewriting every inline style attribute across every view, which is out
// of scope for this pass — flagged in the delivery write-up.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      frameAncestors: ["'none'"]
    }
  },
  xFrameOptions: { action: 'deny' }
}));

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
const adminPageRouter = express.Router();
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
// domain calls these.
app.use('/api/admin', cors({ origin: false }));
app.use('/api/admin', express.json());
app.use('/api/admin', adminAuthApiRouter);
app.use('/api/admin/paystack', adminPaystackRouter);
app.use('/api/admin/ai-providers', adminAiProvidersRouter);
app.use('/api/admin/website-types', adminWebsiteTypesRouter);
app.use('/api/admin/dashboard', adminDashboardRouter);

// Public build API: not session-gated (there's no session for a client
// filling out a form), rate-limited per IP inside the router instead.
// CORS: same-origin only, same reasoning as /api/admin above.
app.use('/api/build', cors({ origin: false }));
app.use('/api/build', apiBuildRouter);

app.get('/health', async (req, res) => {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', version: '1.0.5' });
  } catch (err) {
    console.error('[HEALTH] DB check failed:', err.message);
    res.status(500).json({ status: 'error', db: 'disconnected', version: '1.0.5' });
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

async function start() {
  try {
    await initDB();
  } catch (err) {
    console.error('[SERVER] Database init failed — exiting so we don\'t serve traffic against a broken DB.');
    process.exit(1);
  }

  startCleanupJob();

  app.listen(PORT, () => {
    console.log(`[SERVER] HeartCode listening on port ${PORT}`);
  });
}

start();
