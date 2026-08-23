const { getPool } = require('../db/init');
const { encrypt, decrypt } = require('./crypto');

/**
 * Turns a raw email_providers row into the normalized, DECRYPTED shape
 * lib/email.js's send functions actually use — this is the one place that
 * knows how each provider_type's `config` JSONB is shaped, so both the
 * real send path (getActiveEmailProvider below) and the admin "send test
 * email" route (routes/adminEmailProviders.js, which needs this for an
 * arbitrary — not necessarily active — row) share exactly the same
 * decrypt/shape logic rather than duplicating it.
 */
function normalizeProviderRow(row) {
  const config = row.config || {};

  if (row.provider_type === 'resend') {
    return {
      type: 'resend',
      apiKey: decrypt(config.api_key_encrypted),
      fromAddress: config.from_address || ''
    };
  }

  if (row.provider_type === 'smtp') {
    return {
      type: 'smtp',
      host: config.host || '',
      port: Number(config.port) || 587,
      username: config.username || '',
      password: decrypt(config.password_encrypted),
      fromAddress: config.from_address || '',
      fromName: config.from_name || '',
      connectionSecurity: config.connection_security || 'STARTTLS'
    };
  }

  throw new Error(`Unknown email provider_type: ${row.provider_type}`);
}

/**
 * Returns the normalized, decrypted config for the currently active
 * email_providers row, or null if none is active / the row fails to
 * decrypt (wrong/missing ENCRYPTION_KEY, malformed data) — callers treat
 * null as "no email provider available" rather than letting a decrypt
 * failure crash whatever triggered the send.
 */
async function getActiveEmailProvider() {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM email_providers WHERE is_active = true LIMIT 1');
  if (result.rowCount === 0) return null;

  try {
    return normalizeProviderRow(result.rows[0]);
  } catch (err) {
    console.error('[EMAIL-PROVIDER] Failed to decrypt/normalize the active provider config:', err.message);
    return null;
  }
}

/**
 * v1.1.1 Part C — graceful migration: called once at server boot (see
 * server.js), AFTER initDB() has created the email_providers table. If
 * that table has zero rows AND process.env.RESEND_API_KEY is set, seeds
 * one active 'resend' row from it (and EMAIL_FROM_ADDRESS, if set) so
 * upgrading to this version doesn't silently stop email from sending for
 * anyone who already had the env var configured. See db/init.js's schema
 * comment for the one real consequence worth knowing (this check re-runs
 * on every boot, keyed on "zero rows right now", not "has this ever run
 * before").
 *
 * Deliberately never throws — a failure here (e.g. ENCRYPTION_KEY missing)
 * is logged clearly but must not prevent the server from starting; the app
 * already runs fine with zero email providers configured, it just won't
 * be able to send until one exists.
 */
async function seedEmailProviderFromEnvIfNeeded() {
  try {
    const pool = getPool();
    const existing = await pool.query('SELECT COUNT(*)::int AS count FROM email_providers');
    if (existing.rows[0].count > 0) {
      return { seeded: false, reason: 'email_providers already has at least one row' };
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return { seeded: false, reason: 'RESEND_API_KEY is not set — nothing to migrate' };
    }

    const fromAddress = process.env.EMAIL_FROM_ADDRESS || '';
    if (!fromAddress) {
      console.warn('[EMAIL-PROVIDER] Seeding a Resend provider from RESEND_API_KEY, but EMAIL_FROM_ADDRESS is not set — sends will fail until a from address is added via the Email Providers admin page.');
    }

    const config = {
      api_key_encrypted: encrypt(apiKey),
      from_address: fromAddress
    };

    await pool.query(
      `INSERT INTO email_providers (provider_type, label, config, is_active)
       VALUES ('resend', $1, $2, true)`,
      ['Resend (migrated from environment)', JSON.stringify(config)]
    );

    console.log('[EMAIL-PROVIDER] Migrated RESEND_API_KEY / EMAIL_FROM_ADDRESS into a new active "Resend (migrated from environment)" provider. The env vars can be removed from Render once this is confirmed working (or replaced with a different provider) via the Email Providers admin page.');
    return { seeded: true };
  } catch (err) {
    console.error('[EMAIL-PROVIDER] Failed to seed a provider from RESEND_API_KEY — email sending will stay unconfigured until one is added via the admin dashboard:', err.message);
    return { seeded: false, reason: err.message };
  }
}

module.exports = { getActiveEmailProvider, normalizeProviderRow, seedEmailProviderFromEnvIfNeeded };
