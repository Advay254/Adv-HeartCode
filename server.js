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

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS upstream and proxies requests, so trust the first
// hop's X-Forwarded-* headers. This is needed for req.ip to reflect the
// real client IP, which the login rate limiter keys on.
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

app.use(express.static(path.join(__dirname, 'public')));

// Admin API surface: not slug-gated (called by fetch from pages the browser
// already loaded), but every route is session-gated and every
// state-changing route is CSRF-gated inside its own router (except
// /api/admin/login, which has no session yet by definition).
app.use('/api/admin', express.json());
app.use('/api/admin', adminAuthApiRouter);
app.use('/api/admin/paystack', adminPaystackRouter);
app.use('/api/admin/ai-providers', adminAiProvidersRouter);
app.use('/api/admin/website-types', adminWebsiteTypesRouter);

app.get('/health', async (req, res) => {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', version: '1.0.2' });
  } catch (err) {
    console.error('[HEALTH] DB check failed:', err.message);
    res.status(500).json({ status: 'error', db: 'disconnected', version: '1.0.2' });
  }
});

async function start() {
  try {
    await initDB();
  } catch (err) {
    console.error('[SERVER] Database init failed — exiting so we don\'t serve traffic against a broken DB.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[SERVER] HeartCode listening on port ${PORT}`);
  });
}

start();
