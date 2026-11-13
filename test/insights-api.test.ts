import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Article, InsightsOverview, InsightsResponse, Memo, MemoList } from "../src/api/types";
import { newArticleId } from "../src/ids";
import { createSite, createUser, login, resetDb, send, type SessionCookies } from "./helpers";

let cookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  const member = await createUser({ email: "member@example.com" });
  cookies = await login(member.email);
});

const GSC = "sc-domain:example.com";
const GA4 = "123456";

function get(path: string): Promise<Response> {
  return send(path, { cookies });
}

async function insertSearch(siteId: string, rows: [string, string, number, number, number][], property = GSC) {
  for (const [date, page, clicks, impressions, position] of rows) {
    await env.DB.prepare("INSERT INTO gsc_page_daily VALUES (?, ?, ?, ?, ?, ?, ?, 'run')")
      .bind(siteId, property, date, page, clicks, impressions, position)
      .run();
  }
}

async function insertQuery(siteId: string, date: string, page: string, query: string, clicks: number, impressions: number) {
  await env.DB.prepare("INSERT INTO gsc_query_daily VALUES (?, ?, ?, ?, ?, ?, ?, 3, 'run')")
    .bind(siteId, GSC, date, page, query, clicks, impressions)
    .run();
}

async function insertSessions(siteId: string, date: string, page: string, channel: string, sessions: number, engaged: number) {
  await env.DB.prepare("INSERT INTO ga4_landing_daily VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'run')")
    .bind(siteId, GA4, date, page, channel, sessions, engaged)
    .run();
}

async function markImported(siteId: string, dataset: string, property: string, date: string) {
  await env.DB.prepare(
    `INSERT INTO sync_days (site_id, dataset, date, property, status, run_id, queued_at, last_succeeded_at, last_data_state)
    VALUES (?, ?, ?, ?, 'succeeded', 'run', 1, 1, 'final')`,
  )
    .bind(siteId, dataset, date, property)
    .run();
}

describe("GET /api/v1/sites/:id/insights", () => {
  it("returns the daily series, the totals and the top groups of the period and the previous one", async () => {
    const site = await createSite({ url: "https://example.com", gscProperty: GSC, ga4PropertyId: GA4 });
    await insertSearch(site.id, [
      ["2026-01-01", "https://example.com/a", 1, 10, 4],
      ["2026-01-03", "https://example.com/a", 5, 50, 2],
      ["2026-01-04", "https://example.com/a", 10, 100, 3],
      ["2026-01-04", "https://example.com/b", 2, 100, 7],
      // Another property: left out.
    ]);
    await insertSearch(site.id, [["2026-01-04", "https://example.com/a", 999, 999, 1]], "sc-domain:other.example");
    await insertQuery(site.id, "2026-01-04", "https://example.com/a", "q1", 8, 80);
    await insertSessions(site.id, "2026-01-04", "/a", "Organic Search", 6, 3);
    await insertSessions(site.id, "2026-01-04", "/a", "Direct", 2, 1);
    for (const date of ["2026-01-03", "2026-01-04"]) await markImported(site.id, "gsc_pages", GSC, date);

    const res = await get(`/api/v1/sites/${site.id}/insights?days=2&end=2026-01-04`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InsightsResponse;
    expect(body.period).toEqual({ start: "2026-01-03", end: "2026-01-04", days: 2 });
    expect(body.previous_period).toEqual({ start: "2026-01-01", end: "2026-01-02" });
    expect(body.search?.daily).toEqual([
      { date: "2026-01-01", clicks: 1, impressions: 10, position: 4 },
      { date: "2026-01-02", clicks: null, impressions: null, position: null },
      { date: "2026-01-03", clicks: 5, impressions: 50, position: 2 },
      // Position weighted by impressions: (3 * 100 + 7 * 100) / 200.
      { date: "2026-01-04", clicks: 12, impressions: 200, position: 5 },
    ]);
    expect(body.search?.totals).toEqual({ clicks: 17, impressions: 250, ctr: 0.068, position: 4.4 });
    expect(body.search?.previous_totals).toEqual({ clicks: 1, impressions: 10, ctr: 0.1, position: 4 });
    expect(body.search?.pages.map((row) => [row.key, row.clicks, row.previous_clicks])).toEqual([
      ["https://example.com/a", 15, 1],
      ["https://example.com/b", 2, null],
    ]);
    expect(body.search?.queries.map((row) => [row.key, row.clicks])).toEqual([["q1", 8]]);
    expect(body.search?.coverage).toMatchObject({ days: 2, available_days: 2, missing_days: 0 });
    expect(body.sessions?.totals).toEqual({ sessions: 8, engaged_sessions: 4, engagement_rate: 0.5, key_events: 0 });
    expect(body.sessions?.channels.map((row) => [row.key, row.sessions])).toEqual([
      ["Organic Search", 6],
      ["Direct", 2],
    ]);
    expect(body.sessions?.landing_pages.map((row) => row.key)).toEqual(["/a"]);
  });

  it("ends at the latest imported day by default", async () => {
    const site = await createSite({ gscProperty: GSC });
    await markImported(site.id, "gsc_pages", GSC, "2026-02-10");
    const body = (await (await get(`/api/v1/sites/${site.id}/insights?days=7`)).json()) as InsightsResponse;
    expect(body.period).toEqual({ start: "2026-02-04", end: "2026-02-10", days: 7 });
    expect(body.sessions).toBeNull();
  });

  it("reads one article: its page, its landing page and its memos", async () => {
    const site = await createSite({ url: "https://example.com", gscProperty: GSC, ga4PropertyId: GA4 });
    await insertSearch(site.id, [
      ["2026-01-04", "https://example.com/a", 10, 100, 3],
      ["2026-01-04", "https://example.com/b", 2, 100, 7],
    ]);
    await insertSessions(site.id, "2026-01-04", "/a", "Organic Search", 6, 3);
    await insertSessions(site.id, "2026-01-04", "/b", "Organic Search", 9, 3);
    const article = (await (
      await send(`/api/v1/sites/${site.id}/articles`, { cookies, json: { title: "A", url: "https://example.com/a" } })
    ).json()) as Article;
    const linked = (await (
      await send(`/api/v1/sites/${site.id}/memos`, { cookies, json: { title: "Linked", article_ids: [article.id] } })
    ).json()) as Memo;
    await send(`/api/v1/sites/${site.id}/memos`, { cookies, json: { title: "Other" } });

    const end = new Date().toISOString().slice(0, 10);
    const res = await get(`/api/v1/sites/${site.id}/insights?days=1&end=2026-01-04&article_id=${article.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InsightsResponse;
    expect(body.article).toEqual({ id: article.id, title: "A", url: "https://example.com/a" });
    expect(body.search?.totals.clicks).toBe(10);
    expect(body.search?.pages).toEqual([]);
    expect(body.sessions?.totals.sessions).toBe(6);
    expect(body.sessions?.landing_pages).toEqual([]);
    // The memos are read around the period; the ones of today are outside 2026-01-04.
    expect(body.memos).toEqual([]);
    const today = (await (
      await get(`/api/v1/sites/${site.id}/insights?days=1&end=${end}&article_id=${article.id}`)
    ).json()) as InsightsResponse;
    expect(today.memos.map((memo) => memo.id)).toEqual([linked.id]);
  });

  it("rejects a wrong query, a missing site and an article of another site", async () => {
    const site = await createSite({ gscProperty: GSC });
    const other = await createSite();
    const article = (await (await send(`/api/v1/sites/${other.id}/articles`, { cookies, json: { title: "A" } })).json()) as Article;
    for (const query of ["days=0", "days=181", "days=x", "end=2026-02-30", "end=2999-01-01"]) {
      const res = await get(`/api/v1/sites/${site.id}/insights?${query}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_query");
    }
    expect((await get(`/api/v1/sites/${site.id}/insights?article_id=${article.id}`)).status).toBe(404);
    expect((await get(`/api/v1/sites/${site.id}/insights?article_id=${newArticleId(1)}`)).status).toBe(404);
    expect((await get(`/api/v1/sites/site_x/insights`)).status).toBe(404);
  });

  it("requires a signed-in user", async () => {
    const site = await createSite();
    expect((await send(`/api/v1/sites/${site.id}/insights`)).status).toBe(401);
    expect((await send("/api/v1/sites/insights")).status).toBe(401);
  });
});

describe("GET /api/v1/sites/insights", () => {
  it("returns the daily clicks and sessions of every site", async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const a = await createSite({ name: "A", gscProperty: GSC, ga4PropertyId: GA4 });
    const b = await createSite({ name: "B" });
    await insertSearch(a.id, [[yesterday, "https://example.com/a", 4, 40, 3]]);
    await insertSessions(a.id, yesterday, "/a", "Direct", 3, 1);

    const res = await get("/api/v1/sites/insights");
    expect(res.status).toBe(200);
    const body = (await res.json()) as InsightsOverview;
    expect(body.period.days).toBe(28);
    expect(body.period.end).toBe(yesterday);
    const entryA = body.sites.find((entry) => entry.site_id === a.id);
    expect(entryA?.clicks?.total).toBe(4);
    expect(entryA?.clicks?.daily).toHaveLength(28);
    expect(entryA?.clicks?.daily.at(-1)).toBe(4);
    expect(entryA?.sessions?.total).toBe(3);
    expect(body.sites.find((entry) => entry.site_id === b.id)).toEqual({ site_id: b.id, clicks: null, sessions: null });
  });
});

describe("GET /api/v1/sites/:id/memos?q=", () => {
  it("finds the words in the title or the content, ignoring ASCII case, and returns the previews", async () => {
    const site = await createSite();
    const post = (json: unknown) => send(`/api/v1/sites/${site.id}/memos`, { cookies, json });
    await post({ title: "GTM に移行", content: "タグを変更" });
    await post({ title: "競合", content: "比較記事で gtm を使っていた" });
    await post({ title: "100% の_扱い", content: "" });
    await post({ title: "無関係", content: "なし" });

    const search = async (q: string) =>
      ((await (await get(`/api/v1/sites/${site.id}/memos?q=${encodeURIComponent(q)}`)).json()) as MemoList).memos
        .map((memo) => memo.title)
        .sort();
    expect(await search("gtm")).toEqual(["GTM に移行", "競合"]);
    expect(await search("タグ")).toEqual(["GTM に移行"]);
    // % and _ match themselves.
    expect(await search("%")).toEqual(["100% の_扱い"]);
    expect(await search("_")).toEqual(["100% の_扱い"]);
    // Blank is no search.
    expect(await search("  ")).toHaveLength(4);

    const list = (await (await get(`/api/v1/sites/${site.id}/memos?q=gtm`)).json()) as MemoList;
    expect(list.memos.map((memo) => memo.content_preview).sort()).toEqual(["タグを変更", "比較記事で gtm を使っていた"]);
  });

  it("rejects a search longer than 100 characters", async () => {
    const site = await createSite();
    const res = await get(`/api/v1/sites/${site.id}/memos?q=${"a".repeat(101)}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_query");
  });
});

async function insertPageViews(
  siteId: string,
  rows: [date: string, host: string, path: string, views: number, seconds: number][],
  property = GA4,
) {
  for (const [date, host, path, views, seconds] of rows) {
    await env.DB.prepare("INSERT INTO ga4_page_daily VALUES (?, ?, ?, ?, ?, ?, ?, 'run')")
      .bind(siteId, property, date, host, path, views, seconds)
      .run();
  }
}

async function markDay(
  siteId: string,
  dataset: string,
  property: string,
  date: string,
  day: { status?: string; succeeded?: boolean; state?: "final" | "provisional"; thresholded?: number | null } = {},
) {
  const succeeded = day.succeeded ?? true;
  await env.DB.prepare(
    `INSERT INTO sync_days (site_id, dataset, date, property, status, run_id, queued_at, last_succeeded_at, last_data_state,
      last_time_zone, last_thresholded)
    VALUES (?, ?, ?, ?, ?, 'run', 1, ?, ?, ?, ?)`,
  )
    .bind(
      siteId,
      dataset,
      date,
      property,
      day.status ?? "succeeded",
      succeeded ? 1 : null,
      succeeded ? (day.state ?? "final") : null,
      succeeded ? "Asia/Tokyo" : null,
      day.thresholded ?? null,
    )
    .run();
}

async function insightsOf(siteId: string, query: string): Promise<InsightsResponse> {
  const res = await get(`/api/v1/sites/${siteId}/insights?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as InsightsResponse;
}

async function createArticle(siteId: string, url: string): Promise<Article> {
  return (await (await send(`/api/v1/sites/${siteId}/articles`, { cookies, json: { title: url, url } })).json()) as Article;
}

describe("GET /api/v1/sites/:id/insights page_views", () => {
  it("returns the daily views of the previous period and the period, with 0 on an imported day without rows", async () => {
    const site = await createSite({ url: "https://example.com", ga4PropertyId: GA4 });
    await insertPageViews(site.id, [
      ["2026-01-01", "example.com", "/a", 4, 20],
      ["2026-01-03", "example.com", "/a", 10, 100],
      ["2026-01-04", "example.com", "/b", 1, 50.04],
      ["2026-01-04", "example.com", "/c", 2, 3],
    ]);
    // Another property: left out.
    await insertPageViews(site.id, [["2026-01-04", "example.com", "/a", 999, 999]], "999");
    for (const date of ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]) await markDay(site.id, "ga4_pages", GA4, date);

    const body = await insightsOf(site.id, "days=2&end=2026-01-04");
    const pageViews = body.page_views;
    expect(pageViews?.property).toBe(GA4);
    expect(pageViews?.daily).toEqual([
      { date: "2026-01-01", views: 4, engagement_seconds: 20, state: "final" },
      // Imported without rows: 0 views.
      { date: "2026-01-02", views: 0, engagement_seconds: 0, state: "final" },
      { date: "2026-01-03", views: 10, engagement_seconds: 100, state: "final" },
      { date: "2026-01-04", views: 3, engagement_seconds: 53, state: "final" },
    ]);
  });

  it("returns the totals, the previous totals and the top pages", async () => {
    const site = await createSite({ url: "https://example.com", ga4PropertyId: GA4 });
    await insertPageViews(site.id, [
      ["2026-01-01", "example.com", "/a", 4, 20],
      ["2026-01-03", "example.com", "/a", 10, 100],
      ["2026-01-04", "example.com", "/b", 1, 50.04],
      ["2026-01-04", "www.example.com", "/a", 2, 3],
    ]);
    for (const date of ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]) await markDay(site.id, "ga4_pages", GA4, date);
    const body = await insightsOf(site.id, "days=2&end=2026-01-04");
    const pageViews = body.page_views;
    // (100 + 50.04 + 3) / (10 + 1 + 2) = 11.77..., not the mean of the daily averages ((10 + 17.68) / 2 = 13.8).
    expect(pageViews?.totals).toEqual({ views: 13, engagement_seconds: 153, avg_engagement_seconds_per_view: 11.8 });
    expect(pageViews?.previous_totals).toEqual({ views: 4, engagement_seconds: 20, avg_engagement_seconds_per_view: 5 });
    expect(pageViews?.pages).toEqual([
      { host_name: "example.com", page_path: "/a", views: 10, engagement_seconds: 100, avg_engagement_seconds_per_view: 10, previous_views: 4 },
      { host_name: "www.example.com", page_path: "/a", views: 2, engagement_seconds: 3, avg_engagement_seconds_per_view: 1.5, previous_views: 0 },
      { host_name: "example.com", page_path: "/b", views: 1, engagement_seconds: 50, avg_engagement_seconds_per_view: 50, previous_views: 0 },
    ]);
    expect(pageViews?.coverage).toEqual({
      days: 2,
      available_days: 2,
      provisional_days: 0,
      missing_days: 0,
      pending_days: 0,
      truncated_days: 0,
      time_zone: "Asia/Tokyo",
      thresholded_days: 0,
    });
    expect(pageViews?.previous_coverage).toMatchObject({ days: 2, available_days: 2, missing_days: 0 });
  });

  it("returns null avg without views", async () => {
    const site = await createSite({ ga4PropertyId: GA4 });
    await insertPageViews(site.id, [["2026-01-04", "example.com", "/a", 0, 5]]);
    await markDay(site.id, "ga4_pages", GA4, "2026-01-04");
    const body = await insightsOf(site.id, "days=1&end=2026-01-04");
    expect(body.page_views?.totals).toEqual({ views: 0, engagement_seconds: 5, avg_engagement_seconds_per_view: null });
    expect(body.page_views?.pages[0]?.avg_engagement_seconds_per_view).toBeNull();
  });

  it("does not count the days not imported as 0, and tells their state", async () => {
    const site = await createSite({ ga4PropertyId: GA4 });
    // Rows of a day without a success are not counted.
    await insertPageViews(site.id, [
      ["2026-01-05", "example.com", "/a", 7, 7],
      ["2026-01-06", "example.com", "/a", 3, 3],
      ["2026-01-08", "example.com", "/a", 5, 5],
    ]);
    await markDay(site.id, "ga4_pages", GA4, "2026-01-05", { status: "failed", succeeded: false });
    await markDay(site.id, "ga4_pages", GA4, "2026-01-06", { state: "provisional", status: "queued" });
    await markDay(site.id, "ga4_pages", GA4, "2026-01-07", { status: "running", succeeded: false });
    // A day of another property, and of ga4_landing_pages, are not used for the state.
    await markDay(site.id, "ga4_pages", "999", "2026-01-08");
    await markDay(site.id, "ga4_landing_pages", GA4, "2026-01-08");
    const body = await insightsOf(site.id, "days=4&end=2026-01-08");
    const pageViews = body.page_views;
    expect(pageViews?.daily.slice(4)).toEqual([
      { date: "2026-01-05", views: null, engagement_seconds: null, state: "failed" },
      { date: "2026-01-06", views: 3, engagement_seconds: 3, state: "provisional" },
      { date: "2026-01-07", views: null, engagement_seconds: null, state: "pending" },
      { date: "2026-01-08", views: null, engagement_seconds: null, state: "missing" },
    ]);
    expect(pageViews?.totals).toEqual({ views: 3, engagement_seconds: 3, avg_engagement_seconds_per_view: 1 });
    // 2026-01-07 (running) waits for its import; 2026-01-05 (failed) and 2026-01-08 (no row) are missing.
    expect(pageViews?.coverage).toMatchObject({ days: 4, available_days: 1, provisional_days: 1, missing_days: 3, pending_days: 1 });
    // No day of the previous period is imported: null, not 0.
    expect(pageViews?.daily.slice(0, 4).every((day) => day.views === null && day.state === "missing")).toBe(true);
    expect(pageViews?.previous_totals).toEqual({ views: null, engagement_seconds: null, avg_engagement_seconds_per_view: null });
    expect(pageViews?.previous_coverage).toMatchObject({ days: 4, available_days: 0, missing_days: 4, pending_days: 0 });
    expect(pageViews?.pages.map((row) => [row.page_path, row.previous_views])).toEqual([["/a", null]]);
  });

  it("returns null totals when no day of the period is imported", async () => {
    const site = await createSite({ ga4PropertyId: GA4 });
    await insertPageViews(site.id, [["2026-01-04", "example.com", "/a", 5, 5]]);
    const body = await insightsOf(site.id, "days=1&end=2026-01-04");
    expect(body.page_views?.totals).toEqual({ views: null, engagement_seconds: null, avg_engagement_seconds_per_view: null });
    expect(body.page_views?.daily.at(-1)).toEqual({ date: "2026-01-04", views: null, engagement_seconds: null, state: "missing" });
  });

  it("counts the thresholded days of each period", async () => {
    const site = await createSite({ ga4PropertyId: GA4 });
    await markDay(site.id, "ga4_pages", GA4, "2026-01-03", { thresholded: 1 });
    await markDay(site.id, "ga4_pages", GA4, "2026-01-04", { thresholded: 0 });
    await markDay(site.id, "ga4_pages", GA4, "2026-01-01", { thresholded: 1 });
    await markDay(site.id, "ga4_pages", GA4, "2026-01-02", { thresholded: 1, status: "failed", succeeded: false });
    const body = await insightsOf(site.id, "days=2&end=2026-01-04");
    expect(body.page_views?.coverage.thresholded_days).toBe(1);
    expect(body.page_views?.previous_coverage.thresholded_days).toBe(1);
  });

  it("reads an article by its host name and path, keeping the trailing slash and the other hosts apart", async () => {
    const site = await createSite({ url: "https://example.com", ga4PropertyId: GA4 });
    await insertPageViews(site.id, [
      ["2026-01-04", "example.com", "/a", 5, 10],
      ["2026-01-04", "example.com", "/a/", 100, 100],
      ["2026-01-04", "www.example.com", "/a", 200, 200],
      ["2026-01-04", "example.com", "/b", 300, 300],
    ]);
    await markDay(site.id, "ga4_pages", GA4, "2026-01-04");
    const article = await createArticle(site.id, "https://example.com/a");
    const body = await insightsOf(site.id, `days=1&end=2026-01-04&article_id=${article.id}`);
    expect(body.page_views?.totals.views).toBe(5);
    expect(body.page_views?.daily.at(-1)?.views).toBe(5);
    expect(body.page_views?.pages).toEqual([]);
    // The site counts every host of the property.
    const all = await insightsOf(site.id, "days=1&end=2026-01-04");
    expect(all.page_views?.totals.views).toBe(605);
  });

  it("matches the decoded path as well and adds both, but never decodes %2F", async () => {
    const site = await createSite({ url: "https://example.com", ga4PropertyId: GA4 });
    await insertPageViews(site.id, [
      ["2026-01-04", "example.com", "/%E3%81%82", 3, 6],
      ["2026-01-04", "example.com", "/あ", 4, 8],
      ["2026-01-04", "example.com", "/x%2Fy", 5, 5],
      ["2026-01-04", "example.com", "/x/y", 50, 50],
    ]);
    await markDay(site.id, "ga4_pages", GA4, "2026-01-04");
    const encoded = await createArticle(site.id, "https://example.com/あ");
    const body = await insightsOf(site.id, `days=1&end=2026-01-04&article_id=${encoded.id}`);
    expect(body.page_views?.totals).toEqual({ views: 7, engagement_seconds: 14, avg_engagement_seconds_per_view: 2 });
    const slash = await createArticle(site.id, "https://example.com/x%2Fy");
    const slashBody = await insightsOf(site.id, `days=1&end=2026-01-04&article_id=${slash.id}`);
    expect(slashBody.page_views?.totals.views).toBe(5);
  });

  it("is null without a GA4 property or without the URL of the article", async () => {
    const gscOnly = await createSite({ gscProperty: GSC });
    expect((await insightsOf(gscOnly.id, "days=1&end=2026-01-04")).page_views).toBeNull();
    const site = await createSite({ ga4PropertyId: GA4 });
    const article = (await (await send(`/api/v1/sites/${site.id}/articles`, { cookies, json: { title: "No URL" } })).json()) as Article;
    expect((await insightsOf(site.id, `days=1&end=2026-01-04&article_id=${article.id}`)).page_views).toBeNull();
  });

  it("keeps the views apart from the sessions of the landing pages, and has no user count", async () => {
    const site = await createSite({ url: "https://example.com", ga4PropertyId: GA4 });
    await insertSessions(site.id, "2026-01-04", "/a", "Organic Search", 6, 3);
    await insertPageViews(site.id, [["2026-01-04", "example.com", "/a", 40, 80]]);
    await markDay(site.id, "ga4_pages", GA4, "2026-01-04");
    await markDay(site.id, "ga4_landing_pages", GA4, "2026-01-04");
    const body = await insightsOf(site.id, "days=1&end=2026-01-04");
    expect(body.sessions?.totals.sessions).toBe(6);
    expect(body.page_views?.totals.views).toBe(40);
    expect(JSON.stringify(body.page_views)).not.toMatch(/user/i);
  });

  it("keeps the keys of search and sessions, with pending_days added to the coverage", async () => {
    const site = await createSite({ url: "https://example.com", gscProperty: GSC, ga4PropertyId: GA4 });
    await insertSearch(site.id, [["2026-01-04", "https://example.com/a", 1, 10, 4]]);
    await insertSessions(site.id, "2026-01-04", "/a", "Organic Search", 6, 3);
    const body = await insightsOf(site.id, "days=1&end=2026-01-04");
    expect(Object.keys(body).sort()).toEqual(
      ["article", "memos", "page_views", "period", "previous_period", "search", "sessions", "site_id"].sort(),
    );
    expect(Object.keys(body.search ?? {}).sort()).toEqual(
      ["coverage", "daily", "pages", "previous_totals", "property", "queries", "time_zone", "totals"].sort(),
    );
    expect(Object.keys(body.search?.coverage ?? {}).sort()).toEqual(
      ["available_days", "days", "missing_days", "pending_days", "provisional_days", "time_zone", "truncated_days"].sort(),
    );
    expect(Object.keys(body.sessions ?? {}).sort()).toEqual(
      ["channels", "coverage", "daily", "landing_pages", "previous_totals", "property", "totals"].sort(),
    );
    expect(Object.keys(body.sessions?.coverage ?? {}).sort()).toEqual(
      ["available_days", "days", "missing_days", "pending_days", "provisional_days", "time_zone", "truncated_days"].sort(),
    );
    expect(Object.keys(body.sessions?.daily[0] ?? {}).sort()).toEqual(["date", "engaged_sessions", "key_events", "sessions"]);
  });

  it("does not move the default end with the days of ga4_pages", async () => {
    const site = await createSite({ gscProperty: GSC, ga4PropertyId: GA4 });
    await markDay(site.id, "gsc_pages", GSC, "2026-02-10");
    await markDay(site.id, "ga4_landing_pages", GA4, "2026-02-11");
    await markDay(site.id, "ga4_pages", GA4, "2026-02-14");
    const body = await insightsOf(site.id, "days=7");
    expect(body.period.end).toBe("2026-02-11");
  });
});
