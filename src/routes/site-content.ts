// The handlers of the articles, memos and tags of a site (/api/v1/sites/:id/...), mounted on the sites router so
// that its requireUser runs once. The items themselves are served by routes/articles.ts and routes/memos.ts.
import type { Context, MiddlewareHandler } from "hono";
import { createFactory } from "hono/factory";
import { eq } from "drizzle-orm";
import type {
  Article,
  ArticleList,
  ArticleListQuery,
  CreateArticleRequest,
  CreateMemoRequest,
  ImportArticleResult,
  ImportArticlesRequest,
  ImportArticlesResponse,
  MemoList,
  MemoListQuery,
  ReadSitemapRequest,
  ReadSitemapResponse,
} from "../api/types";
import { apiError, clock, jsonBody, type Db } from "@i2bskn/workers-app-core";
import { sites, type SiteRow } from "../db/schema";
import type { AppEnv } from "../env";
import { SITE_ID_PATTERN } from "../ids";
import { createArticle, findArticle, listArticles, siteArticleUrls, type RegisteredArticle } from "../records/articles";
import { siteNotFound, type Failure } from "../records/common";
import { createMemo, listMemos, listTags } from "../records/memos";
import {
  checkArticleBody,
  checkMemoBody,
  checkMemoFilters,
  checkQueryNumber,
  checkTagFilter,
  MAX_ARTICLES_PER_SITE,
  MAX_MEMOS_PER_SITE,
  normalizeArticleUrl,
  unknownFieldError,
  type ArticleInput,
  type Check,
  type MemoFilters,
  type MemoInput,
} from "../records/validate";
import {
  IMPORT_CONCURRENCY,
  IMPORT_DEADLINE_MS,
  IMPORT_FETCH_BUDGET,
  importMessages,
  MAX_IMPORT_URLS,
  readPage,
  readSitemap,
  type FetchBudget,
  type PageResult,
} from "../sitemap";
import { mapConcurrently } from "../sync/articles";

const factory = createFactory<AppEnv>();

// The :id of the path. The handlers are made without their path, so the parameter is typed as optional; an empty ID
// is not found.
function siteIdOf(c: Context<AppEnv>): string {
  return c.req.param("id") ?? "";
}

// The error response of a failure of src/records/.
export function failureResponse(c: Context<AppEnv>, result: Failure) {
  return apiError(c, result.status, result.code, result.message);
}

// Validates the query string and passes the result to c.req.valid("query"). Unknown parameters are ignored.
function queryCheck<In, Out extends object>(
  check: (query: Record<string, string>) => Check<Out>,
): MiddlewareHandler<AppEnv, string, { in: { query: In }; out: { query: Out } }> {
  return async (c, next) => {
    const result = check(c.req.query());
    if (!result.ok) return apiError(c, 400, result.code, result.message);
    c.req.addValidatedData("query", result.value);
    return next();
  };
}

// Validates the JSON body with a checker of src/records/validate.ts.
export function recordsJsonBody<In, Out extends object>(check: (body: Record<string, unknown>) => Check<Out>) {
  return jsonBody<In, Out>((body, c) => {
    const result = check(body);
    return result.ok ? result : apiError(c, 400, result.code, result.message);
  });
}

const articleListQuery = queryCheck<ArticleListQuery, { tag?: string | undefined }>((query) => {
  const tag = checkTagFilter(query.tag);
  return tag.ok ? { ok: true, value: { tag: tag.value } } : tag;
});

export const listSiteArticles = factory.createHandlers(articleListQuery, async (c) => {
  const { tag } = c.req.valid("query");
  const result = await listArticles(c.get("db").$client, siteIdOf(c), { tag });
  if (!result) return apiError(c, 404, "not_found", siteNotFound);
  const body: ArticleList = { articles: result.articles };
  return c.json(body, 200);
});

export const createSiteArticle = factory.createHandlers(
  recordsJsonBody<CreateArticleRequest, ArticleInput>((body) => checkArticleBody(body, true)),
  async (c) => {
    const result = await createArticle(c.get("db"), siteIdOf(c), c.req.valid("json"), clock.now());
    if (!result.ok) return failureResponse(c, result);
    return c.json(result.value, 201);
  },
);

const MEMO_LIMIT_DEFAULT = 50;
const MEMO_LIMIT_MAX = 100;

const memoListQuery = queryCheck<MemoListQuery, { filters: MemoFilters; limit: number; offset: number }>((query) => {
  const filters = checkMemoFilters(query);
  if (!filters.ok) return filters;
  const limit = checkQueryNumber("limit", query.limit, 1, MEMO_LIMIT_MAX, MEMO_LIMIT_DEFAULT);
  if (!limit.ok) return limit;
  const offset = checkQueryNumber("offset", query.offset, 0, MAX_MEMOS_PER_SITE, 0);
  if (!offset.ok) return offset;
  return { ok: true, value: { filters: filters.value, limit: limit.value, offset: offset.value } };
});

export const listSiteMemos = factory.createHandlers(memoListQuery, async (c) => {
  const { filters, limit, offset } = c.req.valid("query");
  const result = await listMemos(c.get("db").$client, siteIdOf(c), filters, { limit, offset }, true);
  if (!result) return apiError(c, 404, "not_found", siteNotFound);
  const body: MemoList = {
    memos: result.memos.map((memo) => ({ ...memo, content_preview: memo.content_preview ?? "" })),
    next_offset: result.nextOffset,
  };
  return c.json(body, 200);
});

export const createSiteMemo = factory.createHandlers(
  recordsJsonBody<CreateMemoRequest, MemoInput>((body) => checkMemoBody(body, true)),
  async (c) => {
    const result = await createMemo(c.get("db"), siteIdOf(c), c.req.valid("json"), clock.now());
    if (!result.ok) return failureResponse(c, result);
    return c.json(result.value, 201);
  },
);

export const listSiteTags = factory.createHandlers(async (c) => {
  const result = await listTags(c.get("db").$client, siteIdOf(c));
  if (!result) return apiError(c, 404, "not_found", siteNotFound);
  return c.json(result, 200);
});

// ---------- Importing articles from the sitemap ----------

// The site of the path, or undefined when it is missing or the ID is malformed. Read here rather than imported from
// routes/sites.ts, which imports this module.
function findSiteOf(c: Context<AppEnv>): Promise<SiteRow | undefined> {
  const id = siteIdOf(c);
  if (!SITE_ID_PATTERN.test(id)) return Promise.resolve(undefined);
  return c.get("db").select().from(sites).where(eq(sites.id, id)).get();
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Sets the published date of a registered article that has none. null when the article is gone or got a date in the
// meantime (the date set by someone else is kept).
async function fillPublishedOn(db: Db, id: string, publishedOn: string, now: number): Promise<Article | null> {
  const result = await db.$client
    .prepare("UPDATE articles SET published_on = ?, updated_at = ? WHERE id = ? AND published_on IS NULL")
    .bind(publishedOn, now, id)
    .run();
  if ((result.meta.changes ?? 0) === 0) return null;
  return findArticle(db, id);
}

const SITEMAP_FIELDS = ["sitemap_url"];
const invalidSitemapUrlFormat = "サイトマップの URL は http または https で始まる正しい形式にしてください";

function invalidSitemapUrlMessage(origin: string): string {
  return `サイトマップの URL は、サイトと同じ ${origin} で始まる URL にしてください`;
}

// null: the default sitemap of the site.
const sitemapBody = recordsJsonBody<ReadSitemapRequest, { sitemapUrl: string | null }>((body) => {
  const unknown = Object.keys(body).find((key) => !SITEMAP_FIELDS.includes(key));
  if (unknown !== undefined) return unknownFieldError(unknown);
  const value = body.sitemap_url;
  if (value === undefined || value === null) return { ok: true, value: { sitemapUrl: null } };
  const url = normalizeArticleUrl(value);
  if (!url.ok) return { ok: false, code: "invalid_sitemap_url", message: invalidSitemapUrlFormat };
  return { ok: true, value: { sitemapUrl: url.value } };
});

export const readSiteSitemap = factory.createHandlers(sitemapBody, async (c) => {
  const { sitemapUrl: requested } = c.req.valid("json");
  const site = await findSiteOf(c);
  if (!site) return apiError(c, 404, "not_found", siteNotFound);
  const sitemapUrl = requested ?? `${site.url}/sitemap.xml`;
  if (originOf(sitemapUrl) !== site.url) {
    return apiError(c, 400, "invalid_sitemap_url", invalidSitemapUrlMessage(site.url));
  }
  const result = await readSitemap(sitemapUrl, site.url);
  if (!result.ok) {
    return apiError(c, 422, result.error === "unavailable" ? "sitemap_unavailable" : "sitemap_unreadable", result.message);
  }
  const existing = await siteArticleUrls(c.get("db"), site.id);
  const body: ReadSitemapResponse = {
    sitemap_url: sitemapUrl,
    urls: result.urls.map((entry) => {
      const article = existing.urls.get(entry.url);
      return { ...entry, registered: article !== undefined, undated: article !== undefined && !article.dated };
    }),
    truncated: result.truncated,
    skipped_urls: result.skippedUrls,
    skipped_sitemaps: result.skippedSitemaps,
    remaining: Math.max(0, MAX_ARTICLES_PER_SITE - existing.count),
  };
  return c.json(body, 200);
});

const IMPORT_FIELDS = ["urls"];
const invalidUrlsMessage = `取り込む URL は 1〜${MAX_IMPORT_URLS} 件の、サイトと同じ origin の URL にしてください`;

function invalidUrls(): { ok: false; code: string; message: string } {
  return { ok: false, code: "invalid_urls", message: invalidUrlsMessage };
}

// 1 to 10 URLs, normalized; duplicates after normalization are removed keeping the first. Whether they are on the
// origin of the site is checked once the site is read.
const importBody = recordsJsonBody<ImportArticlesRequest, { urls: string[] }>((body) => {
  const unknown = Object.keys(body).find((key) => !IMPORT_FIELDS.includes(key));
  if (unknown !== undefined) return unknownFieldError(unknown);
  const value = body.urls;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IMPORT_URLS) return invalidUrls();
  const urls: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return invalidUrls();
    const url = normalizeArticleUrl(item);
    if (!url.ok || url.value === null) return invalidUrls();
    if (!urls.includes(url.value)) urls.push(url.value);
  }
  return { ok: true, value: { urls } };
});

export const importSiteArticles = factory.createHandlers(importBody, async (c) => {
  const { urls } = c.req.valid("json");
  const db = c.get("db");
  const site = await findSiteOf(c);
  if (!site) return apiError(c, 404, "not_found", siteNotFound);
  if (urls.some((url) => originOf(url) !== site.url)) return apiError(c, 400, "invalid_urls", invalidUrlsMessage);
  const existing = await siteArticleUrls(db, site.id);
  // Every page is fetched before any article is created, so that the articles are created in the order of the
  // request and the article limit cuts it at one place.
  const budget: FetchBudget = { remaining: IMPORT_FETCH_BUDGET };
  const deadline = Date.now() + IMPORT_DEADLINE_MS;
  // A registered article is read again only to fill its missing published date.
  const pages = await mapConcurrently(urls, IMPORT_CONCURRENCY, async (url): Promise<PageResult | "exists"> => {
    if (existing.urls.get(url)?.dated === true) return "exists";
    if (Date.now() >= deadline) return { ok: false, error: importMessages.budget, retryable: true };
    return readPage(url, site.url, budget);
  });
  const now = clock.now();
  const results: ImportArticleResult[] = [];
  let limitReached = false;
  for (const [i, url] of urls.entries()) {
    const page = pages[i] ?? { ok: false, error: importMessages.budget, retryable: true };
    if (page === "exists") {
      results.push({ url, status: "exists" });
      continue;
    }
    // The page may also redirect to the URL of a registered article.
    const registered = existing.urls.get(page.ok ? page.url : url);
    if (registered !== undefined) {
      results.push(await fillDate(db, url, registered, page, now));
      continue;
    }
    // Once the limit is reached, every URL left is reported with it, even those whose page failed.
    if (limitReached) {
      results.push({ url, status: "failed", error: importMessages.limit });
      continue;
    }
    if (!page.ok) {
      results.push({ url, status: "failed", error: page.error });
      continue;
    }
    const created = await createArticle(
      db,
      site.id,
      { title: page.title, url: page.url, publishedOn: page.publishedOn, tags: [], note: "" },
      now,
    );
    if (created.ok) {
      const { note: _note, ...article } = created.value;
      results.push({ url, status: "created", article });
      // Another URL of the request that leads to the same page is reported as registered, not read for a date.
      existing.urls.set(page.url, { id: article.id, dated: true });
      continue;
    }
    if (created.status === 404) return failureResponse(c, created);
    if (created.code === "url_conflict") {
      results.push({ url, status: "exists" });
    } else if (created.code === "limit_exceeded") {
      limitReached = true;
      results.push({ url, status: "failed", error: importMessages.limit });
    } else {
      results.push({ url, status: "failed", error: created.message });
    }
  }
  const body: ImportArticlesResponse = { results };
  return c.json(body, 200);
});

// The result of a URL whose article is registered: the published date read from the page fills the missing one.
async function fillDate(
  db: Db,
  url: string,
  registered: RegisteredArticle,
  page: PageResult,
  now: number,
): Promise<ImportArticleResult> {
  if (registered.dated) return { url, status: "exists" };
  if (!page.ok) return { url, status: "failed", error: page.error };
  if (page.publishedOn === null) return { url, status: "failed", error: importMessages.noDate };
  const article = await fillPublishedOn(db, registered.id, page.publishedOn, now);
  if (article === null) return { url, status: "exists" };
  registered.dated = true;
  const { note: _note, ...summary } = article;
  return { url, status: "dated", article: summary };
}
