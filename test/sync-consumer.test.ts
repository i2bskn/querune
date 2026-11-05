import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "@i2bskn/workers-app-core";
import type { SiteRow } from "../src/db/schema";
import { PAGE_ROWS } from "../src/google/api";
import { clearGoogleTokenCache } from "../src/google/credentials";
import { newUlid } from "../src/ids";
import { handleSyncQueue, SYNC_DEAD_LETTER_QUEUE, SYNC_QUEUE } from "../src/sync/consumer";
import { enqueueSync, type Dataset, type SyncMessage } from "../src/sync/enqueue";
import {
  countTable,
  createSite,
  dbChangingBefore,
  fakeBatch,
  fakeMessage,
  fakeQueue,
  resetDb,
  type FakeMessage,
  type FakeQueue,
} from "./helpers";
import { fakeGoogle, ga4Rows, gscRows, sharedServiceAccount, type FakeGoogle } from "./google";

const GSC = "sc-domain:example.com";
const GA4 = "123456789";
// 2026-11-05 03:00 UTC: 2026-11-04 in Pacific Time.
const NOW = Date.UTC(2026, 10, 5, 3, 0, 0);
const FINAL_DATE = "2026-10-20";
const HOUR = 60 * 60 * 1000;

type SyncBody = Extract<SyncMessage, { kind: "sync" }>;

type DayRow = {
  status: string;
  property: string;
  run_id: string;
  started_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
  error_code: string | null;
  error_message: string | null;
  last_succeeded_at: number | null;
  last_data_state: string | null;
  last_row_count: number | null;
  last_truncated: number | null;
  last_time_zone: string | null;
};

let now: number;
let site: SiteRow;
let queue: FakeQueue;
let google: FakeGoogle;
let key: string;

beforeEach(async () => {
  await resetDb();
  clearGoogleTokenCache();
  now = NOW;
  vi.spyOn(clock, "now").mockImplementation(() => now);
  site = await createSite({ gscProperty: GSC, ga4PropertyId: GA4 });
  queue = fakeQueue();
  google = fakeGoogle();
  key = (await sharedServiceAccount()).key;
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearGoogleTokenCache();
  await resetDb();
});

function testEnv(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return { ...env, SYNC_QUEUE: queue, GOOGLE_SERVICE_ACCOUNT_KEY: key, ...overrides };
}

// Queues one day and returns its first message.
async function queueDay(dataset: Dataset, date = FINAL_DATE, property = dataset === "ga4_landing_pages" ? GA4 : GSC) {
  const sending = fakeQueue();
  await enqueueSync(env.DB, sending, [{ siteId: site.id, dataset, date, property }], { now, force: true });
  const message = sending.messages[0];
  if (message?.kind !== "sync") throw new Error("not queued");
  return message;
}

async function deliver(
  body: unknown,
  options: { attempts?: number; queueName?: string; db?: D1Database; overrides?: Partial<Cloudflare.Env> } = {},
): Promise<FakeMessage> {
  const message = fakeMessage(body, options.attempts ?? 1);
  const testing = testEnv({ ...(options.db ? { DB: options.db } : {}), ...options.overrides });
  await handleSyncQueue(fakeBatch(options.queueName ?? SYNC_QUEUE, [message]), testing, { fetcher: google.fetcher });
  return message;
}

async function day(dataset: Dataset, date = FINAL_DATE): Promise<DayRow | null> {
  return env.DB.prepare("SELECT * FROM sync_days WHERE site_id = ? AND dataset = ? AND date = ?")
    .bind(site.id, dataset, date)
    .first<DayRow>();
}

// Answers the Search Analytics API with the given number of rows in total, PAGE_ROWS per page.
function gscAnswers(total: number, dataset: "gsc_pages" | "gsc_queries", metadata?: Record<string, unknown>) {
  google.api = (call) => {
    const body = call.body as { startRow: number; rowLimit: number };
    const count = Math.max(0, Math.min(body.rowLimit, total - body.startRow));
    const response: Record<string, unknown> = { responseAggregationType: "byPage" };
    if (count > 0) response.rows = gscRows(count, dataset, body.startRow);
    if (metadata) response.metadata = metadata;
    return Response.json(response);
  };
}

function ga4Answers(total: number, date: string, timeZone: string | null = "Asia/Tokyo") {
  google.api = (call) => {
    const body = call.body as { offset: number; limit: number };
    const count = Math.max(0, Math.min(body.limit, total - body.offset));
    return Response.json({
      ...(count > 0 ? { rows: ga4Rows(count, date, body.offset) } : {}),
      rowCount: total,
      ...(timeZone === null ? {} : { metadata: { timeZone } }),
    });
  };
}

// Delivers the message and every follow-up message it sends, in order.
async function deliverAll(first: SyncBody): Promise<SyncBody[]> {
  const delivered: SyncBody[] = [];
  let next: SyncMessage | undefined = first;
  while (next !== undefined) {
    if (next.kind !== "sync") throw new Error("unexpected message");
    delivered.push(next);
    const before = queue.messages.length;
    const message = await deliver(next);
    expect(message.acked).toBe(true);
    next = queue.messages.length > before ? queue.messages[queue.messages.length - 1] : undefined;
  }
  return delivered;
}

describe("Search Console", () => {
  it("imports one page of page rows and records the day", async () => {
    gscAnswers(3, "gsc_pages");
    const first = await queueDay("gsc_pages");
    const message = await deliver(first);
    expect(message.acked).toBe(true);
    expect(queue.messages).toEqual([]);
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]?.url).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query",
    );
    expect(google.calls[0]?.authorization).toBe("Bearer test-access-token");
    expect(google.calls[0]?.body).toEqual({
      startDate: FINAL_DATE,
      endDate: FINAL_DATE,
      dimensions: ["page"],
      type: "web",
      dataState: "all",
      rowLimit: PAGE_ROWS,
      startRow: 0,
    });
    const { results } = await env.DB.prepare(
      "SELECT page, clicks, impressions, position, typeof(clicks) AS t_clicks, typeof(impressions) AS t_impressions, typeof(position) AS t_position, run_id FROM gsc_page_daily ORDER BY page",
    ).all();
    expect(results).toEqual(
      gscRows(3, "gsc_pages").map((row) => ({
        page: row.keys[0],
        clicks: row.clicks,
        impressions: row.impressions,
        position: row.position,
        t_clicks: "integer",
        t_impressions: "integer",
        t_position: "real",
        run_id: first.runId,
      })),
    );
    expect(await day("gsc_pages")).toMatchObject({
      status: "succeeded",
      started_at: NOW,
      heartbeat_at: NOW,
      finished_at: NOW,
      error_code: null,
      last_succeeded_at: NOW,
      last_data_state: "final",
      last_row_count: 3,
      last_truncated: 0,
      last_time_zone: "America/Los_Angeles",
    });
  });

  it("imports page and query rows, with several rows per statement", async () => {
    gscAnswers(1500, "gsc_queries");
    const first = await queueDay("gsc_queries");
    expect((await deliver(first)).acked).toBe(true);
    expect(google.calls[0]?.body).toMatchObject({ dimensions: ["page", "query"] });
    expect(await countTable("gsc_query_daily")).toBe(1500);
    const row = await env.DB.prepare(
      "SELECT page, query, clicks, typeof(clicks) AS t FROM gsc_query_daily WHERE query = 'query 1234'",
    ).first();
    expect(row).toEqual({ page: "https://example.com/p/123", query: "query 1234", clicks: 1234 % 7, t: "integer" });
    expect(await day("gsc_queries")).toMatchObject({ status: "succeeded", last_row_count: 1500, last_truncated: 0 });
  });

  it("imports several pages through follow-up messages", async () => {
    gscAnswers(5000, "gsc_pages");
    const delivered = await deliverAll(await queueDay("gsc_pages"));
    expect(delivered.map((m) => m.offset)).toEqual([0, 2000, 4000]);
    expect(new Set(delivered.map((m) => m.runId)).size).toBe(1);
    expect(await countTable("gsc_page_daily")).toBe(5000);
    expect(await day("gsc_pages")).toMatchObject({ status: "succeeded", last_row_count: 5000, last_truncated: 0 });
  });

  it("does not send a follow-up for exactly 2,000 rows at the last allowed page, and records the truncation", async () => {
    gscAnswers(60000, "gsc_pages");
    const first = await queueDay("gsc_pages");
    // The page at offset 48,000 is the last one that fits within 50,000 rows.
    expect((await deliver({ ...first, offset: 48000 })).acked).toBe(true);
    expect(queue.messages).toEqual([]);
    expect(await day("gsc_pages")).toMatchObject({ status: "succeeded", last_row_count: 2000, last_truncated: 1 });
  });

  it("succeeds with zero rows", async () => {
    gscAnswers(0, "gsc_pages");
    expect((await deliver(await queueDay("gsc_pages"))).acked).toBe(true);
    expect(await day("gsc_pages")).toMatchObject({ status: "succeeded", last_row_count: 0, last_truncated: 0 });
  });

  it("upserts the rows and deletes the rows the new import did not write", async () => {
    gscAnswers(3, "gsc_pages");
    await deliver(await queueDay("gsc_pages"));
    // The next import returns new values for 2 of the 3 pages.
    google.api = () =>
      Response.json({
        rows: [
          { keys: ["https://example.com/p/0"], clicks: 100, impressions: 1000, position: 2.5 },
          { keys: ["https://example.com/p/1"], clicks: 50, impressions: 500, position: 3.5 },
        ],
      });
    now += 60_000;
    const second = await queueDay("gsc_pages");
    await deliver(second);
    const { results } = await env.DB.prepare("SELECT page, clicks, run_id FROM gsc_page_daily ORDER BY page").all();
    expect(results).toEqual([
      { page: "https://example.com/p/0", clicks: 100, run_id: second.runId },
      { page: "https://example.com/p/1", clicks: 50, run_id: second.runId },
    ]);
    expect(await day("gsc_pages")).toMatchObject({ last_row_count: 2, last_succeeded_at: now });
  });

  it("keeps the rows of another day and another property", async () => {
    gscAnswers(2, "gsc_pages");
    await deliver(await queueDay("gsc_pages", "2026-10-19"));
    await env.DB.prepare(
      "INSERT INTO gsc_page_daily VALUES (?, 'sc-domain:old.example.com', ?, 'https://old.example.com/', 1, 1, 1, 'r')",
    )
      .bind(site.id, FINAL_DATE)
      .run();
    await deliver(await queueDay("gsc_pages", FINAL_DATE));
    expect(await countTable("gsc_page_daily")).toBe(5);
  });

  it("records provisional data from the metadata and from the recent days", async () => {
    gscAnswers(1, "gsc_pages", { first_incomplete_date: FINAL_DATE });
    await deliver(await queueDay("gsc_pages"));
    expect((await day("gsc_pages"))?.last_data_state).toBe("provisional");

    gscAnswers(1, "gsc_pages", { firstIncompleteDate: "2026-10-21" });
    await deliver(await queueDay("gsc_pages"));
    expect((await day("gsc_pages"))?.last_data_state).toBe("final");

    // Today in Pacific Time is 2026-11-04: from 2026-11-01 the data is provisional.
    gscAnswers(1, "gsc_pages");
    await deliver(await queueDay("gsc_pages", "2026-11-01"));
    expect((await day("gsc_pages", "2026-11-01"))?.last_data_state).toBe("provisional");
    await deliver(await queueDay("gsc_pages", "2026-10-31"));
    expect((await day("gsc_pages", "2026-10-31"))?.last_data_state).toBe("final");
  });
});

describe("GA4", () => {
  it("imports the rows and records the time zone of the property", async () => {
    ga4Answers(3, FINAL_DATE);
    const first = await queueDay("ga4_landing_pages");
    expect((await deliver(first)).acked).toBe(true);
    expect(google.calls[0]?.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport");
    expect(google.calls[0]?.body).toEqual({
      dateRanges: [{ startDate: FINAL_DATE, endDate: FINAL_DATE }],
      dimensions: [{ name: "date" }, { name: "landingPage" }, { name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }],
      orderBys: [
        { dimension: { dimensionName: "landingPage" } },
        { dimension: { dimensionName: "sessionDefaultChannelGroup" } },
      ],
      limit: PAGE_ROWS,
      offset: 0,
      keepEmptyRows: false,
    });
    const { results } = await env.DB.prepare(
      "SELECT date, landing_page, channel_group, sessions, engaged_sessions, key_events, typeof(sessions) AS t_sessions, typeof(key_events) AS t_key_events FROM ga4_landing_daily ORDER BY landing_page",
    ).all();
    expect(results).toEqual([
      { date: FINAL_DATE, landing_page: "/p/0", channel_group: "Organic Search", sessions: 5, engaged_sessions: 2, key_events: 1.5, t_sessions: "integer", t_key_events: "real" },
      { date: FINAL_DATE, landing_page: "/p/1", channel_group: "Direct", sessions: 6, engaged_sessions: 3, key_events: 1.5, t_sessions: "integer", t_key_events: "real" },
      { date: FINAL_DATE, landing_page: "/p/2", channel_group: "Organic Search", sessions: 7, engaged_sessions: 2, key_events: 1.5, t_sessions: "integer", t_key_events: "real" },
    ]);
    expect(await day("ga4_landing_pages")).toMatchObject({
      status: "succeeded",
      last_data_state: "final",
      last_row_count: 3,
      last_time_zone: "Asia/Tokyo",
    });
  });

  it("imports several pages through follow-up messages", async () => {
    ga4Answers(4001, FINAL_DATE);
    const delivered = await deliverAll(await queueDay("ga4_landing_pages"));
    expect(delivered.map((m) => m.offset)).toEqual([0, 2000, 4000]);
    expect(await countTable("ga4_landing_daily")).toBe(4001);
  });

  it("decides provisional days in the time zone of the property, or UTC", async () => {
    // 2026-11-05 03:00 UTC is 2026-11-05 in Tokyo and 2026-11-04 in Los Angeles.
    ga4Answers(1, "2026-11-03", "Asia/Tokyo");
    await deliver(await queueDay("ga4_landing_pages", "2026-11-03"));
    expect((await day("ga4_landing_pages", "2026-11-03"))?.last_data_state).toBe("provisional");
    ga4Answers(1, "2026-11-02", "Asia/Tokyo");
    await deliver(await queueDay("ga4_landing_pages", "2026-11-02"));
    expect((await day("ga4_landing_pages", "2026-11-02"))?.last_data_state).toBe("final");
    ga4Answers(1, "2026-11-02", "America/Los_Angeles");
    await deliver(await queueDay("ga4_landing_pages", "2026-11-02"));
    expect((await day("ga4_landing_pages", "2026-11-02"))?.last_data_state).toBe("provisional");
    ga4Answers(1, "2026-11-02", "Not/AZone");
    await deliver(await queueDay("ga4_landing_pages", "2026-11-02"));
    expect(await day("ga4_landing_pages", "2026-11-02")).toMatchObject({ last_data_state: "final", last_time_zone: "UTC" });
    ga4Answers(1, "2026-11-03", null);
    await deliver(await queueDay("ga4_landing_pages", "2026-11-03"));
    expect(await day("ga4_landing_pages", "2026-11-03")).toMatchObject({
      last_data_state: "provisional",
      last_time_zone: "UTC",
    });
  });
});

describe("replaced and duplicate messages", () => {
  it("drops a message of a replaced import", async () => {
    gscAnswers(2, "gsc_pages");
    const old = await queueDay("gsc_pages");
    // The message of old has expired, so the day is queued again.
    now += 25 * HOUR;
    await queueDay("gsc_pages");
    const message = await deliver(old);
    expect(message.acked).toBe(true);
    expect(google.calls).toHaveLength(0);
    expect((await day("gsc_pages"))?.status).toBe("queued");
  });

  it("drops a duplicate message of a succeeded day", async () => {
    gscAnswers(2, "gsc_pages");
    const first = await queueDay("gsc_pages");
    await deliver(first);
    google.calls.length = 0;
    const message = await deliver(first);
    expect(message.acked).toBe(true);
    expect(google.calls).toHaveLength(0);
  });

  it("drops malformed messages", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await queueDay("gsc_pages");
    for (const body of [null, "x", { kind: "other" }, { ...first, offset: 1 }, { ...first, dataset: "x" }, { ...first, date: "2026-02-30" }]) {
      expect((await deliver(body)).acked).toBe(true);
    }
    expect(error).toHaveBeenCalledWith("sync message is malformed", expect.anything());
    expect(google.calls).toHaveLength(0);
  });

  it("writes nothing when the property changes while Google answers", async () => {
    gscAnswers(3, "gsc_pages");
    const first = await queueDay("gsc_pages");
    const db = dbChangingBefore(/INSERT INTO gsc_page_daily/, async () => {
      await env.DB.batch([
        env.DB.prepare("UPDATE sites SET gsc_property = 'sc-domain:new.example.com' WHERE id = ?").bind(site.id),
        env.DB.prepare("DELETE FROM sync_days WHERE site_id = ?").bind(site.id),
      ]);
    });
    expect((await deliver(first, { db: db.$client })).acked).toBe(true);
    expect(await countTable("gsc_page_daily")).toBe(0);
    expect(await countTable("sync_days")).toBe(0);
  });

  it("writes nothing when the site is deleted while Google answers", async () => {
    ga4Answers(3, FINAL_DATE);
    const first = await queueDay("ga4_landing_pages");
    const db = dbChangingBefore(/INSERT INTO ga4_landing_daily/, async () => {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM sync_days WHERE site_id = ?").bind(site.id),
        env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(site.id),
      ]);
    });
    expect((await deliver(first, { db: db.$client })).acked).toBe(true);
    expect(await countTable("ga4_landing_daily")).toBe(0);
  });

  it("drops the message when the property of the site no longer matches", async () => {
    const first = await queueDay("gsc_pages");
    await env.DB.prepare("UPDATE sites SET gsc_property = 'sc-domain:other.example.com' WHERE id = ?").bind(site.id).run();
    expect((await deliver(first)).acked).toBe(true);
    expect(google.calls).toHaveLength(0);
  });
});

describe("errors", () => {
  async function failedWith(
    answer: () => Response,
    code: string,
    message: string,
    dataset: Dataset = "gsc_pages",
  ): Promise<void> {
    google.api = answer;
    const m = await deliver(await queueDay(dataset));
    expect(m.acked).toBe(true);
    expect(m.retried).toBeNull();
    expect(await day(dataset)).toMatchObject({
      status: "failed",
      error_code: code,
      error_message: message,
      finished_at: now,
      last_succeeded_at: null,
    });
  }

  const googleError = (status: number, message?: string) => () =>
    Response.json(message === undefined ? {} : { error: { code: status, message } }, { status });

  it("records failures that are not retried", async () => {
    await failedWith(googleError(400, "Invalid date"), "invalid_request", "Invalid date");
    await failedWith(googleError(400), "invalid_request", "HTTP 400");
    await failedWith(googleError(403, "User does not have sufficient permission"), "permission_denied", "User does not have sufficient permission");
    await failedWith(googleError(403), "permission_denied", "サービスアカウントにプロパティの閲覧権限がありません");
    await failedWith(googleError(404, "Property not found"), "property_not_found", "Property not found", "ga4_landing_pages");
    await failedWith(googleError(404), "property_not_found", "HTTP 404");
    await failedWith(() => Response.json({ rows: [{ keys: [], clicks: 1, impressions: 1, position: 1 }] }), "invalid_response", "Google の応答を読み取れませんでした");
    await failedWith(() => new Response("not json", { status: 200 }), "invalid_response", "Google の応答を読み取れませんでした");
    await failedWith(
      () => Response.json({ rows: [{ dimensionValues: [{ value: "20261020" }, { value: "/" }, { value: "Direct" }], metricValues: [{ value: "x" }, { value: "1" }, { value: "1" }] }] }),
      "invalid_response",
      "Google の応答を読み取れませんでした",
      "ga4_landing_pages",
    );
  });

  it("cuts Google's message to 500 characters", async () => {
    await failedWith(googleError(400, "a".repeat(600)), "invalid_request", "a".repeat(500));
  });

  it("records google_not_configured and credentials_invalid", async () => {
    const first = await queueDay("gsc_pages");
    expect((await deliver(first, { overrides: { GOOGLE_SERVICE_ACCOUNT_KEY: undefined } })).acked).toBe(true);
    expect(await day("gsc_pages")).toMatchObject({
      status: "failed",
      error_code: "google_not_configured",
      error_message: "サービスアカウントの鍵が設定されていません",
    });

    vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = await queueDay("gsc_pages");
    expect((await deliver(second, { overrides: { GOOGLE_SERVICE_ACCOUNT_KEY: "{" } })).acked).toBe(true);
    expect(await day("gsc_pages")).toMatchObject({
      status: "failed",
      error_code: "credentials_invalid",
      error_message: "サービスアカウントの鍵を確認してください",
    });

    for (const status of [400, 401]) {
      clearGoogleTokenCache();
      google.token = () => Response.json({ error: "invalid_grant" }, { status });
      const third = await queueDay("gsc_pages");
      expect((await deliver(third)).acked).toBe(true);
      expect((await day("gsc_pages"))?.error_code).toBe("credentials_invalid");
    }
    expect(google.calls).toHaveLength(0);
  });

  it("retries 401, 429, 5xx, network errors and token failures with a growing delay, leaving the day running", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: { setup: () => void; attempts: number; delay: number }[] = [
      { setup: () => (google.api = googleError(429)), attempts: 1, delay: 60 },
      { setup: () => (google.api = googleError(500)), attempts: 2, delay: 120 },
      { setup: () => (google.api = googleError(503)), attempts: 3, delay: 240 },
      { setup: () => (google.api = googleError(401)), attempts: 5, delay: 960 },
      {
        setup: () =>
          (google.api = () => {
            throw new TypeError("network");
          }),
        attempts: 7,
        delay: 3600,
      },
      {
        setup: () => {
          clearGoogleTokenCache();
          google.token = () => new Response("", { status: 503 });
        },
        attempts: 1,
        delay: 60,
      },
      {
        setup: () => {
          clearGoogleTokenCache();
          google.token = () => new Response("", { status: 429 });
        },
        attempts: 2,
        delay: 120,
      },
    ];
    for (const { setup, attempts, delay } of cases) {
      setup();
      // The day of the previous case is running; it is queued again once it counts as stopped.
      now += 7 * HOUR;
      const first = await queueDay("gsc_pages");
      const message = await deliver(first, { attempts });
      expect(message.acked).toBe(false);
      expect(message.retried).toEqual({ delaySeconds: delay });
      expect(await day("gsc_pages")).toMatchObject({ status: "running", error_code: null });
    }
  });

  it("clears the cached token on 401", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await queueDay("gsc_pages");
    google.api = googleError(401);
    await deliver(first);
    expect(google.tokenCalls).toBe(1);
    gscAnswers(1, "gsc_pages");
    expect((await deliver(first, { attempts: 2 })).acked).toBe(true);
    expect(google.tokenCalls).toBe(2);
    expect((await day("gsc_pages"))?.status).toBe("succeeded");
  });

  it("goes on with the same message after a 429 on the first page", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await queueDay("gsc_pages");
    google.api = googleError(429);
    expect((await deliver(first)).retried).toEqual({ delaySeconds: 60 });
    now += 60_000;
    gscAnswers(2, "gsc_pages");
    expect((await deliver(first, { attempts: 2 })).acked).toBe(true);
    expect(await day("gsc_pages")).toMatchObject({ status: "succeeded", started_at: NOW, last_row_count: 2 });
  });

  it("retries unexpected exceptions after 60 seconds without the details of the key", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    gscAnswers(2, "gsc_pages");
    const first = await queueDay("gsc_pages");
    const failing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") return async () => Promise.reject(new Error("D1 is down"));
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const message = await deliver(first, { db: failing });
    expect(message.retried).toEqual({ delaySeconds: 60 });
    expect(error).toHaveBeenCalledWith("sync failed unexpectedly", expect.objectContaining({ message: "D1 is down" }));
    expect((await day("gsc_pages"))?.status).toBe("running");
  });

  it("retries when the follow-up message cannot be sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    gscAnswers(3000, "gsc_pages");
    queue.fail = true;
    const message = await deliver(await queueDay("gsc_pages"));
    expect(message.retried).toEqual({ delaySeconds: 60 });
  });
});

describe("dead letter queue", () => {
  it("records the day as failed only for the current import", async () => {
    const old = await queueDay("gsc_pages");
    const message = await deliver(old, { queueName: SYNC_DEAD_LETTER_QUEUE });
    expect(message.acked).toBe(true);
    expect(await day("gsc_pages")).toMatchObject({
      status: "failed",
      error_code: "retry_exhausted",
      error_message: "再試行の上限に達しました",
    });

    const replaced = await queueDay("gsc_pages");
    now += 25 * HOUR;
    const current = await queueDay("gsc_pages");
    expect(current.runId).not.toBe(replaced.runId);
    expect((await deliver(replaced, { queueName: SYNC_DEAD_LETTER_QUEUE })).acked).toBe(true);
    expect((await day("gsc_pages"))?.status).toBe("queued");
  });

  it("does not change a succeeded day", async () => {
    gscAnswers(1, "gsc_pages");
    const first = await queueDay("gsc_pages");
    await deliver(first);
    await deliver(first, { queueName: SYNC_DEAD_LETTER_QUEUE });
    expect((await day("gsc_pages"))?.status).toBe("succeeded");
  });

  it("acks purges and malformed messages, and retries D1 failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await deliver({ kind: "purge", purgeId: newUlid(now) }, { queueName: SYNC_DEAD_LETTER_QUEUE })).acked).toBe(true);
    expect((await deliver({ kind: "x" }, { queueName: SYNC_DEAD_LETTER_QUEUE })).acked).toBe(true);
    const first = await queueDay("gsc_pages");
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
    const message = await deliver(first, { queueName: SYNC_DEAD_LETTER_QUEUE, db: failing });
    expect(message.retried).toEqual({ delaySeconds: 60 });
  });
});

describe("purge", () => {
  async function insertRows(table: "gsc_page_daily", property: string, dates: string[], perDay: number) {
    const rows: unknown[][] = [];
    for (const date of dates) for (let i = 0; i < perDay; i++) rows.push([date, `https://example.com/${i}`]);
    await env.DB.prepare(
      `INSERT INTO ${table} (site_id, property, date, page, clicks, impressions, position, run_id)
      SELECT ?1, ?2, j.value ->> 0, j.value ->> 1, 1, 1, 1, 'r' FROM json_each(?3) AS j WHERE true`,
    )
      .bind(site.id, property, JSON.stringify(rows))
      .run();
  }

  async function addPurge(dataset: Dataset, property: string | null): Promise<string> {
    const id = newUlid(now);
    await env.DB.prepare(
      "INSERT INTO pending_purges (id, site_id, dataset, property, created_at, attempted_at) VALUES (?, ?, ?, ?, ?, NULL)",
    )
      .bind(id, site.id, dataset, property, now)
      .run();
    return id;
  }

  it("deletes 5,000 rows per message and sends the message again while rows remain", async () => {
    const old = "sc-domain:old.example.com";
    await insertRows("gsc_page_daily", old, ["2026-10-01", "2026-10-02", "2026-10-03"], 2000);
    await insertRows("gsc_page_daily", GSC, ["2026-10-01"], 10);
    const purgeId = await addPurge("gsc_pages", old);

    const first = await deliver({ kind: "purge", purgeId });
    expect(first.acked).toBe(true);
    expect(await countTable("gsc_page_daily")).toBe(1010);
    expect(queue.messages).toEqual([{ kind: "purge", purgeId }]);
    expect(await env.DB.prepare("SELECT attempted_at FROM pending_purges").first()).toEqual({ attempted_at: now });

    const second = await deliver({ kind: "purge", purgeId });
    expect(second.acked).toBe(true);
    expect(await countTable("gsc_page_daily")).toBe(10);
    expect(await countTable("pending_purges")).toBe(0);
    expect(queue.messages).toHaveLength(1);
  });

  it("keeps the days imported again for the same property", async () => {
    const old = "sc-domain:old.example.com";
    await insertRows("gsc_page_daily", old, ["2026-10-01", "2026-10-02"], 3);
    // The property was changed back to old, and 2026-10-02 was imported again.
    await env.DB.prepare(
      `INSERT INTO sync_days (site_id, dataset, date, property, status, run_id, queued_at, last_succeeded_at)
      VALUES (?, 'gsc_pages', '2026-10-02', ?, 'succeeded', 'r', 1, 1)`,
    )
      .bind(site.id, old)
      .run();
    const purgeId = await addPurge("gsc_pages", old);
    expect((await deliver({ kind: "purge", purgeId })).acked).toBe(true);
    const { results } = await env.DB.prepare("SELECT DISTINCT date FROM gsc_page_daily").all();
    expect(results).toEqual([{ date: "2026-10-02" }]);
    expect(await countTable("pending_purges")).toBe(0);
  });

  it("deletes every row of the dataset without a property", async () => {
    await insertRows("gsc_page_daily", "sc-domain:a.example.com", ["2026-10-01"], 2);
    await insertRows("gsc_page_daily", "sc-domain:b.example.com", ["2026-10-01"], 2);
    const other = await createSite();
    await env.DB.prepare(
      "INSERT INTO gsc_page_daily VALUES (?, 'sc-domain:a.example.com', '2026-10-01', 'https://x/', 1, 1, 1, 'r')",
    )
      .bind(other.id)
      .run();
    const purgeId = await addPurge("gsc_pages", null);
    await deliver({ kind: "purge", purgeId });
    expect(await countTable("gsc_page_daily")).toBe(1);
  });

  it("acks a purge that is gone, and retries failures after 300 seconds", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await deliver({ kind: "purge", purgeId: newUlid(now) })).acked).toBe(true);
    const purgeId = await addPurge("gsc_pages", null);
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
    const message = await deliver({ kind: "purge", purgeId }, { db: failing });
    expect(message.retried).toEqual({ delaySeconds: 300 });
    expect(error).toHaveBeenCalledWith("purge failed", expect.objectContaining({ purgeId }));
  });
});
