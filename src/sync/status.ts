// The import state of a site (GET /api/v1/sites/:id/sync and the get_sync_status tool).

import type { DatasetSyncStatus, SyncFailure, SyncStatus } from "../api/types";
import { DATASETS } from "../db/schema";
import { propertyOf, type Dataset, type SiteProperties } from "./enqueue";

const RECENT_FAILURES = 10;

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

// Only the days of the current property of each dataset are counted. One D1 batch.
export async function getSyncStatus(db: D1Database, site: SiteProperties): Promise<SyncStatus> {
  const gsc = site.gscProperty;
  const ga4 = site.ga4PropertyId;
  // A NULL property matches nothing.
  const currentProperty = `site_id = ? AND (
    (dataset IN ('gsc_pages', 'gsc_queries') AND property = ?) OR (dataset = 'ga4_landing_pages' AND property = ?)
  )`;
  const [summaries, failures] = await db.batch<Summary | FailureRow>([
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
  ]);
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
    };
  });
  return { site_id: site.id, datasets };
}
