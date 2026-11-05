import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Article, ArticleSummary, RecordList, SiteRecord, TagList } from "../src/api/types";
import { createDb } from "../src/db/client";
import { newArticleId, newRecordId, newSiteId } from "../src/ids";
import { createRecord, listRecords } from "../src/records/records";
import {
  MAX_ARTICLES_PER_RECORD,
  MAX_ARTICLES_PER_SITE,
  MAX_RECORDS_PER_SITE,
} from "../src/records/validate";
import {
  countTable,
  createSite,
  createUser,
  d1RecordingLargeBinds,
  login,
  resetDb,
  send,
  type SessionCookies,
} from "./helpers";

let cookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  const member = await createUser({ email: "member@example.com" });
  cookies = await login(member.email);
});

const MISSING_SITE = newSiteId(Date.UTC(2026, 0, 1));
const MISSING_ARTICLE = newArticleId(Date.UTC(2026, 0, 1));
const MISSING_RECORD = newRecordId(Date.UTC(2026, 0, 1));

async function expectError(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(body.error.message).toEqual(expect.any(String));
}

function post(path: string, json: unknown): Promise<Response> {
  return send(path, { cookies, json });
}

function patch(path: string, json: unknown): Promise<Response> {
  return send(path, { method: "PATCH", cookies, json });
}

function get(path: string): Promise<Response> {
  return send(path, { cookies });
}

async function newArticle(siteId: string, json: Record<string, unknown> = {}): Promise<Article> {
  const res = await post(`/api/v1/sites/${siteId}/articles`, { title: "Article", ...json });
  expect(res.status).toBe(201);
  return (await res.json()) as Article;
}

async function newRecord(siteId: string, json: Record<string, unknown> = {}): Promise<SiteRecord> {
  const res = await post(`/api/v1/sites/${siteId}/records`, { kind: "action", title: "Record", ...json });
  expect(res.status).toBe(201);
  return (await res.json()) as SiteRecord;
}

async function listOf(path: string): Promise<RecordList> {
  const res = await get(path);
  expect(res.status).toBe(200);
  return (await res.json()) as RecordList;
}

describe("authentication", () => {
  it("returns 401 without a session on every new path", async () => {
    const site = await createSite();
    const requests = [
      send(`/api/v1/sites/${site.id}/articles`),
      send(`/api/v1/sites/${site.id}/articles`, { json: { title: "a" } }),
      send(`/api/v1/sites/${site.id}/records`),
      send(`/api/v1/sites/${site.id}/records`, { json: { kind: "note", title: "a" } }),
      send(`/api/v1/sites/${site.id}/tags`),
      send(`/api/v1/articles/${MISSING_ARTICLE}`),
      send(`/api/v1/articles/${MISSING_ARTICLE}`, { method: "PATCH", json: { title: "a" } }),
      send(`/api/v1/articles/${MISSING_ARTICLE}`, { method: "DELETE" }),
      send(`/api/v1/records/${MISSING_RECORD}`),
      send(`/api/v1/records/${MISSING_RECORD}`, { method: "PATCH", json: { title: "a" } }),
      send(`/api/v1/records/${MISSING_RECORD}`, { method: "DELETE" }),
    ];
    for (const res of await Promise.all(requests)) await expectError(res, 401, "unauthorized");
    expect(await countTable("articles")).toBe(0);
    expect(await countTable("records")).toBe(0);
  });
});

describe("articles", () => {
  it("creates, reads, changes and deletes an article", async () => {
    const site = await createSite();
    const article = await newArticle(site.id, {
      title: "  First  ",
      url: "https://example.com/a?x=1#top",
      published_on: "2026-10-01",
      tags: ["stage:draft", " topic:ai ", "stage:draft"],
      note: "line1\r\nline2",
    });
    expect(article).toMatchObject({
      site_id: site.id,
      title: "First",
      url: "https://example.com/a?x=1",
      published_on: "2026-10-01",
      tags: ["stage:draft", "topic:ai"],
      note: "line1\nline2",
    });
    expect(article.id).toMatch(/^art_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(article.created_at).toBe(article.updated_at);

    expect(await (await get(`/api/v1/articles/${article.id}`)).json()).toEqual(article);

    const changed = await patch(`/api/v1/articles/${article.id}`, { url: null, published_on: null, tags: [] });
    expect(changed.status).toBe(200);
    const body = (await changed.json()) as Article;
    expect(body).toMatchObject({ title: "First", url: null, published_on: null, tags: [], note: "line1\nline2" });
    expect(body.updated_at).toBeGreaterThanOrEqual(article.updated_at);
    expect(body.created_at).toBe(article.created_at);

    expect((await send(`/api/v1/articles/${article.id}`, { method: "DELETE", cookies })).status).toBe(204);
    await expectError(await get(`/api/v1/articles/${article.id}`), 404, "not_found");
    await expectError(await send(`/api/v1/articles/${article.id}`, { method: "DELETE", cookies }), 404, "not_found");
  });

  it("succeeds with the same values and sets updated_at", async () => {
    const site = await createSite();
    const article = await newArticle(site.id, { title: "Same" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await patch(`/api/v1/articles/${article.id}`, { title: "Same" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Article).updated_at).toBeGreaterThan(article.updated_at);
  });

  it("rejects invalid input", async () => {
    const site = await createSite();
    const article = await newArticle(site.id);
    const cases: [unknown, string][] = [
      ["not json", "invalid_body"],
      [{}, "invalid_title"],
      [{ title: "a", url: "ftp://example.com/" }, "invalid_url"],
      [{ title: "a", published_on: "2026-02-30" }, "invalid_date"],
      [{ title: "a", tags: "a" }, "invalid_tags"],
      [{ title: "a", note: 1 }, "invalid_note"],
      [{ title: "a", site_id: site.id }, "unknown_field"],
    ];
    for (const [json, code] of cases) await expectError(await post(`/api/v1/sites/${site.id}/articles`, json), 400, code);
    await expectError(await patch(`/api/v1/articles/${article.id}`, {}), 400, "invalid_request");
    for (const key of ["id", "site_id", "created_at"]) {
      await expectError(await patch(`/api/v1/articles/${article.id}`, { [key]: "x" }), 400, "unknown_field");
    }
  });

  it("answers 404 for a missing site or article and for malformed IDs", async () => {
    for (const id of [MISSING_SITE, "site_bad"]) {
      await expectError(await post(`/api/v1/sites/${id}/articles`, { title: "a" }), 404, "not_found");
      await expectError(await get(`/api/v1/sites/${id}/articles`), 404, "not_found");
    }
    for (const id of [MISSING_ARTICLE, "art_bad", "x"]) {
      await expectError(await get(`/api/v1/articles/${id}`), 404, "not_found");
      await expectError(await patch(`/api/v1/articles/${id}`, { title: "a" }), 404, "not_found");
    }
  });

  it("rejects a URL used by another article of the same site", async () => {
    const site = await createSite();
    const other = await createSite();
    const first = await newArticle(site.id, { url: "https://example.com/a" });
    await expectError(await post(`/api/v1/sites/${site.id}/articles`, { title: "b", url: "https://example.com/a#x" }), 409, "url_conflict");
    // Another site may use the same URL, and several articles may have none.
    await newArticle(other.id, { url: "https://example.com/a" });
    await newArticle(site.id);
    const second = await newArticle(site.id);
    await expectError(await patch(`/api/v1/articles/${second.id}`, { url: "https://example.com/a" }), 409, "url_conflict");
    expect((await patch(`/api/v1/articles/${first.id}`, { url: "https://example.com/a" })).status).toBe(200);
  });

  it("stops at the limit of articles per site", async () => {
    const site = await createSite();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO articles (id, site_id, title, tags, note, created_at, updated_at)
      SELECT printf('art_%026d', i), ?, 'a' || i, '[]', '', 0, 0 FROM n`,
    )
      .bind(MAX_ARTICLES_PER_SITE - 1, site.id)
      .run();
    await newArticle(site.id);
    await expectError(await post(`/api/v1/sites/${site.id}/articles`, { title: "over" }), 409, "limit_exceeded");
    expect(await countTable("articles")).toBe(MAX_ARTICLES_PER_SITE);
    // Another site is not affected.
    await newArticle((await createSite()).id);
  });

  it("lists the articles unpublished first, then the newest, filtered by a tag", async () => {
    const site = await createSite();
    const old = await newArticle(site.id, { title: "old", published_on: "2026-01-01", tags: ["a"] });
    const recent = await newArticle(site.id, { title: "recent", published_on: "2026-06-01", note: "long" });
    const draft = await newArticle(site.id, { title: "draft", tags: ["a", "b"] });
    await newArticle((await createSite()).id, { tags: ["a"] });

    const res = await get(`/api/v1/sites/${site.id}/articles`);
    expect(res.status).toBe(200);
    const { articles } = (await res.json()) as { articles: ArticleSummary[] };
    expect(articles.map((a) => a.id)).toEqual([draft.id, recent.id, old.id]);
    expect(articles[1]).not.toHaveProperty("note");

    const tagged = (await (await get(`/api/v1/sites/${site.id}/articles?tag=%20a%20`)).json()) as {
      articles: ArticleSummary[];
    };
    expect(tagged.articles.map((a) => a.id)).toEqual([draft.id, old.id]);
    await expectError(await get(`/api/v1/sites/${site.id}/articles?tag=a,b`), 400, "invalid_query");
  });
});

describe("records", () => {
  it("creates, reads, changes and deletes a record with its articles", async () => {
    const site = await createSite();
    const b = await newArticle(site.id, { title: "B", url: "https://example.com/b" });
    const a = await newArticle(site.id, { title: "A" });
    const record = await newRecord(site.id, {
      kind: "review",
      title: " Review ",
      date: "2026-10-31",
      period_start: "2026-10-01",
      period_end: "2026-10-31",
      tags: ["x"],
      content: "  indented\r\n",
      article_ids: [b.id, a.id, b.id],
    });
    expect(record).toMatchObject({
      site_id: site.id,
      kind: "review",
      status: "done",
      title: "Review",
      date: "2026-10-31",
      period_start: "2026-10-01",
      period_end: "2026-10-31",
      tags: ["x"],
      content: "  indented\n",
      articles: [
        { id: a.id, title: "A", url: null },
        { id: b.id, title: "B", url: "https://example.com/b" },
      ],
    });
    expect(record.id).toMatch(/^rec_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await (await get(`/api/v1/records/${record.id}`)).json()).toEqual(record);

    // article_ids replaces the whole set, and a PATCH of it alone sets updated_at.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await patch(`/api/v1/records/${record.id}`, { article_ids: [b.id] });
    expect(res.status).toBe(200);
    const changed = (await res.json()) as SiteRecord;
    expect(changed.articles.map((x) => x.id)).toEqual([b.id]);
    expect(changed.updated_at).toBeGreaterThan(record.updated_at);
    expect(changed.content).toBe("  indented\n");
    const cleared = (await (await patch(`/api/v1/records/${record.id}`, { article_ids: [] })).json()) as SiteRecord;
    expect(cleared.articles).toEqual([]);
    expect(await countTable("record_articles")).toBe(0);

    expect((await send(`/api/v1/records/${record.id}`, { method: "DELETE", cookies })).status).toBe(204);
    await expectError(await get(`/api/v1/records/${record.id}`), 404, "not_found");
    await expectError(await send(`/api/v1/records/${record.id}`, { method: "DELETE", cookies }), 404, "not_found");
  });

  it("checks the period of a PATCH against the stored other end", async () => {
    const site = await createSite();
    const record = await newRecord(site.id, { period_start: "2026-10-01", period_end: "2026-10-31" });
    expect((await patch(`/api/v1/records/${record.id}`, { period_end: "2026-11-30" })).status).toBe(200);
    await expectError(await patch(`/api/v1/records/${record.id}`, { period_end: "2026-09-30" }), 400, "invalid_period");
    await expectError(await patch(`/api/v1/records/${record.id}`, { period_start: null }), 400, "invalid_period");
    const both = await patch(`/api/v1/records/${record.id}`, { period_start: null, period_end: "" });
    expect(((await both.json()) as SiteRecord).period_start).toBeNull();
    const plain = await newRecord(site.id);
    await expectError(await patch(`/api/v1/records/${plain.id}`, { period_start: "2026-01-01" }), 400, "invalid_period");
  });

  it("rejects invalid input", async () => {
    const site = await createSite();
    const record = await newRecord(site.id);
    const cases: [unknown, string][] = [
      [{ title: "a" }, "invalid_kind"],
      [{ kind: "note" }, "invalid_title"],
      [{ kind: "note", title: "a", status: "x" }, "invalid_status"],
      [{ kind: "note", title: "a", date: "x" }, "invalid_date"],
      [{ kind: "note", title: "a", content: "\u0000" }, "invalid_content"],
      [{ kind: "note", title: "a", article_ids: ["x"] }, "invalid_articles"],
      [{ kind: "note", title: "a", article_ids: [MISSING_ARTICLE] }, "invalid_articles"],
      [{ kind: "note", title: "a", unknown: 1 }, "unknown_field"],
    ];
    for (const [json, code] of cases) await expectError(await post(`/api/v1/sites/${site.id}/records`, json), 400, code);
    await expectError(await patch(`/api/v1/records/${record.id}`, {}), 400, "invalid_request");
    await expectError(await patch(`/api/v1/records/${record.id}`, { site_id: site.id }), 400, "unknown_field");
    for (const id of [MISSING_RECORD, "rec_bad"]) {
      await expectError(await patch(`/api/v1/records/${id}`, { title: "a" }), 404, "not_found");
      await expectError(await get(`/api/v1/records/${id}`), 404, "not_found");
    }
    await expectError(await post(`/api/v1/sites/${MISSING_SITE}/records`, { kind: "note", title: "a" }), 404, "not_found");
    await expectError(
      await post(`/api/v1/sites/${MISSING_SITE}/records`, { kind: "note", title: "a", article_ids: [MISSING_ARTICLE] }),
      404,
      "not_found",
    );
  });

  it("rejects articles of another site and more than the limit", async () => {
    const site = await createSite();
    const other = await createSite();
    const foreign = await newArticle(other.id);
    await expectError(
      await post(`/api/v1/sites/${site.id}/records`, { kind: "note", title: "a", article_ids: [foreign.id] }),
      400,
      "invalid_articles",
    );
    const record = await newRecord(site.id);
    await expectError(await patch(`/api/v1/records/${record.id}`, { article_ids: [foreign.id] }), 400, "invalid_articles");
    const own = [];
    for (let i = 0; i <= MAX_ARTICLES_PER_RECORD; i++) own.push((await newArticle(site.id)).id);
    await expectError(await patch(`/api/v1/records/${record.id}`, { article_ids: own }), 400, "invalid_articles");
    expect((await patch(`/api/v1/records/${record.id}`, { article_ids: own.slice(0, MAX_ARTICLES_PER_RECORD) })).status).toBe(
      200,
    );
    expect(await countTable("record_articles")).toBe(MAX_ARTICLES_PER_RECORD);
  });

  it("stops at the limit of records per site and writes no links", async () => {
    const site = await createSite();
    const article = await newArticle(site.id);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO records (id, site_id, kind, status, title, tags, content, created_at, updated_at)
      SELECT printf('rec_%026d', i), ?, 'note', 'done', 'r' || i, '[]', '', 0, 0 FROM n`,
    )
      .bind(MAX_RECORDS_PER_SITE, site.id)
      .run();
    await expectError(
      await post(`/api/v1/sites/${site.id}/records`, { kind: "note", title: "over", article_ids: [article.id] }),
      409,
      "limit_exceeded",
    );
    expect(await countTable("records")).toBe(MAX_RECORDS_PER_SITE);
    expect(await countTable("record_articles")).toBe(0);
  });

  it("filters and pages the records, undated first, then the newest", async () => {
    const site = await createSite();
    const article = await newArticle(site.id);
    const foreign = await newArticle((await createSite()).id);
    const undated = await newRecord(site.id, { kind: "note", status: "planned", tags: ["t"] });
    const r1 = await newRecord(site.id, { kind: "action", date: "2026-01-01", article_ids: [article.id] });
    const r2 = await newRecord(site.id, { kind: "review", date: "2026-02-01", tags: ["t"] });
    const r3 = await newRecord(site.id, { kind: "action", date: "2026-02-01", status: "canceled" });
    const base = `/api/v1/sites/${site.id}/records`;

    const all = await listOf(base);
    expect(all.records.map((r) => r.id)).toEqual([undated.id, r3.id, r2.id, r1.id]);
    expect(all.next_offset).toBeNull();
    expect(all.records[3]).toMatchObject({ articles: [{ id: article.id, title: "Article" }] });
    expect(all.records[0]).not.toHaveProperty("content");

    const first = await listOf(`${base}?limit=2`);
    expect(first.records.map((r) => r.id)).toEqual([undated.id, r3.id]);
    expect(first.next_offset).toBe(2);
    const second = await listOf(`${base}?limit=2&offset=2`);
    expect(second.records.map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(second.next_offset).toBeNull();

    expect((await listOf(`${base}?kind=action`)).records.map((r) => r.id)).toEqual([r3.id, r1.id]);
    expect((await listOf(`${base}?status=planned`)).records.map((r) => r.id)).toEqual([undated.id]);
    expect((await listOf(`${base}?tag=t`)).records.map((r) => r.id)).toEqual([undated.id, r2.id]);
    expect((await listOf(`${base}?article_id=${article.id}`)).records.map((r) => r.id)).toEqual([r1.id]);
    expect((await listOf(`${base}?article_id=${foreign.id}`)).records).toEqual([]);
    expect((await listOf(`${base}?article_id=${MISSING_ARTICLE}`)).records).toEqual([]);
    expect((await listOf(`${base}?date_from=2026-01-15`)).records.map((r) => r.id)).toEqual([r3.id, r2.id]);
    expect((await listOf(`${base}?date_to=2026-01-01`)).records.map((r) => r.id)).toEqual([r1.id]);
    expect((await listOf(`${base}?unknown=1`)).records).toHaveLength(4);

    for (const query of [
      "kind=x",
      "status=x",
      "tag=",
      "article_id=x",
      "date_from=x",
      "date_from=2026-02-02&date_to=2026-02-01",
      "limit=0",
      "limit=101",
      "limit=1.5",
      "offset=-1",
      `offset=${MAX_RECORDS_PER_SITE + 1}`,
    ]) {
      await expectError(await get(`${base}?${query}`), 400, "invalid_query");
    }
    await expectError(await get(`/api/v1/sites/${MISSING_SITE}/records`), 404, "not_found");
  });

  it("binds the IDs of a page of 100 records as one value", async () => {
    const site = await createSite();
    const article = await newArticle(site.id);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 101)
      INSERT INTO records (id, site_id, kind, status, title, tags, content, created_at, updated_at)
      SELECT printf('rec_%026d', i), ?, 'note', 'done', 'r' || i, '[]', '', 0, 0 FROM n`,
    )
      .bind(site.id)
      .run();
    await env.DB.prepare("INSERT INTO record_articles (record_id, article_id) SELECT id, ? FROM records").bind(article.id).run();
    const { d1, large } = d1RecordingLargeBinds();
    const result = await listRecords(d1, site.id, {}, { limit: 100, offset: 0 });
    expect(result?.records).toHaveLength(100);
    expect(result?.records.every((r) => r.articles.length === 1)).toBe(true);
    expect(result?.nextOffset).toBe(100);
    expect(large).toEqual([]);
    // The creation with links binds the IDs as one value too.
    const created = await createRecord(
      createDb(d1),
      site.id,
      {
        kind: "note",
        status: "done",
        title: "linked",
        date: null,
        periodStart: null,
        periodEnd: null,
        tags: [],
        content: "",
        articleIds: [article.id],
      },
      Date.now(),
    );
    expect(created.ok && created.value.articles.map((a) => a.id)).toEqual([article.id]);
    expect(large).toEqual([]);
  });
});

describe("GET /api/v1/sites/:id/tags", () => {
  it("counts the articles and records of each tag, the most used first", async () => {
    const site = await createSite();
    await newArticle(site.id, { tags: ["a", "b"] });
    await newArticle(site.id, { tags: ["b"] });
    await newRecord(site.id, { tags: ["b", "c"] });
    await newRecord(site.id, { tags: ["a"] });
    await newArticle((await createSite()).id, { tags: ["z"] });
    const res = await get(`/api/v1/sites/${site.id}/tags`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tags: [
        { tag: "b", articles: 2, records: 1 },
        { tag: "a", articles: 1, records: 1 },
        { tag: "c", articles: 0, records: 1 },
      ],
      truncated: false,
    } satisfies TagList);
    await expectError(await get(`/api/v1/sites/${MISSING_SITE}/tags`), 404, "not_found");
  });

  it("returns 200 tags and marks the rest as truncated", async () => {
    const site = await createSite();
    for (let i = 0; i < 11; i++) {
      await newArticle(site.id, { tags: Array.from({ length: 20 }, (_, j) => `t${String(i * 20 + j).padStart(3, "0")}`) });
    }
    const body = (await (await get(`/api/v1/sites/${site.id}/tags`)).json()) as TagList;
    expect(body.tags).toHaveLength(200);
    expect(body.tags[0]?.tag).toBe("t000");
    expect(body.truncated).toBe(true);
  });
});

describe("cascade", () => {
  it("deletes the articles, records and links with the site", async () => {
    const site = await createSite();
    const other = await createSite();
    const article = await newArticle(site.id);
    await newRecord(site.id, { article_ids: [article.id] });
    const kept = await newArticle(other.id);
    await newRecord(other.id, { article_ids: [kept.id] });
    expect((await send(`/api/v1/sites/${site.id}`, { method: "DELETE", cookies })).status).toBe(204);
    expect(await countTable("articles")).toBe(1);
    expect(await countTable("records")).toBe(1);
    expect(await countTable("record_articles")).toBe(1);
  });

  it("keeps the record and removes the link when an article is deleted", async () => {
    const site = await createSite();
    const a = await newArticle(site.id);
    const b = await newArticle(site.id);
    const record = await newRecord(site.id, { article_ids: [a.id, b.id] });
    expect((await send(`/api/v1/articles/${a.id}`, { method: "DELETE", cookies })).status).toBe(204);
    const left = (await (await get(`/api/v1/records/${record.id}`)).json()) as SiteRecord;
    expect(left.articles.map((x) => x.id)).toEqual([b.id]);
    expect(await countTable("record_articles")).toBe(1);
  });

  it("removes the links when a record is deleted", async () => {
    const site = await createSite();
    const article = await newArticle(site.id);
    const record = await newRecord(site.id, { article_ids: [article.id] });
    expect((await send(`/api/v1/records/${record.id}`, { method: "DELETE", cookies })).status).toBe(204);
    expect(await countTable("record_articles")).toBe(0);
    expect(await countTable("articles")).toBe(1);
  });
});
