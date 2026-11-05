// Asks for imports: records the days in sync_days and sends one message per day and dataset to the sync queue
// (src/sync/consumer.ts). Also the daily cron, which imports the recent days again.

import { describeError } from "@i2bskn/workers-app-core";
import { DATASETS } from "../db/schema";
import { parseServiceAccountKey } from "../google/credentials";
import { newUlid } from "../ids";
import { addDays, todayUtc } from "./dates";

export type Dataset = (typeof DATASETS)[number];

// One page (offset, a multiple of PAGE_ROWS) of one import of a day and dataset, or the purge of pending_purges.
export type SyncMessage =
  | { kind: "sync"; siteId: string; dataset: Dataset; date: string; property: string; runId: string; offset: number }
  | { kind: "purge"; purgeId: string };

export type SyncCandidate = { siteId: string; dataset: Dataset; date: string; property: string };

export type SiteProperties = { id: string; gscProperty: string | null; ga4PropertyId: string | null };

const HOUR_MS = 60 * 60 * 1000;
// Messages are kept in the queue for 24 hours; a day queued longer ago has lost its message.
export const QUEUE_RETENTION_MS = 24 * HOUR_MS;
// A running import whose heartbeat is older than this has stopped. Much longer than the retry delays (about 31
// minutes in total) and the time messages wait in the queue.
export const STALE_RUNNING_MS = 6 * HOUR_MS;
// Queues accept up to 100 messages per sendBatch.
const SEND_BATCH_SIZE = 100;
// 6 bound values per row and 3 for the conditions, within D1's limit of 100 per statement.
const UPSERT_ROWS_PER_STATEMENT = 16;
// Purges whose message was sent longer ago than this are sent again by the cron.
const PURGE_RESEND_MS = 6 * HOUR_MS;
const PURGE_RESEND_LIMIT = 100;
// The cron imports the last 7 days, and the provisional and failed days of the last 30.
const DAILY_RECENT_DAYS = 7;
const DAILY_RETRY_DAYS = 30;

export const ENQUEUE_FAILED_MESSAGE = "取り込みを依頼できませんでした";

// Sending to the queue failed. sent is the number of messages sent before the failure.
export class EnqueueError extends Error {
  readonly sent: number;

  constructor(sent: number, options?: { cause?: unknown }) {
    super("enqueueing the import failed", options);
    this.name = "EnqueueError";
    this.sent = sent;
  }
}

// The property of the dataset, or null if the site has none.
export function propertyOf(site: SiteProperties, dataset: Dataset): string | null {
  return dataset === "ga4_landing_pages" ? site.ga4PropertyId : site.gscProperty;
}

// The datasets that the site imports: gsc_pages and gsc_queries with a Search Console property, ga4_landing_pages
// with a GA4 property.
export function datasetsOf(site: SiteProperties): Dataset[] {
  return DATASETS.filter((dataset) => propertyOf(site, dataset) !== null);
}

type Queued = { site_id: string; dataset: Dataset; date: string; property: string; run_id: string };

// Records the candidates as queued and sends their first messages. A day already in sync_days is asked for again
// only if its property changed, it failed, it succeeded with provisional data (or force), its message expired
// (queued longer than QUEUE_RETENTION_MS) or its import stopped (running without a heartbeat for STALE_RUNNING_MS).
// The last_* columns are kept. Returns the number of days and datasets asked for. Throws EnqueueError if sending
// failed: the days not sent are recorded as failed (enqueue_failed).
export async function enqueueSync(
  db: D1Database,
  queue: Queue<SyncMessage>,
  candidates: SyncCandidate[],
  options: { now: number; force: boolean },
): Promise<Queued[]> {
  const { now } = options;
  const unique = new Map<string, SyncCandidate>();
  for (const candidate of candidates) unique.set(`${candidate.siteId}\n${candidate.dataset}\n${candidate.date}`, candidate);
  const list = [...unique.values()];
  if (list.length === 0) return [];

  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < list.length; i += UPSERT_ROWS_PER_STATEMENT) {
    const chunk = list.slice(i, i + UPSERT_ROWS_PER_STATEMENT);
    const values: unknown[] = [];
    for (const candidate of chunk) {
      values.push(candidate.siteId, candidate.dataset, candidate.date, candidate.property, newUlid(now), now);
    }
    values.push(options.force ? 1 : 0, now - QUEUE_RETENTION_MS, now - STALE_RUNNING_MS);
    statements.push(
      db
        .prepare(
          `INSERT INTO sync_days (site_id, dataset, date, property, status, run_id, queued_at)
          VALUES ${chunk.map(() => "(?, ?, ?, ?, 'queued', ?, ?)").join(", ")}
          ON CONFLICT (site_id, dataset, date) DO UPDATE SET
            status = 'queued', property = excluded.property, run_id = excluded.run_id, queued_at = excluded.queued_at,
            started_at = NULL, heartbeat_at = NULL, finished_at = NULL, error_code = NULL, error_message = NULL
          WHERE sync_days.property <> excluded.property
            OR sync_days.status = 'failed'
            OR (sync_days.status = 'succeeded' AND (sync_days.last_data_state = 'provisional' OR ? = 1))
            OR (sync_days.status = 'queued' AND sync_days.queued_at < ?)
            OR (sync_days.status = 'running' AND sync_days.heartbeat_at < ?)
          RETURNING site_id, dataset, date, property, run_id`,
        )
        .bind(...values),
    );
  }
  const results = await db.batch<Queued>(statements);
  const queued = results.flatMap((result) => result.results);

  for (let i = 0; i < queued.length; i += SEND_BATCH_SIZE) {
    const chunk = queued.slice(i, i + SEND_BATCH_SIZE);
    try {
      await queue.sendBatch(
        chunk.map((row) => ({
          body: {
            kind: "sync",
            siteId: row.site_id,
            dataset: row.dataset,
            date: row.date,
            property: row.property,
            runId: row.run_id,
            offset: 0,
          } satisfies SyncMessage,
        })),
      );
    } catch (error) {
      const unsent = queued.slice(i);
      await db.batch(
        unsent.map((row) =>
          db
            .prepare(
              `UPDATE sync_days SET status = 'failed', error_code = 'enqueue_failed', error_message = ?, finished_at = ?
              WHERE site_id = ? AND dataset = ? AND date = ? AND run_id = ? AND status = 'queued'`,
            )
            .bind(ENQUEUE_FAILED_MESSAGE, now, row.site_id, row.dataset, row.date, row.run_id),
        ),
      );
      throw new EnqueueError(i, { cause: error });
    }
  }
  return queued;
}

export type DailySyncDeps = {
  db: D1Database;
  queue: Queue<SyncMessage>;
  now: number;
  serviceAccountKey: string | undefined;
};

type SiteRecord = { id: string; gsc_property: string | null; ga4_property_id: string | null };

// Sends the purge messages of pending_purges that were never sent or were sent more than PURGE_RESEND_MS ago.
async function resendPurges(deps: DailySyncDeps): Promise<void> {
  try {
    const { results } = await deps.db
      .prepare(
        `UPDATE pending_purges SET attempted_at = ?
        WHERE id IN (
          SELECT id FROM pending_purges WHERE attempted_at IS NULL OR attempted_at < ? ORDER BY created_at LIMIT ?
        )
        RETURNING id`,
      )
      .bind(deps.now, deps.now - PURGE_RESEND_MS, PURGE_RESEND_LIMIT)
      .all<{ id: string }>();
    if (results.length === 0) return;
    await deps.queue.sendBatch(results.map((row) => ({ body: { kind: "purge", purgeId: row.id } satisfies SyncMessage })));
  } catch (error) {
    console.error("resending purges failed", describeError(error));
  }
}

// The daily cron: imports the last 7 days of every site, and the days of the 30 days before yesterday that are
// provisional, failed, stopped or whose message expired; then sends the purges again. A fixed number of D1 queries
// (at most 5) regardless of the number of sites.
export async function runDailySync(deps: DailySyncDeps): Promise<void> {
  const { db, now } = deps;
  const account = await parseServiceAccountKey(deps.serviceAccountKey);
  if (!account.ok) {
    console.warn("daily sync skipped: google service account key", {
      error: account.error,
      reason: account.error === "invalid" ? account.reason : undefined,
    });
  } else {
    try {
      const today = todayUtc(now);
      const { results: sites } = await db
        .prepare("SELECT id, gsc_property, ga4_property_id FROM sites")
        .all<SiteRecord>();
      const { results: retries } = await db
        .prepare(
          `SELECT site_id, dataset, date, property FROM sync_days
          WHERE date >= ? AND date <= ? AND (
            last_data_state = 'provisional'
            OR status = 'failed'
            OR (status = 'running' AND heartbeat_at < ?)
            OR (status = 'queued' AND queued_at < ?)
          )`,
        )
        .bind(
          addDays(today, -DAILY_RETRY_DAYS),
          addDays(today, -(DAILY_RECENT_DAYS + 1)),
          now - STALE_RUNNING_MS,
          now - QUEUE_RETENTION_MS,
        )
        .all<{ site_id: string; dataset: Dataset; date: string; property: string }>();

      const byId = new Map<string, SiteProperties>();
      const candidates: SyncCandidate[] = [];
      for (const row of sites) {
        const site = { id: row.id, gscProperty: row.gsc_property, ga4PropertyId: row.ga4_property_id };
        byId.set(site.id, site);
        for (const dataset of datasetsOf(site)) {
          const property = propertyOf(site, dataset) as string;
          for (let n = DAILY_RECENT_DAYS; n >= 1; n--) {
            candidates.push({ siteId: site.id, dataset, date: addDays(today, -n), property });
          }
        }
      }
      // Only the days of the current property; the rows of an older property are not imported again.
      for (const row of retries) {
        const site = byId.get(row.site_id);
        const property = site ? propertyOf(site, row.dataset) : null;
        if (property === null || property === undefined || property !== row.property) continue;
        candidates.push({ siteId: row.site_id, dataset: row.dataset, date: row.date, property });
      }
      await enqueueSync(db, deps.queue, candidates, { now, force: false });
    } catch (error) {
      console.error("daily sync failed", describeError(error));
    }
  }
  await resendPurges(deps);
}
