const express = require('express');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');

const router = express.Router();
router.use(requireAdminSession);

// v1.0.6: a small, generic key/value surface over the already-existing
// site_settings table, starting with the one setting v1.0.6 actually
// needs (kenyan_payment_currency). Deliberately per-key routes rather than
// a single free-form "set any key" endpoint -- that would let the admin UI
// (or a CSRF-bypassing bug) write arbitrary settings keys the backend
// doesn't know about; each setting this app actually reads gets its own
// narrow, validated route instead.

router.get('/kenyan-payment-currency', async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    "SELECT value FROM site_settings WHERE key = 'kenyan_payment_currency'"
  );
  res.json({ value: result.rowCount > 0 ? result.rows[0].value : 'USD' });
});

const updateKenyanCurrencySchema = z.object({
  value: z.enum(['USD', 'KES'])
});

router.put('/kenyan-payment-currency', requireCsrf, async (req, res) => {
  const parsed = updateKenyanCurrencySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'value must be "USD" or "KES"' });
  }

  const pool = getPool();
  await pool.query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ('kenyan_payment_currency', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [parsed.data.value]
  );
  res.json({ value: parsed.data.value });
});

module.exports = router;
