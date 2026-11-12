// The import state of a site (GET /api/v1/sites/:id/sync and the get_sync_status tool).

import type { DatasetSyncStatus, RecentDay, SyncFailure, SyncStatus } from "../api/types";
import { DATASETS } from "../db/schema";
import { addDays, todayUtc } from "./dates";
import { propertyOf, REFRESH_DAYS, type Dataset, type SiteProperties } from "./enqueue";
import { datasetDayOf, ga4TimeZoneKey, ga4TimeZonesStatement } from "./time-zones";

const RECENT_FAILURES = 10;
const RECENT_DAYS = 14;
// Yesterday in any time zone is between 2 days before and the day of today in UTC, so the RECENT_DAYS days to it are
// within these days around today in UTC.
const RECENT_FROM_DAYS = RECENT_DAYS + 2;
const RECENT_TO_DAYS = 1;

type Summary = {
  dataset: Dataset;
  latest_date: string | null;
  provisional_from: string | null;
  last_succeeded_at: number | null;
  available_days: number | null;
  truncated_days: number | null;
  queued: number | null;
  running: number | null;
  failed: number | null;
};

type FailureRow = SyncFailure & { dataset: Dataset };

type RecentRow = {
  dataset: Dataset;
  date: string;
  status: string;
  last_succeeded_at: number | null;
  last_data_state: string | null;
  last_row_count: number | null;
  error_code: string | null;
};

function recentDayOf(date: string, row: RecentRow | undefined): RecentDay {
  if (row === undefined) {
    return { date, state: "missing", updating: false, row_count: null, fetched_at: null, error_code: null };
  }
  const succeeded = row.last_succeeded_at !== null;
  const active = row.status === "queued" || row.status === "running";
  let state: RecentDay["state"];
  if (succeeded) state = row.last_data_state === "provisional" ? "provisional" : "final";
  else if (row.status === "failed") state = "failed";
  else if (active) state = "pending";
  else state = "missing";
  return {
    date,
    state,
    updating: succeeded && active,
    row_count: succeeded ? row.last_row_count : null,
    fetched_at: row.last_succeeded_at,
    error_code: row.status === "failed" ? row.error_code : null,
  };
}

// The day before the oldest day that is not final, the last day if every one is final, or null if the first is not.
function finalThrough(days: RecentDay[]): string | null {
  const index = days.findIndex((day) => day.state !== "final");
  if (index === -1) return days.at(-1)?.date ?? null;
  if (index === 0) return null;
  return days[index - 1]?.date ?? null;
}

// Only the days of the current property of each dataset are counted. One D1 batch.
export async function getSyncStatus(db: D1Database, site: SiteProperties, now: number): Promise<SyncStatus> {
  const gsc = site.gscProperty;
  const ga4 = site.ga4PropertyId;
  // A NULL property matches nothing.
  const currentProperty = `site_id = ? AND (
    (dataset IN ('gsc_pages', 'gsc_queries') AND property = ?) OR (dataset = 'ga4_landing_pages' AND property = ?)
  )`;
  const today = todayUtc(now);
  const zones = ga4TimeZonesStatement(db, site.id);
  const [summaries, failures, zoneRows, recentRows] = await db.batch<Summary | FailureRow | RecentRow>([
    db
      .prepare(
        `SELECT dataset,
          MAX(CASE WHEN last_succeeded_at IS NOT NULL THEN date END) AS latest_date,
          MIN(CASE WHEN last_succeeded_at IS NOT NULL AND last_data_state = 'provisional' THEN date END)
            AS provisional_from,
          MAX(last_succeeded_at) AS last_succeeded_at,
          SUM(last_succeeded_at IS NOT NULL) AS available_days,
          SUM(last_succeeded_at IS NOT NULL AND last_truncated = 1) AS truncated_days,
          SUM(status = 'queued') AS queued,
          SUM(status = 'running') AS running,
          SUM(status = 'failed') AS failed
        FROM sync_days WHERE ${currentProperty}
        GROUP BY dataset`,
      )
      .bind(site.id, gsc, ga4),
    db
      .prepare(
        `SELECT dataset, date, error_code, error_message, finished_at FROM (
          SELECT dataset, date, error_code, error_message, finished_at,
            ROW_NUMBER() OVER (PARTITION BY dataset ORDER BY finished_at DESC, date DESC) AS n
          FROM sync_days WHERE ${currentProperty} AND status = 'failed'
        ) WHERE n <= ?
        ORDER BY dataset, n`,
      )
      .bind(site.id, gsc, ga4, RECENT_FAILURES),
    zones.statement,
    db
      .prepare(
        `SELECT dataset, date, status, last_succeeded_at, last_data_state, last_row_count, error_code
        FROM sync_days WHERE ${currentProperty} AND date >= ? AND date <= ?`,
      )
      .bind(site.id, gsc, ga4, addDays(today, -RECENT_FROM_DAYS), addDays(today, RECENT_TO_DAYS)),
  ]);
  const ga4TimeZones = zones.read((zoneRows?.results ?? []) as Record<string, unknown>[]);
  const recentByDay = new Map(
    ((recentRows?.results ?? []) as RecentRow[]).map((row) => [`${row.dataset}\n${row.date}`, row]),
  );
  const byDataset = new Map((summaries?.results as Summary[] | undefined)?.map((row) => [row.dataset, row]));
  const failuresOf = (dataset: Dataset): SyncFailure[] =>
    ((failures?.results ?? []) as FailureRow[])
      .filter((row) => row.dataset === dataset)
      .map((row) => ({
        date: row.date,
        error_code: row.error_code,
        error_message: row.error_message,
        finished_at: row.finished_at,
      }));

  const datasets: DatasetSyncStatus[] = DATASETS.map((dataset) => {
    const property = propertyOf(site, dataset);
    const row = property === null ? undefined : byDataset.get(dataset);
    let freshness: Pick<
      DatasetSyncStatus,
      | "time_zone"
      | "time_zone_known"
      | "expected_latest_date"
      | "state_basis"
      | "refresh_days"
      | "recent_days"
      | "final_through"
    > = {
      time_zone: null,
      time_zone_known: false,
      expected_latest_date: null,
      state_basis: null,
      refresh_days: 0,
      recent_days: [],
      final_through: null,
    };
    if (property !== null) {
      const ga4TimeZone = dataset === "ga4_landing_pages" ? ga4TimeZones.get(ga4TimeZoneKey(site.id, property)) : null;
      const day = datasetDayOf(dataset, ga4TimeZone, now);
      const recent: RecentDay[] = [];
      for (let n = RECENT_DAYS - 1; n >= 0; n--) {
        const date = addDays(day.expectedLatestDate, -n);
        recent.push(recentDayOf(date, recentByDay.get(`${dataset}\n${date}`)));
      }
      freshness = {
        time_zone: day.timeZone,
        time_zone_known: day.timeZoneKnown,
        expected_latest_date: day.expectedLatestDate,
        state_basis: dataset === "ga4_landing_pages" ? "elapsed_days" : "api",
        refresh_days: REFRESH_DAYS[dataset],
        recent_days: recent,
        final_through: finalThrough(recent),
      };
    }
    return {
      dataset,
      configured: property !== null,
      property,
      latest_date: row?.latest_date ?? null,
      provisional_from: row?.provisional_from ?? null,
      last_succeeded_at: row?.last_succeeded_at ?? null,
      available_days: row?.available_days ?? 0,
      truncated_days: row?.truncated_days ?? 0,
      queued: row?.queued ?? 0,
      running: row?.running ?? 0,
      failed: row?.failed ?? 0,
      recent_failures: property === null ? [] : failuresOf(dataset),
      ...freshness,
    };
  });
  const configured = datasets.filter((dataset) => dataset.configured);
  let siteFinalThrough: string | null = null;
  if (configured.length > 0 && configured.every((dataset) => dataset.final_through !== null)) {
    siteFinalThrough = configured.map((dataset) => dataset.final_through as string).sort()[0] ?? null;
  }
  return { site_id: site.id, datasets, final_through: siteFinalThrough };
}
