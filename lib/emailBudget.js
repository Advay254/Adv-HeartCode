const { getPool } = require('../db/init');

// v1.2.23: counts every email HeartCode sends and compares it with the daily
// limit the admin typed in. Nothing is assumed: with no limit saved there is
// no meter. The day is a UTC day, which is how most email providers count.
const KEY = 'email_daily_quota';

function utcDayStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Never lets a logging problem stop an email from being sent or reported.
async function recordEmail(ok) {
  try {
    await getPool().query('INSERT INTO email_log (ok) VALUES ($1)', [Boolean(ok)]);
  } catch (err) {
    console.error('[EMAIL-LOG] Could not record an email:', err.message);
  }
}

async function getQuota() {
  const r = await getPool().query('SELECT value FROM site_settings WHERE key = $1', [KEY]);
  const n = r.rowCount ? parseInt(r.rows[0].value, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function setQuota(n) {
  const pool = getPool();
  if (n == null) {
    await pool.query('DELETE FROM site_settings WHERE key = $1', [KEY]);
    return;
  }
  await pool.query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KEY, String(n)]
  );
}

async function getEmailBudget() {
  const pool = getPool();
  const quota = await getQuota();
  const today = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ok)::int AS sent, COUNT(*) FILTER (WHERE NOT ok)::int AS failed
       FROM email_log WHERE sent_at >= $1`, [utcDayStart()]);
  const week = await pool.query(
    `SELECT to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
       FROM email_log WHERE ok AND sent_at >= $1 GROUP BY 1 ORDER BY 1 DESC`,
    [new Date(utcDayStart().getTime() - 6 * 86400000)]);
  const sent = today.rows[0].sent;
  return {
    quota,
    sentToday: sent,
    failedToday: today.rows[0].failed,
    remaining: quota == null ? null : Math.max(0, quota - sent),
    lastDays: week.rows.map(r => ({ day: r.day, count: r.n }))
  };
}

async function purgeOldEmailLog() {
  const r = await getPool().query("DELETE FROM email_log WHERE sent_at < NOW() - INTERVAL '40 days'");
  return r.rowCount;
}

module.exports = { recordEmail, getQuota, setQuota, getEmailBudget, purgeOldEmailLog, utcDayStart };
