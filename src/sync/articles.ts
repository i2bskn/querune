// The daily article sync: registers the pages that newly appear in the sitemap of each site as articles.
//
// The full cron sends one articles_sitemap message per site. That message reads <site URL>/sitemap.xml and compares
// its URLs with sitemap_urls, the URLs seen before. The first time (no row for the site) every URL is only recorded,
// so that the pages already listed are not registered at once. Afterwards the URLs not seen before are new: those
// already in the ledger are recorded, and up to ARTICLE_SYNC_MAX_PER_DAY of the others are sent as articles_import
// messages of up to MAX_IMPORT_URLS URLs. An articles_import message reads the pages and creates their articles, and
// records the URLs that were handled for good. A URL whose page failed in a way that may go away is not recorded, so
// that it is tried again the next day. A recorded URL is never registered again by the sync, so that an article
// deleted by a user does not come back. Existing articles are never changed.

import { clock, type Db } from "@i2bskn/workers-app-core";
import { createArticle, siteArticleUrls } from "../records/articles";
import { MAX_ARTICLES_PER_SITE } from "../records/validate";
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
import type { SyncMessage } from "./enqueue";

// The new pages of a site registered by one day of the sync at most.
export const ARTICLE_SYNC_MAX_PER_DAY = 100;
// The URLs in the JSON of one statement that records them: up to 2048 characters each, within 1 MB.
const RECORD_URLS_PER_STATEMENT = 500;
// Queues accept up to 100 messages per sendBatch.
const SEND_BATCH_SIZE = 100;

export type ArticleSyncDeps = {
  db: Db;
  queue: Queue<SyncMessage>;
  fetcher: typeof fetch;
};

type SiteOfSync = { id: string; url: string };

// Runs task on every item with at most limit at a time. The results are in the order of the items.
export async function mapConcurrently<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

// The statements that record the URLs as seen in the sitemap of the site. The URLs are bound as one JSON value per
// statement, so that the number of bound values stays within the limit of D1. Nothing is recorded once the site is
// deleted (the foreign key would fail).
function recordStatements(d1: D1Database, siteId: string, urls: string[], now: number): D1PreparedStatement[] {
  return chunks(urls, RECORD_URLS_PER_STATEMENT).map((chunk) =>
    d1
      .prepare(
        `INSERT OR IGNORE INTO sitemap_urls (site_id, url, seen_at)
        SELECT ?1, value, ?2 FROM json_each(?3) WHERE EXISTS (SELECT 1 FROM sites WHERE id = ?1)`,
      )
      .bind(siteId, now, JSON.stringify(chunk)),
  );
}

async function findSite(d1: D1Database, siteId: string): Promise<SiteOfSync | null> {
  return d1.prepare("SELECT id, url FROM sites WHERE id = ?").bind(siteId).first<SiteOfSync>();
}

// Sends an articles_sitemap message for every site (the full cron). Throws when D1 or the queue fails.
export async function enqueueArticleSync(db: D1Database, queue: Queue<SyncMessage>): Promise<void> {
  const { results } = await db.prepare("SELECT id FROM sites").all<{ id: string }>();
  for (const chunk of chunks(results, SEND_BATCH_SIZE)) {
    await queue.sendBatch(
      chunk.map((row) => ({ body: { kind: "articles_sitemap", siteId: row.id } satisfies SyncMessage })),
    );
  }
}

// An articles_sitemap message: reads the sitemap of the site and sends the new URLs as articles_import messages.
// Throws on unexpected errors (D1, the queue); the caller retries. Every step can run again: the records are
// INSERT OR IGNORE, and an import of a URL already registered creates nothing.
export async function syncArticleSitemap(deps: ArticleSyncDeps, siteId: string): Promise<void> {
  const d1 = deps.db.$client;
  const site = await findSite(d1, siteId);
  if (site === null) return;
  const sitemap = await readSitemap(`${site.url}/sitemap.xml`, site.url, { fetcher: deps.fetcher });
  if (!sitemap.ok) {
    console.warn("article sync: sitemap failed", { siteId, error: sitemap.error, message: sitemap.message });
    return;
  }
  const partial = sitemap.truncated || sitemap.skippedSitemaps > 0;
  const [seenResult, articlesResult] = await d1.batch<{ url: string | null }>([
    d1.prepare("SELECT url FROM sitemap_urls WHERE site_id = ?").bind(siteId),
    d1.prepare("SELECT url FROM articles WHERE site_id = ?").bind(siteId),
  ]);
  const seenRows = seenResult?.results ?? [];
  const articleRows = articlesResult?.results ?? [];
  const now = clock.now();

  if (seenRows.length === 0) {
    // The first time. A sitemap read only in part is not recorded: the URLs of the children not read would be new
    // on a later day, and the pages they list would be registered at once.
    if (partial) {
      console.warn("article sync: sitemap partly read; waiting for a complete one to start", {
        siteId,
        truncated: sitemap.truncated,
        skippedSitemaps: sitemap.skippedSitemaps,
      });
      return;
    }
    const statements = recordStatements(
      d1,
      siteId,
      sitemap.urls.map((entry) => entry.url),
      now,
    );
    if (statements.length > 0) await d1.batch(statements);
    console.log("article sync: sitemap recorded", { siteId, urls: sitemap.urls.length });
    return;
  }

  // Afterwards, the URLs read are handled even when the sitemap was read only in part: the first time recorded the
  // whole sitemap, so a URL read now and not recorded is new.
  const seen = new Set(seenRows.map((row) => row.url));
  const registered = new Set(articleRows.map((row) => row.url).filter((url) => url !== null));
  const fresh = sitemap.urls.map((entry) => entry.url).filter((url) => !seen.has(url));
  // Registered by hand before the sync saw them.
  const known = fresh.filter((url) => registered.has(url));
  const candidates = fresh.filter((url) => !registered.has(url));
  const room = Math.min(ARTICLE_SYNC_MAX_PER_DAY, MAX_ARTICLES_PER_SITE - articleRows.length);
  // The candidates left out are not recorded, so that they are candidates again the next day.
  const selected = room > 0 ? candidates.slice(0, room) : [];

  const statements = recordStatements(d1, siteId, known, now);
  if (statements.length > 0) await d1.batch(statements);
  // The selected URLs are recorded by the import, depending on its result.
  const messages = chunks(selected, MAX_IMPORT_URLS).map((urls) => ({
    body: { kind: "articles_import", siteId, urls } satisfies SyncMessage,
  }));
  for (const batch of chunks(messages, SEND_BATCH_SIZE)) await deps.queue.sendBatch(batch);
  console.log("article sync: sitemap read", {
    siteId,
    partial,
    fresh: fresh.length,
    known: known.length,
    queued: selected.length,
  });
}

// An articles_import message: reads the pages and creates their articles (no tags, an empty note). The URLs handled
// for good are recorded: created, already registered (also after a redirect), off the origin of the site, or failed
// in a way that stays. The URLs whose page may be read later, and those after the article limit, are not recorded.
// Throws on unexpected errors (D1); the caller retries.
export async function importArticlePages(deps: ArticleSyncDeps, siteId: string, urls: string[]): Promise<void> {
  const { db } = deps;
  const d1 = db.$client;
  const site = await findSite(d1, siteId);
  if (site === null) return;
  const existing = await siteArticleUrls(db, siteId);
  // Every page is read before any article is created, so that the articles are created in the order of the message
  // and the article limit cuts it at one place (as the manual import does).
  const budget: FetchBudget = { remaining: IMPORT_FETCH_BUDGET };
  const deadline = Date.now() + IMPORT_DEADLINE_MS;
  const pages = await mapConcurrently(urls, IMPORT_CONCURRENCY, async (url): Promise<PageResult | "skip"> => {
    // The URL of the site may have changed since the message was sent.
    if (originOf(url) !== site.url || existing.urls.has(url)) return "skip";
    if (Date.now() >= deadline) return { ok: false, error: importMessages.budget, retryable: true };
    return readPage(url, site.url, budget, deps.fetcher);
  });

  const now = clock.now();
  const record: string[] = [];
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const [i, url] of urls.entries()) {
    const page = pages[i] ?? { ok: false, error: importMessages.budget, retryable: true };
    if (page === "skip") {
      record.push(url);
      skipped++;
      continue;
    }
    if (!page.ok) {
      console.warn("article sync: page failed", { siteId, url, error: page.error, retryable: page.retryable });
      failed++;
      if (!page.retryable) record.push(url);
      continue;
    }
    // The page may redirect to the URL of a registered article.
    if (existing.urls.has(page.url)) {
      record.push(url);
      skipped++;
      continue;
    }
    const result = await createArticle(
      db,
      siteId,
      { title: page.title, url: page.url, publishedOn: page.publishedOn, tags: [], note: "" },
      now,
    );
    if (result.ok) {
      created++;
      existing.urls.set(page.url, { id: result.value.id, dated: result.value.published_on !== null });
      record.push(url);
      continue;
    }
    if (result.code === "url_conflict") {
      record.push(url);
      skipped++;
      continue;
    }
    // limit_exceeded, or the site was deleted: nothing more is created, and the URLs left are not recorded.
    if (result.code !== "limit_exceeded") {
      console.warn("article sync: creating an article failed", { siteId, url, code: result.code });
    }
    break;
  }
  const statements = recordStatements(d1, siteId, record, now);
  if (statements.length > 0) await d1.batch(statements);
  console.log("article sync: imported", { siteId, created, skipped, failed });
}
