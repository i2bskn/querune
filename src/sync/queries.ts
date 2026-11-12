// The aggregations of the imported rows for the MCP tools (src/mcp/tools.ts). Only the rows of the current property
// are read.

import type { Dataset } from "./enqueue";
import { datesBetween } from "./dates";

export type Period = { start: string; end: string };

export type Metric = {
  // The name in the result.
  name: string;
  // The SQL expression summed per group, over the columns of the table.
  expr: string;
};

export type AggregateQuery = {
  table: string;
  siteId: string;
  property: string;
  // The key columns of a group.
  keys: string[];
  metrics: Metric[];
  // Extra conditions on the rows, with their bound values.
  filters: { sql: string; values: unknown[] }[];
  current: Period;
  previous: Period | null;
  // A metric name: groups by it descending, then by the keys ascending, up to limit. null: by the keys ascending,
  // every group.
  orderBy: string | null;
  limit: number;
};

export type MetricValues = Record<string, number>;

export type AggregateRow = { keys: Record<string, string>; values: MetricValues; previous: MetricValues | null };

export type AggregateResult = {
  rows: AggregateRow[];
  // The sums over every group of the current period (0 without rows).
  totals: MetricValues;
  // The sums over every group of the previous period; null without a previous period, 0 without rows.
  previousTotals: MetricValues | null;
};

function metricColumns(metrics: Metric[], prefix: string): string[] {
  return metrics.map((_, i) => `${prefix}${i}`);
}

// The statement of an aggregation, and how to read its rows. One statement reads each period once: the totals are
// window sums over the groups, taken before LIMIT, and the previous period is joined to the top groups of the
// current period.
export function aggregateStatement(db: D1Database, q: AggregateQuery): {
  statement: D1PreparedStatement;
  read: (rows: Record<string, unknown>[]) => AggregateResult;
} {
  const keyList = q.keys.join(", ");
  const filterSql = q.filters.map((f) => ` AND ${f.sql}`).join("");
  const filterValues = q.filters.flatMap((f) => f.values);
  const where = `site_id = ? AND property = ? AND date >= ? AND date <= ?${filterSql}`;
  const whereValues = (period: Period) => [q.siteId, q.property, period.start, period.end, ...filterValues];
  const m = metricColumns(q.metrics, "m");
  const sums = q.metrics.map((metric, i) => `SUM(${metric.expr}) AS m${i}`).join(", ");
  const totals = m.map((col, i) => `SUM(${col}) OVER () AS t${i}`).join(", ");
  const keyOrder = q.keys.map((k) => `${k} ASC`).join(", ");
  const order =
    q.orderBy === null ? keyOrder : `m${q.metrics.findIndex((metric) => metric.name === q.orderBy)} DESC, ${keyOrder}`;
  const limitSql = q.orderBy === null ? "" : " LIMIT ?";
  const limitValues = q.orderBy === null ? [] : [q.limit];

  const values: unknown[] = [];
  let sql: string;
  if (q.previous === null) {
    sql = `WITH cur AS (SELECT ${keyList}, ${sums} FROM ${q.table} WHERE ${where} GROUP BY ${keyList})
      SELECT 0 AS kind, ${keyList}, ${m.join(", ")}, ${totals} FROM cur ORDER BY ${order}${limitSql}`;
    values.push(...whereValues(q.current), ...limitValues);
  } else {
    const p = metricColumns(q.metrics, "p");
    const pt = metricColumns(q.metrics, "pt");
    const nulls = (cols: string[]) => cols.map((col) => `NULL AS ${col}`).join(", ");
    const keyNulls = q.keys.map((k) => `NULL AS ${k}`).join(", ");
    const join = q.keys.map((k) => `prev.${k} = top.${k}`).join(" AND ");
    sql = `WITH cur AS (SELECT ${keyList}, ${sums} FROM ${q.table} WHERE ${where} GROUP BY ${keyList}),
      top AS (SELECT ${keyList}, ${m.join(", ")}, ${totals} FROM cur ORDER BY ${order}${limitSql}),
      prev AS MATERIALIZED (
        SELECT ${keyList}, ${q.metrics.map((metric, i) => `SUM(${metric.expr}) AS p${i}`).join(", ")},
          ${q.metrics.map((metric, i) => `SUM(SUM(${metric.expr})) OVER () AS pt${i}`).join(", ")}
        FROM ${q.table} WHERE ${where} GROUP BY ${keyList}
      )
      SELECT 0 AS kind, ${q.keys.map((k) => `top.${k} AS ${k}`).join(", ")}, ${m.map((c) => `top.${c} AS ${c}`).join(", ")},
        ${m.map((_, i) => `top.t${i} AS t${i}`).join(", ")}, ${p.map((c) => `prev.${c} AS ${c}`).join(", ")}, ${nulls(pt)}
      FROM top LEFT JOIN prev ON ${join}
      UNION ALL
      SELECT 1 AS kind, ${keyNulls}, ${nulls(m)}, ${nulls(m.map((_, i) => `t${i}`))}, ${nulls(p)}, ${pt.join(", ")}
      FROM (SELECT ${pt.join(", ")} FROM prev LIMIT 1)
      ORDER BY kind, ${order}`;
    values.push(...whereValues(q.current), ...limitValues, ...whereValues(q.previous));
  }

  const zero = () => Object.fromEntries(q.metrics.map((metric) => [metric.name, 0]));
  const read = (rows: Record<string, unknown>[]): AggregateResult => {
    const result: AggregateResult = { rows: [], totals: zero(), previousTotals: q.previous === null ? null : zero() };
    let totalsRead = false;
    for (const row of rows) {
      if (row.kind === 1) {
        result.previousTotals = Object.fromEntries(q.metrics.map((metric, i) => [metric.name, Number(row[`pt${i}`] ?? 0)]));
        continue;
      }
      if (!totalsRead) {
        result.totals = Object.fromEntries(q.metrics.map((metric, i) => [metric.name, Number(row[`t${i}`] ?? 0)]));
        totalsRead = true;
      }
      const hasPrevious = q.previous !== null && row.p0 !== null && row.p0 !== undefined;
      result.rows.push({
        keys: Object.fromEntries(q.keys.map((k) => [k, String(row[k])])),
        values: Object.fromEntries(q.metrics.map((metric, i) => [metric.name, Number(row[`m${i}`] ?? 0)])),
        previous: hasPrevious
          ? Object.fromEntries(q.metrics.map((metric, i) => [metric.name, Number(row[`p${i}`] ?? 0)]))
          : null,
      });
    }
    return result;
  };
  return { statement: db.prepare(sql).bind(...values), read };
}

export type Coverage = {
  dataset: Dataset;
  start_date: string;
  end_date: string;
  days: number;
  available_days: number;
  provisional_days: number;
  truncated_days: number;
  refreshing_days: number;
  missing_dates: string[];
  missing_dates_truncated: boolean;
  // The available days with provisional data, ascending, up to 31.
  provisional_dates: string[];
  provisional_dates_truncated: boolean;
  time_zone: string | null;
  // Only when the available days have more than one time zone.
  time_zones?: string[];
};

const MISSING_DATES_LIMIT = 31;
const PROVISIONAL_DATES_LIMIT = 31;

type CoverageRow = {
  date: string;
  status: string;
  last_succeeded_at: number | null;
  last_data_state: string | null;
  last_truncated: number | null;
  last_time_zone: string | null;
};

// The import state of the days of a period, and how to read it. fixedTimeZone is the time zone of every day of the
// dataset (Search Console); without it, the time zone of the latest successful import is used.
export function coverageStatement(
  db: D1Database,
  params: { siteId: string; dataset: Dataset; property: string; period: Period; fixedTimeZone: string | null },
): { statement: D1PreparedStatement; read: (rows: Record<string, unknown>[]) => Coverage } {
  const { period } = params;
  const statement = db
    .prepare(
      `SELECT date, status, last_succeeded_at, last_data_state, last_truncated, last_time_zone FROM sync_days
      WHERE site_id = ? AND dataset = ? AND property = ? AND date >= ? AND date <= ?`,
    )
    .bind(params.siteId, params.dataset, params.property, period.start, period.end);
  const read = (raw: Record<string, unknown>[]): Coverage => {
    const rows = raw as CoverageRow[];
    const available = rows.filter((row) => row.last_succeeded_at !== null);
    const availableDates = new Set(available.map((row) => row.date));
    const dates = datesBetween(period.start, period.end);
    const missing = dates.filter((date) => !availableDates.has(date));
    const provisional = available
      .filter((row) => row.last_data_state === "provisional")
      .map((row) => row.date)
      .sort();
    const coverage: Coverage = {
      dataset: params.dataset,
      start_date: period.start,
      end_date: period.end,
      days: dates.length,
      available_days: available.length,
      provisional_days: provisional.length,
      truncated_days: available.filter((row) => row.last_truncated === 1).length,
      refreshing_days: available.filter((row) => row.status === "queued" || row.status === "running").length,
      missing_dates: missing.slice(0, MISSING_DATES_LIMIT),
      missing_dates_truncated: missing.length > MISSING_DATES_LIMIT,
      provisional_dates: provisional.slice(0, PROVISIONAL_DATES_LIMIT),
      provisional_dates_truncated: provisional.length > PROVISIONAL_DATES_LIMIT,
      time_zone: params.fixedTimeZone,
    };
    if (params.fixedTimeZone === null) {
      let latest: CoverageRow | null = null;
      const zones = new Set<string>();
      for (const row of available) {
        if (row.last_time_zone === null) continue;
        zones.add(row.last_time_zone);
        if (latest === null || (row.last_succeeded_at ?? 0) > (latest.last_succeeded_at ?? 0)) latest = row;
      }
      coverage.time_zone = latest?.last_time_zone ?? null;
      if (zones.size > 1) coverage.time_zones = [...zones].sort();
    }
    return coverage;
  };
  return { statement, read };
}
