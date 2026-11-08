import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Article, ImportArticlesResponse, ReadSitemapResponse } from "../src/api/types";
import { newSiteId } from "../src/ids";
import { MAX_ARTICLES_PER_SITE } from "../src/records/validate";
import { createSite, createUser, login, resetDb, send, type SessionCookies } from "./helpers";

// The requests of the tests go to the Worker directly (not through fetch), so replacing the global fetch only
// replaces the requests that the Worker makes to the site.
const ORIGIN = "https://example.com";
const MISSING_SITE = newSiteId(Date.UTC(2026, 0, 1));

let cookies: SessionCookies;
let pages: Record<string, () => Response>;
let fetched: string[];

beforeEach(async () => {
  await resetDb();
  const member = await createUser({ email: "member@example.com" });
  cookies = await login(member.email);
  pages = {};
  fetched = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetched.push(url);
    const page = pages[url];
    return page ? page() : new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function xml(body: string): () => Response {
  return () => new Response(body, { headers: { "Content-Type": "application/xml" } });
}

function html(body: string, contentType = "text/html; charset=utf-8"): () => Response {
  return () => new Response(body, { headers: { "Content-Type": contentType } });
}

function urlset(...locs: string[]): string {
  return `<?xml version="1.0"?><urlset>${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`;
}

function post(path: string, json: unknown): Promise<Response> {
  return send(path, { cookies, json });
}

async function expectError(res: Response, status: number, code: string): Promise<string> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  return body.error.message;
}

async function newArticle(siteId: string, json: Record<string, unknown>): Promise<Article> {
  const res = await post(`/api/v1/sites/${siteId}/articles`, { title: "Article", ...json });
  expect(res.status).toBe(201);
  return (await res.json()) as Article;
}

// Inserts count articles without a URL.
async function fillArticles(siteId: string, count: number): Promise<void> {
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO articles (id, site_id, title, tags, note, created_at, updated_at)
    SELECT printf('art_%026d', i), ?, 'a' || i, '[]', '', 0, 0 FROM n`,
  )
    .bind(count, siteId)
    .run();
}

describe("authentication and the site", () => {
  it("returns 401 without a session", async () => {
    const site = await createSite({ url: ORIGIN });
    expect((await send(`/api/v1/sites/${site.id}/articles/sitemap`, { json: {} })).status).toBe(401);
    expect((await send(`/api/v1/sites/${site.id}/articles/import`, { json: { urls: [`${ORIGIN}/a`] } })).status).toBe(
      401,
    );
    expect(fetched).toEqual([]);
  });

  it("returns 404 for a missing site or a malformed ID", async () => {
    for (const id of [MISSING_SITE, "bad-id"]) {
      await expectError(await post(`/api/v1/sites/${id}/articles/sitemap`, {}), 404, "not_found");
      await expectError(await post(`/api/v1/sites/${id}/articles/import`, { urls: [`${ORIGIN}/a`] }), 404, "not_found");
    }
    expect(fetched).toEqual([]);
  });
});

describe("POST /api/v1/sites/:id/articles/sitemap", () => {
  it("reads the default sitemap and marks the registered URLs", async () => {
    const site = await createSite({ url: ORIGIN });
    await newArticle(site.id, { url: `${ORIGIN}/b`, published_on: "2026-01-01" });
    await newArticle(site.id, { url: `${ORIGIN}/d` });
    await newArticle(site.id, { title: "No URL" });
    pages[`${ORIGIN}/sitemap.xml`] = xml(
      `<?xml version="1.0"?><urlset><url><loc>${ORIGIN}/a</loc><lastmod>2026-10-01T00:00:00Z</lastmod></url>` +
        `<url><loc>${ORIGIN}/b</loc></url><url><loc>https://www.example.com/c</loc></url>` +
        `<url><loc>${ORIGIN}/d</loc></url></urlset>`,
    );
    const res = await post(`/api/v1/sites/${site.id}/articles/sitemap`, {});
    expect(res.status).toBe(200);
    expect((await res.json()) as ReadSitemapResponse).toEqual({
      sitemap_url: `${ORIGIN}/sitemap.xml`,
      urls: [
        { url: `${ORIGIN}/a`, lastmod: "2026-10-01", registered: false, undated: false },
        { url: `${ORIGIN}/b`, lastmod: null, registered: true, undated: false },
        // A registered article without a published date.
        { url: `${ORIGIN}/d`, lastmod: null, registered: true, undated: true },
      ],
      truncated: false,
      skipped_urls: 1,
      skipped_sitemaps: 0,
      // The article without a URL counts too.
      remaining: MAX_ARTICLES_PER_SITE - 3,
    });
    expect(fetched).toEqual([`${ORIGIN}/sitemap.xml`]);
  });

  it("uses the given sitemap_url and the default for null and blank", async () => {
    const site = await createSite({ url: ORIGIN });
    pages[`${ORIGIN}/posts-sitemap.xml`] = xml(urlset(`${ORIGIN}/posts/1`));
    pages[`${ORIGIN}/sitemap.xml`] = xml(urlset());
    const res = await post(`/api/v1/sites/${site.id}/articles/sitemap`, { sitemap_url: ` ${ORIGIN}/posts-sitemap.xml ` });
    expect(((await res.json()) as ReadSitemapResponse).urls.map((u) => u.url)).toEqual([`${ORIGIN}/posts/1`]);
    for (const sitemapUrl of [null, ""]) {
      const body = (await (
        await post(`/api/v1/sites/${site.id}/articles/sitemap`, { sitemap_url: sitemapUrl })
      ).json()) as ReadSitemapResponse;
      expect(body.sitemap_url).toBe(`${ORIGIN}/sitemap.xml`);
    }
  });

  it("rejects a sitemap_url of another origin, an invalid one and unknown fields", async () => {
    const site = await createSite({ url: ORIGIN });
    const message = await expectError(
      await post(`/api/v1/sites/${site.id}/articles/sitemap`, { sitemap_url: "https://www.example.com/sitemap.xml" }),
      400,
      "invalid_sitemap_url",
    );
    expect(message).toBe("サイトマップの URL は、サイトと同じ https://example.com で始まる URL にしてください");
    for (const sitemapUrl of ["ftp://example.com/sitemap.xml", "https://user:pass@example.com/sitemap.xml", 1]) {
      await expectError(
        await post(`/api/v1/sites/${site.id}/articles/sitemap`, { sitemap_url: sitemapUrl }),
        400,
        "invalid_sitemap_url",
      );
    }
    await expectError(await post(`/api/v1/sites/${site.id}/articles/sitemap`, { url: ORIGIN }), 400, "unknown_field");
    expect(fetched).toEqual([]);
  });

  it("returns 422 when the sitemap cannot be fetched or read", async () => {
    const site = await createSite({ url: ORIGIN });
    const message = await expectError(
      await post(`/api/v1/sites/${site.id}/articles/sitemap`, {}),
      422,
      "sitemap_unavailable",
    );
    expect(message).toBe("サイトマップを取得できませんでした（HTTP 404）");
    pages[`${ORIGIN}/sitemap.xml`] = html("<html></html>");
    await expectError(await post(`/api/v1/sites/${site.id}/articles/sitemap`, {}), 422, "sitemap_unreadable");
  });

  it("returns the first 5000 URLs with truncated", async () => {
    const site = await createSite({ url: ORIGIN });
    pages[`${ORIGIN}/sitemap.xml`] = xml(urlset(...Array.from({ length: 5001 }, (_, i) => `${ORIGIN}/p/${i}`)));
    const body = (await (await post(`/api/v1/sites/${site.id}/articles/sitemap`, {})).json()) as ReadSitemapResponse;
    expect(body.urls).toHaveLength(5000);
    expect(body.truncated).toBe(true);
  });

  it("returns 0 as remaining at the limit", async () => {
    const site = await createSite({ url: ORIGIN });
    await fillArticles(site.id, MAX_ARTICLES_PER_SITE);
    pages[`${ORIGIN}/sitemap.xml`] = xml(urlset(`${ORIGIN}/a`));
    const body = (await (await post(`/api/v1/sites/${site.id}/articles/sitemap`, {})).json()) as ReadSitemapResponse;
    expect(body.remaining).toBe(0);
  });
});

describe("POST /api/v1/sites/:id/articles/import", () => {
  it("creates the articles, reports the existing and failed ones in the order of the request", async () => {
    const site = await createSite({ url: ORIGIN });
    await newArticle(site.id, { url: `${ORIGIN}/exists`, published_on: "2026-01-01" });
    await newArticle(site.id, { url: `${ORIGIN}/moved-target`, published_on: "2026-01-01" });
    pages[`${ORIGIN}/a`] = html(
      `<html><head><meta property="og:title" content="Post A"><title>ignored</title>
<script type="application/ld+json">{"datePublished":"2026-10-01T09:00:00+09:00"}</script></head></html>`,
    );
    pages[`${ORIGIN}/b`] = html("<title>  Post\n B </title>");
    pages[`${ORIGIN}/json`] = html("{}", "application/json");
    pages[`${ORIGIN}/sjis`] = html("<title>x</title>", "text/html; charset=Shift_JIS");
    pages[`${ORIGIN}/moved`] = () => new Response(null, { status: 301, headers: { Location: "/moved-target" } });
    pages[`${ORIGIN}/moved-target`] = html("<title>Moved</title>");
    pages[`${ORIGIN}/old`] = () => new Response(null, { status: 302, headers: { Location: "/new?x=1" } });
    pages[`${ORIGIN}/new?x=1`] = html("<title>New</title>");
    pages[`${ORIGIN}/out`] = () => new Response(null, { status: 301, headers: { Location: "https://other.example.com/" } });

    const res = await post(`/api/v1/sites/${site.id}/articles/import`, {
      urls: [
        `${ORIGIN}/a`,
        `${ORIGIN}/exists`,
        `${ORIGIN}/missing`,
        `${ORIGIN}/b#section`,
        `${ORIGIN}/b`,
        `${ORIGIN}/json`,
        `${ORIGIN}/sjis`,
        `${ORIGIN}/moved`,
        `${ORIGIN}/old`,
        `${ORIGIN}/out`,
      ],
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as ImportArticlesResponse;
    expect(results.map((r) => [r.url, r.status, r.status === "failed" ? r.error : undefined])).toEqual([
      [`${ORIGIN}/a`, "created", undefined],
      [`${ORIGIN}/exists`, "exists", undefined],
      [`${ORIGIN}/missing`, "failed", "ページを取得できませんでした（HTTP 404）"],
      [`${ORIGIN}/b`, "created", undefined],
      [`${ORIGIN}/json`, "failed", "HTML のページではありません"],
      [`${ORIGIN}/sjis`, "failed", "UTF-8 以外の文字コードのページは取り込めません"],
      [`${ORIGIN}/moved`, "exists", undefined],
      [`${ORIGIN}/old`, "created", undefined],
      [`${ORIGIN}/out`, "failed", "サイトの外へリダイレクトされました"],
    ]);
    const created = results.flatMap((r) => (r.status === "created" ? [r.article] : []));
    expect(created.map((a) => [a.title, a.url, a.published_on, a.tags])).toEqual([
      ["Post A", `${ORIGIN}/a`, "2026-10-01", []],
      ["Post B", `${ORIGIN}/b`, null, []],
      // The article takes the URL after the redirect.
      ["New", `${ORIGIN}/new?x=1`, null, []],
    ]);
    expect(created[0]).not.toHaveProperty("note");
    // Registered URLs are not fetched.
    expect(fetched).not.toContain(`${ORIGIN}/exists`);
    const { results: rows } = await env.DB.prepare("SELECT url, note FROM articles WHERE site_id = ? ORDER BY url")
      .bind(site.id)
      .all<{ url: string; note: string }>();
    expect(rows.map((row) => row.url)).toEqual([
      `${ORIGIN}/a`,
      `${ORIGIN}/b`,
      `${ORIGIN}/exists`,
      `${ORIGIN}/moved-target`,
      `${ORIGIN}/new?x=1`,
    ]);
  });

  it("reports exists for two URLs that lead to the same page", async () => {
    const site = await createSite({ url: ORIGIN });
    pages[`${ORIGIN}/a`] = html("<title>A</title>");
    pages[`${ORIGIN}/alias`] = () => new Response(null, { status: 301, headers: { Location: `${ORIGIN}/a` } });
    const { results } = (await (
      await post(`/api/v1/sites/${site.id}/articles/import`, { urls: [`${ORIGIN}/a`, `${ORIGIN}/alias`] })
    ).json()) as ImportArticlesResponse;
    expect(results.map((r) => r.status)).toEqual(["created", "exists"]);
  });

  it("fills the published date of registered articles that have none", async () => {
    const site = await createSite({ url: ORIGIN });
    const undated = await newArticle(site.id, { url: `${ORIGIN}/undated`, title: "Kept", tags: ["t"] });
    await newArticle(site.id, { url: `${ORIGIN}/no-date` });
    await newArticle(site.id, { url: `${ORIGIN}/target` });
    // At the limit: filling a date takes no room.
    await fillArticles(site.id, MAX_ARTICLES_PER_SITE - 3);
    pages[`${ORIGIN}/new`] = html("<title>New</title>");
    pages[`${ORIGIN}/undated`] = html(
      `<title>New title</title><article><h1>A</h1><time datetime="2026-11-04T20:00:00Z">11/5</time></article>`,
    );
    pages[`${ORIGIN}/no-date`] = html("<title>No date</title>");
    pages[`${ORIGIN}/alias`] = () => new Response(null, { status: 301, headers: { Location: `${ORIGIN}/target` } });
    pages[`${ORIGIN}/target`] = html(`<meta property="article:published_time" content="2026-09-01">`);
    const { results } = (await (
      await post(`/api/v1/sites/${site.id}/articles/import`, {
        urls: [`${ORIGIN}/undated`, `${ORIGIN}/no-date`, `${ORIGIN}/alias`, `${ORIGIN}/missing`, `${ORIGIN}/new`],
      })
    ).json()) as ImportArticlesResponse;
    expect(results.map((r) => [r.url, r.status, r.status === "failed" ? r.error : undefined])).toEqual([
      [`${ORIGIN}/undated`, "dated", undefined],
      [`${ORIGIN}/no-date`, "failed", "公開日を読み取れませんでした"],
      // The page redirects to a registered article without a date.
      [`${ORIGIN}/alias`, "dated", undefined],
      [`${ORIGIN}/missing`, "failed", "ページを取得できませんでした（HTTP 404）"],
      // A new article still needs room.
      [`${ORIGIN}/new`, "failed", "記事は 1 サイトにつき 1000 件まで登録できます"],
    ]);
    const first = results[0];
    // Only the date changes: the UTC time is a date in Japan time, and the title and the tags are kept.
    expect(first?.status === "dated" && [first.article.id, first.article.title, first.article.published_on, first.article.tags]).toEqual([
      undated.id,
      "Kept",
      "2026-11-05",
      ["t"],
    ]);
    const third = results[2];
    expect(third?.status === "dated" && [third.article.url, third.article.published_on]).toEqual([`${ORIGIN}/target`, "2026-09-01"]);
  });

  it("fails the URLs from the one that reaches the article limit", async () => {
    const site = await createSite({ url: ORIGIN });
    await fillArticles(site.id, MAX_ARTICLES_PER_SITE - 1);
    pages[`${ORIGIN}/a`] = html("<title>A</title>");
    pages[`${ORIGIN}/c`] = html("<title>C</title>");
    const { results } = (await (
      await post(`/api/v1/sites/${site.id}/articles/import`, {
        urls: [`${ORIGIN}/missing`, `${ORIGIN}/a`, `${ORIGIN}/c`, `${ORIGIN}/gone`],
      })
    ).json()) as ImportArticlesResponse;
    const limit = "記事は 1 サイトにつき 1000 件まで登録できます";
    expect(results.map((r) => [r.status, r.status === "failed" ? r.error : undefined])).toEqual([
      ["failed", "ページを取得できませんでした（HTTP 404）"],
      ["created", undefined],
      ["failed", limit],
      ["failed", limit],
    ]);
  });

  it("rejects invalid urls", async () => {
    const site = await createSite({ url: ORIGIN });
    const path = `/api/v1/sites/${site.id}/articles/import`;
    const eleven = Array.from({ length: 11 }, (_, i) => `${ORIGIN}/p/${i}`);
    for (const urls of [[], eleven, [`${ORIGIN}/a`, "https://www.example.com/a"], `${ORIGIN}/a`, [1], [""], ["nope"]]) {
      const message = await expectError(await post(path, { urls }), 400, "invalid_urls");
      expect(message).toBe("取り込む URL は 1〜10 件の、サイトと同じ origin の URL にしてください");
    }
    await expectError(await post(path, { urls: [`${ORIGIN}/a`], tags: [] }), 400, "unknown_field");
    expect(fetched).toEqual([]);
  });
});
