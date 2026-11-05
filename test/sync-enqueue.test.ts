import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteRow } from "../src/db/schema";
import { newUlid } from "../src/ids";
import { addDays } from "../src/sync/dates";
import {
  EnqueueError,
  enqueueSync,
  QUEUE_RETENTION_MS,
  runDailySync,
  STALE_RUNNING_MS,
  type Dataset,
  type SyncCandidate,
} from "../src/sync/enqueue";
import { countTable, createSite, d1Counting, d1RecordingLargeBinds, fakeQueue, resetDb, type FakeQueue } from "./helpers";
import { sharedServiceAccount } from "./google";

const GSC = "sc-domain:example.com";
const GA4 = "123456789";
// 2026-11-05 18:00 UTC.
const NOW = Date.UTC(2026, 10, 5, 18, 0, 0);
const TODAY = "2026-11-05";
const HOUR = 60 * 60 * 1000;

type DayRow = {
  date: string;
  dataset: string;
  status: string;
  property: string;
  run_id: string;
  queued_at: number;
  error_code: string | null;
  error_message: string | null;
  finished_at: number | null;
  last_succeeded_at: number | null;
  last_data_state: string | null;
  last_row_count: number | null;
};

let site: SiteRow;
let queue: FakeQueue;

beforeEach(async () => {
  await resetDb();
  site = await createSite({ gscProperty: GSC, ga4PropertyId: GA4 });
  queue = fakeQueue();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

async function insertDay(params: {
  dataset?: Dataset;
  date: string;
  status: string;
  property?: string;
  queuedAt?: number;
  heartbeatAt?: number | null;
  lastDataState?: "final" | "provisional" | null;
  siteId?: string;
}): Promise<void> {
  const succeeded = params.lastDataState !== undefined && params.lastDataState !== null;
  await env.DB.prepare(
    `INSERT INTO sync_days (site_id, dataset, date, property, status, run_id, queued_at, heartbeat_at,
      last_succeeded_at, last_data_state, last_row_count, last_truncated, last_time_zone)
    VALUES (?, ?, ?, ?, ?, 'old-run', ?, ?, ?, ?, ?, 0, 'America/Los_Angeles')`,
  )
    .bind(
      params.siteId ?? site.id,
      params.dataset ?? "gsc_pages",
      params.date,
      params.property ?? GSC,
      params.status,
      params.queuedAt ?? NOW - HOUR,
      params.heartbeatAt ?? null,
      succeeded ? NOW - 2 * HOUR : null,
      params.lastDataState ?? null,
      succeeded ? 42 : null,
    )
    .run();
}

async function dayOf(date: string, dataset: Dataset = "gsc_pages"): Promise<DayRow | null> {
  return env.DB.prepare("SELECT * FROM sync_days WHERE site_id = ? AND dataset = ? AND date = ?")
    .bind(site.id, dataset, date)
    .first<DayRow>();
}

function candidate(date: string, dataset: Dataset = "gsc_pages", property = GSC): SyncCandidate {
  return { siteId: site.id, dataset, date, property };
}

describe("enqueueSync", () => {
  it("records new days as queued and sends their first messages", async () => {
    const queued = await enqueueSync(env.DB, queue, [candidate("2026-10-01"), candidate("2026-10-01", "ga4_landing_pages", GA4)], {
      now: NOW,
      force: false,
    });
    expect(queued).toHaveLength(2);
    const day = await dayOf("2026-10-01");
    expect(day).toMatchObject({ status: "queued", property: GSC, queued_at: NOW, last_succeeded_at: null });
    expect(queue.messages).toEqual([
      { kind: "sync", siteId: site.id, dataset: "gsc_pages", date: "2026-10-01", property: GSC, runId: day?.run_id, offset: 0 },
      {
        kind: "sync",
        siteId: site.id,
        dataset: "ga4_landing_pages",
        date: "2026-10-01",
        property: GA4,
        runId: (await dayOf("2026-10-01", "ga4_landing_pages"))?.run_id,
        offset: 0,
      },
    ]);
  });

  it("asks for existing days again only when one of the conditions holds", async () => {
    const days: [string, Parameters<typeof insertDay>[0], boolean][] = [
      ["2026-10-01", { date: "2026-10-01", status: "succeeded", lastDataState: "final" }, false],
      ["2026-10-02", { date: "2026-10-02", status: "succeeded", lastDataState: "provisional" }, true],
      ["2026-10-03", { date: "2026-10-03", status: "failed" }, true],
      ["2026-10-04", { date: "2026-10-04", status: "queued", queuedAt: NOW - QUEUE_RETENTION_MS + 1 }, false],
      ["2026-10-05", { date: "2026-10-05", status: "queued", queuedAt: NOW - QUEUE_RETENTION_MS - 1 }, true],
      ["2026-10-06", { date: "2026-10-06", status: "running", heartbeatAt: NOW - STALE_RUNNING_MS + 1 }, false],
      ["2026-10-07", { date: "2026-10-07", status: "running", heartbeatAt: NOW - STALE_RUNNING_MS - 1 }, true],
      ["2026-10-08", { date: "2026-10-08", status: "succeeded", property: "sc-domain:old.example.com", lastDataState: "final" }, true],
      ["2026-10-09", { date: "2026-10-09", status: "queued", property: "sc-domain:old.example.com" }, true],
    ];
    for (const [, params] of days) await insertDay(params);
    const queued = await enqueueSync(
      env.DB,
      queue,
      [...days.map(([date]) => candidate(date)), candidate("2026-10-10")],
      { now: NOW, force: false },
    );
    const expected = [...days.filter(([, , again]) => again).map(([date]) => date), "2026-10-10"];
    expect(queued.map((row) => row.date).sort()).toEqual(expected);
    expect(queue.messages.map((m) => (m.kind === "sync" ? m.date : null)).sort()).toEqual(expected);
    for (const [date, , again] of days) {
      const day = await dayOf(date);
      expect(day?.run_id === "old-run", date).toBe(!again);
      if (again) expect(day).toMatchObject({ status: "queued", property: GSC, queued_at: NOW, error_code: null, finished_at: null });
    }
  });

  it("with force, asks for succeeded days again, keeping the last successful import", async () => {
    await insertDay({ date: "2026-10-01", status: "succeeded", lastDataState: "final" });
    await insertDay({ date: "2026-10-02", status: "queued" });
    const queued = await enqueueSync(env.DB, queue, [candidate("2026-10-01"), candidate("2026-10-02")], {
      now: NOW,
      force: true,
    });
    expect(queued.map((row) => row.date)).toEqual(["2026-10-01"]);
    expect(await dayOf("2026-10-01")).toMatchObject({
      status: "queued",
      last_succeeded_at: NOW - 2 * HOUR,
      last_data_state: "final",
      last_row_count: 42,
    });
  });

  it("sends at most 100 messages per sendBatch, and binds at most 100 values per statement", async () => {
    const sendBatch = vi.spyOn(queue, "sendBatch");
    const { d1, large } = d1RecordingLargeBinds();
    const candidates = Array.from({ length: 250 }, (_, i) => candidate(addDays("2026-01-01", i)));
    const queued = await enqueueSync(d1, queue, candidates, { now: NOW, force: false });
    expect(queued).toHaveLength(250);
    expect(sendBatch.mock.calls.map(([messages]) => [...messages].length)).toEqual([100, 100, 50]);
    expect(large).toEqual([]);
  });

  it("records the days that were not sent as enqueue_failed and throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    queue.failAfter = 1;
    const candidates = Array.from({ length: 250 }, (_, i) => candidate(addDays("2026-01-01", i)));
    const error = await enqueueSync(env.DB, queue, candidates, { now: NOW, force: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnqueueError);
    expect((error as EnqueueError).sent).toBe(100);
    const { results } = await env.DB.prepare(
      "SELECT status, error_code, error_message, finished_at, COUNT(*) AS n FROM sync_days GROUP BY status",
    ).all();
    expect(results).toEqual(
      expect.arrayContaining([
        { status: "queued", error_code: null, error_message: null, finished_at: null, n: 100 },
        { status: "failed", error_code: "enqueue_failed", error_message: "取り込みを依頼できませんでした", finished_at: NOW, n: 150 },
      ]),
    );
    expect(queue.messages).toHaveLength(100);
  });

  it("does nothing without candidates", async () => {
    expect(await enqueueSync(env.DB, queue, [], { now: NOW, force: true })).toEqual([]);
    expect(queue.messages).toEqual([]);
  });
});

describe("runDailySync", () => {
  let key: string;

  beforeEach(async () => {
    key = (await sharedServiceAccount()).key;
  });

  function run(db: D1Database = env.DB, options: { serviceAccountKey?: string } = { serviceAccountKey: key }) {
    return runDailySync({ db, queue, now: NOW, serviceAccountKey: options.serviceAccountKey });
  }

  function sentDays(dataset: Dataset = "gsc_pages"): string[] {
    return queue.messages
      .filter((m) => m.kind === "sync" && m.dataset === dataset && m.siteId === site.id)
      .map((m) => (m.kind === "sync" ? m.date : ""))
      .sort();
  }

  it("imports the last 7 days of every dataset", async () => {
    const gscOnly = await createSite({ gscProperty: "sc-domain:b.example.com" });
    await createSite();
    await run();
    const recent = Array.from({ length: 7 }, (_, i) => addDays(TODAY, -7 + i));
    expect(sentDays("gsc_pages")).toEqual(recent);
    expect(sentDays("gsc_queries")).toEqual(recent);
    expect(sentDays("ga4_landing_pages")).toEqual(recent);
    expect(queue.messages.filter((m) => m.kind === "sync" && m.siteId === gscOnly.id)).toHaveLength(14);
    expect(queue.messages).toHaveLength(35);
  });

  it("imports again the provisional, failed, stopped and expired days of the 30 days before", async () => {
    await insertDay({ date: addDays(TODAY, -8), status: "succeeded", lastDataState: "provisional" });
    await insertDay({ date: addDays(TODAY, -9), status: "succeeded", lastDataState: "final" });
    await insertDay({ date: addDays(TODAY, -10), status: "failed" });
    await insertDay({ date: addDays(TODAY, -11), status: "running", heartbeatAt: NOW - STALE_RUNNING_MS - 1 });
    await insertDay({ date: addDays(TODAY, -12), status: "running", heartbeatAt: NOW - HOUR });
    await insertDay({ date: addDays(TODAY, -13), status: "queued", queuedAt: NOW - QUEUE_RETENTION_MS - 1 });
    await insertDay({ date: addDays(TODAY, -14), status: "queued", queuedAt: NOW - HOUR });
    await insertDay({ date: addDays(TODAY, -30), status: "failed" });
    await insertDay({ date: addDays(TODAY, -31), status: "failed" });
    // A day of another property is not imported again.
    await insertDay({ date: addDays(TODAY, -15), status: "failed", property: "sc-domain:old.example.com" });
    await run();
    const recent = Array.from({ length: 7 }, (_, i) => addDays(TODAY, -7 + i));
    expect(sentDays("gsc_pages")).toEqual(
      [addDays(TODAY, -30), addDays(TODAY, -13), addDays(TODAY, -11), addDays(TODAY, -10), addDays(TODAY, -8), ...recent].sort(),
    );
    expect(sentDays("gsc_queries")).toEqual(recent);
  });

  it("does not ask for imports without a valid key, but sends the purges again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fresh = newUlid(NOW);
    const stale = newUlid(NOW);
    const recent = newUlid(NOW);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO pending_purges (id, site_id, dataset, property, created_at, attempted_at) VALUES (?, ?, 'gsc_pages', NULL, ?, NULL)",
      ).bind(fresh, site.id, NOW - HOUR),
      env.DB.prepare(
        "INSERT INTO pending_purges (id, site_id, dataset, property, created_at, attempted_at) VALUES (?, ?, 'gsc_queries', NULL, ?, ?)",
      ).bind(stale, site.id, NOW - 10 * HOUR, NOW - 7 * HOUR),
      env.DB.prepare(
        "INSERT INTO pending_purges (id, site_id, dataset, property, created_at, attempted_at) VALUES (?, ?, 'ga4_landing_pages', NULL, ?, ?)",
      ).bind(recent, site.id, NOW - 10 * HOUR, NOW - HOUR),
    ]);
    for (const value of [undefined, "{"]) {
      queue.messages.length = 0;
      await env.DB.prepare("UPDATE pending_purges SET attempted_at = NULL WHERE id = ?").bind(fresh).run();
      await env.DB.prepare("UPDATE pending_purges SET attempted_at = ? WHERE id = ?").bind(NOW - 7 * HOUR, stale).run();
      await run(env.DB, { serviceAccountKey: value });
      expect(queue.messages.filter((m) => m.kind === "sync")).toEqual([]);
      expect(queue.messages.filter((m) => m.kind === "purge").map((m) => (m.kind === "purge" ? m.purgeId : "")).sort()).toEqual(
        [fresh, stale].sort(),
      );
    }
    expect(warn).toHaveBeenCalledWith("daily sync skipped: google service account key", {
      error: "invalid",
      reason: "json",
    });
    const { results } = await env.DB.prepare("SELECT id, attempted_at FROM pending_purges ORDER BY id").all();
    expect(results).toEqual(
      expect.arrayContaining([
        { id: fresh, attempted_at: NOW },
        { id: stale, attempted_at: NOW },
        { id: recent, attempted_at: NOW - HOUR },
      ]),
    );
  });

  it("logs a failed enqueue and still sends the purges", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const purgeId = newUlid(NOW);
    await env.DB.prepare(
      "INSERT INTO pending_purges (id, site_id, dataset, property, created_at, attempted_at) VALUES (?, ?, 'gsc_pages', NULL, ?, NULL)",
    )
      .bind(purgeId, site.id, NOW)
      .run();
    let calls = 0;
    const sendBatch = queue.sendBatch.bind(queue);
    queue.sendBatch = async (messages) => {
      calls++;
      // The first call (the imports) fails; the purges go through.
      if (calls === 1) throw new Error("queue is down");
      return sendBatch(messages);
    };
    await run();
    expect(error).toHaveBeenCalledWith("daily sync failed", expect.objectContaining({ name: "EnqueueError" }));
    expect(queue.messages).toEqual([{ kind: "purge", purgeId }]);
    expect(await countTable("sync_days")).toBe(21);
  });

  it("makes at most 6 D1 queries with 100 sites", async () => {
    for (let i = 0; i < 99; i++) await createSite({ gscProperty: `sc-domain:s${i}.example.com`, ga4PropertyId: `${1000 + i}` });
    await insertDay({ date: addDays(TODAY, -10), status: "failed" });
    const { d1, count } = d1Counting();
    await run(d1);
    // The sites, the days to import again, the imports (one batch) and the purges.
    expect(count()).toBe(4);
    expect(queue.messages.length).toBe(100 * 21 + 1);
  });
});
