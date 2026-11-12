import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Site, SyncStatus } from "../src/api/types";
import type { UserRow } from "../src/db/schema";
import { newSiteId } from "../src/ids";
import { addDays, subtractMonths, todayUtc } from "../src/sync/dates";
import { getSyncStatus } from "../src/sync/status";
import {
  countTable,
  createSite,
  createUser,
  d1Counting,
  dbChangingBefore,
  fakeQueue,
  login,
  resetDb,
  send,
  type FakeQueue,
  type SessionCookies,
} from "./helpers";
import { sharedServiceAccount } from "./google";

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  admin = await createUser({ email: "admin@example.com", role: "admin" });
  member = await createUser({ email: "member@example.com" });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MISSING_ID = newSiteId(Date.UTC(2026, 0, 1));

function createRequest(json: unknown, cookies: SessionCookies = memberCookies): Promise<Response> {
  return send("/api/v1/sites", { cookies, json });
}

function updateRequest(id: string, json: unknown, cookies: SessionCookies = memberCookies): Promise<Response> {
  return send(`/api/v1/sites/${id}`, { method: "PATCH", cookies, json });
}

async function expectError(res: Response, status: number, code: string, message?: string): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  if (message !== undefined) expect(body.error.message).toBe(message);
}

async function created(json: unknown): Promise<Site> {
  const res = await createRequest(json);
  expect(res.status).toBe(201);
  return (await res.json()) as Site;
}

describe("authentication and authorization", () => {
  it("returns 401 without a session", async () => {
    const site = await createSite();
    const requests = [
      send("/api/v1/sites"),
      send("/api/v1/sites", { json: { name: "a", url: "https://a.example.com" } }),
      send(`/api/v1/sites/${site.id}`),
      send(`/api/v1/sites/${site.id}`, { method: "PATCH", json: { name: "b" } }),
      send(`/api/v1/sites/${site.id}`, { method: "DELETE" }),
    ];
    for (const res of await Promise.all(requests)) await expectError(res, 401, "unauthorized", "ログインが必要です");
  });

  it("lets a member create, read, change and delete sites", async () => {
    const site = await created({ name: "Blog", url: "https://blog.example.com" });
    expect((await send(`/api/v1/sites/${site.id}`, { cookies: memberCookies })).status).toBe(200);
    expect((await updateRequest(site.id, { name: "Blog 2" })).status).toBe(200);
    expect((await send(`/api/v1/sites/${site.id}`, { method: "DELETE", cookies: memberCookies })).status).toBe(204);
  });

  it("shows every user the same sites", async () => {
    await created({ name: "Blog", url: "https://blog.example.com" });
    const res = await send("/api/v1/sites", { cookies: adminCookies });
    expect(((await res.json()) as { sites: Site[] }).sites.map((s) => s.name)).toEqual(["Blog"]);
  });

  it("rejects cross-origin POST, PATCH and DELETE with 403", async () => {
    const site = await createSite();
    const options = { cookies: memberCookies, origin: "https://evil.example" };
    await expectError(
      await send("/api/v1/sites", { ...options, json: { name: "a", url: "https://a.example.com" } }),
      403,
      "forbidden",
    );
    await expectError(await send(`/api/v1/sites/${site.id}`, { ...options, method: "PATCH", json: { name: "b" } }), 403, "forbidden");
    await expectError(await send(`/api/v1/sites/${site.id}`, { ...options, method: "DELETE" }), 403, "forbidden");
    expect(await countTable("sites")).toBe(1);
  });

  it("keeps the sites when the user who created them is deleted", async () => {
    await created({ name: "Blog", url: "https://blog.example.com" });
    expect((await send(`/api/v1/users/${member.id}`, { method: "DELETE", cookies: adminCookies })).status).toBe(204);
    expect(await countTable("sites")).toBe(1);
  });
});

describe("GET /api/v1/sites", () => {
  it("lists the sites by name, then by ID", async () => {
    const b = await createSite({ name: "B" });
    const a2 = await createSite({ name: "A" });
    const a1 = await createSite({ name: "A" });
    const res = await send("/api/v1/sites", { cookies: memberCookies });
    expect(res.status).toBe(200);
    const { sites } = (await res.json()) as { sites: Site[] };
    const sameName = [a1.id, a2.id].sort();
    expect(sites.map((site) => site.id)).toEqual([...sameName, b.id]);
  });

  it("returns an empty list", async () => {
    const res = await send("/api/v1/sites", { cookies: memberCookies });
    expect(await res.json()).toEqual({ sites: [] });
  });
});

describe("POST /api/v1/sites", () => {
  it("creates a site with the normalized values", async () => {
    const site = await created({
      name: "  Blog  ",
      url: "  HTTPS://Blog.Example.COM:443/path/?q=1#top ",
      gsc_property: " SC-Domain:Example.COM ",
      ga4_property_id: " 0123456789 ",
    });
    expect(site).toMatchObject({
      name: "Blog",
      url: "https://blog.example.com",
      gsc_property: "sc-domain:example.com",
      ga4_property_id: "0123456789",
    });
    expect(site.id).toMatch(/^site_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(site.created_at).toBe(site.updated_at);
    const res = await send(`/api/v1/sites/${site.id}`, { cookies: memberCookies });
    expect(await res.json()).toEqual(site);
  });

  it("keeps a non-default port and stores a URL prefix with its trailing slash", async () => {
    const site = await created({ name: "Dev", url: "http://localhost:8787/x", gsc_property: "https://example.com" });
    expect(site.url).toBe("http://localhost:8787");
    expect(site.gsc_property).toBe("https://example.com/");
    const prefix = await created({ name: "Docs", url: "https://docs.example.com", gsc_property: "https://example.com/docs/" });
    expect(prefix.gsc_property).toBe("https://example.com/docs/");
  });

  it("stores missing, null and blank properties as null", async () => {
    const a = await created({ name: "A", url: "https://a.example.com" });
    const b = await created({ name: "B", url: "https://b.example.com", gsc_property: null, ga4_property_id: null });
    const c = await created({ name: "C", url: "https://c.example.com", gsc_property: "  ", ga4_property_id: "" });
    for (const site of [a, b, c]) {
      expect(site.gsc_property).toBeNull();
      expect(site.ga4_property_id).toBeNull();
    }
  });

  it("registers http and https of the same host as two sites", async () => {
    await created({ name: "A", url: "https://example.com" });
    await created({ name: "B", url: "http://example.com" });
    expect(await countTable("sites")).toBe(2);
  });

  it("returns 409 url_conflict for a URL with the same origin", async () => {
    await created({ name: "A", url: "https://example.com/a" });
    await expectError(
      await createRequest({ name: "B", url: "https://EXAMPLE.com/b" }),
      409,
      "url_conflict",
      "この URL のサイトは登録済みです",
    );
  });

  it("returns 409 limit_exceeded at 100 sites, also for a duplicate URL", async () => {
    for (let i = 0; i < 100; i++) await createSite({ url: `https://s${i}.example.com` });
    await expectError(
      await createRequest({ name: "New", url: "https://new.example.com" }),
      409,
      "limit_exceeded",
      "サイトは 100 件まで登録できます",
    );
    await expectError(await createRequest({ name: "Dup", url: "https://s0.example.com" }), 409, "limit_exceeded");
    expect(await countTable("sites")).toBe(100);
  });

  it("creates the 100th site", async () => {
    for (let i = 0; i < 99; i++) await createSite({ url: `https://s${i}.example.com` });
    await created({ name: "Last", url: "https://last.example.com" });
    expect(await countTable("sites")).toBe(100);
  });

  it("rejects a body that is not a JSON object", async () => {
    for (const json of ["not json", "[]", "null", "1"]) {
      await expectError(await createRequest(json), 400, "invalid_body");
    }
  });

  it("rejects unknown fields first", async () => {
    await expectError(
      await createRequest({ name: "", url: "x", extra: 1 }),
      400,
      "unknown_field",
      "未知の項目があります: extra",
    );
  });

  it("validates the name before the URL, the URL before the properties", async () => {
    await expectError(await createRequest({ url: "x", gsc_property: 1 }), 400, "invalid_name");
    await expectError(await createRequest({ name: "A", url: "x", gsc_property: 1 }), 400, "invalid_url");
    await expectError(
      await createRequest({ name: "A", url: "https://a.example.com", gsc_property: 1, ga4_property_id: 1 }),
      400,
      "invalid_gsc_property",
    );
  });

  it.each([[undefined], [null], [1], [""], ["   "], ["a\u0007b"], ["a".repeat(101)]])("rejects the name %j", async (name) => {
    await expectError(
      await createRequest({ name, url: "https://a.example.com" }),
      400,
      "invalid_name",
      "名前は制御文字を含まない 1〜100 文字にしてください",
    );
  });

  it("accepts a name of 100 code points", async () => {
    const site = await created({ name: "😀".repeat(100), url: "https://a.example.com" });
    expect(site.name).toBe("😀".repeat(100));
  });

  it.each([
    [undefined],
    [null],
    [1],
    [""],
    ["example.com"],
    ["ftp://example.com"],
    ["javascript:alert(1)"],
    ["https://user:pass@example.com"],
    ["https://user@example.com"],
    [`https://example.com/${"a".repeat(2049 - "https://example.com/".length)}`],
  ])("rejects the URL %j", async (url) => {
    await expectError(
      await createRequest({ name: "A", url }),
      400,
      "invalid_url",
      "URL は http または https で始まる正しい形式にしてください",
    );
  });

  it("accepts a URL of 2048 characters", async () => {
    const url = `https://example.com/${"a".repeat(2048 - "https://example.com/".length)}`;
    expect(url).toHaveLength(2048);
    expect((await created({ name: "A", url })).url).toBe("https://example.com");
  });

  it.each([
    [1],
    ["sc-domain:"],
    ["sc-domain:example"],
    ["sc-domain:-example.com"],
    ["sc-domain:exa_mple.com"],
    ["sc-domain:https://example.com"],
    [`sc-domain:${"a".repeat(250)}.com`],
    ["example.com"],
    ["ftp://example.com/"],
    ["https://example.com/docs"],
    ["https://example.com/?q=1"],
    ["https://example.com/#top"],
    ["https://user:pass@example.com/"],
  ])("rejects the Search Console property %j", async (gscProperty) => {
    await expectError(
      await createRequest({ name: "A", url: "https://a.example.com", gsc_property: gscProperty }),
      400,
      "invalid_gsc_property",
      "Search Console のプロパティは sc-domain:example.com か https://example.com/ の形式にしてください",
    );
  });

  it.each([[1], ["12a"], ["G-12345"], ["1".repeat(21)], ["-1"]])("rejects the GA4 property ID %j", async (id) => {
    await expectError(
      await createRequest({ name: "A", url: "https://a.example.com", ga4_property_id: id }),
      400,
      "invalid_ga4_property",
      "GA4 のプロパティ ID は数字だけで入力してください",
    );
  });

  it("accepts a GA4 property ID of 20 digits", async () => {
    const site = await created({ name: "A", url: "https://a.example.com", ga4_property_id: "9".repeat(20) });
    expect(site.ga4_property_id).toBe("9".repeat(20));
  });
});

describe("GET /api/v1/sites/:id", () => {
  it("returns 404 not_found for a missing site or an ID of another form", async () => {
    for (const id of [MISSING_ID, "site_bad", "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V"]) {
      await expectError(
        await send(`/api/v1/sites/${id}`, { cookies: memberCookies }),
        404,
        "not_found",
        "サイトが見つかりません",
      );
    }
  });
});

describe("PATCH /api/v1/sites/:id", () => {
  it("changes only the given items", async () => {
    const site = await created({
      name: "Blog",
      url: "https://blog.example.com",
      gsc_property: "sc-domain:example.com",
      ga4_property_id: "123",
    });
    const res = await updateRequest(site.id, { name: " Blog 2 " });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Site;
    expect(updated).toMatchObject({
      id: site.id,
      name: "Blog 2",
      url: "https://blog.example.com",
      gsc_property: "sc-domain:example.com",
      ga4_property_id: "123",
      created_at: site.created_at,
    });
    expect(updated.updated_at).toBeGreaterThanOrEqual(site.updated_at);
  });

  it("changes the URL and clears the properties", async () => {
    const site = await created({ name: "Blog", url: "https://blog.example.com", gsc_property: "sc-domain:example.com", ga4_property_id: "1" });
    const res = await updateRequest(site.id, { url: "https://new.example.com/path", gsc_property: null, ga4_property_id: "" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: "https://new.example.com", gsc_property: null, ga4_property_id: null });
  });

  it("accepts the site's own URL", async () => {
    const site = await created({ name: "Blog", url: "https://blog.example.com" });
    expect((await updateRequest(site.id, { url: "https://blog.example.com/" })).status).toBe(200);
  });

  it("returns 409 url_conflict for the URL of another site", async () => {
    await created({ name: "A", url: "https://a.example.com" });
    const b = await created({ name: "B", url: "https://b.example.com" });
    await expectError(await updateRequest(b.id, { url: "https://a.example.com" }), 409, "url_conflict");
  });

  it("returns 400 invalid_request for an empty object", async () => {
    const site = await createSite();
    await expectError(await updateRequest(site.id, {}), 400, "invalid_request", "変更する項目を指定してください");
  });

  it("validates in order: unknown fields, then the items", async () => {
    const site = await createSite();
    await expectError(await updateRequest(site.id, { id: "x" }), 400, "unknown_field", "未知の項目があります: id");
    await expectError(await updateRequest(site.id, { name: "", url: "x" }), 400, "invalid_name");
    await expectError(await updateRequest(site.id, { url: "x", gsc_property: 1 }), 400, "invalid_url");
    await expectError(await updateRequest(site.id, { gsc_property: 1, ga4_property_id: 1 }), 400, "invalid_gsc_property");
    await expectError(await updateRequest(site.id, { ga4_property_id: 1 }), 400, "invalid_ga4_property");
    await expectError(await updateRequest(site.id, { name: null }), 400, "invalid_name");
    await expectError(await updateRequest(site.id, { url: null }), 400, "invalid_url");
  });

  it("returns 404 not_found for a missing site or an ID of another form", async () => {
    for (const id of [MISSING_ID, "site_bad"]) {
      await expectError(await updateRequest(id, { name: "A" }), 404, "not_found", "サイトが見つかりません");
    }
  });
});

describe("DELETE /api/v1/sites/:id", () => {
  it("deletes the site", async () => {
    const site = await createSite();
    const other = await createSite();
    const res = await send(`/api/v1/sites/${site.id}`, { method: "DELETE", cookies: memberCookies });
    expect(res.status).toBe(204);
    expect(await countTable("sites")).toBe(1);
    const left = await env.DB.prepare("SELECT id FROM sites").first<{ id: string }>();
    expect(left?.id).toBe(other.id);
  });

  it("returns 404 not_found for a missing site, a deleted one or an ID of another form", async () => {
    const site = await createSite();
    expect((await send(`/api/v1/sites/${site.id}`, { method: "DELETE", cookies: memberCookies })).status).toBe(204);
    for (const id of [site.id, MISSING_ID, "site_bad"]) {
      await expectError(
        await send(`/api/v1/sites/${id}`, { method: "DELETE", cookies: memberCookies }),
        404,
        "not_found",
        "サイトが見つかりません",
      );
    }
  });
});

const GSC = "sc-domain:example.com";
const GA4 = "123456789";

async function insertDay(siteId: string, row: Record<string, unknown>): Promise<void> {
  const values = {
    dataset: "gsc_pages",
    property: GSC,
    status: "succeeded",
    run_id: "r",
    queued_at: 1,
    ...row,
    site_id: siteId,
  };
  const columns = Object.keys(values);
  await env.DB.prepare(`INSERT INTO sync_days (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...Object.values(values))
    .run();
}

describe("POST /api/v1/sites/:id/sync", () => {
  let queue: FakeQueue;
  let key: string;
  const today = () => todayUtc(Date.now());

  beforeEach(async () => {
    queue = fakeQueue();
    key = (await sharedServiceAccount()).key;
  });

  function syncRequest(id: string, json: unknown, env: Record<string, unknown> = {}) {
    return send(`/api/v1/sites/${id}/sync`, {
      cookies: memberCookies,
      json,
      env: { SYNC_QUEUE: queue, GOOGLE_SERVICE_ACCOUNT_KEY: key, ...env },
    });
  }

  it("returns 401 without a session", async () => {
    const site = await createSite({ gscProperty: GSC });
    const res = await send(`/api/v1/sites/${site.id}/sync`, { json: { start_date: today(), end_date: today() } });
    await expectError(res, 401, "unauthorized");
  });

  it("queues every day of every dataset with a property", async () => {
    const site = await createSite({ gscProperty: GSC, ga4PropertyId: GA4 });
    const end = addDays(today(), -1);
    const start = addDays(end, -2);
    const res = await syncRequest(site.id, { start_date: start, end_date: end });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: 12, days: 3 });
    expect(queue.messages).toHaveLength(12);
    expect(queue.messages).toContainEqual(
      expect.objectContaining({ kind: "sync", siteId: site.id, dataset: "ga4_landing_pages", date: start, property: GA4, offset: 0 }),
    );
    expect(queue.messages).toContainEqual(
      expect.objectContaining({ kind: "sync", siteId: site.id, dataset: "ga4_pages", date: start, property: GA4, offset: 0 }),
    );
    // A manual import accepts a day without rows.
    expect(queue.messages.every((m) => m.kind === "sync" && m.acceptEmpty === true)).toBe(true);
    expect(await countTable("sync_days")).toBe(12);
  });

  it("queues the GA4 property alone, and today", async () => {
    const site = await createSite({ ga4PropertyId: GA4 });
    const res = await syncRequest(site.id, { start_date: today(), end_date: today() });
    expect(await res.json()).toEqual({ queued: 2, days: 1 });
    expect(queue.messages.map((m) => (m.kind === "sync" ? m.dataset : "")).sort()).toEqual(["ga4_landing_pages", "ga4_pages"]);
  });

  it("asks for succeeded days again (force)", async () => {
    const site = await createSite({ gscProperty: GSC });
    const date = addDays(today(), -20);
    await insertDay(site.id, { date, last_succeeded_at: 1, last_data_state: "final" });
    await insertDay(site.id, { date, dataset: "gsc_queries", status: "queued", queued_at: Date.now() });
    const res = await syncRequest(site.id, { start_date: date, end_date: date });
    expect(await res.json()).toEqual({ queued: 1, days: 1 });
  });

  it("leaves out the Search Console days older than 16 months", async () => {
    const site = await createSite({ gscProperty: GSC, ga4PropertyId: GA4 });
    const cutoff = subtractMonths(today(), 16);
    const res = await syncRequest(site.id, { start_date: addDays(cutoff, -5), end_date: addDays(cutoff, 4) });
    expect(await res.json()).toEqual({ queued: 30, days: 10 });
    const ga4PagesDates = queue.messages.filter((m) => m.kind === "sync" && m.dataset === "ga4_pages");
    expect(ga4PagesDates).toHaveLength(10);
    const gscDates = queue.messages.filter((m) => m.kind === "sync" && m.dataset === "gsc_pages").map((m) => (m.kind === "sync" ? m.date : ""));
    expect(gscDates.sort()).toEqual([0, 1, 2, 3, 4].map((n) => addDays(cutoff, n)));
  });

  it("validates in order", async () => {
    const site = await createSite({ gscProperty: GSC });
    const invalidDate = "日付は YYYY-MM-DD の形式で入力してください";
    await expectError(await syncRequest(site.id, { start_date: "x", days: 1 }), 400, "unknown_field", "未知の項目があります: days");
    for (const body of [
      {},
      { start_date: today() },
      { start_date: 20261001, end_date: today() },
      { start_date: "2026-1-01", end_date: today() },
      { start_date: "2026-02-30", end_date: today() },
      { start_date: today(), end_date: "2026-13-01" },
    ]) {
      await expectError(await syncRequest(site.id, body), 400, "invalid_date", invalidDate);
    }
    await expectError(
      await syncRequest(site.id, { start_date: today(), end_date: addDays(today(), -1) }),
      400,
      "invalid_range",
      "開始日は終了日以前にしてください",
    );
    await expectError(
      await syncRequest(site.id, { start_date: today(), end_date: addDays(today(), 1) }),
      400,
      "invalid_range",
      "終了日は今日以前にしてください",
    );
    await expectError(
      await syncRequest(site.id, { start_date: addDays(today(), -90), end_date: today() }),
      400,
      "invalid_range",
      "一度に取り込める期間は 90 日までです",
    );
    const ok = { start_date: addDays(today(), -89), end_date: today() };
    await expectError(await syncRequest(MISSING_ID, ok), 404, "not_found", "サイトが見つかりません");
    await expectError(await syncRequest("site_bad", ok), 404, "not_found");
    const bare = await createSite();
    await expectError(
      await syncRequest(bare.id, ok),
      409,
      "not_configured",
      "Search Console か GA4 のプロパティを設定してください",
    );
    await expectError(
      await syncRequest(site.id, ok, { GOOGLE_SERVICE_ACCOUNT_KEY: undefined }),
      409,
      "google_not_configured",
      "サービスアカウントの鍵が設定されていません",
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expectError(
      await syncRequest(site.id, ok, { GOOGLE_SERVICE_ACCOUNT_KEY: "{" }),
      409,
      "google_not_configured",
      "サービスアカウントの鍵を確認してください",
    );
    expect(queue.messages).toEqual([]);
    const accepted = await syncRequest(site.id, ok);
    expect(await accepted.json()).toEqual({ queued: 180, days: 90 });
  });

  it("returns 503 temporarily_unavailable when the queue fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const site = await createSite({ gscProperty: GSC });
    queue.fail = true;
    await expectError(
      await syncRequest(site.id, { start_date: today(), end_date: today() }),
      503,
      "temporarily_unavailable",
      "取り込みを依頼できませんでした。時間をおいてやり直してください",
    );
    const { results } = await env.DB.prepare("SELECT status, error_code FROM sync_days").all();
    expect(results).toEqual([
      { status: "failed", error_code: "enqueue_failed" },
      { status: "failed", error_code: "enqueue_failed" },
    ]);
  });
});

describe("GET /api/v1/sites/:id/sync", () => {
  it("returns 404 not_found for a missing site", async () => {
    for (const id of [MISSING_ID, "site_bad"]) {
      await expectError(await send(`/api/v1/sites/${id}/sync`, { cookies: memberCookies }), 404, "not_found");
    }
  });

  it("counts the days of the current property of each dataset", async () => {
    const site = await createSite({ gscProperty: GSC });
    await insertDay(site.id, { date: "2026-10-01", last_succeeded_at: 100, last_data_state: "final", last_truncated: 1 });
    await insertDay(site.id, { date: "2026-10-02", status: "queued", last_succeeded_at: 300, last_data_state: "provisional", last_truncated: 0 });
    await insertDay(site.id, { date: "2026-10-03", status: "running", last_succeeded_at: 200, last_data_state: "provisional", last_truncated: 0 });
    await insertDay(site.id, { date: "2026-10-04", status: "failed", error_code: "permission_denied", error_message: "denied", finished_at: 500 });
    await insertDay(site.id, { date: "2026-10-05", status: "failed", error_code: "invalid_request", error_message: "bad", finished_at: 600, last_succeeded_at: 50, last_data_state: "final", last_truncated: 0 });
    // Another property, another dataset, another site.
    await insertDay(site.id, { date: "2026-10-09", property: "sc-domain:old.example.com", last_succeeded_at: 900, last_data_state: "final" });
    await insertDay(site.id, { date: "2026-10-01", dataset: "gsc_queries", status: "failed", finished_at: 1 });
    await insertDay(site.id, { date: "2026-10-01", dataset: "ga4_landing_pages", property: GA4, last_succeeded_at: 1 });
    const other = await createSite({ gscProperty: GSC });
    await insertDay(other.id, { date: "2026-10-20", last_succeeded_at: 999, last_data_state: "final" });

    const res = await send(`/api/v1/sites/${site.id}/sync`, { cookies: memberCookies });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncStatus;
    expect(body).toEqual({
      site_id: site.id,
      datasets: [
        {
          dataset: "gsc_pages",
          configured: true,
          property: GSC,
          latest_date: "2026-10-05",
          provisional_from: "2026-10-02",
          last_succeeded_at: 300,
          available_days: 4,
          truncated_days: 1,
          queued: 1,
          running: 1,
          failed: 2,
          recent_failures: [
            { date: "2026-10-05", error_code: "invalid_request", error_message: "bad", finished_at: 600 },
            { date: "2026-10-04", error_code: "permission_denied", error_message: "denied", finished_at: 500 },
          ],
          time_zone: "America/Los_Angeles",
          time_zone_known: true,
          expected_latest_date: expect.any(String),
          state_basis: "api",
          refresh_days: 7,
          recent_days: expect.any(Array),
          // The days of October are not among the recent days.
          final_through: null,
        },
        {
          dataset: "gsc_queries",
          configured: true,
          property: GSC,
          latest_date: null,
          provisional_from: null,
          last_succeeded_at: null,
          available_days: 0,
          truncated_days: 0,
          queued: 0,
          running: 0,
          failed: 1,
          recent_failures: [{ date: "2026-10-01", error_code: null, error_message: null, finished_at: 1 }],
          time_zone: "America/Los_Angeles",
          time_zone_known: true,
          expected_latest_date: expect.any(String),
          state_basis: "api",
          refresh_days: 7,
          recent_days: expect.any(Array),
          final_through: null,
        },
        {
          dataset: "ga4_landing_pages",
          configured: false,
          property: null,
          latest_date: null,
          provisional_from: null,
          last_succeeded_at: null,
          available_days: 0,
          truncated_days: 0,
          queued: 0,
          running: 0,
          failed: 0,
          recent_failures: [],
          time_zone: null,
          time_zone_known: false,
          expected_latest_date: null,
          state_basis: null,
          refresh_days: 0,
          recent_days: [],
          final_through: null,
        },
        {
          dataset: "ga4_pages",
          configured: false,
          property: null,
          latest_date: null,
          provisional_from: null,
          last_succeeded_at: null,
          available_days: 0,
          truncated_days: 0,
          queued: 0,
          running: 0,
          failed: 0,
          recent_failures: [],
          time_zone: null,
          time_zone_known: false,
          expected_latest_date: null,
          state_basis: null,
          refresh_days: 0,
          recent_days: [],
          final_through: null,
        },
      ],
      final_through: null,
    });
    expect(body.datasets[0]?.recent_days).toHaveLength(14);
  });

  it("returns at most 10 recent failures, newest first", async () => {
    const site = await createSite({ gscProperty: GSC });
    for (let i = 1; i <= 12; i++) {
      await insertDay(site.id, { date: addDays("2026-10-01", i), status: "failed", error_code: "x", finished_at: i });
    }
    const body = (await (await send(`/api/v1/sites/${site.id}/sync`, { cookies: memberCookies })).json()) as SyncStatus;
    expect(body.datasets[0]?.failed).toBe(12);
    expect(body.datasets[0]?.recent_failures.map((f) => f.finished_at)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });
});

describe("getSyncStatus", () => {
  // 2026-11-12 06:00 UTC: 2026-11-11 22:00 in Los Angeles, 2026-11-12 15:00 in Tokyo, 2026-11-11 18:00 in Etc/GMT+12.
  const NOW = Date.UTC(2026, 10, 12, 6, 0, 0);

  async function insertDays(siteId: string, dates: string[], row: Record<string, unknown>): Promise<void> {
    for (const date of dates) {
      await insertDay(siteId, { date, last_succeeded_at: 100, last_data_state: "final", last_row_count: 5, ...row });
    }
  }

  function datesFrom(start: string, count: number): string[] {
    return Array.from({ length: count }, (_, i) => addDays(start, i));
  }

  it("returns the state of each of the recent days", async () => {
    const site = await createSite({ gscProperty: GSC });
    await insertDay(site.id, { date: "2026-10-28", last_succeeded_at: 100, last_data_state: "final", last_row_count: 5 });
    await insertDay(site.id, { date: "2026-10-29", last_succeeded_at: 100, last_data_state: "provisional", last_row_count: 4 });
    await insertDay(site.id, { date: "2026-10-30", status: "queued" });
    await insertDay(site.id, { date: "2026-10-31", status: "failed", error_code: "permission_denied" });
    await insertDay(site.id, { date: "2026-11-01", status: "running", last_succeeded_at: 200, last_data_state: "final", last_row_count: 3 });
    await insertDay(site.id, { date: "2026-11-02", status: "failed", error_code: "empty_response", last_succeeded_at: 300, last_data_state: "provisional", last_row_count: 2 });
    // Another property.
    await insertDay(site.id, { date: "2026-11-03", property: "sc-domain:old.example.com", last_succeeded_at: 100, last_data_state: "final" });
    const status = await getSyncStatus(env.DB, { id: site.id, gscProperty: GSC, ga4PropertyId: null }, NOW);
    const pages = status.datasets[0];
    expect(pages?.expected_latest_date).toBe("2026-11-10");
    expect(pages?.recent_days.map((d) => d.date)).toEqual(datesFrom("2026-10-28", 14));
    expect(pages?.recent_days.slice(0, 7)).toEqual([
      { date: "2026-10-28", state: "final", updating: false, row_count: 5, fetched_at: 100, error_code: null },
      { date: "2026-10-29", state: "provisional", updating: false, row_count: 4, fetched_at: 100, error_code: null },
      { date: "2026-10-30", state: "pending", updating: false, row_count: null, fetched_at: null, error_code: null },
      { date: "2026-10-31", state: "failed", updating: false, row_count: null, fetched_at: null, error_code: "permission_denied" },
      { date: "2026-11-01", state: "final", updating: true, row_count: 3, fetched_at: 200, error_code: null },
      { date: "2026-11-02", state: "provisional", updating: false, row_count: 2, fetched_at: 300, error_code: "empty_response" },
      { date: "2026-11-03", state: "missing", updating: false, row_count: null, fetched_at: null, error_code: null },
    ]);
    expect(pages?.final_through).toBe("2026-10-28");
    // The first day is not final.
    expect(status.datasets[1]?.final_through).toBeNull();
    expect(status.final_through).toBeNull();
  });

  it("returns final_through of every dataset and the earliest of them, in their time zones", async () => {
    const site = await createSite({ gscProperty: GSC, ga4PropertyId: GA4 });
    await insertDays(site.id, datesFrom("2026-10-28", 14).filter((date) => date !== "2026-11-09"), {});
    await insertDay(site.id, { date: "2026-11-09", last_succeeded_at: 100, last_data_state: "provisional" });
    await insertDays(site.id, datesFrom("2026-10-28", 14), { dataset: "gsc_queries" });
    await insertDays(site.id, datesFrom("2026-10-29", 10), { dataset: "ga4_landing_pages", property: GA4, last_time_zone: "Asia/Tokyo" });
    await insertDay(site.id, { date: "2026-11-08", dataset: "ga4_landing_pages", property: GA4, status: "queued" });
    await insertDays(site.id, datesFrom("2026-10-29", 14), { dataset: "ga4_pages", property: GA4, last_time_zone: "Asia/Tokyo" });
    const { d1, count } = d1Counting();
    const status = await getSyncStatus(d1, { id: site.id, gscProperty: GSC, ga4PropertyId: GA4 }, NOW);
    expect(count()).toBe(1);
    const [pages, queries, ga4, ga4Pages] = status.datasets;
    expect(pages).toMatchObject({ expected_latest_date: "2026-11-10", final_through: "2026-11-08" });
    expect(queries).toMatchObject({ expected_latest_date: "2026-11-10", final_through: "2026-11-10" });
    expect(ga4).toMatchObject({
      time_zone: "Asia/Tokyo",
      time_zone_known: true,
      expected_latest_date: "2026-11-11",
      state_basis: "elapsed_days",
      refresh_days: 10,
      final_through: "2026-11-07",
    });
    expect(ga4?.recent_days[0]?.date).toBe("2026-10-29");
    expect(ga4Pages).toMatchObject({
      time_zone: "Asia/Tokyo",
      expected_latest_date: "2026-11-11",
      state_basis: "elapsed_days",
      refresh_days: 10,
      final_through: "2026-11-11",
    });
    expect(status.final_through).toBe("2026-11-07");
  });

  it("includes ga4_pages in final_through of the site", async () => {
    const site = await createSite({ ga4PropertyId: GA4 });
    await insertDays(site.id, datesFrom("2026-10-29", 14), { dataset: "ga4_landing_pages", property: GA4, last_time_zone: "Asia/Tokyo" });
    const before = await getSyncStatus(env.DB, { id: site.id, gscProperty: null, ga4PropertyId: GA4 }, NOW);
    expect(before.datasets.map((d) => d.dataset)).toEqual(["gsc_pages", "gsc_queries", "ga4_landing_pages", "ga4_pages"]);
    expect(before.datasets[2]?.final_through).toBe("2026-11-11");
    // The time zone recorded by ga4_landing_pages is used for ga4_pages as well.
    expect(before.datasets[3]).toMatchObject({ time_zone: "Asia/Tokyo", expected_latest_date: "2026-11-11", final_through: null });
    // Not imported yet: the site has no final_through until the days of ga4_pages are imported.
    expect(before.final_through).toBeNull();
    await insertDays(site.id, datesFrom("2026-10-29", 12), { dataset: "ga4_pages", property: GA4, last_time_zone: "Asia/Tokyo" });
    const after = await getSyncStatus(env.DB, { id: site.id, gscProperty: null, ga4PropertyId: GA4 }, NOW);
    expect(after.final_through).toBe("2026-11-09");
  });

  it("uses yesterday in Etc/GMT+12 while the time zone of the GA4 property is not known", async () => {
    const site = await createSite({ ga4PropertyId: GA4 });
    // A time zone of another property, and a failed day with a time zone, are not used.
    await insertDay(site.id, { date: "2026-10-01", dataset: "ga4_landing_pages", property: "999", last_succeeded_at: 1, last_time_zone: "Asia/Tokyo" });
    await insertDay(site.id, { date: "2026-10-02", dataset: "ga4_landing_pages", property: GA4, status: "failed", last_time_zone: "Asia/Tokyo" });
    const status = await getSyncStatus(env.DB, { id: site.id, gscProperty: null, ga4PropertyId: GA4 }, NOW);
    expect(status.datasets[2]).toMatchObject({
      configured: true,
      time_zone: null,
      time_zone_known: false,
      expected_latest_date: "2026-11-10",
      state_basis: "elapsed_days",
    });
    expect(status.datasets[0]).toMatchObject({ configured: false, expected_latest_date: null, recent_days: [], refresh_days: 0 });
  });

  it("returns null final_through without a configured dataset", async () => {
    const site = await createSite();
    const status = await getSyncStatus(env.DB, { id: site.id, gscProperty: null, ga4PropertyId: null }, NOW);
    expect(status.final_through).toBeNull();
  });
});

describe("imported data on property changes and deletion", () => {
  let queue: FakeQueue;

  beforeEach(() => {
    queue = fakeQueue();
  });

  async function seed(siteId: string): Promise<void> {
    for (const dataset of ["gsc_pages", "gsc_queries"]) await insertDay(siteId, { date: "2026-10-01", dataset });
    await insertDay(siteId, { date: "2026-10-01", dataset: "ga4_landing_pages", property: GA4 });
    await insertDay(siteId, { date: "2026-10-01", dataset: "ga4_pages", property: GA4 });
  }

  async function datasetsLeft(): Promise<string[]> {
    const { results } = await env.DB.prepare("SELECT dataset FROM sync_days ORDER BY dataset").all<{ dataset: string }>();
    return results.map((row) => row.dataset);
  }

  async function purges() {
    const { results } = await env.DB.prepare(
      "SELECT id, site_id, dataset, property FROM pending_purges ORDER BY dataset",
    ).all<{ id: string; site_id: string; dataset: string; property: string | null }>();
    return results;
  }

  function patch(id: string, json: unknown) {
    return send(`/api/v1/sites/${id}`, { method: "PATCH", cookies: memberCookies, json, env: { SYNC_QUEUE: queue } });
  }

  it("forgets the Search Console days and purges their rows when the property changes", async () => {
    const site = await createSite({ gscProperty: GSC, ga4PropertyId: GA4 });
    await seed(site.id);
    const res = await patch(site.id, { gsc_property: "sc-domain:new.example.com" });
    expect(res.status).toBe(200);
    expect(await datasetsLeft()).toEqual(["ga4_landing_pages", "ga4_pages"]);
    const rows = await purges();
    expect(rows.map(({ site_id, dataset, property }) => ({ site_id, dataset, property }))).toEqual([
      { site_id: site.id, dataset: "gsc_pages", property: GSC },
      { site_id: site.id, dataset: "gsc_queries", property: GSC },
    ]);
    expect(queue.messages.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(
      rows.map((row) => ({ kind: "purge", purgeId: row.id })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  });

  it("forgets the GA4 days when the GA4 property is cleared", async () => {
    const site = await createSite({ gscProperty: GSC, ga4PropertyId: GA4 });
    await seed(site.id);
    expect((await patch(site.id, { ga4_property_id: "" })).status).toBe(200);
    expect(await datasetsLeft()).toEqual(["gsc_pages", "gsc_queries"]);
    expect((await purges()).map((row) => [row.dataset, row.property])).toEqual([
      ["ga4_landing_pages", GA4],
      ["ga4_pages", GA4],
    ]);
    expect(queue.messages).toHaveLength(2);
  });

  it("creates no purge when a property is set for the first time", async () => {
    const site = await createSite({ ga4PropertyId: GA4 });
    await seed(site.id);
    expect((await patch(site.id, { gsc_property: GSC })).status).toBe(200);
    expect(await datasetsLeft()).toEqual(["ga4_landing_pages", "ga4_pages"]);
    expect(await purges()).toEqual([]);
    expect(queue.messages).toEqual([]);
  });

  it("keeps everything when the properties do not change", async () => {
    const site = await createSite({ gscProperty: GSC, ga4PropertyId: GA4 });
    await seed(site.id);
    expect((await patch(site.id, { name: "Renamed", gsc_property: " SC-DOMAIN:Example.com ", ga4_property_id: GA4 })).status).toBe(200);
    expect(await datasetsLeft()).toEqual(["ga4_landing_pages", "ga4_pages", "gsc_pages", "gsc_queries"]);
    expect(await purges()).toEqual([]);
  });

  it("logs a failed purge message and still answers 200", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const site = await createSite({ gscProperty: GSC });
    queue.fail = true;
    expect((await patch(site.id, { gsc_property: null })).status).toBe(200);
    expect(await purges()).toHaveLength(2);
    expect(error).toHaveBeenCalledWith("sending purges failed", expect.anything());
  });

  it("forgets every day and purges every dataset when the site is deleted", async () => {
    const site = await createSite({ gscProperty: GSC, ga4PropertyId: GA4 });
    const other = await createSite({ gscProperty: GSC });
    await seed(site.id);
    await insertDay(other.id, { date: "2026-10-01" });
    const res = await send(`/api/v1/sites/${site.id}`, { method: "DELETE", cookies: memberCookies, env: { SYNC_QUEUE: queue } });
    expect(res.status).toBe(204);
    expect(await datasetsLeft()).toEqual(["gsc_pages"]);
    const rows = await purges();
    expect(rows.map(({ site_id, dataset, property }) => ({ site_id, dataset, property }))).toEqual([
      { site_id: site.id, dataset: "ga4_landing_pages", property: null },
      { site_id: site.id, dataset: "ga4_pages", property: null },
      { site_id: site.id, dataset: "gsc_pages", property: null },
      { site_id: site.id, dataset: "gsc_queries", property: null },
    ]);
    expect(queue.messages).toHaveLength(4);
  });

  it("creates no purge when deleting a missing site", async () => {
    await expectError(
      await send(`/api/v1/sites/${MISSING_ID}`, { method: "DELETE", cookies: memberCookies, env: { SYNC_QUEUE: queue } }),
      404,
      "not_found",
    );
    expect(await purges()).toEqual([]);
    expect(queue.messages).toEqual([]);
  });

  it("creates no purge when the site is deleted concurrently", async () => {
    const site = await createSite({ gscProperty: GSC });
    const db = dbChangingBefore(/INSERT INTO pending_purges/, async () => {
      await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(site.id).run();
    });
    const res = await send(`/api/v1/sites/${site.id}`, {
      method: "DELETE",
      cookies: memberCookies,
      env: { SYNC_QUEUE: queue, DB: db.$client },
    });
    await expectError(res, 404, "not_found");
    expect(await purges()).toEqual([]);
    expect(queue.messages).toEqual([]);
  });
});
