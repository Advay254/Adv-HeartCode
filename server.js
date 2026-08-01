require('dotenv').config();

const path = require('path');
const express = require('express');
const { getPool, initDB } = require('./db/init');
const { adminSlugMiddleware } = require('./middleware/adminSlug');
const { pageRouter: adminPageRouter, apiRouter: adminApiRouter } = require('./routes/adminAuth');

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS upstream and proxies requests, so trust the first
// hop's X-Forwarded-* headers. This is needed for req.ip to reflect the
// real client IP, which the login rate limiter keys on.
app.set('trust proxy', 1);

// Slug-gated admin pages are checked before static files so a slug can
// never be shadowed by something under public/.
app.use(adminSlugMiddleware(adminPageRouter));

app.use(express.static(path.join(__dirname, 'public')));

// Admin API: not slug-gated (called by fetch from pages the browser already
// loaded), but every route except /login is session-gated inside the router.
app.use('/api/admin', adminApiRouter);

app.get('/health', async (req, res) => {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', version: '1.0.1' });
  } catch (err) {
    console.error('[HEALTH] DB check failed:', err.message);
    res.status(500).json({ status: 'error', db: 'disconnected', version: '1.0.1' });
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
