'use strict';

const { getPool } = require('../db/init');

// v1.2.12: everything that reads APPROVED reviews for public display. One
// shared SELECT so every public place (the /testimonials page, a website
// type's build page, a landing page testimonials block) applies the same
// rules.
//
// WEBSITE TYPE TITLE, worked out LIVE on every query from the deployment's
// CURRENT website type, never stored on the review:
//   - the type exists AND is active AND is not the shared "Deleted Website
//     Types" placeholder  -> its name and slug are returned (a link)
//   - anything else (inactive, deleted and re-pointed at the placeholder,
//     or the deployment record itself gone)  -> NULL name and NULL slug, and
//     the view shows "Discontinued" with no link.
// The CASE expressions mean a deleted or inactive type's name never even
// leaves the database, so it cannot leak by a view mistake. The website
// types for a whole page of reviews come from the one LEFT JOIN below, never
// one query per review.
//
// No aggregate (average, count shown as a rating, etc.) is computed here or
// anywhere else; each review carries only its own rating.

const PUBLIC_REVIEW_SELECT = `
  SELECT r.id, r.reviewer_name, r.rating, r.testimonial, r.image_url, r.approved_at,
         CASE WHEN wt.is_active AND NOT wt.is_deleted_placeholder THEN wt.name END AS type_name,
         CASE WHEN wt.is_active AND NOT wt.is_deleted_placeholder THEN wt.slug END AS type_slug
    FROM reviews r
    LEFT JOIN deployed_sites ds ON ds.id = r.deployed_site_id
    LEFT JOIN website_types wt ON wt.id = ds.website_type_id
`;

function toPublicReview(row) {
  const imageOk = typeof row.image_url === 'string' && /^https:\/\//i.test(row.image_url);
  return {
    id: row.id,
    name: row.reviewer_name,
    rating: row.rating,
    text: row.testimonial,
    imageUrl: imageOk ? row.image_url : null,
    typeTitle: row.type_name || null,
    typeSlug: row.type_slug || null
  };
}

/** One page of every approved review, newest approved first. */
async function listApprovedPage(page, pageSize) {
  const pool = getPool();
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const total = (await pool.query("SELECT COUNT(*)::int AS n FROM reviews WHERE status = 'approved'")).rows[0].n;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(safePage, totalPages);

  const result = await pool.query(
    `${PUBLIC_REVIEW_SELECT}
      WHERE r.status = 'approved'
      ORDER BY r.approved_at DESC NULLS LAST, r.id DESC
      LIMIT $1 OFFSET $2`,
    [pageSize, (current - 1) * pageSize]
  );
  return { reviews: result.rows.map(toPublicReview), total, totalPages, page: current };
}

/**
 * Up to `limit` reviews for one website type's build page: approved, rated 4
 * or 5, best rating first then most recent. A single indexed query.
 */
async function listTopForType(websiteTypeId, limit = 3) {
  const result = await getPool().query(
    `${PUBLIC_REVIEW_SELECT}
      WHERE r.status = 'approved' AND r.rating >= 4 AND ds.website_type_id = $1
      ORDER BY r.rating DESC, r.approved_at DESC NULLS LAST, r.id DESC
      LIMIT $2`,
    [websiteTypeId, limit]
  );
  return result.rows.map(toPublicReview);
}

/** Approved reviews picked by id (landing block references), one query. Missing or unapproved ids simply do not come back. */
async function listApprovedByIds(ids) {
  const clean = Array.from(new Set((ids || []).filter(n => Number.isInteger(n) && n > 0)));
  if (clean.length === 0) return new Map();
  const result = await getPool().query(
    `${PUBLIC_REVIEW_SELECT} WHERE r.status = 'approved' AND r.id = ANY($1::int[])`,
    [clean]
  );
  return new Map(result.rows.map(row => [row.id, toPublicReview(row)]));
}

/**
 * Resolves the review references inside landing page `testimonials` sections
 * into live review data. Works on COPIES (the landing_sections cache holds the
 * originals and must never be mutated). A reference whose review was deleted
 * (or is not approved) is dropped, so the block never shows a broken entry.
 */
async function resolveTestimonialSections(sections) {
  const ids = [];
  for (const s of sections) {
    if (s.sectionType !== 'testimonials' || !s.content || !Array.isArray(s.content.items)) continue;
    for (const item of s.content.items) {
      if (item && Number.isInteger(item.review_id)) ids.push(item.review_id);
    }
  }
  if (ids.length === 0) return sections;

  const byId = await listApprovedByIds(ids);
  return sections.map(s => {
    if (s.sectionType !== 'testimonials' || !s.content || !Array.isArray(s.content.items)) return s;
    const items = [];
    for (const item of s.content.items) {
      if (item && Number.isInteger(item.review_id)) {
        const review = byId.get(item.review_id);
        if (review) items.push({ review });
      } else {
        items.push(item);
      }
    }
    return { ...s, content: { ...s.content, items } };
  });
}

module.exports = {
  listApprovedPage,
  listTopForType,
  listApprovedByIds,
  resolveTestimonialSections,
  toPublicReview
};
