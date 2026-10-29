const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../lib/asyncHandler');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { getEmailBudget, setQuota } = require('../lib/emailBudget');

// v1.2.23: the email budget meter. The daily limit is typed in by the admin.
const router = express.Router();
router.use(requireAdminSession);

router.get('/', asyncHandler(async (req, res) => {
  res.json(await getEmailBudget());
}));

router.put('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = z.object({ quota: z.union([z.coerce.number().int().min(1).max(10000000), z.null(), z.literal('')]) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a whole number of emails per day, or leave it empty to turn the meter off.' });
  const q = parsed.data.quota;
  await setQuota(q === null || q === '' ? null : q);
  res.json(await getEmailBudget());
}));

module.exports = router;
