// The figures of the admin dashboard (GET /api/v1/sites/:id/insights and GET /api/v1/insights/overview): the daily
// series, the totals and the top groups of the imported Search Console and GA4 rows, read in one D1 batch. Only the
// rows of the current properties are read, as in the MCP tools.
import type {
  InsightsCoverage,
  InsightsMemo,
  InsightsOverview,
  InsightsResponse,
  SearchRow,
  SearchTotals,
  SessionRow,
  SessionTotals,
} from "./api/types";
import type { SiteRow } from "./db/schema";
import type { ArticleRow } from "./db/schema";
import { SEARCH_CONSOLE_TIME_ZONE } from "./sync/consumer";
import { addDays, datesBetween, isValidDate, todayUtc } from "./sync/dates";
import { aggregateStatement, coverageStatement, type MetricValues, type Period } from "./sync/queries";

export const INSIGHTS_DAYS_DEFAULT = 28;
export const INSIGHTS_DAYS_MAX = 180;
const TOP_LIMIT = 10;
const MEMO_PINS_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const SEARCH_METRICS = [
  { name: "clicks", expr: "clicks" },
  { name: "impressions", expr: "impressions" },
  { name: "weighted_position", expr: "position * impressions" },
];
const SESSION_METRICS = [
  { name: "sessions", expr: "sessions" },
  { name: "engaged_sessions", expr: "engaged_sessions" },
  { name: "key_events", expr: "key_events" },
];

function ratio(numerator: number, denominator: number, digits: number): number | null {
  if (denominator === 0) return null;
  const scale = 10 ** digits;
  return Math.round((numerator / denominator) * scale) / scale;
}

function searchTotals(values: MetricValues): SearchTotals {
  const clicks = values.clicks ?? 0;
  const impressions = values.impressions ?? 0;
  return {
    clicks,
    impressions,
    ctr: ratio(clicks, impressions, 4),
    position: ratio(values.weighted_position ?? 0, impressions, 1),
  };
}

function sessionTotals(values: MetricValues): SessionTotals {
  const sessions = values.sessions ?? 0;
  const engaged = values.engaged_sessions ?? 0;
  return {
    sessions,
    engaged_sessions: engaged,
    engagement_rate: ratio(engaged, sessions, 4),
    key_events: Math.round((values.key_events ?? 0) * 100) / 100,
  };
}

// The period of the dashboard: days days ending at end, and the same number of days just before it.
export function periodsOf(end: string, days: number): { current: Period; previous: Period } {
  const start = addDays(end, -(days - 1));
  return { current: { start, end }, previous: { start: addDays(start, -days), end: addDays(start, -1) } };
}

// The pathname of an article URL, which GA4 reports as the landing page.
function landingPageOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

// The latest day imported for the current properties of a site; null when nothing is imported.
async function latestDate(d1: D1Database, site: SiteRow): Promise<string | null> {
  const properties = [site.gscProperty, site.ga4PropertyId].filter((p): p is string => p !== null);
  if (properties.length === 0) return null;
  const row = await d1
    .prepare(
      `SELECT MAX(date) AS date FROM sync_days
      WHERE site_id = ? AND property IN (SELECT value FROM json_each(?)) AND last_succeeded_at IS NOT NULL`,
    )
    .bind(site.id, JSON.stringify(properties))
    .first<{ date: string | null }>();
  return row?.date ?? null;
}

function coverageOf(raw: ReturnType<ReturnType<typeof coverageStatement>["read"]>): InsightsCoverage {
  return {
    days: raw.days,
    available_days: raw.available_days,
    provisional_days: raw.provisional_days,
    missing_days: raw.days - raw.available_days,
    truncated_days: raw.truncated_days,
    time_zone: raw.time_zone,
  };
}

export type InsightsInput = { days: number; end: string | null; article: ArticleRow | null };

export async function getInsights(d1: D1Database, site: SiteRow, input: InsightsInput, now: number): Promise<InsightsResponse> {
  const end = input.end ?? (await latestDate(d1, site)) ?? addDays(todayUtc(now), -1);
  const { current, previous } = periodsOf(end, input.days);
  const article = input.article;
  // An article without a URL has no rows to read.
  const articleUrl = article === null ? null : article.url;
  const landingPage = articleUrl === null ? null : landingPageOf(articleUrl);
  const readSearch = site.gscProperty !== null && (article === null || articleUrl !== null);
  const readSessions = site.ga4PropertyId !== null && (article === null || landingPage !== null);

  const statements: D1PreparedStatement[] = [];
  const readers: ((rows: Record<string, unknown>[]) => void)[] = [];
  const push = (statement: D1PreparedStatement, read: (rows: Record<string, unknown>[]) => void) => {
    statements.push(statement);
    readers.push(read);
  };

  let search: InsightsResponse["search"] = null;
  if (readSearch && site.gscProperty !== null) {
    const property = site.gscProperty;
    const pageFilter = articleUrl === null ? [] : [{ sql: "page = ?", values: [articleUrl] }];
    const result: NonNullable<InsightsResponse["search"]> = {
      property,
      time_zone: SEARCH_CONSOLE_TIME_ZONE,
      daily: [],
      totals: searchTotals({}),
      previous_totals: searchTotals({}),
      pages: [],
      queries: [],
      coverage: { days: 0, available_days: 0, provisional_days: 0, missing_days: 0, truncated_days: 0, time_zone: null },
    };
    search = result;
    push(
      d1
        .prepare(
          `SELECT date, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) AS wp
          FROM gsc_page_daily WHERE site_id = ? AND property = ? AND date >= ? AND date <= ?${articleUrl === null ? "" : " AND page = ?"}
          GROUP BY date ORDER BY date`,
        )
        .bind(site.id, property, previous.start, current.end, ...(articleUrl === null ? [] : [articleUrl])),
      (rows) => {
        const byDate = new Map(rows.map((row) => [String(row.date), row]));
        const current_: MetricValues = { clicks: 0, impressions: 0, weighted_position: 0 };
        const previous_: MetricValues = { clicks: 0, impressions: 0, weighted_position: 0 };
        for (const date of datesBetween(previous.start, current.end)) {
          const row = byDate.get(date);
          const clicks = Number(row?.clicks ?? 0);
          const impressions = Number(row?.impressions ?? 0);
          const wp = Number(row?.wp ?? 0);
          const target = date >= current.start ? current_ : previous_;
          target.clicks = (target.clicks ?? 0) + clicks;
          target.impressions = (target.impressions ?? 0) + impressions;
          target.weighted_position = (target.weighted_position ?? 0) + wp;
          result.daily.push({
            date,
            clicks: row === undefined ? null : clicks,
            impressions: row === undefined ? null : impressions,
            position: row === undefined ? null : ratio(wp, impressions, 1),
          });
        }
        result.totals = searchTotals(current_);
        result.previous_totals = searchTotals(previous_);
      },
    );
    const top = (table: string, key: string, extra: { sql: string; values: unknown[] }[], assign: (rows: SearchRow[]) => void) => {
      const q = aggregateStatement(d1, {
        table,
        siteId: site.id,
        property,
        keys: [key],
        metrics: SEARCH_METRICS,
        filters: extra,
        current,
        previous,
        orderBy: "clicks",
        limit: TOP_LIMIT,
      });
      push(q.statement, (rows) =>
        assign(
          q.read(rows).rows.map((row) => {
            const values = searchTotals(row.values);
            const before = row.previous === null ? null : searchTotals(row.previous);
            return {
              key: row.keys[key] ?? "",
              ...values,
              previous_clicks: before?.clicks ?? null,
              previous_impressions: before?.impressions ?? null,
              previous_position: before?.position ?? null,
            };
          }),
        ),
      );
    };
    if (articleUrl === null) top("gsc_page_daily", "page", [], (rows) => (result.pages = rows));
    top("gsc_query_daily", "query", pageFilter, (rows) => (result.queries = rows));
    const coverage = coverageStatement(d1, {
      siteId: site.id,
      dataset: "gsc_pages",
      property,
      period: current,
      fixedTimeZone: SEARCH_CONSOLE_TIME_ZONE,
    });
    push(coverage.statement, (rows) => (result.coverage = coverageOf(coverage.read(rows))));
  }

  let sessions: InsightsResponse["sessions"] = null;
  if (readSessions && site.ga4PropertyId !== null) {
    const property = site.ga4PropertyId;
    const result: NonNullable<InsightsResponse["sessions"]> = {
      property,
      daily: [],
      totals: sessionTotals({}),
      previous_totals: sessionTotals({}),
      channels: [],
      landing_pages: [],
      coverage: { days: 0, available_days: 0, provisional_days: 0, missing_days: 0, truncated_days: 0, time_zone: null },
    };
    sessions = result;
    const pageFilter = landingPage === null ? [] : [{ sql: "landing_page = ?", values: [landingPage] }];
    push(
      d1
        .prepare(
          `SELECT date, SUM(sessions) AS sessions, SUM(engaged_sessions) AS engaged, SUM(key_events) AS key_events
          FROM ga4_landing_daily WHERE site_id = ? AND property = ? AND date >= ? AND date <= ?${landingPage === null ? "" : " AND landing_page = ?"}
          GROUP BY date ORDER BY date`,
        )
        .bind(site.id, property, previous.start, current.end, ...(landingPage === null ? [] : [landingPage])),
      (rows) => {
        const byDate = new Map(rows.map((row) => [String(row.date), row]));
        const current_: MetricValues = { sessions: 0, engaged_sessions: 0, key_events: 0 };
        const previous_: MetricValues = { sessions: 0, engaged_sessions: 0, key_events: 0 };
        for (const date of datesBetween(previous.start, current.end)) {
          const row = byDate.get(date);
          const s = Number(row?.sessions ?? 0);
          const e = Number(row?.engaged ?? 0);
          const k = Number(row?.key_events ?? 0);
          const target = date >= current.start ? current_ : previous_;
          target.sessions = (target.sessions ?? 0) + s;
          target.engaged_sessions = (target.engaged_sessions ?? 0) + e;
          target.key_events = (target.key_events ?? 0) + k;
          result.daily.push({
            date,
            sessions: row === undefined ? null : s,
            engaged_sessions: row === undefined ? null : e,
            key_events: row === undefined ? null : Math.round(k * 100) / 100,
          });
        }
        result.totals = sessionTotals(current_);
        result.previous_totals = sessionTotals(previous_);
      },
    );
    const top = (key: string, assign: (rows: SessionRow[]) => void) => {
      const q = aggregateStatement(d1, {
        table: "ga4_landing_daily",
        siteId: site.id,
        property,
        keys: [key],
        metrics: SESSION_METRICS,
        filters: pageFilter,
        current,
        previous,
        orderBy: "sessions",
        limit: TOP_LIMIT,
      });
      push(q.statement, (rows) =>
        assign(
          q.read(rows).rows.map((row) => ({
            key: row.keys[key] ?? "",
            ...sessionTotals(row.values),
            previous_sessions: row.previous === null ? null : (row.previous.sessions ?? 0),
          })),
        ),
      );
    };
    top("channel_group", (rows) => (result.channels = rows));
    if (landingPage === null) top("landing_page", (rows) => (result.landing_pages = rows));
    const coverage = coverageStatement(d1, {
      siteId: site.id,
      dataset: "ga4_landing_pages",
      property,
      period: current,
      fixedTimeZone: null,
    });
    push(coverage.statement, (rows) => (result.coverage = coverageOf(coverage.read(rows))));
  }

  // The memos around the period, for the marks on the charts. The browser places them by its own date, so a day of
  // margin is read on each side.
  const memos: InsightsMemo[] = [];
  const from = Date.parse(`${previous.start}T00:00:00Z`) - DAY_MS;
  const to = Date.parse(`${current.end}T00:00:00Z`) + 2 * DAY_MS;
  push(
    d1
      .prepare(
        `SELECT id, title, tags, created_at FROM memos WHERE site_id = ? AND created_at >= ? AND created_at < ?${
          article === null ? "" : " AND id IN (SELECT memo_id FROM memo_articles WHERE article_id = ?)"
        } ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(site.id, from, to, ...(article === null ? [] : [article.id]), MEMO_PINS_LIMIT),
    (rows) => {
      for (const row of rows) {
        let tags: string[] = [];
        try {
          const parsed: unknown = JSON.parse(String(row.tags));
          if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
        } catch {
          // Stored by the app as JSON; an unreadable value is shown without tags.
        }
        memos.push({ id: String(row.id), title: String(row.title), tags, created_at: Number(row.created_at) });
      }
    },
  );

  const results = await d1.batch<Record<string, unknown>>(statements);
  readers.forEach((read, i) => read(results[i]?.results ?? []));

  return {
    site_id: site.id,
    period: { start: current.start, end: current.end, days: input.days },
    previous_period: previous,
    article: article === null ? null : { id: article.id, title: article.title, url: article.url },
    search,
    sessions,
    memos,
  };
}

// The daily clicks and sessions of every site over the last days days, for the list of sites. Two statements for
// every site together.
export async function getOverview(d1: D1Database, rows: SiteRow[], days: number, now: number): Promise<InsightsOverview> {
  const end = addDays(todayUtc(now), -1);
  const { current, previous } = periodsOf(end, days);
  const search = rows.filter((row) => row.gscProperty !== null).map((row) => [row.id, row.gscProperty]);
  const ga4 = rows.filter((row) => row.ga4PropertyId !== null).map((row) => [row.id, row.ga4PropertyId]);
  const [clicks, sessions] = await d1.batch<{ site_id: string; date: string; value: number }>([
    d1
      .prepare(
        `SELECT site_id, date, SUM(clicks) AS value FROM gsc_page_daily
        WHERE (site_id, property) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
          AND date >= ? AND date <= ? GROUP BY site_id, date`,
      )
      .bind(JSON.stringify(search), previous.start, current.end),
    d1
      .prepare(
        `SELECT site_id, date, SUM(sessions) AS value FROM ga4_landing_daily
        WHERE (site_id, property) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
          AND date >= ? AND date <= ? GROUP BY site_id, date`,
      )
      .bind(JSON.stringify(ga4), previous.start, current.end),
  ]);
  const dates = datesBetween(current.start, current.end);
  const series = (result: D1Result<{ site_id: string; date: string; value: number }> | undefined, siteId: string) => {
    const byDate = new Map<string, number>();
    let total = 0;
    let previousTotal = 0;
    for (const row of result?.results ?? []) {
      if (row.site_id !== siteId) continue;
      if (row.date >= current.start) {
        byDate.set(row.date, Number(row.value));
        total += Number(row.value);
      } else {
        previousTotal += Number(row.value);
      }
    }
    return { daily: dates.map((date) => byDate.get(date) ?? 0), total, previous_total: previousTotal };
  };
  return {
    period: { start: current.start, end: current.end, days },
    sites: rows.map((row) => ({
      site_id: row.id,
      clicks: row.gscProperty === null ? null : series(clicks, row.id),
      sessions: row.ga4PropertyId === null ? null : series(sessions, row.id),
    })),
  };
}

// The query of GET /:id/insights: days (1-180, default 28), end (YYYY-MM-DD, default the latest imported day) and
// article_id. null with the name of the wrong parameter.
export function checkInsightsQuery(
  query: Record<string, string>,
  now: number,
): { ok: true; days: number; end: string | null; articleId: string | null } | { ok: false; name: string } {
  let days = INSIGHTS_DAYS_DEFAULT;
  if (query.days !== undefined) {
    if (!/^[0-9]{1,3}$/.test(query.days)) return { ok: false, name: "days" };
    days = Number(query.days);
    if (days < 1 || days > INSIGHTS_DAYS_MAX) return { ok: false, name: "days" };
  }
  let end: string | null = null;
  if (query.end !== undefined) {
    if (!isValidDate(query.end) || query.end > todayUtc(now)) return { ok: false, name: "end" };
    end = query.end;
  }
  const articleId = query.article_id ?? null;
  return { ok: true, days, end, articleId };
}
