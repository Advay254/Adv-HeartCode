'use strict';

const { getPool } = require('../db/init');
const {
  REMINDER_AFTER_DAYS,
  AUTO_PUBLISH_AFTER_DAYS
} = require('./reviews');
const { sendReviewReminder } = require('./reviewReminder');
const { deleteExpiredBroadcast } = require('./broadcast');

// v1.2.11: the one scheduled job for reviews. All state lives in the
// database and nothing is remembered in memory, so it is safe across
// restarts and safe if two runs overlap:
//   - cleanup is a plain DELETE of rows past expiry (idempotent)
//   - auto-publish is one conditional UPDATE (a row can only be approved
//     once, and a deleted review is simply not there to update)
//   - reminders take a row lock with SKIP LOCKED, send while holding it,
//     and only then stamp reminder_sent_at, so a second concurrent run
//     skips that row instead of emailing it again

const MAX_REMINDERS_PER_RUN = 25;

/** Permanently deletes every review link row past its expiry. */
async function cleanupExpiredLinks() {
  const result = await getPool().query('DELETE FROM review_links WHERE expires_at <= NOW()');
  return result.rowCount;
}

/**
 * Approves every review still pending 14 days after it was submitted, marks
 * it auto-approved, and records the approval time.
 */
async function autoPublishOldPending() {
  const result = await getPool().query(
    `UPDATE reviews
        SET status = 'approved', auto_approved = true, approved_at = NOW()
      WHERE status = 'pending'
        AND submitted_at <= NOW() - make_interval(days => $1)
      RETURNING id`,
    [AUTO_PUBLISH_AFTER_DAYS]
  );
  return result.rowCount;
}

/**
 * Sends each due reminder at most once per deployment. One link per
 * transaction. Returns { sent, failed }.
 */
async function sendDueReminders(limit = MAX_REMINDERS_PER_RUN) {
  const pool = getPool();
  let sent = 0;
  const failedIds = [];

  for (let i = 0; i < limit; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const due = await client.query(
        `SELECT rl.id, rl.token, ds.client_email, ds.site_url, ds.deployed_at,
                ds.website_type_id, wt.name AS website_type_name
           FROM review_links rl
           JOIN deployed_sites ds ON ds.id = rl.deployed_site_id
           LEFT JOIN website_types wt ON wt.id = ds.website_type_id
          WHERE rl.reminder_sent_at IS NULL
            AND rl.created_at <= NOW() - make_interval(days => $1)
            AND rl.expires_at > NOW()
            AND ds.is_test = false
            AND rl.id <> ALL($2::int[])
          ORDER BY rl.created_at ASC, rl.id ASC
          LIMIT 1
          FOR UPDATE OF rl SKIP LOCKED`,
        [REMINDER_AFTER_DAYS, failedIds]
      );

      if (due.rowCount === 0) {
        await client.query('COMMIT');
        break;
      }

      const row = due.rows[0];
      try {
        await sendReviewReminder(row);
      } catch (err) {
        await client.query('ROLLBACK');
        failedIds.push(row.id);
        console.error(`[REVIEWS] Reminder for review link #${row.id} failed and will be retried on a later run:`, err.message);
        continue;
      }

      // Stamped only after the send succeeded.
      await client.query('UPDATE review_links SET reminder_sent_at = NOW() WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      sent++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[REVIEWS] Reminder run error:', err.message);
      break;
    } finally {
      client.release();
    }
  }

  return { sent, failed: failedIds.length };
}

/** One full maintenance pass. Each step is independent: one failing never stops the others. */
async function runReviewMaintenance() {
  const summary = { cleaned: 0, autoPublished: 0, reminded: 0, reminderFailures: 0 };

  try {
    summary.cleaned = await cleanupExpiredLinks();
  } catch (err) {
    console.error('[REVIEWS] Link cleanup failed:', err.message);
  }

  // v1.2.12: the /testimonials broadcast is physically removed once its 7
  // days are up (readers already ignore an expired one, so this is tidying).
  try {
    await deleteExpiredBroadcast();
  } catch (err) {
    console.error('[REVIEWS] Broadcast cleanup failed:', err.message);
  }

  try {
    summary.autoPublished = await autoPublishOldPending();
  } catch (err) {
    console.error('[REVIEWS] Auto-publish failed:', err.message);
  }

  try {
    const r = await sendDueReminders();
    summary.reminded = r.sent;
    summary.reminderFailures = r.failed;
  } catch (err) {
    console.error('[REVIEWS] Reminder step failed:', err.message);
  }

  if (summary.cleaned || summary.autoPublished || summary.reminded) {
    console.log(`[REVIEWS] Maintenance: removed ${summary.cleaned} expired link(s), auto-published ${summary.autoPublished} review(s), sent ${summary.reminded} reminder(s).`);
  }
  return summary;
}

module.exports = {
  cleanupExpiredLinks,
  autoPublishOldPending,
  sendDueReminders,
  runReviewMaintenance
};
