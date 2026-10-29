const { getPool } = require('../db/init');

// v1.2.23: test deployments delete themselves from ClarityHeart after this
// many days, so the Test folder does not fill up. 0 keeps them forever.
const KEY = 'test_expiry_days';
const DEFAULT_DAYS = 1;

async function getTestExpiryDays() {
  const r = await getPool().query('SELECT value FROM site_settings WHERE key = $1', [KEY]);
  if (!r.rowCount) return DEFAULT_DAYS;
  const n = parseInt(r.rows[0].value, 10);
  return Number.isInteger(n) && n >= 0 && n <= 30 ? n : DEFAULT_DAYS;
}

async function setTestExpiryDays(n) {
  await getPool().query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KEY, String(n)]
  );
}

// The options object handed to deployToClarityHeart for a test site.
async function testDeployOptions() {
  const days = await getTestExpiryDays();
  return days > 0 ? { folder: 'Test', expiresInDays: days } : { folder: 'Test' };
}

module.exports = { getTestExpiryDays, setTestExpiryDays, testDeployOptions };
