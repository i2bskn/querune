import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteRow } from "../src/db/schema";
import worker from "../src/index";
import { MAX_ARTICLES_PER_SITE } from "../src/records/validate";
import { readPage } from "../src/sitemap";
import { ARTICLE_SYNC_MAX_PER_DAY } from "../src/sync/articles";
import { handleSyncQueue, parseSyncMessage, SYNC_DEAD_LETTER_QUEUE, SYNC_QUEUE } from "../src/sync/consumer";
import { DAILY_CRON, FRESH_CRON, type SyncMessage } from "../src/sync/enqueue";
import {
  createSite,
  createUser,
  fakeBatch,
  fakeMessage,
  fakeQueue,
  login,
  resetDb,
  send,
  type FakeMessage,
  type FakeQueue,
} from "./helpers";
import { sharedServiceAccount } from "./google";

const ORIGIN = "https://example.com";
const SITEMAP = `${ORIGIN}/sitemap.xml`;

type ImportBody = Extract<SyncMessage, { kind: "articles_import" }>;

let site: SiteRow;
let queue: FakeQueue;
let pages: Record<string, () => Response>;
let fetched: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await resetDb();
  site = await createSite({ url: ORIGIN });
  queue = fakeQueue();
  pages = {};
  fetched = [];
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

const fetcher: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  fetched.push(url);
  const page = pages[url];
  return page ? page() : new Response("not found", { status: 404 });
};

function xml(body: string): () => Response {
  return () => new Response(body, { headers: { "Content-Type": "application/xml" } });
}

function html(body: string, contentType = "text/html; charset=utf-8"): () => Response {
  return () => new Response(body, { headers: { "Content-Type": contentType } });
}

function urlset(...locs: string[]): string {
  return `<?xml version="1.0"?><urlset>${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`;
}

function sitemapIndex(...locs: string[]): string {
  return `<?xml version="1.0"?><sitemapindex>${locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join("")}</sitemapindex>`;
}

function paths(...names: string[]): string[] {
  return names.map((name) => `${ORIGIN}/${name}`);
}

function serveSitemap(...urls: string[]): void {
  pages[SITEMAP] = xml(urlset(...urls));
}

function servePage(url: string, title: string, publishedOn?: string): void {
  const meta = publishedOn === undefined ? "" : `<meta property="article:published_time" content="${publishedOn}">`;
  pages[url] = html(`<html><head><title>${title}</title>${meta}</head><body></body></html>`);
}

async function deliver(
  body: unknown,
  options: { queueName?: string; db?: D1Database } = {},
): Promise<FakeMessage> {
  const message = fakeMessage(body);
  const testing = { ...env, SYNC_QUEUE: queue, ...(options.db ? { DB: options.db } : {}) };
  await handleSyncQueue(fakeBatch(options.queueName ?? SYNC_QUEUE, [message]), testing, { fetcher });
  return message;
}

function readSitemapOf(target: SiteRow = site): Promise<FakeMessage> {
  return deliver({ kind: "articles_sitemap", siteId: target.id });
}

function importOf(urls: string[], target: SiteRow = site): Promise<FakeMessage> {
  return deliver({ kind: "articles_import", siteId: target.id, urls });
}

function sentImports(): ImportBody[] {
  return queue.messages.filter((m): m is ImportBody => m.kind === "articles_import");
}

async function recorded(siteId = site.id): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT url FROM sitemap_urls WHERE site_id = ? ORDER BY url")
    .bind(siteId)
    .all<{ url: string }>();
  return results.map((row) => row.url);
}

async function record(...urls: string[]): Promise<void> {
  for (const url of urls) {
    await env.DB.prepare("INSERT INTO sitemap_urls (site_id, url, seen_at) VALUES (?, ?, 0)").bind(site.id, url).run();
  }
}

type ArticleColumns = { id: string; title: string; url: string | null; published_on: string | null; tags: string; note: string };

async function articlesOf(siteId = site.id): Promise<ArticleColumns[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, title, url, published_on, tags, note FROM articles WHERE site_id = ? ORDER BY url",
  )
    .bind(siteId)
    .all<ArticleColumns>();
  return results;
}

async function insertArticle(url: string | null, publishedOn: string | null = null, id = crypto.randomUUID()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO articles (id, site_id, title, url, published_on, tags, note, created_at, updated_at)
    VALUES (?, ?, 'Existing', ?, ?, '["kept"]', 'note', 0, 0)`,
  )
    .bind(id, site.id, url, publishedOn)
    .run();
}

// Inserts count articles without a URL.
async function fillArticles(count: number): Promise<void> {
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO articles (id, site_id, title, tags, note, created_at, updated_at)
    SELECT printf('art_%026d', i), ?, 'a' || i, '[]', '', 0, 0 FROM n`,
  )
    .bind(count, site.id)
    .run();
}

function expectAcked(message: FakeMessage): void {
  expect(message.acked).toBe(true);
  expect(message.retried).toBeNull();
}

describe("the full cron", () => {
  async function runCron(cron: string, key: string | undefined): Promise<void> {
    const ctx = createExecutionContext();
    const controller = { cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController;
    await worker.scheduled(controller, { ...env, SYNC_QUEUE: queue, GOOGLE_SERVICE_ACCOUNT_KEY: key }, ctx);
    await waitOnExecutionContext(ctx);
  }

  it("sends an articles_sitemap message for every site, after the imports", async () => {
    const other = await createSite({ gscProperty: "sc-domain:other.example.com" });
    await runCron(DAILY_CRON, (await sharedServiceAccount()).key);
    const kinds = queue.messages.map((m) => m.kind);
    const firstArticle = kinds.indexOf("articles_sitemap");
    expect(firstArticle).toBeGreaterThan(0);
    expect(kinds.slice(0, firstArticle).every((kind) => kind === "sync")).toBe(true);
    expect(queue.messages.slice(firstArticle)).toEqual(
      expect.arrayContaining([
        { kind: "articles_sitemap", siteId: site.id },
        { kind: "articles_sitemap", siteId: other.id },
      ]),
    );
    expect(queue.messages.slice(firstArticle)).toHaveLength(2);
  });

  it("sends them without the Google service account key", async () => {
    await runCron(DAILY_CRON, undefined);
    expect(queue.messages).toEqual([{ kind: "articles_sitemap", siteId: site.id }]);
  });

  it("sends none with the fresh cron", async () => {
    await runCron(FRESH_CRON, undefined);
    expect(queue.messages).toEqual([]);
  });

  it("logs a failure to send without throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    queue.fail = true;
    await runCron(DAILY_CRON, undefined);
    expect(error).toHaveBeenCalledWith("article sync enqueue failed", expect.anything());
  });
});

describe("articles_sitemap", () => {
  it("the first time, records every URL and registers nothing", async () => {
    serveSitemap(...paths("a", "b"));
    const message = await readSitemapOf();
    expectAcked(message);
    expect(await recorded()).toEqual(paths("a", "b"));
    expect(await articlesOf()).toEqual([]);
    expect(queue.messages).toEqual([]);
  });

  it("afterwards, sends the URLs not seen before as imports of 10", async () => {
    await record(...paths("a", "b"));
    const fresh = Array.from({ length: 12 }, (_, i) => `${ORIGIN}/new-${String(i).padStart(2, "0")}`);
    serveSitemap(`${ORIGIN}/a`, ...fresh, `${ORIGIN}/b`);
    const message = await readSitemapOf();
    expectAcked(message);
    expect(queue.messages).toEqual([
      { kind: "articles_import", siteId: site.id, urls: fresh.slice(0, 10) },
      { kind: "articles_import", siteId: site.id, urls: fresh.slice(10) },
    ]);
    // Recorded by the import, not here.
    expect(await recorded()).toEqual(paths("a", "b"));
  });

  it("does not send recorded URLs, such as the URL of a deleted article", async () => {
    // a was registered and then deleted: it stays recorded and has no article.
    await record(...paths("a", "b"));
    serveSitemap(...paths("a", "b"));
    expectAcked(await readSitemapOf());
    expect(queue.messages).toEqual([]);
  });

  it("only records the new URLs already in the ledger", async () => {
    await record(`${ORIGIN}/a`);
    await insertArticle(`${ORIGIN}/manual`);
    serveSitemap(...paths("a", "manual", "c"));
    expectAcked(await readSitemapOf());
    expect(queue.messages).toEqual([{ kind: "articles_import", siteId: site.id, urls: [`${ORIGIN}/c`] }]);
    expect(await recorded()).toEqual(paths("a", "manual"));
  });

  it(`sends at most ${ARTICLE_SYNC_MAX_PER_DAY} URLs a day, and does not record the rest`, async () => {
    await record(`${ORIGIN}/a`);
    const fresh = Array.from({ length: 105 }, (_, i) => `${ORIGIN}/p${String(i).padStart(3, "0")}`);
    serveSitemap(`${ORIGIN}/a`, ...fresh);
    expectAcked(await readSitemapOf());
    const sent = sentImports();
    expect(sent).toHaveLength(10);
    expect(sent.flatMap((m) => m.urls)).toEqual(fresh.slice(0, ARTICLE_SYNC_MAX_PER_DAY));
    expect(await recorded()).toEqual([`${ORIGIN}/a`]);
  });

  it("sends only as many URLs as the ledger has room for", async () => {
    await record(`${ORIGIN}/a`);
    await fillArticles(MAX_ARTICLES_PER_SITE - 3);
    serveSitemap(...paths("a", "b", "c", "d", "e", "f"));
    expectAcked(await readSitemapOf());
    expect(sentImports().flatMap((m) => m.urls)).toEqual(paths("b", "c", "d"));
    expect(await recorded()).toEqual([`${ORIGIN}/a`]);
  });

  it("sends nothing when the ledger is full", async () => {
    await record(`${ORIGIN}/a`);
    await fillArticles(MAX_ARTICLES_PER_SITE);
    serveSitemap(...paths("a", "b"));
    expectAcked(await readSitemapOf());
    expect(queue.messages).toEqual([]);
  });

  it("acks without retrying when the sitemap cannot be read", async () => {
    await record(`${ORIGIN}/a`);
    const message = await readSitemapOf();
    expectAcked(message);
    expect(queue.messages).toEqual([]);
    expect(await recorded()).toEqual([`${ORIGIN}/a`]);
    expect(warnSpy).toHaveBeenCalledWith("article sync: sitemap failed", expect.objectContaining({ siteId: site.id }));
  });

  it("the first time, records nothing when the sitemap was read only in part", async () => {
    pages[SITEMAP] = xml(sitemapIndex(`${ORIGIN}/posts.xml`, `${ORIGIN}/missing.xml`));
    pages[`${ORIGIN}/posts.xml`] = xml(urlset(...paths("a", "b")));
    expectAcked(await readSitemapOf());
    expect(await recorded()).toEqual([]);
    expect(queue.messages).toEqual([]);
  });

  it("afterwards, handles the new URLs of a sitemap read only in part", async () => {
    await record(`${ORIGIN}/a`);
    pages[SITEMAP] = xml(sitemapIndex(`${ORIGIN}/posts.xml`, `${ORIGIN}/missing.xml`));
    pages[`${ORIGIN}/posts.xml`] = xml(urlset(...paths("a", "b")));
    expectAcked(await readSitemapOf());
    expect(queue.messages).toEqual([{ kind: "articles_import", siteId: site.id, urls: [`${ORIGIN}/b`] }]);
  });

  it("acks a message of a missing site", async () => {
    const other = await createSite();
    await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(other.id).run();
    expectAcked(await readSitemapOf(other));
    expect(fetched).toEqual([]);
  });

  it("retries when sending fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await record(`${ORIGIN}/a`);
    serveSitemap(...paths("a", "b"));
    queue.fail = true;
    const message = await readSitemapOf();
    expect(message.acked).toBe(false);
    expect(message.retried).toEqual({ delaySeconds: 60 });
    expect(error).toHaveBeenCalledWith(
      "article sync failed",
      expect.objectContaining({ kind: "articles_sitemap", siteId: site.id }),
    );
  });
});

describe("articles_import", () => {
  it("creates the articles with their title and published date, no tags and an empty note, and records them", async () => {
    servePage(`${ORIGIN}/a`, "Article A", "2026-10-01T09:00:00+09:00");
    servePage(`${ORIGIN}/b`, "Article B");
    expectAcked(await importOf(paths("a", "b")));
    expect((await articlesOf()).map(({ id: _id, ...rest }) => rest)).toEqual([
      { title: "Article A", url: `${ORIGIN}/a`, published_on: "2026-10-01", tags: "[]", note: "" },
      { title: "Article B", url: `${ORIGIN}/b`, published_on: null, tags: "[]", note: "" },
    ]);
    expect(await recorded()).toEqual(paths("a", "b"));
    expect(logSpy).toHaveBeenCalledWith("article sync: imported", {
      siteId: site.id,
      created: 2,
      skipped: 0,
      failed: 0,
    });
  });

  it("records a registered URL without reading it, and leaves the article as it is", async () => {
    await insertArticle(`${ORIGIN}/a`, null, "art_existing");
    servePage(`${ORIGIN}/a`, "New title", "2026-10-01");
    expectAcked(await importOf([`${ORIGIN}/a`]));
    expect(fetched).toEqual([]);
    expect(await articlesOf()).toEqual([
      { id: "art_existing", title: "Existing", url: `${ORIGIN}/a`, published_on: null, tags: '["kept"]', note: "note" },
    ]);
    expect(await recorded()).toEqual([`${ORIGIN}/a`]);
  });

  it("records a URL that redirects to a registered article without creating one", async () => {
    await insertArticle(`${ORIGIN}/new`);
    pages[`${ORIGIN}/old`] = () => new Response(null, { status: 301, headers: { Location: `${ORIGIN}/new` } });
    servePage(`${ORIGIN}/new`, "New");
    expectAcked(await importOf([`${ORIGIN}/old`]));
    expect(await articlesOf()).toHaveLength(1);
    expect(await recorded()).toEqual([`${ORIGIN}/old`]);
  });

  it("records a URL off the origin of the site without reading it", async () => {
    expectAcked(await importOf(["https://other.example.com/a"]));
    expect(fetched).toEqual([]);
    expect(await recorded()).toEqual(["https://other.example.com/a"]);
  });

  it("records the pages that failed for good, and not those that may be read later", async () => {
    pages[`${ORIGIN}/gone`] = () => new Response("gone", { status: 410 });
    pages[`${ORIGIN}/json`] = html("{}", "application/json");
    pages[`${ORIGIN}/sjis`] = html("<title>x</title>", "text/html; charset=Shift_JIS");
    pages[`${ORIGIN}/forbidden`] = () => new Response("no", { status: 403 });
    pages[`${ORIGIN}/error`] = () => new Response("error", { status: 500 });
    // missing: 404.
    expectAcked(await importOf(paths("gone", "json", "sjis", "forbidden", "error", "missing")));
    expect(await articlesOf()).toEqual([]);
    expect(await recorded()).toEqual(paths("gone", "json", "sjis"));
    expect(warnSpy).toHaveBeenCalledWith(
      "article sync: page failed",
      expect.objectContaining({ url: `${ORIGIN}/error`, retryable: true }),
    );
  });

  it("stops at the article limit and does not record the URLs left", async () => {
    await fillArticles(MAX_ARTICLES_PER_SITE - 1);
    for (const url of paths("a", "b", "c")) servePage(url, url);
    expectAcked(await importOf(paths("a", "b", "c")));
    expect((await articlesOf()).filter((a) => a.url !== null).map((a) => a.url)).toEqual([`${ORIGIN}/a`]);
    expect(await recorded()).toEqual([`${ORIGIN}/a`]);
  });

  it("acks a message of a missing site", async () => {
    const other = await createSite();
    await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(other.id).run();
    expectAcked(await importOf(["https://x.example.com/a"], other));
    expect(fetched).toEqual([]);
  });

  it("retries when D1 fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return () => {
            throw new Error("D1 is down");
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const message = await deliver({ kind: "articles_import", siteId: site.id, urls: [`${ORIGIN}/a`] }, { db: failing });
    expect(message.acked).toBe(false);
    expect(message.retried).toEqual({ delaySeconds: 60 });
    expect(error).toHaveBeenCalledWith(
      "article sync failed",
      expect.objectContaining({ kind: "articles_import", siteId: site.id }),
    );
  });
});

describe("a deleted article", () => {
  it("is not registered again the next day", async () => {
    serveSitemap(`${ORIGIN}/a`);
    await readSitemapOf();
    serveSitemap(...paths("a", "b"));
    servePage(`${ORIGIN}/b`, "B");
    await readSitemapOf();
    const [sent] = sentImports();
    if (sent === undefined) throw new Error("not sent");
    expectAcked(await deliver(sent));
    const [article] = await articlesOf();
    expect(article?.url).toBe(`${ORIGIN}/b`);

    await env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(article?.id).run();
    queue.messages.length = 0;
    expectAcked(await readSitemapOf());
    expect(queue.messages).toEqual([]);
    expect(await articlesOf()).toEqual([]);
  });
});

describe("the sites", () => {
  async function member() {
    const user = await createUser({ email: `member-${crypto.randomUUID()}@example.com` });
    return login(user.email);
  }

  it("deleting a site deletes its seen URLs", async () => {
    await record(...paths("a", "b"));
    const cookies = await member();
    const res = await send(`/api/v1/sites/${site.id}`, { method: "DELETE", cookies });
    expect(res.status).toBe(204);
    expect(await recorded()).toEqual([]);
  });

  it("changing the URL of a site forgets its seen URLs, and the next sync starts over", async () => {
    await record(...paths("a", "b"));
    const cookies = await member();
    const renamed = await send(`/api/v1/sites/${site.id}`, { method: "PATCH", cookies, json: { name: "Renamed" } });
    expect(renamed.status).toBe(200);
    expect(await recorded()).toEqual(paths("a", "b"));

    const moved = await send(`/api/v1/sites/${site.id}`, {
      method: "PATCH",
      cookies,
      json: { url: "https://new.example.com" },
    });
    expect(moved.status).toBe(200);
    expect(await recorded()).toEqual([]);

    pages["https://new.example.com/sitemap.xml"] = xml(urlset("https://new.example.com/a", "https://new.example.com/b"));
    expectAcked(await readSitemapOf());
    expect(queue.messages).toEqual([]);
    expect(await recorded()).toEqual(["https://new.example.com/a", "https://new.example.com/b"]);
  });
});

describe("parseSyncMessage", () => {
  it("reads the messages of the article sync", () => {
    expect(parseSyncMessage({ kind: "articles_sitemap", siteId: site.id })).toEqual({
      kind: "articles_sitemap",
      siteId: site.id,
    });
    const urls = paths("a", "b");
    expect(parseSyncMessage({ kind: "articles_import", siteId: site.id, urls })).toEqual({
      kind: "articles_import",
      siteId: site.id,
      urls,
    });
    const ten = Array.from({ length: 10 }, (_, i) => `${ORIGIN}/${i}`);
    expect(parseSyncMessage({ kind: "articles_import", siteId: site.id, urls: ten })).not.toBeNull();
  });

  it("rejects malformed messages of the article sync", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `${ORIGIN}/${i}`);
    for (const body of [
      { kind: "articles_sitemap" },
      { kind: "articles_sitemap", siteId: "bad-id" },
      { kind: "articles_import", siteId: "bad-id", urls: [`${ORIGIN}/a`] },
      { kind: "articles_import", siteId: site.id },
      { kind: "articles_import", siteId: site.id, urls: [] },
      { kind: "articles_import", siteId: site.id, urls: eleven },
      { kind: "articles_import", siteId: site.id, urls: [1] },
      { kind: "articles_import", siteId: site.id, urls: [""] },
      { kind: "articles_import", siteId: site.id, urls: ["ftp://example.com/a"] },
      // Not normalized.
      { kind: "articles_import", siteId: site.id, urls: [`${ORIGIN}/a#top`] },
      { kind: "articles_import", siteId: site.id, urls: [" https://example.com/a"] },
      { kind: "articles_import", siteId: site.id, urls: paths("a", "a") },
    ]) {
      expect(parseSyncMessage(body)).toBeNull();
    }
  });
});

describe("the dead letter queue", () => {
  it("acks the messages of the article sync and leaves sync_days as it is", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare(
      `INSERT INTO sync_days (site_id, dataset, date, property, status, run_id, queued_at)
      VALUES (?, 'gsc_pages', '2026-10-01', 'sc-domain:example.com', 'running', '01JBQZ0000000000000000000A', 0)`,
    )
      .bind(site.id)
      .run();
    const before = await env.DB.prepare("SELECT * FROM sync_days").all();
    for (const body of [
      { kind: "articles_sitemap", siteId: site.id },
      { kind: "articles_import", siteId: site.id, urls: [`${ORIGIN}/a`] },
    ]) {
      expectAcked(await deliver(body, { queueName: SYNC_DEAD_LETTER_QUEUE }));
    }
    expect((await env.DB.prepare("SELECT * FROM sync_days").all()).results).toEqual(before.results);
    expect(error).toHaveBeenCalledWith("article sync dead-lettered", { kind: "articles_sitemap", siteId: site.id });
    expect(error).toHaveBeenCalledWith("article sync dead-lettered", { kind: "articles_import", siteId: site.id });
  });
});

describe("readPage retryable", () => {
  async function failureOf(response: () => Response | Promise<Response>): Promise<unknown> {
    const page = `${ORIGIN}/page`;
    const local: typeof fetch = async () => response();
    return readPage(page, ORIGIN, { remaining: 5 }, local);
  }

  it("is true for the failures that may go away", async () => {
    // 302 without Location, and 204. A 1xx status cannot be made with Response; it is handled as any other status.
    for (const status of [400, 401, 403, 404, 429, 500, 503, 302, 204]) {
      expect(await failureOf(() => new Response(null, { status }))).toMatchObject({ ok: false, retryable: true });
    }
    expect(
      await failureOf(() => {
        throw new TypeError("network");
      }),
    ).toMatchObject({ ok: false, retryable: true });
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("reset"));
      },
    });
    expect(
      await failureOf(() => new Response(broken, { headers: { "Content-Type": "text/html; charset=utf-8" } })),
    ).toMatchObject({ ok: false, retryable: true });
    expect(await readPage(`${ORIGIN}/page`, ORIGIN, { remaining: 0 }, fetcher)).toMatchObject({
      ok: false,
      retryable: true,
    });
  });

  it("is false for the failures that stay", async () => {
    expect(await failureOf(() => new Response("gone", { status: 410 }))).toMatchObject({ ok: false, retryable: false });
    expect(
      await failureOf(() => new Response("{}", { headers: { "Content-Type": "application/json" } })),
    ).toMatchObject({ ok: false, retryable: false });
    expect(
      await failureOf(() => new Response("x", { headers: { "Content-Type": "text/html; charset=EUC-JP" } })),
    ).toMatchObject({ ok: false, retryable: false });
    expect(
      await failureOf(() => new Response(null, { status: 301, headers: { Location: "https://other.example.com/" } })),
    ).toMatchObject({ ok: false, retryable: false });
    expect(
      await failureOf(() => new Response(null, { status: 301, headers: { Location: `${ORIGIN}/page` } })),
    ).toMatchObject({ ok: false, retryable: false });
  });
});
