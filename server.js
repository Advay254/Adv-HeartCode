require('dotenv').config();

const path = require('path');
const express = require('express');
const { getPool, initDB } = require('./db/init');
const { adminSlugMiddleware } = require('./middleware/adminSlug');
const { pageRouter: adminLoginPageRouter, apiRouter: adminAuthApiRouter } = require('./routes/adminAuth');
const adminPagesRouter = require('./routes/adminPages');
const adminPaystackRouter = require('./routes/adminPaystack');
const adminAiProvidersRouter = require('./routes/adminAiProviders');
const adminWebsiteTypesRouter = require('./routes/adminWebsiteTypes');
const publicRouter = require('./routes/public');
const apiBuildRouter = require('./routes/apiBuild');
const webhooksRouter = require('./routes/webhooks');
const sitePasswordCache = require('./lib/sitePasswordCache');

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS upstream and proxies requests, so trust the first
// hop's X-Forwarded-* headers. Needed for req.ip (rate limiters) and for
// req.protocol to correctly read "https" (used to build the Paystack
// callback_url in routes/public.js) rather than the raw internal "http".
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

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
// static so these dynamic routes always take precedence.
app.use(publicRouter);

app.use(express.static(path.join(__dirname, 'public')));

// Admin API surface: not slug-gated (called by fetch from pages the browser
// already loaded), but every route is session-gated and every
// state-changing route is CSRF-gated inside its own router.
app.use('/api/admin', express.json());
app.use('/api/admin', adminAuthApiRouter);
app.use('/api/admin/paystack', adminPaystackRouter);
app.use('/api/admin/ai-providers', adminAiProvidersRouter);
app.use('/api/admin/website-types', adminWebsiteTypesRouter);

// Public build API: not session-gated (there's no session for a client
// filling out a form), rate-limited per IP inside the router instead.
app.use('/api/build', apiBuildRouter);

// Paystack webhook: not session-gated, not CSRF-gated (Paystack isn't a
// browser with a session — CSRF doesn't apply), verified instead via its
// own HMAC-SHA512 signature check inside the router. Mounts its own
// express.raw() internally rather than express.json(), since signature
// verification needs the untouched raw body bytes.
app.use('/api/webhooks', webhooksRouter);

app.get('/health', async (req, res) => {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', version: '1.0.4' });
  } catch (err) {
    console.error('[HEALTH] DB check failed:', err.message);
    res.status(500).json({ status: 'error', db: 'disconnected', version: '1.0.4' });
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
