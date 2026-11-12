// The consumers of the sync queue and of its dead letter queue (wrangler.jsonc).
//
// A sync message is one page (up to PAGE_ROWS rows) of the import of one day and dataset. Every message of an import
// carries its run_id, and every write is conditional on sync_days still holding that run_id as running with the same
// property: a message of an import that was replaced, finished, or whose site was deleted or whose property changed
// writes nothing. Rows are upserted, and the last page deletes the rows that the import did not write. An import
// that returns no rows for a day that had rows fails (empty_response) and keeps them, unless the message accepts it
// (acceptEmpty, a manual import). A purge message deletes the rows left by a deleted site or an old property, 5,000
// rows at a time. The articles_sitemap and articles_import messages are the daily article sync (src/sync/articles.ts).

import { clock, createDb, describeError, type Db } from "@i2bskn/workers-app-core";
import { DATASETS } from "../db/schema";
import { loadConfig, type Bindings } from "../env";
import { PAGE_ROWS, truncateMessage, type GoogleFailure } from "../google/api";
import { fetchLandingPage } from "../google/analytics";
import { getGoogleAccessToken } from "../google/credentials";
import { fetchSearchAnalyticsPage } from "../google/search-console";
import { SITE_ID_PATTERN, ULID_PATTERN } from "../ids";
import { normalizeArticleUrl } from "../records/validate";
import { MAX_IMPORT_URLS } from "../sitemap";
import { importArticlePages, syncArticleSitemap } from "./articles";
import { addDays, isUsableTimeZone, isValidDate, todayIn } from "./dates";
import { propertyOf, type Dataset, type SyncMessage } from "./enqueue";
import { SEARCH_CONSOLE_TIME_ZONE } from "./time-zones";

export { SEARCH_CONSOLE_TIME_ZONE };

export const SYNC_QUEUE = "querune-sync";
export const SYNC_DEAD_LETTER_QUEUE = "querune-sync-dlq";

// The rows imported for one day and dataset at most. The Search Analytics API returns up to 50,000 rows per day; the
// same limit applies to GA4.
export const MAX_ROWS_PER_DAY = 50_000;
// The rows in the JSON of one upsert statement.
const UPSERT_ROWS_PER_STATEMENT = 1000;
// The rows deleted by one purge message.
export const PURGE_ROWS_PER_MESSAGE = 5000;
// Search Console days are provisional when the API marks them incomplete; a day without rows, which the API cannot
// mark, is provisional up to 3 days ago. GA4 does not tell: its days are provisional up to 4 days ago (events arrive
// up to 2 days late and take up to 48 hours to process). Both in the time zone of the dataset.
const GSC_PROVISIONAL_DAYS = 3;
const GA4_PROVISIONAL_DAYS = 4;
const RETRY_BASE_SECONDS = 60;
const RETRY_MAX_SECONDS = 3600;
const UNEXPECTED_RETRY_SECONDS = 60;
const PURGE_RETRY_SECONDS = 300;
const DEAD_LETTER_RETRY_SECONDS = 60;
// When the configuration is invalid, messages wait for it to be fixed.
const CONFIG_RETRY_SECONDS = 300;

const ULID = new RegExp(`^${ULID_PATTERN}$`);

type ColumnType = "text" | "integer" | "real";

type DatasetTable = {
  table: string;
  // The columns after site_id, property and date, in the order of the values of a row.
  columns: [string, ColumnType][];
  // The columns among them that belong to the primary key.
  keys: string[];
};

export const DATASET_TABLES: Record<Dataset, DatasetTable> = {
  gsc_pages: {
    table: "gsc_page_daily",
    columns: [
      ["page", "text"],
      ["clicks", "integer"],
      ["impressions", "integer"],
      ["position", "real"],
    ],
    keys: ["page"],
  },
  gsc_queries: {
    table: "gsc_query_daily",
    columns: [
      ["page", "text"],
      ["query", "text"],
      ["clicks", "integer"],
      ["impressions", "integer"],
      ["position", "real"],
    ],
    keys: ["page", "query"],
  },
  ga4_landing_pages: {
    table: "ga4_landing_daily",
    columns: [
      ["landing_page", "text"],
      ["channel_group", "text"],
      ["sessions", "integer"],
      ["engaged_sessions", "integer"],
      ["key_events", "real"],
    ],
    keys: ["landing_page", "channel_group"],
  },
};

// The import of the message is still the current one: ?1 site_id, ?2 property, ?3 date, ?4 run_id, ?5 dataset.
const CURRENT_RUN = `EXISTS (
  SELECT 1 FROM sync_days
  WHERE site_id = ?1 AND dataset = ?5 AND date = ?3 AND run_id = ?4 AND property = ?2 AND status = 'running'
)`;

function selectExpression(index: number, type: ColumnType): string {
  const value = `j.value ->> ${index}`;
  if (type === "integer") return `CAST(${value} AS INTEGER)`;
  if (type === "real") return `CAST(${value} AS REAL)`;
  return value;
}

// Upserts the rows given as one JSON array (?6) of value arrays. The rows are expanded by D1 (json_each), not by the
// Worker.
function upsertSql(dataset: Dataset): string {
  const { table, columns, keys } = DATASET_TABLES[dataset];
  const names = columns.map(([name]) => name);
  const updates = [...names.filter((name) => !keys.includes(name)), "run_id"];
  return `INSERT INTO ${table} (site_id, property, date, ${names.join(", ")}, run_id)
    SELECT ?1, ?2, ?3, ${columns.map(([, type], i) => selectExpression(i, type)).join(", ")}, ?4
    FROM json_each(?6) AS j
    WHERE ${CURRENT_RUN}
    ON CONFLICT (site_id, property, date, ${keys.join(", ")}) DO UPDATE SET
      ${updates.map((name) => `${name} = excluded.${name}`).join(", ")}`;
}

type SyncDeps = {
  db: D1Database;
  // The same database through drizzle, for src/records/.
  orm: Db;
  queue: Queue<SyncMessage>;
  serviceAccountKey: string | undefined;
  fetcher: typeof fetch;
};

type SyncBody = Extract<SyncMessage, { kind: "sync" }>;

// What the message asks for, or null if it is malformed.
export function parseSyncMessage(body: unknown): SyncMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.kind === "purge") {
    return typeof record.purgeId === "string" && ULID.test(record.purgeId)
      ? { kind: "purge", purgeId: record.purgeId }
      : null;
  }
  if (record.kind === "articles_sitemap") {
    return typeof record.siteId === "string" && SITE_ID_PATTERN.test(record.siteId)
      ? { kind: "articles_sitemap", siteId: record.siteId }
      : null;
  }
  if (record.kind === "articles_import") {
    const { siteId, urls } = record;
    if (typeof siteId !== "string" || !SITE_ID_PATTERN.test(siteId)) return null;
    const parsedUrls = parseImportUrls(urls);
    return parsedUrls === null ? null : { kind: "articles_import", siteId, urls: parsedUrls };
  }
  if (record.kind !== "sync") return null;
  const { siteId, dataset, date, property, runId, offset, incomplete, acceptEmpty } = record;
  if (typeof siteId !== "string" || !SITE_ID_PATTERN.test(siteId)) return null;
  if (typeof dataset !== "string" || !(DATASETS as readonly string[]).includes(dataset)) return null;
  if (!isValidDate(date)) return null;
  if (typeof property !== "string" || property === "") return null;
  if (typeof runId !== "string" || !ULID.test(runId)) return null;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset % PAGE_ROWS !== 0) return null;
  if (offset >= MAX_ROWS_PER_DAY) return null;
  // Missing in the messages sent before these fields existed.
  if (incomplete !== undefined && typeof incomplete !== "boolean") return null;
  if (acceptEmpty !== undefined && typeof acceptEmpty !== "boolean") return null;
  const parsed: SyncBody = { kind: "sync", siteId, dataset: dataset as Dataset, date, property, runId, offset };
  // incomplete only means something for Search Console.
  if (incomplete === true && dataset !== "ga4_landing_pages") parsed.incomplete = true;
  if (acceptEmpty === true) parsed.acceptEmpty = true;
  return parsed;
}

// The URLs of an articles_import message: 1 to MAX_IMPORT_URLS distinct strings, each already normalized. null
// otherwise. Whether they are on the origin of the site is checked when the message is processed.
function parseImportUrls(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IMPORT_URLS) return null;
  const urls: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const url = normalizeArticleUrl(item);
    if (!url.ok || url.value === null || url.value !== item || urls.includes(item)) return null;
    urls.push(item);
  }
  return urls;
}

// 60 seconds doubling with each try, up to an hour.
function retryDelaySeconds(attempts: number): number {
  return Math.min(RETRY_BASE_SECONDS * 2 ** (Math.max(attempts, 1) - 1), RETRY_MAX_SECONDS);
}

// Records the import as failed if it is still the current one.
async function failRun(db: D1Database, m: SyncBody, code: string, message: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_days SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?
      WHERE site_id = ? AND dataset = ? AND date = ? AND run_id = ? AND status IN ('queued', 'running')`,
    )
    .bind(code, truncateMessage(message), now, m.siteId, m.dataset, m.date, m.runId)
    .run();
}

const NOT_CONFIGURED_MESSAGE = "サービスアカウントの鍵が設定されていません";
const CREDENTIALS_INVALID_MESSAGE = "サービスアカウントの鍵を確認してください";
const PERMISSION_DENIED_MESSAGE = "サービスアカウントにプロパティの閲覧権限がありません";
const INVALID_RESPONSE_MESSAGE = "Google の応答を読み取れませんでした";
const RETRY_EXHAUSTED_MESSAGE = "再試行の上限に達しました";
const EMPTY_RESPONSE_MESSAGE =
  "前回は行があった日に Google が 0 行を返したため、前回のデータを残しました。0 行が正しい場合は、この日を手動で取り込んでください";

// The error code and message recorded for a failure that is not retried.
function failureOf(failure: Extract<GoogleFailure, { retryable: false }>): { code: string; message: string } {
  switch (failure.code) {
    case "invalid_response":
      return { code: "invalid_response", message: INVALID_RESPONSE_MESSAGE };
    case "permission_denied":
      return { code: "permission_denied", message: failure.message ?? PERMISSION_DENIED_MESSAGE };
    default:
      return { code: failure.code, message: failure.message ?? INVALID_RESPONSE_MESSAGE };
  }
}

type FetchedPage = {
  rows: (string | number)[][];
  // The data state of the day if this is the last page.
  dataState: "final" | "provisional";
  // Search Console: this page or an earlier one was marked incomplete. Always false for GA4.
  incomplete: boolean;
  // The time zone recorded for the day; null when GA4 did not return a usable one.
  timeZone: string | null;
};

// One page from Google, with the data state of the day if it were the last page.
async function fetchPage(
  deps: SyncDeps,
  m: SyncBody,
  accessToken: string,
  now: number,
): Promise<{ ok: true; page: FetchedPage } | GoogleFailure> {
  if (m.dataset === "ga4_landing_pages") {
    const res = await fetchLandingPage({
      accessToken,
      property: m.property,
      date: m.date,
      offset: m.offset,
      fetcher: deps.fetcher,
    });
    if (!res.ok) return res;
    // Without a usable time zone the day is judged in UTC, but no time zone is recorded: UTC is only a guess.
    const timeZone = isUsableTimeZone(res.timeZone) ? res.timeZone : null;
    const provisional = m.date >= addDays(todayIn(timeZone ?? "UTC", now), -GA4_PROVISIONAL_DAYS);
    return {
      ok: true,
      page: { rows: res.rows, dataState: provisional ? "provisional" : "final", incomplete: false, timeZone },
    };
  }
  const res = await fetchSearchAnalyticsPage({
    accessToken,
    property: m.property,
    dataset: m.dataset,
    date: m.date,
    offset: m.offset,
    fetcher: deps.fetcher,
  });
  if (!res.ok) return res;
  // The API returns first_incomplete_date only when the period has incomplete data. Whether it is returned with the
  // later pages is not documented, so a mark on an earlier page is carried over (m.incomplete).
  const incomplete = m.incomplete === true || (res.firstIncompleteDate !== null && res.firstIncompleteDate <= m.date);
  // A follow-up page is sent only after a full page, so a day with a later page has rows.
  const hasRows = m.offset > 0 || res.rows.length > 0;
  const provisional = hasRows
    ? incomplete
    : incomplete || m.date >= addDays(todayIn(SEARCH_CONSOLE_TIME_ZONE, now), -GSC_PROVISIONAL_DAYS);
  return {
    ok: true,
    page: {
      rows: res.rows,
      dataState: provisional ? "provisional" : "final",
      incomplete,
      timeZone: SEARCH_CONSOLE_TIME_ZONE,
    },
  };
}

// Steps of one sync message. Throws on unexpected errors (D1, the queue); the caller retries.
async function sync(deps: SyncDeps, message: Message<unknown>, m: SyncBody): Promise<void> {
  const { db } = deps;
  let now = clock.now();
  // Starts the import, or goes on with it (a later page, or the same message delivered again).
  const claimed = await db
    .prepare(
      `UPDATE sync_days SET status = 'running', started_at = COALESCE(started_at, ?), heartbeat_at = ?
      WHERE site_id = ? AND dataset = ? AND date = ? AND run_id = ? AND property = ? AND status IN ('queued', 'running')
      RETURNING 1 AS claimed`,
    )
    .bind(now, now, m.siteId, m.dataset, m.date, m.runId, m.property)
    .first();
  // Replaced by another import, finished, or removed with the site or the property.
  if (claimed === null) {
    message.ack();
    return;
  }
  const site = await db
    .prepare("SELECT id, gsc_property, ga4_property_id FROM sites WHERE id = ?")
    .bind(m.siteId)
    .first<{ id: string; gsc_property: string | null; ga4_property_id: string | null }>();
  if (
    site === null ||
    propertyOf({ id: site.id, gscProperty: site.gsc_property, ga4PropertyId: site.ga4_property_id }, m.dataset) !==
      m.property
  ) {
    message.ack();
    return;
  }

  const token = await getGoogleAccessToken(deps.serviceAccountKey, { now, fetcher: deps.fetcher });
  if (!token.ok) {
    if (token.error === "retryable") {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      return;
    }
    if (token.error === "not_configured") {
      await failRun(db, m, "google_not_configured", NOT_CONFIGURED_MESSAGE, now);
    } else {
      await failRun(db, m, "credentials_invalid", CREDENTIALS_INVALID_MESSAGE, now);
    }
    message.ack();
    return;
  }

  const fetched = await fetchPage(deps, m, token.accessToken, now);
  now = clock.now();
  if (!fetched.ok) {
    if (fetched.retryable) {
      console.warn("google request failed; retrying", {
        siteId: m.siteId,
        dataset: m.dataset,
        date: m.date,
        status: fetched.status,
      });
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      return;
    }
    const failure = failureOf(fetched);
    await failRun(db, m, failure.code, failure.message, now);
    message.ack();
    return;
  }
  const { page } = fetched;

  // No rows for the whole day (a follow-up page is sent only after a full page). If the last successful import had
  // rows, Google's answer is not trusted over them unless the message accepts it.
  if (m.offset === 0 && page.rows.length === 0 && m.acceptEmpty !== true) {
    const last = await db
      .prepare(
        `SELECT last_row_count FROM sync_days
        WHERE site_id = ? AND dataset = ? AND date = ? AND run_id = ? AND status = 'running'`,
      )
      .bind(m.siteId, m.dataset, m.date, m.runId)
      .first<{ last_row_count: number | null }>();
    if (last !== null && (last.last_row_count ?? 0) > 0) {
      await db
        .prepare(
          `UPDATE sync_days SET status = 'failed', error_code = 'empty_response', error_message = ?, finished_at = ?
          WHERE site_id = ? AND dataset = ? AND date = ? AND run_id = ? AND status = 'running'`,
        )
        .bind(EMPTY_RESPONSE_MESSAGE, now, m.siteId, m.dataset, m.date, m.runId)
        .run();
      message.ack();
      return;
    }
  }

  // ?1 site_id, ?2 property, ?3 date, ?4 run_id, ?5 dataset, ?6 the rows.
  const statements: D1PreparedStatement[] = [];
  const upsert = upsertSql(m.dataset);
  for (let i = 0; i < page.rows.length; i += UPSERT_ROWS_PER_STATEMENT) {
    const rows = JSON.stringify(page.rows.slice(i, i + UPSERT_ROWS_PER_STATEMENT));
    statements.push(db.prepare(upsert).bind(m.siteId, m.property, m.date, m.runId, m.dataset, rows));
  }
  statements.push(
    db
      .prepare(
        `UPDATE sync_days SET heartbeat_at = ?
        WHERE site_id = ? AND dataset = ? AND date = ? AND run_id = ? AND status = 'running'`,
      )
      .bind(now, m.siteId, m.dataset, m.date, m.runId),
  );
  await db.batch(statements);

  const full = page.rows.length === PAGE_ROWS;
  if (full && m.offset + PAGE_ROWS < MAX_ROWS_PER_DAY) {
    const next: SyncBody = { ...m, offset: m.offset + PAGE_ROWS };
    if (page.incomplete) next.incomplete = true;
    await deps.queue.send(next);
    message.ack();
    return;
  }

  // The last page: the rows of the day that this import did not write are deleted, and the day succeeds.
  const { table } = DATASET_TABLES[m.dataset];
  await db.batch([
    db
      .prepare(
        `DELETE FROM ${table}
        WHERE site_id = ?1 AND property = ?2 AND date = ?3 AND run_id <> ?4 AND ${CURRENT_RUN}`,
      )
      .bind(m.siteId, m.property, m.date, m.runId, m.dataset),
    db
      .prepare(
        `UPDATE sync_days SET status = 'succeeded', finished_at = ?, heartbeat_at = ?, error_code = NULL,
          error_message = NULL, last_succeeded_at = ?, last_data_state = ?,
          last_row_count = (SELECT COUNT(*) FROM ${table} WHERE site_id = ? AND property = ? AND date = ?),
          last_truncated = ?, last_time_zone = ?
        WHERE site_id = ? AND dataset = ? AND date = ? AND run_id = ? AND status = 'running'`,
      )
      .bind(
        now,
        now,
        now,
        page.dataState,
        m.siteId,
        m.property,
        m.date,
        full ? 1 : 0,
        page.timeZone,
        m.siteId,
        m.dataset,
        m.date,
        m.runId,
      ),
  ]);
  message.ack();
}

// Deletes up to PURGE_ROWS_PER_MESSAGE rows of the purge, and sends the message again while rows remain. Rows of a
// day that sync_days still has for the same property (imported again after the property was changed back) are kept.
async function purge(deps: SyncDeps, message: Message<unknown>, purgeId: string): Promise<void> {
  const { db } = deps;
  const row = await db
    .prepare("SELECT id, site_id, dataset, property FROM pending_purges WHERE id = ?")
    .bind(purgeId)
    .first<{ id: string; site_id: string; dataset: Dataset; property: string | null }>();
  if (row === null) {
    message.ack();
    return;
  }
  const { table } = DATASET_TABLES[row.dataset];
  const values: unknown[] = [row.site_id];
  if (row.property !== null) values.push(row.property);
  values.push(row.dataset, PURGE_ROWS_PER_MESSAGE);
  const result = await db
    .prepare(
      `DELETE FROM ${table} WHERE rowid IN (
        SELECT rowid FROM ${table} t
        WHERE t.site_id = ? ${row.property !== null ? "AND t.property = ?" : ""}
          AND NOT EXISTS (
            SELECT 1 FROM sync_days s
            WHERE s.site_id = t.site_id AND s.dataset = ? AND s.date = t.date AND s.property = t.property
          )
        LIMIT ?
      )`,
    )
    .bind(...values)
    .run();
  const deleted = result.meta.changes ?? 0;
  if (deleted >= PURGE_ROWS_PER_MESSAGE) {
    await db.prepare("UPDATE pending_purges SET attempted_at = ? WHERE id = ?").bind(clock.now(), purgeId).run();
    await deps.queue.send({ kind: "purge", purgeId });
    message.ack();
    return;
  }
  await db.prepare("DELETE FROM pending_purges WHERE id = ?").bind(purgeId).run();
  message.ack();
}

async function processMessage(deps: SyncDeps, message: Message<unknown>): Promise<void> {
  const parsed = parseSyncMessage(message.body);
  if (parsed === null) {
    console.error("sync message is malformed", { messageId: message.id });
    message.ack();
    return;
  }
  if (parsed.kind === "purge") {
    try {
      await purge(deps, message, parsed.purgeId);
    } catch (error) {
      console.error("purge failed", { purgeId: parsed.purgeId, ...describeError(error) });
      message.retry({ delaySeconds: PURGE_RETRY_SECONDS });
    }
    return;
  }
  if (parsed.kind === "articles_sitemap" || parsed.kind === "articles_import") {
    const articleDeps = { db: deps.orm, queue: deps.queue, fetcher: deps.fetcher };
    try {
      if (parsed.kind === "articles_sitemap") await syncArticleSitemap(articleDeps, parsed.siteId);
      else await importArticlePages(articleDeps, parsed.siteId, parsed.urls);
      message.ack();
    } catch (error) {
      console.error("article sync failed", { kind: parsed.kind, siteId: parsed.siteId, ...describeError(error) });
      message.retry({ delaySeconds: UNEXPECTED_RETRY_SECONDS });
    }
    return;
  }
  try {
    await sync(deps, message, parsed);
  } catch (error) {
    console.error("sync failed unexpectedly", {
      siteId: parsed.siteId,
      dataset: parsed.dataset,
      date: parsed.date,
      ...describeError(error),
    });
    message.retry({ delaySeconds: UNEXPECTED_RETRY_SECONDS });
  }
}

// A message that the sync consumer could not finish within max_retries. The import is recorded as failed if it is
// still the current one. A purge is left to the daily cron, which sends it again. A message of the article sync is
// only logged: its URLs are not recorded, so the next day reads them again.
async function processDeadLetter(deps: SyncDeps, message: Message<unknown>): Promise<void> {
  const parsed = parseSyncMessage(message.body);
  if (parsed === null) {
    console.error("dead-lettered sync message is malformed", { messageId: message.id });
    message.ack();
    return;
  }
  if (parsed.kind === "purge") {
    message.ack();
    return;
  }
  if (parsed.kind === "articles_sitemap" || parsed.kind === "articles_import") {
    console.error("article sync dead-lettered", { kind: parsed.kind, siteId: parsed.siteId });
    message.ack();
    return;
  }
  try {
    await failRun(deps.db, parsed, "retry_exhausted", RETRY_EXHAUSTED_MESSAGE, clock.now());
    message.ack();
  } catch (error) {
    console.error("recording a dead-lettered sync failed", {
      siteId: parsed.siteId,
      dataset: parsed.dataset,
      date: parsed.date,
      ...describeError(error),
    });
    message.retry({ delaySeconds: DEAD_LETTER_RETRY_SECONDS });
  }
}

export type SyncQueueOptions = { fetcher?: typeof fetch };

export async function handleSyncQueue(
  batch: MessageBatch<unknown>,
  env: Bindings,
  options: SyncQueueOptions = {},
): Promise<void> {
  const config = loadConfig(env);
  if (!config.ok) {
    console.error("invalid configuration", { invalid: config.invalid });
    // Processed again once the configuration is fixed.
    for (const message of batch.messages) message.retry({ delaySeconds: CONFIG_RETRY_SECONDS });
    return;
  }
  const deps: SyncDeps = {
    db: env.DB,
    orm: createDb(env.DB),
    queue: env.SYNC_QUEUE,
    serviceAccountKey: env.GOOGLE_SERVICE_ACCOUNT_KEY,
    fetcher: options.fetcher ?? ((input, init) => fetch(input, init)),
  };
  const process = batch.queue === SYNC_DEAD_LETTER_QUEUE ? processDeadLetter : processMessage;
  // One at a time: each message may use most of the CPU time of an invocation.
  for (const message of batch.messages) await process(deps, message);
}
