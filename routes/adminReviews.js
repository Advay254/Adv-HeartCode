'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../lib/asyncHandler');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const {
  listPendingReviews,
  listApprovedReviews,
  countPendingReviews,
  approveReview,
  deleteReviewRow,
  AUTO_PUBLISH_AFTER_DAYS
} = require('../lib/reviews');
const { validateName, validateTestimonial } = require('../lib/reviewValidation');
const { deleteImageFromClarityHeart } = require('../lib/clarityheart');
const { validateBroadcastMessage, getActiveBroadcast, saveBroadcast, deleteBroadcast } = require('../lib/broadcast');

// v1.2.11: admin moderation API for reviews. Session first, CSRF on every
// state-changing route, every id validated before it touches the database,
// every query parameterized (see lib/reviews.js). Review text is returned
// as plain strings here and escaped on display by the admin page.

const router = express.Router();
router.use(requireAdminSession);

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

// Optional edits when approving. Both fields go through the SAME validators
// a reviewer's own submission does (length limits, control/invisible
// character stripping, no URLs, no HTML).
const approveBodySchema = z.object({
  edit: z.object({
    name: z.string().max(1000),
    testimonial: z.string().max(5000)
  }).optional()
});

function mapReview(row) {
  return {
    id: row.id,
    name: row.reviewer_name,
    rating: row.rating,
    testimonial: row.testimonial,
    imageUrl: row.image_url,
    status: row.status,
    autoApproved: row.auto_approved,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    daysLeft: row.days_left,
    deployment: {
      siteUrl: row.site_url || null,
      clientEmail: row.client_email || null,
      websiteTypeName: row.website_type_name || null
    }
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const [pending, approved] = await Promise.all([listPendingReviews(), listApprovedReviews()]);
  res.json({
    autoPublishAfterDays: AUTO_PUBLISH_AFTER_DAYS,
    pending: pending.map(mapReview),
    approved: approved.map(mapReview)
  });
}));

router.get('/pending-count', asyncHandler(async (req, res) => {
  res.json({ count: await countPendingReviews() });
}));

// ---- /testimonials broadcast (v1.2.12) ----
// Declared BEFORE the '/:id' routes so 'broadcast' is never read as an id.
// One message at most; saving replaces it and restarts the 7 day clock.
router.get('/broadcast', asyncHandler(async (req, res) => {
  res.json({ broadcast: await getActiveBroadcast() });
}));

router.put('/broadcast', requireCsrf, asyncHandler(async (req, res) => {
  const body = z.object({ message: z.string().max(2000) }).safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ error: 'Invalid request' });
  const checked = validateBroadcastMessage(body.data.message);
  if (checked.error) return res.status(422).json({ error: checked.error });
  res.json({ broadcast: await saveBroadcast(checked.value) });
}));

router.delete('/broadcast', requireCsrf, asyncHandler(async (req, res) => {
  await deleteBroadcast();
  res.json({ success: true });
}));

router.post('/:id/approve', requireCsrf, asyncHandler(async (req, res) => {
  const params = idParamSchema.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: 'Invalid review id' });
  const body = approveBodySchema.safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ error: 'Invalid request' });

  let edits = null;
  if (body.data.edit) {
    const n = validateName(body.data.edit.name);
    const t = validateTestimonial(body.data.edit.testimonial);
    const errors = {};
    if (n.error) errors.name = n.error;
    if (t.error) errors.testimonial = t.error;
    if (Object.keys(errors).length > 0) {
      return res.status(422).json({ error: 'Please fix the edited fields.', errors });
    }
    edits = { name: n.value, testimonial: t.value };
  }

  const result = await approveReview(params.data.id, edits);
  if (!result.ok) {
    return res.status(404).json({ error: 'That review is not waiting for approval (it may already be approved, or deleted).' });
  }
  res.json({ success: true });
}));

router.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const params = idParamSchema.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: 'Invalid review id' });

  // The row goes first and is permanent. The image removal happens after and
  // can fail without undoing the delete; the admin is told clearly when it
  // does, with the address so the file can be removed by hand.
  const deleted = await deleteReviewRow(params.data.id);
  if (!deleted) return res.status(404).json({ error: 'Review not found' });

  const result = { success: true, hadImage: Boolean(deleted.imageUrl), imageDeleted: null, imageUrl: null };
  if (deleted.imageUrl) {
    try {
      await deleteImageFromClarityHeart(deleted.imageUrl);
      result.imageDeleted = true;
    } catch (err) {
      console.error('[REVIEWS] Review deleted but its ClarityHeart image could not be removed:', err.message);
      result.imageDeleted = false;
      result.imageUrl = deleted.imageUrl;
    }
  }
  res.json(result);
}));

module.exports = router;
