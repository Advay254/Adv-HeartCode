const { getPool } = require('../db/init');
const { decrypt } = require('./crypto');

/**
 * Returns { mode, publicKey, secretKey } for whichever mode (test/live) is
 * currently active, or null if Paystack isn't configured yet / the secret
 * can't be decrypted. Nothing in this version calls Paystack's API — this
 * is purely a config reader for later versions' payment code to consume.
 */
async function getActivePaystackKeys() {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM paystack_config WHERE id = 1');
  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  const mode = row.mode;
  const publicKey = mode === 'live' ? row.public_key_live : row.public_key_test;
  const encryptedSecret = mode === 'live' ? row.secret_key_live_encrypted : row.secret_key_test_encrypted;

  if (!publicKey || !encryptedSecret) return null;

  try {
    const secretKey = decrypt(encryptedSecret);
    return { mode, publicKey, secretKey };
  } catch (err) {
    console.error('[PAYSTACK] Failed to decrypt secret key:', err.message);
    return null;
  }
}

module.exports = { getActivePaystackKeys };
