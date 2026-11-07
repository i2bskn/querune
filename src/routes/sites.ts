import { Hono, type Context, type MiddlewareHandler } from "hono";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type {
  CreateSiteRequest,
  InsightsQuery,
  InsightsResponse,
  Site,
  SiteList,
  SyncRequest,
  SyncResponse,
  UpdateSiteRequest,
} from "../api/types";
import { apiError, clock, describeError, isUniqueViolation, jsonBody, type Db } from "@i2bskn/workers-app-core";
import { requireUser } from "../core";
import { articles, DATASETS, pendingPurges, sites, syncDays, type ArticleRow, type SiteRow } from "../db/schema";
import type { AppEnv } from "../env";
import { parseServiceAccountKey } from "../google/credentials";
import { ARTICLE_ID_PATTERN, newSiteId, newUlid, SITE_ID_PATTERN } from "../ids";
import { checkInsightsQuery, getInsights, getOverview, INSIGHTS_DAYS_DEFAULT } from "../insights";
import { articleNotFound } from "../records/common";
import { datesBetween, daysBetween, isValidDate, subtractMonths, todayUtc } from "../sync/dates";
import {
  datasetsOf,
  EnqueueError,
  enqueueSync,
  type Dataset,
  type SyncCandidate,
  type SyncMessage,
} from "../sync/enqueue";
import { getSyncStatus } from "../sync/status";
import { normalizeDisplayName, unknownField } from "./api";
import { createSiteArticle, createSiteMemo, listSiteArticles, listSiteMemos, listSiteTags } from "./site-content";

export const MAX_SITES = 100;
const SITE_NAME_MAX_LENGTH = 100;
const URL_MAX_LENGTH = 2048;
const DOMAIN_MAX_LENGTH = 253;
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SC_DOMAIN_PREFIX = "sc-domain:";
const GA4_PROPERTY_ID_PATTERN = /^[0-9]{1,20}$/;
const FIELDS = ["name", "url", "gsc_property", "ga4_property_id"];

const siteNotFound = "サイトが見つかりません";
const invalidNameMessage = "名前は制御文字を含まない 1〜100 文字にしてください";
const invalidUrlMessage = "URL は http または https で始まる正しい形式にしてください";
const invalidGscPropertyMessage =
  "Search Console のプロパティは sc-domain:example.com か https://example.com/ の形式にしてください";
const invalidGa4PropertyMessage = "GA4 のプロパティ ID は数字だけで入力してください";
const urlConflictMessage = "この URL のサイトは登録済みです";

type Parsed<T> = { ok: true; value: T } | { ok: false };

function parseHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url;
}

// The origin of the site (scheme, lowercase host and non-default port). The path, query and fragment are dropped.
export function normalizeSiteUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > URL_MAX_LENGTH) return null;
  return parseHttpUrl(trimmed)?.origin ?? null;
}

// null or blank is "not set". Otherwise "sc-domain:" + a lowercase domain, or a URL prefix ending with "/".
export function normalizeGscProperty(value: unknown): Parsed<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.slice(0, SC_DOMAIN_PREFIX.length).toLowerCase() === SC_DOMAIN_PREFIX) {
    const domain = trimmed.slice(SC_DOMAIN_PREFIX.length).toLowerCase();
    if (domain.length > DOMAIN_MAX_LENGTH || !DOMAIN_PATTERN.test(domain)) return { ok: false };
    return { ok: true, value: `${SC_DOMAIN_PREFIX}${domain}` };
  }
  const url = parseHttpUrl(trimmed);
  if (url === null || url.search !== "" || url.hash !== "" || !url.pathname.endsWith("/")) return { ok: false };
  if (url.href.length > URL_MAX_LENGTH) return { ok: false };
  return { ok: true, value: url.href };
}

// null or blank is "not set". Otherwise 1 to 20 digits.
export function normalizeGa4PropertyId(value: unknown): Parsed<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  return GA4_PROPERTY_ID_PATTERN.test(trimmed) ? { ok: true, value: trimmed } : { ok: false };
}

type SiteInput = { name: string; url: string; gscProperty: string | null; ga4PropertyId: string | null };

// Validates the items present in the body, in the order name, url, gsc_property, ga4_property_id. With required,
// a missing name or url is invalid and a missing property is null.
function checkSiteFields(
  body: Record<string, unknown>,
  c: Context<AppEnv>,
  required: boolean,
): { ok: true; value: Partial<SiteInput> } | Response {
  const value: Partial<SiteInput> = {};
  if (required || "name" in body) {
    const name = normalizeDisplayName(body.name, SITE_NAME_MAX_LENGTH);
    if (name === null) return apiError(c, 400, "invalid_name", invalidNameMessage);
    value.name = name;
  }
  if (required || "url" in body) {
    const url = normalizeSiteUrl(body.url);
    if (url === null) return apiError(c, 400, "invalid_url", invalidUrlMessage);
    value.url = url;
  }
  if ("gsc_property" in body) {
    const gscProperty = normalizeGscProperty(body.gsc_property);
    if (!gscProperty.ok) return apiError(c, 400, "invalid_gsc_property", invalidGscPropertyMessage);
    value.gscProperty = gscProperty.value;
  } else if (required) {
    value.gscProperty = null;
  }
  if ("ga4_property_id" in body) {
    const ga4PropertyId = normalizeGa4PropertyId(body.ga4_property_id);
    if (!ga4PropertyId.ok) return apiError(c, 400, "invalid_ga4_property", invalidGa4PropertyMessage);
    value.ga4PropertyId = ga4PropertyId.value;
  } else if (required) {
    value.ga4PropertyId = null;
  }
  return { ok: true, value };
}

const createSiteBody = jsonBody<CreateSiteRequest, SiteInput>((body, c) => {
  const unknown = unknownField(body, FIELDS);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const result = checkSiteFields(body, c, true);
  if (result instanceof Response) return result;
  return { ok: true, value: result.value as SiteInput };
});

const updateSiteBody = jsonBody<UpdateSiteRequest, Partial<SiteInput>>((body, c) => {
  const unknown = unknownField(body, FIELDS);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  if (Object.keys(body).length === 0) {
    return apiError(c, 400, "invalid_request", "変更する項目を指定してください");
  }
  return checkSiteFields(body, c, false);
});

export function toApiSite(row: SiteRow): Site {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    gsc_property: row.gscProperty,
    ga4_property_id: row.ga4PropertyId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

// POST /:id/sync, after validation.
type SyncInput = { startDate: string; endDate: string };

const SYNC_FIELDS = ["start_date", "end_date"];
// The most days imported by one request, both ends included.
export const MAX_SYNC_DAYS = 90;
// Search Console keeps about 16 months of data.
const GSC_RETENTION_MONTHS = 16;

const syncBody = jsonBody<SyncRequest, SyncInput>((body, c) => {
  const unknown = unknownField(body, SYNC_FIELDS);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const { start_date: startDate, end_date: endDate } = body;
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return apiError(c, 400, "invalid_date", "日付は YYYY-MM-DD の形式で入力してください");
  }
  if (startDate > endDate) return apiError(c, 400, "invalid_range", "開始日は終了日以前にしてください");
  if (endDate > todayUtc(clock.now())) return apiError(c, 400, "invalid_range", "終了日は今日以前にしてください");
  if (daysBetween(startDate, endDate) > MAX_SYNC_DAYS) {
    return apiError(c, 400, "invalid_range", "一度に取り込める期間は 90 日までです");
  }
  return { ok: true, value: { startDate, endDate } };
});

function propertiesOf(row: SiteRow) {
  return { id: row.id, gscProperty: row.gscProperty, ga4PropertyId: row.ga4PropertyId };
}

// Sends the messages of new purges. A failure is only logged: the daily cron sends them again.
async function sendPurges(queue: Queue<SyncMessage>, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await queue.sendBatch(ids.map((purgeId) => ({ body: { kind: "purge", purgeId } satisfies SyncMessage })));
  } catch (error) {
    console.error("sending purges failed", { purgeIds: ids, ...describeError(error) });
  }
}

// Every site, by name, then by ID.
export function listSites(db: Db): Promise<SiteRow[]> {
  return db.select().from(sites).orderBy(asc(sites.name), asc(sites.id)).all();
}

function findSite(db: Db, id: string): Promise<SiteRow | undefined> {
  return db.select().from(sites).where(eq(sites.id, id)).get();
}

type InsightsInput = { days: number; end: string | null; articleId: string | null };

// Validates the query of GET /:id/insights and passes it to c.req.valid("query").
const insightsQuery: MiddlewareHandler<AppEnv, string, { in: { query: InsightsQuery }; out: { query: InsightsInput } }> =
  async (c, next) => {
    const result = checkInsightsQuery(c.req.query(), clock.now());
    if (!result.ok) return apiError(c, 400, "invalid_query", `条件 ${result.name} が正しくありません`);
    c.req.addValidatedData("query", { days: result.days, end: result.end, articleId: result.articleId });
    return next();
  };

// Every signed-in user can read and change the sites; there is no per-site access control.
const sitesApi = new Hono<AppEnv>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const rows = await listSites(c.get("db"));
    const body: SiteList = { sites: rows.map(toApiSite) };
    return c.json(body, 200);
  })
  .post("/", createSiteBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const now = clock.now();
    const id = newSiteId(now);
    let changes: number;
    try {
      // The limit is checked in the same statement, so that concurrent requests cannot go over it. Once it is
      // reached, nothing is inserted and a duplicate URL is reported as limit_exceeded.
      const result = await db.$client
        .prepare(
          `INSERT INTO sites (id, name, url, gsc_property, ga4_property_id, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM sites) < ?`,
        )
        .bind(id, input.name, input.url, input.gscProperty, input.ga4PropertyId, now, now, MAX_SITES)
        .run();
      changes = result.meta.changes ?? 0;
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "url_conflict", urlConflictMessage);
      throw error;
    }
    if (changes === 0) return apiError(c, 409, "limit_exceeded", "サイトは 100 件まで登録できます");
    const created = await findSite(db, id);
    if (!created) throw new Error("created site not found");
    return c.json(toApiSite(created), 201);
  })
  // Before /:id, which would take "insights" as an ID.
  .get("/insights", async (c) => {
    const db = c.get("db");
    const rows = await listSites(db);
    return c.json(await getOverview(db.$client, rows, INSIGHTS_DAYS_DEFAULT, clock.now()), 200);
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const row = SITE_ID_PATTERN.test(id) ? await findSite(c.get("db"), id) : undefined;
    if (!row) return apiError(c, 404, "not_found", siteNotFound);
    return c.json(toApiSite(row), 200);
  })
  .patch("/:id", updateSiteBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const id = c.req.param("id");
    const current = SITE_ID_PATTERN.test(id) ? await findSite(db, id) : undefined;
    if (!current) return apiError(c, 404, "not_found", siteNotFound);
    const now = clock.now();
    // The datasets whose property changes, with the property before the change.
    const changes: { datasets: Dataset[]; before: string | null }[] = [];
    if (input.gscProperty !== undefined && input.gscProperty !== current.gscProperty) {
      changes.push({ datasets: ["gsc_pages", "gsc_queries"], before: current.gscProperty });
    }
    if (input.ga4PropertyId !== undefined && input.ga4PropertyId !== current.ga4PropertyId) {
      changes.push({ datasets: ["ga4_landing_pages"], before: current.ga4PropertyId });
    }
    const purges: { id: string; siteId: string; dataset: Dataset; property: string; createdAt: number; attemptedAt: number }[] =
      [];
    for (const change of changes) {
      if (change.before === null) continue;
      for (const dataset of change.datasets) {
        purges.push({ id: newUlid(now), siteId: id, dataset, property: change.before, createdAt: now, attemptedAt: now });
      }
    }
    try {
      const update = db
        .update(sites)
        .set({ ...input, updatedAt: now })
        .where(eq(sites.id, id));
      if (changes.length === 0) {
        await update.run();
      } else {
        // The days of the old property are forgotten with the change, and its rows are deleted later by the purges:
        // reads use only the rows of the current property.
        const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
          update,
          db
            .delete(syncDays)
            .where(and(eq(syncDays.siteId, id), inArray(syncDays.dataset, changes.flatMap((change) => change.datasets)))),
        ];
        if (purges.length > 0) statements.push(db.insert(pendingPurges).values(purges));
        await db.batch(statements);
      }
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "url_conflict", urlConflictMessage);
      throw error;
    }
    await sendPurges(
      c.env.SYNC_QUEUE,
      purges.map((purge) => purge.id),
    );
    const updated = await findSite(db, id);
    if (!updated) return apiError(c, 404, "not_found", siteNotFound);
    return c.json(toApiSite(updated), 200);
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");
    if (!SITE_ID_PATTERN.test(id) || !(await findSite(db, id))) {
      return apiError(c, 404, "not_found", siteNotFound);
    }
    const d1 = db.$client;
    const now = clock.now();
    const purgeIds = DATASETS.map(() => newUlid(now));
    // The purges are inserted before the site is deleted, and only while it exists, so that a concurrent deletion
    // leaves no purge behind. The imported rows are deleted later by the purges: deleting them here could exceed the
    // D1 limits. The articles, memos and their links are deleted with the site by ON DELETE CASCADE.
    const results = await d1.batch([
      ...DATASETS.map((dataset, i) =>
        d1
          .prepare(
            `INSERT INTO pending_purges (id, site_id, dataset, property, created_at, attempted_at)
            SELECT ?, ?, ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM sites WHERE id = ?)`,
          )
          .bind(purgeIds[i], id, dataset, now, now, id),
      ),
      d1.prepare("DELETE FROM sync_days WHERE site_id = ?").bind(id),
      d1.prepare("DELETE FROM sites WHERE id = ? RETURNING id").bind(id),
    ]);
    const deleted = results[results.length - 1]?.results.length ?? 0;
    if (deleted === 0) return apiError(c, 404, "not_found", siteNotFound);
    await sendPurges(
      c.env.SYNC_QUEUE,
      purgeIds.filter((_, i) => (results[i]?.meta.changes ?? 0) > 0),
    );
    return c.body(null, 204);
  })
  .post("/:id/sync", syncBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const id = c.req.param("id");
    const site = SITE_ID_PATTERN.test(id) ? await findSite(db, id) : undefined;
    if (!site) return apiError(c, 404, "not_found", siteNotFound);
    const datasets = datasetsOf(propertiesOf(site));
    if (datasets.length === 0) {
      return apiError(c, 409, "not_configured", "Search Console か GA4 のプロパティを設定してください");
    }
    const account = await parseServiceAccountKey(c.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    if (!account.ok) {
      if (account.error === "invalid") console.warn("google service account key is invalid", { reason: account.reason });
      return apiError(
        c,
        409,
        "google_not_configured",
        account.error === "not_configured"
          ? "サービスアカウントの鍵が設定されていません"
          : "サービスアカウントの鍵を確認してください",
      );
    }
    const now = clock.now();
    // Days before this are outside the retention of Search Console.
    const gscFrom = subtractMonths(todayUtc(now), GSC_RETENTION_MONTHS);
    const candidates: SyncCandidate[] = [];
    for (const date of datesBetween(input.startDate, input.endDate)) {
      for (const dataset of datasets) {
        if (dataset !== "ga4_landing_pages" && date < gscFrom) continue;
        const property = dataset === "ga4_landing_pages" ? site.ga4PropertyId : site.gscProperty;
        if (property === null) continue;
        candidates.push({ siteId: site.id, dataset, date, property });
      }
    }
    let queued;
    try {
      queued = await enqueueSync(db.$client, c.env.SYNC_QUEUE, candidates, { now, force: true });
    } catch (error) {
      if (!(error instanceof EnqueueError)) throw error;
      console.error("enqueueing the import failed", { siteId: site.id, sent: error.sent, ...describeError(error.cause) });
      return apiError(
        c,
        503,
        "temporarily_unavailable",
        "取り込みを依頼できませんでした。時間をおいてやり直してください",
      );
    }
    const body: SyncResponse = { queued: queued.length, days: new Set(queued.map((row) => row.date)).size };
    return c.json(body, 202);
  })
  .get("/:id/sync", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");
    const site = SITE_ID_PATTERN.test(id) ? await findSite(db, id) : undefined;
    if (!site) return apiError(c, 404, "not_found", siteNotFound);
    return c.json(await getSyncStatus(db.$client, propertiesOf(site)), 200);
  })
  .get("/:id/insights", insightsQuery, async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");
    const query = c.req.valid("query");
    const site = SITE_ID_PATTERN.test(id) ? await findSite(db, id) : undefined;
    if (!site) return apiError(c, 404, "not_found", siteNotFound);
    let article: ArticleRow | null = null;
    if (query.articleId !== null) {
      const row = ARTICLE_ID_PATTERN.test(query.articleId)
        ? await db.select().from(articles).where(eq(articles.id, query.articleId)).get()
        : undefined;
      if (!row || row.siteId !== site.id) return apiError(c, 404, "not_found", articleNotFound);
      article = row;
    }
    const body: InsightsResponse = await getInsights(
      db.$client,
      site,
      { days: query.days, end: query.end, article },
      clock.now(),
    );
    return c.json(body, 200);
  })
  .get("/:id/articles", ...listSiteArticles)
  .post("/:id/articles", ...createSiteArticle)
  .get("/:id/memos", ...listSiteMemos)
  .post("/:id/memos", ...createSiteMemo)
  .get("/:id/tags", ...listSiteTags);

export default sitesApi;
