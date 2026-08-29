const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { moveItem } = require('../lib/reorder');

// v1.1.6 Part D: FAQ entries admin CRUD. Deliberately mirrors
// routes/adminCategories.js structurally, field for field where the shape
// allows (idParamSchema/moveSchema, the create/update/delete/move route
// shape, moveItem() for reordering) -- "same list-management pattern used
// for Categories/Fields" was the explicit ask, and matching an existing,
// already-battle-tested pattern exactly is safer than inventing a new one
// for what is, structurally, the same kind of admin list (a simple
// orderable table with an active/inactive flag and no more than a couple
// of text fields per row).
//
// No slug here (unlike categories/website types) -- an FAQ entry has no
// public URL of its own to need one for; it only ever appears embedded in
// the homepage's 'faq' landing section and its own FAQPage JSON-LD entry
// (see routes/public.js), neither of which links to a question
// individually.

const router = express.Router();
router.use(requireAdminSession);

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const moveSchema = z.object({ direction: z.enum(['up', 'down']) });

function formatFaqEntry(f) {
  return {
    id: f.id,
    question: f.question,
    answer: f.answer,
    displayOrder: f.display_order,
    isActive: f.is_active
  };
}

// Length caps are this version's own reasonable defensive ceiling (same
// role z.string().max(...) plays everywhere else in this app -- a sanity
// backstop against pathological input, not a UX-driven display limit the
// way v1.1.6 Part E's website-type/category description limit is). A
// visible FAQ question/answer has no hard "must fit in a card" layout
// constraint the way a teaser card's description does (see
// lib/landingSectionTypes.js's faq.ejs — questions stack in a plain list,
// each answer only visible once expanded), so no character-counter UI was
// added for these two fields.
const createFaqSchema = z.object({
  question: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(2000)
});

const updateFaqSchema = z.object({
  question: z.string().trim().min(1).max(300).optional(),
  answer: z.string().trim().min(1).max(2000).optional(),
  isActive: z.boolean().optional()
});

router.get('/', asyncHandler(async (req, res) => {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM faq_entries ORDER BY display_order ASC, id ASC');
  res.json(result.rows.map(formatFaqEntry));
}));

router.post('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = createFaqSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'question and answer are required' });
  }
  const { question, answer } = parsed.data;

  const pool = getPool();
  const maxOrderResult = await pool.query('SELECT COALESCE(MAX(display_order), 0) AS max_order FROM faq_entries');
  const nextOrder = Number(maxOrderResult.rows[0].max_order) + 1;

  const result = await pool.query(
    `INSERT INTO faq_entries (question, answer, display_order) VALUES ($1, $2, $3) RETURNING *`,
    [question, answer, nextOrder]
  );
  res.status(201).json(formatFaqEntry(result.rows[0]));
}));

router.put('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid FAQ entry id' });
  }
  const bodyParsed = updateFaqSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  const { id } = paramsParsed.data;
  const { question, answer, isActive } = bodyParsed.data;

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM faq_entries WHERE id = $1', [id]);
  if (existing.rowCount === 0) {
    return res.status(404).json({ error: 'FAQ entry not found' });
  }
  const current = existing.rows[0];

  const next = {
    question: question !== undefined ? question : current.question,
    answer: answer !== undefined ? answer : current.answer,
    is_active: isActive !== undefined ? isActive : current.is_active
  };

  const result = await pool.query(
    `UPDATE faq_entries SET question = $1, answer = $2, is_active = $3 WHERE id = $4 RETURNING *`,
    [next.question, next.answer, next.is_active, id]
  );
  res.json(formatFaqEntry(result.rows[0]));
}));

router.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid FAQ entry id' });
  }
  const { id } = parsed.data;

  const pool = getPool();
  const result = await pool.query('DELETE FROM faq_entries WHERE id = $1 RETURNING id', [id]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'FAQ entry not found' });
  }
  res.json({ success: true });
}));

router.put('/:id/move', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  const bodyParsed = moveSchema.safeParse(req.body);
  if (!idParsed.success || !bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const result = await moveItem(getPool(), 'faq_entries', idParsed.data.id, bodyParsed.data.direction);
  if (result.error === 'not_found') {
    return res.status(404).json({ error: 'FAQ entry not found' });
  }
  if (result.error === 'no_neighbor') {
    return res.status(200).json({ success: true }); // already at the end — no-op, not an error
  }
  res.json({ success: true });
}));

module.exports = router;
