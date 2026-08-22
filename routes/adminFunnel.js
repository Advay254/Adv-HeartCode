const express = require('express');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');

const router = express.Router();
router.use(requireAdminSession);

// Fixed order = the actual client journey, home/explore first (not tied
// to a website type) through to payment. Kept as one ordered list (rather
// than deriving order from whatever rows happen to come back from a GROUP
// BY) so a stage with zero events in the selected range still shows up as
// a real "0" bar instead of silently vanishing from the chart.
const FUNNEL_STAGES = [
  { eventType: 'page_view_home', label: 'Home views' },
  { eventType: 'page_view_explore', label: 'Explore views' },
  { eventType: 'form_started', label: 'Form started' },
  { eventType: 'preview_generated', label: 'Preview generated' },
  { eventType: 'checkout_started', label: 'Checkout started' },
  { eventType: 'payment_completed', label: 'Payment completed' }
];

const statsQuerySchema = z.object({
  days: z.coerce.number().int().refine(v => [7, 30, 90].includes(v), 'days must be 7, 30, or 90').default(7),
  websiteTypeId: z.coerce.number().int().positive().optional()
});

router.get('/stats', async (req, res) => {
  const parsed = statsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query parameters' });
  }
  const { days, websiteTypeId } = parsed.data;

  const pool = getPool();
  const params = [days];
  // website_type_id filter note (surfaced in the admin UI too, not just
  // here): page_view_home and page_view_explore events NEVER carry a
  // website_type_id (see db/init.js's funnel_events schema — home/explore
  // views aren't tied to any specific type), so filtering by type always
  // shows those first two stages as 0. That's correct, not a bug — those
  // two stages are inherently type-agnostic.
  let typeFilter = '';
  if (websiteTypeId) {
    params.push(websiteTypeId);
    typeFilter = 'AND website_type_id = $2';
  }

  const result = await pool.query(
    `SELECT event_type, COUNT(*) AS count
     FROM funnel_events
     WHERE created_at >= NOW() - ($1 || ' days')::interval ${typeFilter}
     GROUP BY event_type`,
    params
  );

  const countByType = {};
  for (const row of result.rows) {
    countByType[row.event_type] = Number(row.count);
  }

  const stages = FUNNEL_STAGES.map((stage, i) => {
    const count = countByType[stage.eventType] || 0;
    let dropOffPct = null;
    if (i > 0) {
      const prevCount = countByType[FUNNEL_STAGES[i - 1].eventType] || 0;
      dropOffPct = prevCount > 0 ? Math.round((1 - count / prevCount) * 100) : null;
    }
    return { eventType: stage.eventType, label: stage.label, count, dropOffPct };
  });

  res.json({ days, websiteTypeId: websiteTypeId || null, stages });
});

module.exports = router;
