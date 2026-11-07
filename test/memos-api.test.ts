import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Article, ArticleSummary, Memo, MemoList, TagList } from "../src/api/types";
import { createDb } from "@i2bskn/workers-app-core";
import { newArticleId, newMemoId, newSiteId } from "../src/ids";
import { createMemo, listMemos } from "../src/records/memos";
import { MAX_ARTICLES_PER_MEMO, MAX_ARTICLES_PER_SITE, MAX_MEMOS_PER_SITE } from "../src/records/validate";
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
const MISSING_MEMO = newMemoId(Date.UTC(2026, 0, 1));

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

async function newMemo(siteId: string, json: Record<string, unknown> = {}): Promise<Memo> {
  const res = await post(`/api/v1/sites/${siteId}/memos`, { title: "Memo", ...json });
  expect(res.status).toBe(201);
  return (await res.json()) as Memo;
}

async function listOf(path: string): Promise<MemoList> {
  const res = await get(path);
  expect(res.status).toBe(200);
  return (await res.json()) as MemoList;
}

async function setCreatedAt(memoId: string, createdAt: number): Promise<void> {
  await env.DB.prepare("UPDATE memos SET created_at = ? WHERE id = ?").bind(createdAt, memoId).run();
}

describe("authentication", () => {
  it("returns 401 without a session on every new path", async () => {
    const site = await createSite();
    const requests = [
      send(`/api/v1/sites/${site.id}/articles`),
      send(`/api/v1/sites/${site.id}/articles`, { json: { title: "a" } }),
      send(`/api/v1/sites/${site.id}/memos`),
      send(`/api/v1/sites/${site.id}/memos`, { json: { title: "a" } }),
      send(`/api/v1/sites/${site.id}/tags`),
      send(`/api/v1/articles/${MISSING_ARTICLE}`),
      send(`/api/v1/articles/${MISSING_ARTICLE}`, { method: "PATCH", json: { title: "a" } }),
      send(`/api/v1/articles/${MISSING_ARTICLE}`, { method: "DELETE" }),
      send(`/api/v1/memos/${MISSING_MEMO}`),
      send(`/api/v1/memos/${MISSING_MEMO}`, { method: "PATCH", json: { title: "a" } }),
      send(`/api/v1/memos/${MISSING_MEMO}`, { method: "DELETE" }),
    ];
    for (const res of await Promise.all(requests)) await expectError(res, 401, "unauthorized");
    expect(await countTable("articles")).toBe(0);
    expect(await countTable("memos")).toBe(0);
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

describe("memos", () => {
  it("creates, reads, changes and deletes a memo with its articles", async () => {
    const site = await createSite();
    const b = await newArticle(site.id, { title: "B", url: "https://example.com/b" });
    const a = await newArticle(site.id, { title: "A" });
    const memo = await newMemo(site.id, {
      title: " GA4 のタグを変更 ",
      tags: ["計測"],
      content: "  indented\r\n",
      article_ids: [b.id, a.id, b.id],
    });
    expect(memo).toMatchObject({
      site_id: site.id,
      title: "GA4 のタグを変更",
      tags: ["計測"],
      content: "  indented\n",
      articles: [
        { id: a.id, title: "A", url: null },
        { id: b.id, title: "B", url: "https://example.com/b" },
      ],
    });
    expect(Object.keys(memo).sort()).toEqual(
      ["articles", "content", "created_at", "id", "site_id", "tags", "title", "updated_at"].sort(),
    );
    expect(memo.id).toMatch(/^memo_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(memo.created_at).toBe(memo.updated_at);
    expect(await (await get(`/api/v1/memos/${memo.id}`)).json()).toEqual(memo);

    // article_ids replaces the whole set, and a PATCH of it alone sets updated_at.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await patch(`/api/v1/memos/${memo.id}`, { article_ids: [b.id] });
    expect(res.status).toBe(200);
    const changed = (await res.json()) as Memo;
    expect(changed.articles.map((x) => x.id)).toEqual([b.id]);
    expect(changed.updated_at).toBeGreaterThan(memo.updated_at);
    expect(changed.created_at).toBe(memo.created_at);
    expect(changed.content).toBe("  indented\n");
    const edited = (await (await patch(`/api/v1/memos/${memo.id}`, { title: "New", content: "", tags: [] })).json()) as Memo;
    expect(edited).toMatchObject({ title: "New", content: "", tags: [] });
    const cleared = (await (await patch(`/api/v1/memos/${memo.id}`, { article_ids: [] })).json()) as Memo;
    expect(cleared.articles).toEqual([]);
    expect(await countTable("memo_articles")).toBe(0);

    expect((await send(`/api/v1/memos/${memo.id}`, { method: "DELETE", cookies })).status).toBe(204);
    await expectError(await get(`/api/v1/memos/${memo.id}`), 404, "not_found");
    await expectError(await send(`/api/v1/memos/${memo.id}`, { method: "DELETE", cookies }), 404, "not_found");
  });

  it("creates a memo with the title alone", async () => {
    const site = await createSite();
    const memo = await newMemo(site.id, { title: "Only" });
    expect(memo).toMatchObject({ title: "Only", content: "", tags: [], articles: [] });
  });

  it("rejects invalid input", async () => {
    const site = await createSite();
    const memo = await newMemo(site.id);
    const cases: [unknown, string][] = [
      ["not json", "invalid_body"],
      [{}, "invalid_title"],
      [{ title: "" }, "invalid_title"],
      [{ title: "a", content: "\u0000" }, "invalid_content"],
      [{ title: "a", tags: "a" }, "invalid_tags"],
      [{ title: "a", article_ids: ["x"] }, "invalid_articles"],
      [{ title: "a", article_ids: [MISSING_ARTICLE] }, "invalid_articles"],
      [{ title: "a", unknown: 1 }, "unknown_field"],
    ];
    for (const [json, code] of cases) await expectError(await post(`/api/v1/sites/${site.id}/memos`, json), 400, code);
    await expectError(await patch(`/api/v1/memos/${memo.id}`, {}), 400, "invalid_request");
    await expectError(await patch(`/api/v1/memos/${memo.id}`, { site_id: site.id }), 400, "unknown_field");
    for (const id of [MISSING_MEMO, "memo_bad", "rec_01JC9Z8Q4R6T2V7W3X5Y1A0B2C"]) {
      await expectError(await patch(`/api/v1/memos/${id}`, { title: "a" }), 404, "not_found");
      await expectError(await get(`/api/v1/memos/${id}`), 404, "not_found");
      await expectError(await send(`/api/v1/memos/${id}`, { method: "DELETE", cookies }), 404, "not_found");
    }
    await expectError(await post(`/api/v1/sites/${MISSING_SITE}/memos`, { title: "a" }), 404, "not_found");
    await expectError(
      await post(`/api/v1/sites/${MISSING_SITE}/memos`, { title: "a", article_ids: [MISSING_ARTICLE] }),
      404,
      "not_found",
    );
  });

  it.each(["kind", "status", "date", "period_start", "period_end"])("rejects the old item %s", async (key) => {
    const site = await createSite();
    const memo = await newMemo(site.id);
    await expectError(await post(`/api/v1/sites/${site.id}/memos`, { title: "a", [key]: null }), 400, "unknown_field");
    await expectError(await patch(`/api/v1/memos/${memo.id}`, { [key]: null }), 400, "unknown_field");
    expect(await countTable("memos")).toBe(1);
  });

  it("does not serve the old paths of the records", async () => {
    const site = await createSite();
    await expectError(await get(`/api/v1/sites/${site.id}/records`), 404, "not_found");
    await expectError(await post(`/api/v1/sites/${site.id}/records`, { title: "a" }), 404, "not_found");
    await expectError(await get(`/api/v1/records/${MISSING_MEMO}`), 404, "not_found");
    await expectError(await get("/api/v1/records"), 404, "not_found");
  });

  it("rejects articles of another site and more than the limit", async () => {
    const site = await createSite();
    const other = await createSite();
    const foreign = await newArticle(other.id);
    await expectError(
      await post(`/api/v1/sites/${site.id}/memos`, { title: "a", article_ids: [foreign.id] }),
      400,
      "invalid_articles",
    );
    const memo = await newMemo(site.id);
    await expectError(await patch(`/api/v1/memos/${memo.id}`, { article_ids: [foreign.id] }), 400, "invalid_articles");
    const own = [];
    for (let i = 0; i <= MAX_ARTICLES_PER_MEMO; i++) own.push((await newArticle(site.id)).id);
    await expectError(await patch(`/api/v1/memos/${memo.id}`, { article_ids: own }), 400, "invalid_articles");
    expect((await patch(`/api/v1/memos/${memo.id}`, { article_ids: own.slice(0, MAX_ARTICLES_PER_MEMO) })).status).toBe(200);
    expect(await countTable("memo_articles")).toBe(MAX_ARTICLES_PER_MEMO);
  });

  it("stops at the limit of memos per site and writes no links", async () => {
    const site = await createSite();
    const article = await newArticle(site.id);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO memos (id, site_id, title, tags, content, created_at, updated_at)
      SELECT printf('memo_%026d', i), ?, 'm' || i, '[]', '', 0, 0 FROM n`,
    )
      .bind(MAX_MEMOS_PER_SITE, site.id)
      .run();
    await expectError(
      await post(`/api/v1/sites/${site.id}/memos`, { title: "over", article_ids: [article.id] }),
      409,
      "limit_exceeded",
    );
    expect(await countTable("memos")).toBe(MAX_MEMOS_PER_SITE);
    expect(await countTable("memo_articles")).toBe(0);
    // Another site is not affected.
    await newMemo((await createSite()).id);
  });

  it("filters and pages the memos, the newest first", async () => {
    const site = await createSite();
    const article = await newArticle(site.id);
    const foreign = await newArticle((await createSite()).id);
    const m1 = await newMemo(site.id, { tags: ["t"] });
    const m2 = await newMemo(site.id, { article_ids: [article.id] });
    const m3 = await newMemo(site.id, { tags: ["t"] });
    const m4 = await newMemo(site.id);
    // m3 and m4 share a time, so the ID decides between them.
    await setCreatedAt(m1.id, Date.parse("2026-10-01T00:00:00Z"));
    await setCreatedAt(m2.id, Date.parse("2026-10-02T00:00:00Z"));
    await setCreatedAt(m3.id, Date.parse("2026-10-03T00:00:00Z"));
    await setCreatedAt(m4.id, Date.parse("2026-10-03T00:00:00Z"));
    // The newest memo by ID is the oldest by time: the order is by created_at.
    const old = await newMemo(site.id);
    await setCreatedAt(old.id, Date.parse("2026-09-01T00:00:00Z"));
    const base = `/api/v1/sites/${site.id}/memos`;

    const all = await listOf(base);
    expect(all.memos.map((m) => m.id)).toEqual([m4.id, m3.id, m2.id, m1.id, old.id]);
    expect(all.next_offset).toBeNull();
    expect(all.memos[2]).toMatchObject({ articles: [{ id: article.id, title: "Article" }] });
    expect(all.memos[0]).not.toHaveProperty("content");

    const first = await listOf(`${base}?limit=2`);
    expect(first.memos.map((m) => m.id)).toEqual([m4.id, m3.id]);
    expect(first.next_offset).toBe(2);
    const second = await listOf(`${base}?limit=2&offset=2`);
    expect(second.memos.map((m) => m.id)).toEqual([m2.id, m1.id]);
    expect(second.next_offset).toBe(4);

    expect((await listOf(`${base}?tag=t`)).memos.map((m) => m.id)).toEqual([m3.id, m1.id]);
    expect((await listOf(`${base}?article_id=${article.id}`)).memos.map((m) => m.id)).toEqual([m2.id]);
    expect((await listOf(`${base}?article_id=${foreign.id}`)).memos).toEqual([]);
    expect((await listOf(`${base}?article_id=${MISSING_ARTICLE}`)).memos).toEqual([]);
    expect((await listOf(`${base}?unknown=1`)).memos).toHaveLength(5);

    // created_after includes its time; created_before does not.
    const after = encodeURIComponent("2026-10-02T09:00:00+09:00");
    const before = encodeURIComponent("2026-10-03T00:00:00Z");
    expect((await listOf(`${base}?created_after=${after}`)).memos.map((m) => m.id)).toEqual([m4.id, m3.id, m2.id]);
    expect((await listOf(`${base}?created_before=${before}`)).memos.map((m) => m.id)).toEqual([m2.id, m1.id, old.id]);
    expect((await listOf(`${base}?created_after=${after}&created_before=${before}`)).memos.map((m) => m.id)).toEqual([
      m2.id,
    ]);
    const justAfter = encodeURIComponent("2026-10-02T00:00:00.001Z");
    expect((await listOf(`${base}?created_after=${justAfter}&created_before=${before}`)).memos).toEqual([]);

    for (const query of [
      "tag=",
      "article_id=x",
      "created_after=2026-10-01T00:00:00",
      "created_after=2026-10-01",
      "created_before=2026-10-01t00:00:00Z",
      "created_before=x",
      `created_after=${before}&created_before=${before}`,
      `created_after=${before}&created_before=${after}`,
      "limit=0",
      "limit=101",
      "limit=1.5",
      "offset=-1",
      `offset=${MAX_MEMOS_PER_SITE + 1}`,
    ]) {
      await expectError(await get(`${base}?${query}`), 400, "invalid_query");
    }
    await expectError(await get(`/api/v1/sites/${MISSING_SITE}/memos`), 404, "not_found");
  });

  it("binds the IDs of a page of 100 memos as one value", async () => {
    const site = await createSite();
    const article = await newArticle(site.id);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 101)
      INSERT INTO memos (id, site_id, title, tags, content, created_at, updated_at)
      SELECT printf('memo_%026d', i), ?, 'm' || i, '[]', '', 0, 0 FROM n`,
    )
      .bind(site.id)
      .run();
    await env.DB.prepare("INSERT INTO memo_articles (memo_id, article_id) SELECT id, ? FROM memos").bind(article.id).run();
    const { d1, large } = d1RecordingLargeBinds();
    const result = await listMemos(d1, site.id, {}, { limit: 100, offset: 0 });
    expect(result?.memos).toHaveLength(100);
    expect(result?.memos.every((m) => m.articles.length === 1)).toBe(true);
    expect(result?.nextOffset).toBe(100);
    expect(large).toEqual([]);
    // The creation with links binds the IDs as one value too.
    const created = await createMemo(
      createDb(d1),
      site.id,
      { title: "linked", tags: [], content: "", articleIds: [article.id] },
      Date.now(),
    );
    expect(created.ok && created.value.articles.map((a) => a.id)).toEqual([article.id]);
    expect(large).toEqual([]);
  });
});

describe("GET /api/v1/sites/:id/tags", () => {
  it("counts the articles and memos of each tag, the most used first", async () => {
    const site = await createSite();
    await newArticle(site.id, { tags: ["a", "b"] });
    await newArticle(site.id, { tags: ["b"] });
    await newMemo(site.id, { tags: ["b", "c"] });
    await newMemo(site.id, { tags: ["a"] });
    await newArticle((await createSite()).id, { tags: ["z"] });
    const res = await get(`/api/v1/sites/${site.id}/tags`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tags: [
        { tag: "b", articles: 2, memos: 1 },
        { tag: "a", articles: 1, memos: 1 },
        { tag: "c", articles: 0, memos: 1 },
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
  it("deletes the articles, memos and links with the site", async () => {
    const site = await createSite();
    const other = await createSite();
    const article = await newArticle(site.id);
    await newMemo(site.id, { article_ids: [article.id] });
    const kept = await newArticle(other.id);
    await newMemo(other.id, { article_ids: [kept.id] });
    expect((await send(`/api/v1/sites/${site.id}`, { method: "DELETE", cookies })).status).toBe(204);
    expect(await countTable("articles")).toBe(1);
    expect(await countTable("memos")).toBe(1);
    expect(await countTable("memo_articles")).toBe(1);
  });

  it("keeps the memo and removes the link when an article is deleted", async () => {
    const site = await createSite();
    const a = await newArticle(site.id);
    const b = await newArticle(site.id);
    const memo = await newMemo(site.id, { article_ids: [a.id, b.id] });
    expect((await send(`/api/v1/articles/${a.id}`, { method: "DELETE", cookies })).status).toBe(204);
    const left = (await (await get(`/api/v1/memos/${memo.id}`)).json()) as Memo;
    expect(left.articles.map((x) => x.id)).toEqual([b.id]);
    expect(await countTable("memo_articles")).toBe(1);
  });

  it("removes the links when a memo is deleted", async () => {
    const site = await createSite();
    const article = await newArticle(site.id);
    const memo = await newMemo(site.id, { article_ids: [article.id] });
    expect((await send(`/api/v1/memos/${memo.id}`, { method: "DELETE", cookies })).status).toBe(204);
    expect(await countTable("memo_articles")).toBe(0);
    expect(await countTable("articles")).toBe(1);
  });
});
