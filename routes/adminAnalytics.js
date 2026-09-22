'use strict';

/**
 * v1.2.4 (Chunk B: Analytics foundation).
 *
 * These replace the time-bound parts of the old GET /api/admin/dashboard/stats
 * (total deployments/revenue, subscriber count, per-type breakdown), which
 * had grown into one route doing several unrelated things (see the v1.2.3
 * HANDOFF's "Known gaps"). /api/admin/dashboard/stats now only answers
 * "what is HeartCode's current CONFIGURATION" (Paystack set up? which AI
 * provider? how many active/inactive website types?) -- questions with no
 * time dimension. Everything with a time dimension lives here instead.
 */

const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const aq = require('../lib/analyticsQueries');
const { getPool } = require('../db/init');

const router = express.Router();
router.use(requireAdminSession);

function parseRange(req, res) {
  const parsed = aq.rangeSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return null;
  }
  const rangeError = aq.validateRange(parsed.data);
  if (rangeError) {
    res.status(400).json({ error: rangeError });
    return null;
  }
  return parsed.data;
}

router.get('/overview', asyncHandler(async (req, res) => {
  const filters = parseRange(req, res);
  if (!filters) return;
  const overview = await aq.fetchOverview(getPool(), filters);
  res.json(overview);
}));

router.get('/deployments', asyncHandler(async (req, res) => {
  const parsed = aq.seriesQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid query parameters' });
  const rangeError = aq.validateRange(parsed.data);
  if (rangeError) return res.status(400).json({ error: rangeError });
  const { granularity, series, totalDeployments } = await aq.fetchSeries(getPool(), parsed.data, parsed.data.granularity);
  res.json({
    granularity,
    totalDeployments,
    series: series.map(p => ({ bucket: p.bucket, deployments: p.deployments }))
  });
}));

router.get('/revenue', asyncHandler(async (req, res) => {
  const parsed = aq.seriesQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid query parameters' });
  const rangeError = aq.validateRange(parsed.data);
  if (rangeError) return res.status(400).json({ error: rangeError });
  const { granularity, series, totalRevenueUsd } = await aq.fetchSeries(getPool(), parsed.data, parsed.data.granularity);
  res.json({
    granularity,
    totalRevenueUsd,
    series: series.map(p => ({ bucket: p.bucket, revenueUsd: p.revenueUsd }))
  });
}));

router.get('/website-types', asyncHandler(async (req, res) => {
  const parsed = aq.breakdownQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid query parameters' });
  const rangeError = aq.validateRange(parsed.data);
  if (rangeError) return res.status(400).json({ error: rangeError });
  const types = await aq.fetchWebsiteTypeBreakdown(getPool(), parsed.data, parsed.data.sort);
  res.json({ sort: parsed.data.sort, types });
}));

module.exports = router;
