'use strict';

/**
 * v1.2.4 (Chunk B: Analytics foundation): aggregation queries backing
 * /api/admin/analytics/*, kept framework-free like lib/deploymentQueries.js
 * so it can be tested directly against a real Postgres.
 *
 * CORE RULE: every number here comes from a Postgres GROUP BY / aggregate,
 * never from loading rows into Node and reducing them in JS. At HeartCode's
 * current scale that distinction is invisible; at 100k+ deployments it's
 * the difference between an endpoint that costs a few milliseconds and one
 * that streams tens of thousands of rows over the wire just to add them up.
 *
 * DATE RANGES: `from` is inclusive, `to` is EXCLUSIVE, exactly like
 * lib/deploymentQueries.js -- computed by the browser in its own timezone
 * and sent as absolute instants, never guessed at server-side. Omitting
 * both means "all time".
 *
 * PREVIOUS-PERIOD COMPARISON: only meaningful when the caller gives an
 * explicit, bounded window (both `from` and `to`). The previous period is
 * simply the same DURATION immediately before `from` -- not a calendar-
 * aware "same period last year". For a custom or partial-year range that
 * is the only comparison that always makes sense; it does mean "This
 * year" compares against an equal number of days ending on last Dec 31,
 * not literally last year's Jan 1 - today. "All time" has no previous
 * period by definition (there's nothing before it to compare against).
 *
 * GRANULARITY: 'auto' picks a bucket size from the range's span so a
 * 3-day range doesn't render as one bar and a 3-year range doesn't render
 * as a thousand. Buckets are zero-filled (a day with no deployments is a
 * real 0, not a missing point) via a generate_series CTE left-joined to
 * the aggregate -- otherwise a chart would visually skip gaps instead of
 * dropping to zero. An explicit granularity that would produce more than
 * MAX_BUCKETS points for the resolved range is silently coarsened rather
 * than rejected or allowed to build an enormous series (e.g. someone
 * requesting hourly buckets over a 3-year all-time range).
 */

const { z } = require('zod');

const MAX_BUCKETS = 800;
const GRANULARITIES = ['hour', 'day', 'week', 'month'];
// Nominal milliseconds per unit -- only used to pick/cap a bucket count,
// never for the actual bucketing (that's DATE_TRUNC/generate_series in SQL,
// which is calendar-correct for weeks/months/DST).
const NOMINAL_MS = { hour: 3.6e6, day: 8.64e7, week: 6.048e8, month: 2.628e9 };

function emptyToUndefined(v) {
  return v === '' || v === null ? undefined : v;
}

const rangeSchema = z.object({
  from: z.preprocess(emptyToUndefined, z.iso.datetime({ offset: true }).optional()),
  to: z.preprocess(emptyToUndefined, z.iso.datetime({ offset: true }).optional()),
  tz: z.preprocess(emptyToUndefined, z.string().min(1).max(100).optional().default('UTC'))
});

const seriesQuerySchema = rangeSchema.extend({
  granularity: z.preprocess(emptyToUndefined, z.enum([...GRANULARITIES, 'auto']).optional().default('auto'))
});

const breakdownQuerySchema = rangeSchema.extend({
  sort: z.preprocess(emptyToUndefined, z.enum(['deployments', 'revenue']).optional().default('deployments'))
});

function validateRange(filters) {
  if (filters.from && filters.to && new Date(filters.from) >= new Date(filters.to)) {
    return 'from must be earlier than to';
  }
  return null;
}

/**
 * Resolves the effective [from, to) window for a request. When the caller
 * gave explicit bounds, those are returned as-is (and can be used directly
 * as SQL WHERE bounds -- `hasExplicitBounds: true`). When neither was
 * given ("all time"), the actual min/max deployed_at is fetched so callers
 * that need concrete instants (e.g. to build a bucketed series) have
 * something to generate_series between; `hasExplicitBounds: false` tells
 * the caller not to add a WHERE clause for these fields, since bounding by
 * the exact min/max of the data would be a no-op filter, not "all time"
 * semantics (a row inserted between the query's two steps would be
 * silently excluded from an aggregate but should appear in a live reload).
 */
async function resolveRange(pool, filters) {
  if (filters.from || filters.to) {
    return {
      from: filters.from ? new Date(filters.from) : null,
      to: filters.to ? new Date(filters.to) : null,
      hasExplicitBounds: true
    };
  }
  const result = await pool.query('SELECT MIN(deployed_at) AS min, MAX(deployed_at) AS max FROM deployed_sites');
  const { min, max } = result.rows[0];
  return {
    from: min || null,
    to: max ? new Date(new Date(max).getTime() + 1000) : null, // +1s so the max row's own instant is < to
    hasExplicitBounds: false,
    isEmpty: !min
  };
}

/** The previous period is the same duration immediately before `from`. Null unless both bounds are explicit. */
function previousPeriod(filters) {
  if (!filters.from || !filters.to) return null;
  const from = new Date(filters.from);
  const to = new Date(filters.to);
  const durationMs = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - durationMs), to: from };
}

function pctChange(current, previous) {
  if (previous === 0) return current > 0 ? null : 0; // "null" reads as "new" client-side, not a divide-by-zero
  return ((current - previous) / previous) * 100;
}

/**
 * Auto-picks a granularity from a span, or coarsens an explicit choice
 * that would otherwise produce more than MAX_BUCKETS points.
 */
function resolveGranularity(requested, from, to) {
  const spanMs = (to ? to.getTime() : Date.now()) - (from ? from.getTime() : Date.now() - NOMINAL_MS.day);
  if (requested === 'auto') {
    if (spanMs <= 2 * NOMINAL_MS.day) return 'hour';
    if (spanMs <= 92 * NOMINAL_MS.day) return 'day';
    if (spanMs <= 731 * NOMINAL_MS.day) return 'week';
    return 'month';
  }
  let g = requested;
  let i = GRANULARITIES.indexOf(g);
  while (i < GRANULARITIES.length - 1 && spanMs / NOMINAL_MS[g] > MAX_BUCKETS) {
    i += 1;
    g = GRANULARITIES[i];
  }
  return g;
}

const INTERVAL_LITERAL = { hour: '1 hour', day: '1 day', week: '1 week', month: '1 month' };

/**
 * One zero-filled time series: deployments AND revenue per bucket in a
 * single query (both metrics are read from the same aggregate, so serving
 * them from two API routes -- see routes/adminAnalytics.js -- costs one
 * query, not two). `granularity` is only ever one of GRANULARITIES (an
 * enum, never raw user text), so splicing INTERVAL_LITERAL[granularity]
 * into the query string below is safe -- it can't be anything other than
 * one of the four literal strings in that table.
 */
async function fetchSeries(pool, filters, granularity) {
  const range = await resolveRange(pool, filters);
  if (range.isEmpty || !range.from) {
    return { granularity, series: [], totalDeployments: 0, totalRevenueUsd: 0 };
  }
  const resolvedGranularity = resolveGranularity(granularity, range.from, range.to);
  const interval = INTERVAL_LITERAL[resolvedGranularity];
  const params = [range.from, range.to, filters.tz];

  const result = await pool.query(
    `WITH bucket_range AS (
       SELECT generate_series(
         date_trunc($4, $1::timestamptz AT TIME ZONE $3),
         date_trunc($4, ($2::timestamptz - interval '1 microsecond') AT TIME ZONE $3),
         interval '${interval}'
       ) AS bucket
     ),
     agg AS (
       SELECT date_trunc($4, deployed_at AT TIME ZONE $3) AS bucket,
              COUNT(*) AS deployments,
              COALESCE(SUM(COALESCE(charge_amount_usd, amount_kes)), 0) AS revenue_usd
       FROM deployed_sites
       WHERE deployed_at >= $1::timestamptz AND deployed_at < $2::timestamptz
       GROUP BY 1
     )
     SELECT b.bucket, COALESCE(a.deployments, 0) AS deployments, COALESCE(a.revenue_usd, 0) AS revenue_usd
     FROM bucket_range b
     LEFT JOIN agg a ON a.bucket = b.bucket
     ORDER BY b.bucket ASC`,
    [...params, resolvedGranularity]
  );

  let totalDeployments = 0;
  let totalRevenueUsd = 0;
  const series = result.rows.map(row => {
    totalDeployments += Number(row.deployments);
    totalRevenueUsd += Number(row.revenue_usd);
    return {
      // bucket is the LOCAL wall-clock instant (already shifted by the
      // requested tz above); re-labelling it "Z" reflects that shift
      // rather than re-converting it, so the browser displays it verbatim.
      bucket: new Date(row.bucket).toISOString(),
      deployments: Number(row.deployments),
      revenueUsd: Number(row.revenue_usd)
    };
  });
  return { granularity: resolvedGranularity, series, totalDeployments, totalRevenueUsd };
}

/**
 * Builds a `COUNT(*) FILTER (WHERE col >= $n AND col < $m) AS alias`
 * fragment (omitting whichever bound is absent), pushing its values onto
 * `params` and returning the SQL fragment as text. Every value reaching
 * the query is a bound parameter -- the only thing built as a string is
 * the placeholder numbering, never a value.
 */
function countFilter(col, from, to, alias, params) {
  const parts = [];
  if (from) { params.push(from); parts.push(`${col} >= $${params.length}::timestamptz`); }
  if (to) { params.push(to); parts.push(`${col} < $${params.length}::timestamptz`); }
  return parts.length ? `COUNT(*) FILTER (WHERE ${parts.join(' AND ')}) AS ${alias}` : `COUNT(*) AS ${alias}`;
}
function sumFilter(col, from, to, alias, params) {
  const parts = [];
  if (from) { params.push(from); parts.push(`${col} >= $${params.length}::timestamptz`); }
  if (to) { params.push(to); parts.push(`${col} < $${params.length}::timestamptz`); }
  const sumExpr = `SUM(COALESCE(charge_amount_usd, amount_kes))`;
  return parts.length
    ? `COALESCE(${sumExpr} FILTER (WHERE ${parts.join(' AND ')}), 0) AS ${alias}`
    : `COALESCE(${sumExpr}, 0) AS ${alias}`;
}

/**
 * Overview: current-period deployments/revenue/new-subscribers, plus the
 * previous period's equivalents when the caller gave explicit bounds.
 */
async function fetchOverview(pool, filters) {
  const prev = previousPeriod(filters);

  const depParams = [];
  const depSql = [
    countFilter('deployed_at', filters.from, filters.to, 'deployments', depParams),
    sumFilter('deployed_at', filters.from, filters.to, 'revenue_usd', depParams)
  ];
  if (prev) {
    depSql.push(countFilter('deployed_at', prev.from, prev.to, 'prev_deployments', depParams));
    depSql.push(sumFilter('deployed_at', prev.from, prev.to, 'prev_revenue_usd', depParams));
  }
  const depResult = await pool.query(`SELECT ${depSql.join(', ')} FROM deployed_sites`, depParams);
  const depRow = depResult.rows[0];

  const subParams = [];
  const subSql = [countFilter('first_seen_at', filters.from, filters.to, 'new_subscribers', subParams)];
  if (prev) subSql.push(countFilter('first_seen_at', prev.from, prev.to, 'prev_new_subscribers', subParams));
  const subResult = await pool.query(`SELECT ${subSql.join(', ')} FROM subscriber_emails`, subParams);
  const subRow = subResult.rows[0];

  const current = {
    deployments: Number(depRow.deployments),
    revenueUsd: Number(depRow.revenue_usd),
    newSubscribers: Number(subRow.new_subscribers)
  };
  let previous = null;
  let change = null;
  if (prev) {
    previous = {
      deployments: Number(depRow.prev_deployments),
      revenueUsd: Number(depRow.prev_revenue_usd),
      newSubscribers: Number(subRow.prev_new_subscribers)
    };
    change = {
      deploymentsPct: pctChange(current.deployments, previous.deployments),
      revenuePct: pctChange(current.revenueUsd, previous.revenueUsd),
      newSubscribersPct: pctChange(current.newSubscribers, previous.newSubscribers)
    };
  }
  return { current, previous, change };
}

/**
 * Deployments/revenue by website type for the given range, including
 * types with zero deployments in that range (an admin comparing types
 * needs to see the zero, not have the row silently disappear).
 */
async function fetchWebsiteTypeBreakdown(pool, filters, sort) {
  const clauses = [];
  const params = [];
  if (filters.from) { params.push(filters.from); clauses.push(`ds.deployed_at >= $${params.length}::timestamptz`); }
  if (filters.to) { params.push(filters.to); clauses.push(`ds.deployed_at < $${params.length}::timestamptz`); }
  const joinCondition = ['ds.website_type_id = wt.id', ...clauses].join(' AND ');
  const orderCol = sort === 'revenue' ? 'revenue_usd' : 'deployments';

  const result = await pool.query(
    `SELECT wt.id, wt.name, wt.slug, wt.is_active,
            COUNT(ds.id) AS deployments,
            COALESCE(SUM(COALESCE(ds.charge_amount_usd, ds.amount_kes)), 0) AS revenue_usd
     FROM website_types wt
     LEFT JOIN deployed_sites ds ON ${joinCondition}
     GROUP BY wt.id, wt.name, wt.slug, wt.is_active
     ORDER BY ${orderCol} DESC, wt.name ASC`,
    params
  );
  return result.rows.map(r => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    isActive: r.is_active,
    deployments: Number(r.deployments),
    revenueUsd: Number(r.revenue_usd)
  }));
}

module.exports = {
  MAX_BUCKETS,
  GRANULARITIES,
  rangeSchema,
  seriesQuerySchema,
  breakdownQuerySchema,
  validateRange,
  resolveRange,
  previousPeriod,
  pctChange,
  resolveGranularity,
  fetchSeries,
  fetchOverview,
  fetchWebsiteTypeBreakdown
};
