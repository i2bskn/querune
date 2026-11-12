import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "@i2bskn/workers-app-core";
import type { SiteRow } from "../src/db/schema";
import { PAGE_ROWS } from "../src/google/api";
import { clearGoogleTokenCache } from "../src/google/credentials";
import { newUlid } from "../src/ids";
import { addDays } from "../src/sync/dates";
import { handleSyncQueue, SYNC_DEAD_LETTER_QUEUE, SYNC_QUEUE } from "../src/sync/consumer";
import { enqueueSync, runDailySync, type Dataset, type SyncMessage } from "../src/sync/enqueue";
import { getSyncStatus } from "../src/sync/status";
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
async function queueDay(
  dataset: Dataset,
  date = FINAL_DATE,
  property = dataset === "ga4_landing_pages" ? GA4 : GSC,
  options: { acceptEmpty?: boolean } = {},
) {
  const sending = fakeQueue();
  await enqueueSync(env.DB, sending, [{ siteId: site.id, dataset, date, property }], { now, force: true, ...options });
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

// Answers the Search Analytics API with the given number of rows in total, PAGE_ROWS per page. metadata is returned
// with every page, or with the first page only (firstPageOnly).
function gscAnswers(
  total: number,
  dataset: "gsc_pages" | "gsc_queries",
  metadata?: Record<string, unknown>,
  options: { firstPageOnly?: boolean } = {},
) {
  google.api = (call) => {
    const body = call.body as { startRow: number; rowLimit: number; startDate: string };
    const count = Math.max(0, Math.min(body.rowLimit, total - body.startRow));
    const response: Record<string, unknown> = { responseAggregationType: "byPage" };
    if (count > 0) response.rows = gscRows(count, dataset, body.startDate, body.startRow);
    if (metadata && (!options.firstPageOnly || body.startRow === 0)) response.metadata = metadata;
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
      dimensions: ["date", "page"],
      type: "web",
      dataState: "all",
      rowLimit: PAGE_ROWS,
      startRow: 0,
    });
    const { results } = await env.DB.prepare(
      "SELECT page, clicks, impressions, position, typeof(clicks) AS t_clicks, typeof(impressions) AS t_impressions, typeof(position) AS t_position, run_id FROM gsc_page_daily ORDER BY page",
    ).all();
    expect(results).toEqual(
      gscRows(3, "gsc_pages", FINAL_DATE).map((row) => ({
        page: row.keys[1],
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

  it("asks for the date dimension", async () => {
    gscAnswers(1, "gsc_pages");
    await deliver(await queueDay("gsc_pages"));
    expect(google.calls[0]?.body).toMatchObject({ dimensions: ["date", "page"] });
    gscAnswers(1, "gsc_queries");
    await deliver(await queueDay("gsc_queries"));
    expect(google.calls[1]?.body).toMatchObject({ dimensions: ["date", "page", "query"] });
  });

  it("imports page and query rows, with several rows per statement", async () => {
    gscAnswers(1500, "gsc_queries");
    const first = await queueDay("gsc_queries");
    expect((await deliver(first)).acked).toBe(true);
    expect(google.calls[0]?.body).toMatchObject({ dimensions: ["date", "page", "query"] });
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
          { keys: [FINAL_DATE, "https://example.com/p/0"], clicks: 100, impressions: 1000, position: 2.5 },
          { keys: [FINAL_DATE, "https://example.com/p/1"], clicks: 50, impressions: 500, position: 3.5 },
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

  it("records provisional data from the metadata, and from the recent days for a day without rows", async () => {
    gscAnswers(1, "gsc_pages", { first_incomplete_date: FINAL_DATE });
    await deliver(await queueDay("gsc_pages"));
    expect((await day("gsc_pages"))?.last_data_state).toBe("provisional");

    gscAnswers(1, "gsc_pages", { firstIncompleteDate: "2026-10-19" });
    await deliver(await queueDay("gsc_pages"));
    expect((await day("gsc_pages"))?.last_data_state).toBe("provisional");

    gscAnswers(1, "gsc_pages", { firstIncompleteDate: "2026-10-21" });
    await deliver(await queueDay("gsc_pages"));
    expect((await day("gsc_pages"))?.last_data_state).toBe("final");

    // Today in Pacific Time is 2026-11-04. With rows and without metadata, the API says the day is complete, even
    // yesterday.
    gscAnswers(1, "gsc_pages");
    await deliver(await queueDay("gsc_pages", "2026-11-03"));
    expect((await day("gsc_pages", "2026-11-03"))?.last_data_state).toBe("final");

    // Without rows, from 2026-11-01 the data is provisional.
    gscAnswers(0, "gsc_pages");
    await deliver(await queueDay("gsc_pages", "2026-11-01"));
    expect((await day("gsc_pages", "2026-11-01"))?.last_data_state).toBe("provisional");
    await deliver(await queueDay("gsc_pages", "2026-10-31"));
    expect((await day("gsc_pages", "2026-10-31"))?.last_data_state).toBe("final");
    gscAnswers(0, "gsc_pages", { first_incomplete_date: "2026-10-30" });
    await deliver(await queueDay("gsc_pages", "2026-10-30"));
    expect((await day("gsc_pages", "2026-10-30"))?.last_data_state).toBe("provisional");
  });

  it("rejects rows of another date or with missing keys", async () => {
    const rows = (keys: string[]) => () => Response.json({ rows: [{ keys, clicks: 1, impressions: 1, position: 1 }] });
    for (const keys of [["2026-10-21", "https://example.com/"], ["https://example.com/"], [FINAL_DATE, "https://example.com/", "x"]]) {
      google.api = rows(keys);
      expect((await deliver(await queueDay("gsc_pages"))).acked).toBe(true);
      expect(await day("gsc_pages")).toMatchObject({ status: "failed", error_code: "invalid_response" });
    }
    google.api = rows([FINAL_DATE, "https://example.com/"]);
    await deliver(await queueDay("gsc_queries"));
    expect(await day("gsc_queries")).toMatchObject({ status: "failed", error_code: "invalid_response" });
  });

  it("carries the incomplete mark of the first page to the last page", async () => {
    gscAnswers(3000, "gsc_pages", { first_incomplete_date: FINAL_DATE }, { firstPageOnly: true });
    const delivered = await deliverAll(await queueDay("gsc_pages"));
    expect(delivered.map((m) => [m.offset, m.incomplete])).toEqual([
      [0, undefined],
      [2000, true],
    ]);
    expect(await day("gsc_pages")).toMatchObject({ status: "succeeded", last_data_state: "provisional", last_row_count: 3000 });
  });

  it("decides by the API when the last page of a day with rows is empty", async () => {
    // Exactly 2,000 rows of yesterday: the follow-up page is empty, but the day has rows.
    gscAnswers(2000, "gsc_pages");
    const delivered = await deliverAll(await queueDay("gsc_pages", "2026-11-03"));
    expect(delivered.map((m) => m.offset)).toEqual([0, 2000]);
    expect(await day("gsc_pages", "2026-11-03")).toMatchObject({
      status: "succeeded",
      last_data_state: "final",
      last_row_count: 2000,
    });
  });

  it("accepts messages without incomplete and acceptEmpty, and rejects values that are not booleans", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    gscAnswers(1, "gsc_pages");
    const first = await queueDay("gsc_pages");
    expect(first).not.toHaveProperty("incomplete");
    expect(first).not.toHaveProperty("acceptEmpty");
    for (const body of [{ ...first, incomplete: "yes" }, { ...first, incomplete: 1 }, { ...first, acceptEmpty: "true" }]) {
      expect((await deliver(body)).acked).toBe(true);
    }
    expect(google.calls).toHaveLength(0);
    expect((await deliver({ ...first, incomplete: false, acceptEmpty: false })).acked).toBe(true);
    expect(await day("gsc_pages")).toMatchObject({ status: "succeeded", last_data_state: "final" });
  });
});

describe("empty responses", () => {
  it("keeps the rows of a day that had rows when Google returns none", async () => {
    gscAnswers(3, "gsc_pages");
    await deliver(await queueDay("gsc_pages"));
    const before = await day("gsc_pages");
    now += HOUR;
    gscAnswers(0, "gsc_pages");
    const message = await deliver(await queueDay("gsc_pages"));
    expect(message.acked).toBe(true);
    expect(await day("gsc_pages")).toMatchObject({
      status: "failed",
      error_code: "empty_response",
      error_message:
        "前回は行があった日に Google が 0 行を返したため、前回のデータを残しました。0 行が正しい場合は、この日を手動で取り込んでください",
      finished_at: now,
      last_succeeded_at: before?.last_succeeded_at,
      last_data_state: "final",
      last_row_count: 3,
    });
    expect(await countTable("gsc_page_daily")).toBe(3);
  });

  it("accepts no rows in a manual import (acceptEmpty)", async () => {
    gscAnswers(3, "gsc_pages");
    await deliver(await queueDay("gsc_pages"));
    now += HOUR;
    gscAnswers(0, "gsc_pages");
    const first = await queueDay("gsc_pages", FINAL_DATE, GSC, { acceptEmpty: true });
    expect(first.acceptEmpty).toBe(true);
    expect((await deliver(first)).acked).toBe(true);
    expect(await day("gsc_pages")).toMatchObject({ status: "succeeded", last_succeeded_at: now, last_row_count: 0 });
    expect(await countTable("gsc_page_daily")).toBe(0);
  });

  it("succeeds with no rows when the last import had none", async () => {
    gscAnswers(0, "gsc_pages");
    await deliver(await queueDay("gsc_pages"));
    now += HOUR;
    await deliver(await queueDay("gsc_pages"));
    expect(await day("gsc_pages")).toMatchObject({ status: "succeeded", last_succeeded_at: now, last_row_count: 0 });
  });

  it("does the same for GA4", async () => {
    ga4Answers(3, FINAL_DATE);
    await deliver(await queueDay("ga4_landing_pages"));
    now += HOUR;
    ga4Answers(0, FINAL_DATE);
    await deliver(await queueDay("ga4_landing_pages"));
    expect(await day("ga4_landing_pages")).toMatchObject({ status: "failed", error_code: "empty_response", last_row_count: 3 });
    expect(await countTable("ga4_landing_daily")).toBe(3);
    await deliver(await queueDay("ga4_landing_pages", FINAL_DATE, GA4, { acceptEmpty: true }));
    expect(await day("ga4_landing_pages")).toMatchObject({ status: "succeeded", last_row_count: 0 });
    expect(await countTable("ga4_landing_daily")).toBe(0);
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

  it("decides provisional days up to 4 days ago in the time zone of the property, or UTC", async () => {
    // 2026-11-05 03:00 UTC is 2026-11-05 in Tokyo and 2026-11-04 in Los Angeles and New York.
    const cases: [string, string | null, "final" | "provisional"][] = [
      ["2026-11-01", "Asia/Tokyo", "provisional"],
      ["2026-10-31", "Asia/Tokyo", "final"],
      // 2026-11-01 is the end of daylight saving time in the United States.
      ["2026-10-31", "America/Los_Angeles", "provisional"],
      ["2026-10-30", "America/Los_Angeles", "final"],
      ["2026-10-31", "America/New_York", "provisional"],
      ["2026-10-30", "America/New_York", "final"],
      ["2026-11-01", "Not/AZone", "provisional"],
      ["2026-10-31", "Not/AZone", "final"],
      ["2026-11-01", null, "provisional"],
      ["2026-10-31", null, "final"],
    ];
    for (const [date, timeZone, state] of cases) {
      ga4Answers(1, date, timeZone);
      await deliver(await queueDay("ga4_landing_pages", date));
      expect(await day("ga4_landing_pages", date), `${date} ${timeZone}`).toMatchObject({
        last_data_state: state,
        // Without a usable time zone, the day is judged in UTC but no time zone is recorded.
        last_time_zone: timeZone === null || timeZone === "Not/AZone" ? null : timeZone,
      });
    }
  });

  it("ignores incomplete in the messages", async () => {
    ga4Answers(2001, FINAL_DATE);
    const first = await queueDay("ga4_landing_pages");
    expect((await deliver({ ...first, incomplete: true })).acked).toBe(true);
    expect(queue.messages).toHaveLength(1);
    expect(queue.messages[0]).not.toHaveProperty("incomplete");
  });

  it("imports a final day again: updates the values and deletes the rows that are gone", async () => {
    ga4Answers(3, FINAL_DATE);
    await deliver(await queueDay("ga4_landing_pages"));
    expect((await day("ga4_landing_pages"))?.last_data_state).toBe("final");
    now += HOUR;
    google.api = () =>
      Response.json({
        rows: [
          { dimensionValues: [{ value: "20261020" }, { value: "/p/0" }, { value: "Organic Search" }], metricValues: [{ value: "50" }, { value: "40" }, { value: "3" }] },
          { dimensionValues: [{ value: "20261020" }, { value: "/p/2" }, { value: "Organic Search" }], metricValues: [{ value: "7" }, { value: "2" }, { value: "1.5" }] },
        ],
        metadata: { timeZone: "Asia/Tokyo" },
      });
    const second = await queueDay("ga4_landing_pages");
    await deliver(second);
    const { results } = await env.DB.prepare(
      "SELECT landing_page, channel_group, sessions, engaged_sessions, key_events, run_id FROM ga4_landing_daily ORDER BY landing_page",
    ).all();
    expect(results).toEqual([
      { landing_page: "/p/0", channel_group: "Organic Search", sessions: 50, engaged_sessions: 40, key_events: 3, run_id: second.runId },
      { landing_page: "/p/2", channel_group: "Organic Search", sessions: 7, engaged_sessions: 2, key_events: 1.5, run_id: second.runId },
    ]);
    expect(await day("ga4_landing_pages")).toMatchObject({ status: "succeeded", last_row_count: 2, last_succeeded_at: now });
  });
});

describe("schedules", () => {
  // Answers every Search Console request with rows and without metadata, and every GA4 request with rows in Tokyo.
  function answerAll(): void {
    google.api = (call) => {
      if (call.url.startsWith("https://analyticsdata.googleapis.com/")) {
        const body = call.body as { dateRanges: { startDate: string }[] };
        const date = body.dateRanges[0]?.startDate ?? "";
        return Response.json({ rows: ga4Rows(2, date), metadata: { timeZone: "Asia/Tokyo" } });
      }
      const body = call.body as { startDate: string; dimensions: string[] };
      return Response.json({ rows: gscRows(2, body.dimensions.length === 2 ? "gsc_pages" : "gsc_queries", body.startDate) });
    };
  }

  // Runs the cron at the time and delivers every import it asks for.
  async function runAt(at: number, mode: "full" | "fresh" = "full"): Promise<SyncBody[]> {
    now = at;
    const sending = fakeQueue();
    await runDailySync({ db: env.DB, queue: sending, now: at, serviceAccountKey: key, mode });
    const sent = sending.messages.filter((m): m is SyncBody => m.kind === "sync");
    for (const message of sent) await deliverAll(message);
    return sent;
  }

  async function insertGa4Day(date: string, state: "final" | "provisional"): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO sync_days (site_id, dataset, date, property, status, run_id, queued_at, last_succeeded_at,
        last_data_state, last_row_count, last_truncated, last_time_zone)
      VALUES (?, 'ga4_landing_pages', ?, ?, 'succeeded', 'r', 1, 1, ?, 2, 0, 'Asia/Tokyo')`,
    )
      .bind(site.id, date, GA4, state)
      .run();
  }

  async function ga4FinalThrough(at: number): Promise<string | null> {
    const status = await getSyncStatus(env.DB, { id: site.id, gscProperty: GSC, ga4PropertyId: GA4 }, at);
    return status.datasets.find((d) => d.dataset === "ga4_landing_pages")?.final_through ?? null;
  }

  it("makes the GA4 days of the last week final by Friday morning in Tokyo", async () => {
    answerAll();
    for (const date of ["2026-10-30", "2026-10-31", "2026-11-01"]) await insertGa4Day(date, "final");
    await insertGa4Day("2026-11-02", "provisional");
    // 2026-11-13 (Friday) 03:00 in Tokyo.
    await runAt(Date.UTC(2026, 10, 12, 18, 0, 0));
    for (let date = "2026-11-02"; date <= "2026-11-08"; date = addDays(date, 1)) {
      expect((await day("ga4_landing_pages", date))?.last_data_state, date).toBe("final");
    }
    for (let date = "2026-11-09"; date <= "2026-11-12"; date = addDays(date, 1)) {
      expect((await day("ga4_landing_pages", date))?.last_data_state, date).toBe("provisional");
    }
    // During Friday in Tokyo.
    expect(await ga4FinalThrough(Date.UTC(2026, 10, 13, 0, 0, 0))).toBe("2026-11-08");
    expect(await ga4FinalThrough(Date.UTC(2026, 10, 13, 14, 59, 0))).toBe("2026-11-08");
    // Search Console marks no day incomplete: the days with rows are final.
    expect((await day("gsc_pages", "2026-11-11"))?.last_data_state).toBe("final");
  });

  it("makes the last day of the month final in GA4 on the 5th in Tokyo", async () => {
    answerAll();
    await insertGa4Day("2026-10-01", "final");
    // 2026-12-01 03:00 in Tokyo, 2026-11-30 10:00 in Los Angeles.
    const first = await runAt(Date.UTC(2026, 10, 30, 18, 0, 0));
    expect(first.filter((m) => m.dataset === "gsc_pages").map((m) => m.date).sort().at(-1)).toBe("2026-11-29");
    expect(await day("gsc_pages", "2026-11-30")).toBeNull();
    const status = await getSyncStatus(env.DB, { id: site.id, gscProperty: GSC, ga4PropertyId: GA4 }, now);
    expect(status.datasets.find((d) => d.dataset === "gsc_pages")?.expected_latest_date).toBe("2026-11-29");
    expect((await day("ga4_landing_pages", "2026-11-30"))?.last_data_state).toBe("provisional");
    await runAt(Date.UTC(2026, 11, 1, 18, 0, 0));
    expect((await day("ga4_landing_pages", "2026-11-30"))?.last_data_state).toBe("provisional");
    // 2026-12-05 03:00 in Tokyo.
    await runAt(Date.UTC(2026, 11, 4, 18, 0, 0));
    expect((await day("ga4_landing_pages", "2026-11-30"))?.last_data_state).toBe("final");
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
