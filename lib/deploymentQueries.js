'use strict';

/**
 * v1.2.3 (Deployment Center): everything the admin Deployments page needs
 * to read deployed_sites at scale, kept framework-free (no Express) so it
 * can be tested directly against a real Postgres.
 *
 * WHY KEYSET (CURSOR) PAGINATION INSTEAD OF LIMIT/OFFSET
 * `ORDER BY deployed_at DESC LIMIT 20 OFFSET 10000` makes Postgres walk and
 * throw away 10,000 rows before returning 20, so page N costs more than
 * page N-1. Keyset pagination instead says "give me the rows strictly
 * after the last one I saw" -- `WHERE (deployed_at, id) < (last_ts, last_id)`
 * -- which an index on (deployed_at DESC, id DESC) answers by seeking
 * straight to that position, so every page costs the same regardless of
 * depth. `id` is the tie-breaker: two deployments can share a timestamp,
 * and without it one of them could be skipped or repeated at a page
 * boundary.
 *
 * The timestamp inside a cursor is carried as text formatted by Postgres
 * itself to full microsecond precision (to_char ... US), NOT as a JS Date:
 * a JS Date only holds milliseconds, and rounding a cursor's timestamp to
 * the millisecond would make the next page's comparison land in the wrong
 * place for rows that differ only in the last three digits.
 */

const { z } = require('zod');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const EXPORT_BATCH_SIZE = 1000;

// Matches exactly what CURSOR_TS_SQL below produces.
const CURSOR_TS_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_TS_SQL = `to_char(ds.deployed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function emptyToUndefined(v) {
  return v === '' || v === null ? undefined : v;
}

const filtersSchema = z.object({
  search: z.string().trim().max(200).optional().default(''),
  typeId: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  // `from` is inclusive and `to` is EXCLUSIVE, so a caller expressing
  // "all of 21 September" sends [21st 00:00, 22nd 00:00) computed in its
  // own timezone -- the server never has to guess the admin's timezone.
  from: z.preprocess(emptyToUndefined, z.iso.datetime({ offset: true }).optional()),
  to: z.preprocess(emptyToUndefined, z.iso.datetime({ offset: true }).optional()),
  sort: z.enum(['newest', 'oldest']).optional().default('newest')
});

const listQuerySchema = filtersSchema.extend({
  limit: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT)),
  cursor: z.preprocess(emptyToUndefined, z.string().max(300).optional())
});

function validateRange(filters) {
  if (filters.from && filters.to && new Date(filters.from) >= new Date(filters.to)) {
    return 'from must be earlier than to';
  }
  return null;
}

/** Escapes LIKE/ILIKE wildcards so a search for "50%" or "a_b" is literal. */
function escapeLike(term) {
  return term.replace(/[\\%_]/g, '\\$&');
}

function encodeCursor(tsText, id, sort) {
  return Buffer.from(JSON.stringify({ t: tsText, i: id, s: sort }), 'utf8').toString('base64url');
}

/** Returns { ts, id } or null if the token is malformed/tampered/for another sort. */
function decodeCursor(token, sort) {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed.t !== 'string' || !CURSOR_TS_REGEX.test(parsed.t) ||
      !Number.isInteger(parsed.i) || parsed.i < 1 || parsed.i > 2147483647 ||
      parsed.s !== sort
    ) {
      return null;
    }
    return { ts: parsed.t, id: parsed.i };
  } catch (_err) {
    return null;
  }
}

/** Builds the filter-only WHERE clauses (no cursor) plus their parameters. */
function buildFilterWhere(filters) {
  const clauses = [];
  const params = [];
  if (filters.search) {
    params.push(`%${escapeLike(filters.search)}%`);
    const n = params.length;
    clauses.push(`(ds.client_email ILIKE $${n} OR ds.reference ILIKE $${n} OR ds.site_url ILIKE $${n})`);
  }
  if (filters.typeId) {
    params.push(filters.typeId);
    clauses.push(`ds.website_type_id = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    clauses.push(`ds.deployed_at >= $${params.length}::timestamptz`);
  }
  if (filters.to) {
    params.push(filters.to);
    clauses.push(`ds.deployed_at < $${params.length}::timestamptz`);
  }
  return { clauses, params };
}

const SELECT_COLUMNS = `
  ds.id, ds.reference, ds.client_email, ds.site_url, ds.deployed_slug, ds.has_password,
  ds.amount_kes, ds.charge_currency, ds.charge_amount, ds.charge_amount_usd, ds.deployed_at,
  ${CURSOR_TS_SQL} AS deployed_at_cursor,
  wt.id AS website_type_id, wt.name AS website_type_name, wt.slug AS website_type_slug`;

/**
 * One keyset page. Returns { rows, nextCursor }. Fetches limit+1 rows so
 * "is there another page" needs no second query.
 */
async function fetchPage(pool, filters, { limit, cursor }) {
  const { clauses, params } = buildFilterWhere(filters);
  const desc = filters.sort !== 'oldest';

  if (cursor) {
    params.push(cursor.ts, cursor.id);
    clauses.push(`(ds.deployed_at, ds.id) ${desc ? '<' : '>'} ($${params.length - 1}::timestamptz, $${params.length}::int)`);
  }

  params.push(limit + 1);
  const dir = desc ? 'DESC' : 'ASC';
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS}
     FROM deployed_sites ds
     LEFT JOIN website_types wt ON wt.id = ds.website_type_id
     ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
     ORDER BY ds.deployed_at ${dir}, ds.id ${dir}
     LIMIT $${params.length}`,
    params
  );

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor: hasMore && last ? encodeCursor(last.deployed_at_cursor, last.id, filters.sort) : null
  };
}

/**
 * Count + revenue for a filter set. Called once per filter change (the
 * first page) rather than on every page, since an exact COUNT(*) has to
 * visit every matching row -- cheap for a filtered view, but pointless to
 * repeat while someone is just paging through the same result set.
 */
async function fetchSummary(pool, filters) {
  const { clauses, params } = buildFilterWhere(filters);
  const result = await pool.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(COALESCE(ds.charge_amount_usd, ds.amount_kes)), 0) AS revenue_usd
     FROM deployed_sites ds
     ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}`,
    params
  );
  return { total: Number(result.rows[0].total), revenueUsd: Number(result.rows[0].revenue_usd) };
}

async function fetchOne(pool, reference) {
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS}
     FROM deployed_sites ds
     LEFT JOIN website_types wt ON wt.id = ds.website_type_id
     WHERE ds.reference = $1`,
    [reference]
  );
  return result.rows[0] || null;
}

/**
 * The same amount rules the dashboard has used since v1.0.6: charge_* is the
 * real amount charged (null for older rows); amountUsd is the unified
 * USD-equivalent (charge_amount_usd, else the legacy amount_kes figure that
 * was numerically already USD) used for revenue regardless of era.
 */
function mapDeployment(row) {
  return {
    reference: row.reference,
    clientEmail: row.client_email,
    siteUrl: row.site_url,
    deployedSlug: row.deployed_slug,
    hasPassword: !!row.has_password,
    websiteTypeId: row.website_type_id,
    websiteTypeName: row.website_type_name,
    websiteTypeSlug: row.website_type_slug,
    chargeCurrency: row.charge_currency,
    chargeAmount: row.charge_amount !== null ? Number(row.charge_amount) : null,
    amountUsd: row.charge_amount_usd !== null
      ? Number(row.charge_amount_usd)
      : (row.amount_kes !== null ? Number(row.amount_kes) : null),
    deployedAt: row.deployed_at
  };
}

/** Yields batches of rows for the whole filtered set, one keyset page at a time. */
async function* iterateAll(pool, filters, batchSize = EXPORT_BATCH_SIZE) {
  let cursor = null;
  for (;;) {
    const { rows, nextCursor } = await fetchPage(pool, filters, { limit: batchSize, cursor });
    if (rows.length > 0) yield rows;
    if (!nextCursor) return;
    cursor = decodeCursor(nextCursor, filters.sort);
  }
}

// ---- CSV ----

/**
 * Cells that start with = + - @ (or a tab/CR) are interpreted as formulas by
 * Excel/Sheets. client_email is typed by the public at checkout, so an
 * export opened in a spreadsheet must not let it execute anything; the
 * standard mitigation (OWASP "CSV injection") is a leading apostrophe.
 */
function csvText(value) {
  let str = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function csvPlain(value) {
  return value == null ? '' : String(value);
}

const CSV_HEADER = [
  'reference', 'client_email', 'website_type', 'site_url', 'deployed_slug',
  'charge_currency', 'charge_amount', 'amount_usd', 'has_password', 'deployed_at'
].join(',');

function csvLine(d) {
  return [
    csvText(d.reference),
    csvText(d.clientEmail),
    csvText(d.websiteTypeName),
    csvText(d.siteUrl),
    csvText(d.deployedSlug),
    csvPlain(d.chargeCurrency),
    csvPlain(d.chargeAmount),
    csvPlain(d.amountUsd),
    d.hasPassword ? 'true' : 'false',
    new Date(d.deployedAt).toISOString()
  ].join(',');
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  EXPORT_BATCH_SIZE,
  filtersSchema,
  listQuerySchema,
  validateRange,
  escapeLike,
  encodeCursor,
  decodeCursor,
  buildFilterWhere,
  fetchPage,
  fetchSummary,
  fetchOne,
  mapDeployment,
  iterateAll,
  csvText,
  CSV_HEADER,
  csvLine
};
