const express = require('express');
const { getPool } = require('../db/init');
const { encrypt, decrypt, maskSecret } = require('../lib/crypto');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');

const router = express.Router();
router.use(requireAdminSession);

function decryptForMask(encrypted) {
  if (!encrypted) return null;
  try {
    return maskSecret(decrypt(encrypted));
  } catch (err) {
    // Missing/wrong ENCRYPTION_KEY or malformed value — treat as
    // "not configured" rather than letting this crash the request.
    return null;
  }
}

function serialize(row) {
  return {
    mode: row.mode,
    publicKeyTest: row.public_key_test,
    secretKeyTestMasked: decryptForMask(row.secret_key_test_encrypted),
    publicKeyLive: row.public_key_live,
    secretKeyLiveMasked: decryptForMask(row.secret_key_live_encrypted),
    updatedAt: row.updated_at
  };
}

router.get('/', async (req, res) => {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM paystack_config WHERE id = 1');

  if (result.rowCount === 0) {
    return res.json({
      mode: 'test',
      publicKeyTest: '',
      secretKeyTestMasked: null,
      publicKeyLive: '',
      secretKeyLiveMasked: null,
      updatedAt: null
    });
  }

  res.json(serialize(result.rows[0]));
});

// Convention for "leave this field alone" vs "clear it": a field that is
// `null` or omitted from the request body means "don't change this value";
// a field explicitly sent as an empty string "" means "clear it". This
// lets the client save mode/public-key changes without being forced to
// resend a secret key it never decrypted in the first place.
router.put('/', requireCsrf, async (req, res) => {
  const { mode, publicKeyTest, secretKeyTest, publicKeyLive, secretKeyLive } = req.body || {};

  if (mode !== 'test' && mode !== 'live') {
    return res.status(400).json({ error: "mode must be 'test' or 'live'" });
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Row-level lock so two concurrent saves can't both read the same
    // "current" values and clobber each other (lost-update race) — the
    // single row (id = 1) is always targeted, never a new one.
    const existing = await client.query('SELECT * FROM paystack_config WHERE id = 1 FOR UPDATE');
    const current = existing.rows[0] || null;

    const nextPublicKeyTest = publicKeyTest === undefined || publicKeyTest === null
      ? (current ? current.public_key_test : '')
      : publicKeyTest;
    const nextPublicKeyLive = publicKeyLive === undefined || publicKeyLive === null
      ? (current ? current.public_key_live : '')
      : publicKeyLive;

    let nextSecretTestEncrypted = current ? current.secret_key_test_encrypted : '';
    if (secretKeyTest !== undefined && secretKeyTest !== null) {
      nextSecretTestEncrypted = secretKeyTest === '' ? '' : encrypt(secretKeyTest);
    }

    let nextSecretLiveEncrypted = current ? current.secret_key_live_encrypted : '';
    if (secretKeyLive !== undefined && secretKeyLive !== null) {
      nextSecretLiveEncrypted = secretKeyLive === '' ? '' : encrypt(secretKeyLive);
    }

    const result = await client.query(
      `INSERT INTO paystack_config (id, mode, public_key_test, secret_key_test_encrypted, public_key_live, secret_key_live_encrypted, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         mode = EXCLUDED.mode,
         public_key_test = EXCLUDED.public_key_test,
         secret_key_test_encrypted = EXCLUDED.secret_key_test_encrypted,
         public_key_live = EXCLUDED.public_key_live,
         secret_key_live_encrypted = EXCLUDED.secret_key_live_encrypted,
         updated_at = NOW()
       RETURNING *`,
      [mode, nextPublicKeyTest, nextSecretTestEncrypted, nextPublicKeyLive, nextSecretLiveEncrypted]
    );

    await client.query('COMMIT');
    res.json(serialize(result.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PAYSTACK] Failed to save config:', err.message);
    res.status(500).json({ error: 'Failed to save Paystack configuration' });
  } finally {
    client.release();
  }
});

module.exports = router;
