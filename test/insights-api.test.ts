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
