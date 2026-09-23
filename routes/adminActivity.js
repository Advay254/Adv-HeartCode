'use strict';

/**
 * v1.2.5 (Chunk C: activity feed). One read-only, keyset-paginated
 * endpoint over lib/activityEvents.js's log — used both by the Dashboard's
 * compact "Recent Activity" widget (small `limit`, no `eventType`) and the
 * full Activity page (paginated, filterable by type).
 */

const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const ae = require('../lib/activityEvents');
const { getPool } = require('../db/init');

const router = express.Router();
router.use(requireAdminSession);

router.get('/', asyncHandler(async (req, res) => {
  const parsed = ae.listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query parameters' });
  }
  const { limit, cursor: cursorToken, eventType } = parsed.data;

  let cursor = null;
  if (cursorToken) {
    cursor = ae.decodeCursor(cursorToken);
    if (!cursor) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
  }

  const page = await ae.fetchPage(getPool(), { limit, cursor, eventType });
  res.json({
    events: page.rows.map(ae.mapEvent),
    nextCursor: page.nextCursor,
    eventTypes: ae.EVENT_TYPES
  });
}));

module.exports = router;
