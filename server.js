require('dotenv').config();

const path = require('path');
const express = require('express');
const { getPool, initDB } = require('./db/init');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', async (req, res) => {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', version: '1.0.0' });
  } catch (err) {
    console.error('[HEALTH] DB check failed:', err.message);
    res.status(500).json({ status: 'error', db: 'disconnected', version: '1.0.0' });
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
    console.log(`[SERVER] SiteForge listening on port ${PORT}`);
  });
}

start();
