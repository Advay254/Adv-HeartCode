const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { logEvent } = require('../lib/activityEvents');
const { DISPOSABLE_DOMAINS } = require('../lib/disposableDomains');
const { getFreeSettings, saveFreeSettings, freeDeploymentsToday, getFreeInsights, MAX_EXPIRY_DAYS } = require('../lib/freeDeployments');

// v1.2.21: settings and a read-only overview for free deployments.
const router = express.Router();
router.use(requireAdminSession);

const updateSchema = z.object({
  dailyCap: z.coerce.number().int().min(0).max(1000),
  verifyDailyMax: z.coerce.number().int().min(0).max(5000),
  expiryDays: z.coerce.number().int().min(1).max(MAX_EXPIRY_DAYS),
  linkMinutes: z.coerce.number().int().min(5).max(120),
  blockedList: z.string().max(200000)
}).strict();

async function overview() {
  const pool = getPool();
  const settings = await getFreeSettings();
  const todayDeployed = await freeDeploymentsToday(pool);
  const dayStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const sent = await pool.query('SELECT COUNT(*)::int AS n FROM free_claims WHERE created_at >= $1', [dayStart]);
  const total = await pool.query("SELECT COUNT(*)::int AS n FROM free_claims WHERE status = 'verified'");
  const recent = await pool.query(
    `SELECT fc.email, fc.status, fc.created_at, fc.verified_at, fc.expires_at, ds.site_url, ds.expires_at AS site_expires_at
       FROM free_claims fc
       LEFT JOIN deployed_sites ds ON ds.reference = fc.reference
      ORDER BY fc.created_at DESC
      LIMIT 30`
  );
  return {
    settings: {
      dailyCap: settings.dailyCap,
      verifyDailyMax: settings.verifyDailyMax,
      expiryDays: settings.expiryDays,
      linkMinutes: settings.linkMinutes,
      blockedList: settings.blockedList.join('\n')
    },
    maxExpiryDays: MAX_EXPIRY_DAYS,
    builtInBlockedCount: DISPOSABLE_DOMAINS.length,
    today: { deployed: todayDeployed, emailsSent: sent.rows[0].n },
    totalVerified: total.rows[0].n,
    insights: await getFreeInsights(),
    recent: recent.rows.map(r => ({
      email: r.email,
      status: r.status,
      createdAt: r.created_at,
      verifiedAt: r.verified_at,
      linkExpiresAt: r.expires_at,
      siteUrl: r.site_url,
      siteExpiresAt: r.site_expires_at
    }))
  };
}

router.get('/', asyncHandler(async (req, res) => {
  res.json(await overview());
}));

router.put('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Check the numbers: expiry is 1 to 30 days, link time is 5 to 120 minutes.' });
  }
  await saveFreeSettings(parsed.data);
  await logEvent(getPool(), { eventType: 'admin_config_changed', title: 'Free deployment settings updated' });
  res.json(await overview());
}));

module.exports = router;
