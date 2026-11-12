import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, login, resetDb, send, type SessionCookies } from "./helpers";
import { fetchLandingPage, fetchPageViews } from "../src/google/analytics";
import { SERVICE_ACCOUNT_EMAIL, sharedServiceAccount } from "./google";

let cookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  const user = await createUser({ email: "member@example.com" });
  cookies = await login(user.email);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

describe("GET /api/v1/google", () => {
  it("returns 401 without a session", async () => {
    const res = await send("/api/v1/google");
    expect(res.status).toBe(401);
  });

  it("shows the email of a configured service account, never the key", async () => {
    const { key } = await sharedServiceAccount();
    const res = await send("/api/v1/google", { cookies, env: { GOOGLE_SERVICE_ACCOUNT_KEY: key } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ configured: true, client_email: SERVICE_ACCOUNT_EMAIL, error: null });
    expect(text).not.toContain("PRIVATE KEY");
  });

  it("is not configured without a key", async () => {
    const res = await send("/api/v1/google", { cookies, env: { GOOGLE_SERVICE_ACCOUNT_KEY: "" } });
    expect(await res.json()).toEqual({ configured: false, client_email: null, error: null });
  });

  it("reports an invalid key without its content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await send("/api/v1/google", { cookies, env: { GOOGLE_SERVICE_ACCOUNT_KEY: '{"private_key": "SECRET' } });
    expect(await res.json()).toEqual({ configured: false, client_email: null, error: "invalid" });
    expect(warn).toHaveBeenCalledWith("google service account key is invalid", { reason: "json" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET");
  });
});

describe("fetchPageViews", () => {
  const DATE = "2026-10-20";

  function answering(body: unknown, status = 200): { fetcher: typeof fetch; bodies: unknown[] } {
    const bodies: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      bodies.push(JSON.parse(await new Request(input, init).text()) as unknown);
      return typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status });
    };
    return { fetcher, bodies };
  }

  function fetchWith(body: unknown, offset = 0) {
    const fake = answering(body);
    return { result: fetchPageViews({ accessToken: "t", property: "123", date: DATE, offset, fetcher: fake.fetcher }), fake };
  }

  const row = (host: string, path: string, views: string, seconds: string, date = "20261020") => ({
    dimensionValues: [{ value: date }, { value: host }, { value: path }],
    metricValues: [{ value: views }, { value: seconds }],
  });

  it("asks for the views and the engagement time by host name and page path, without users", async () => {
    const { result, fake } = fetchWith({ rows: [] }, 4000);
    await result;
    expect(fake.bodies).toEqual([
      {
        dateRanges: [{ startDate: DATE, endDate: DATE }],
        dimensions: [{ name: "date" }, { name: "hostName" }, { name: "pagePath" }],
        metrics: [{ name: "screenPageViews" }, { name: "userEngagementDuration" }],
        orderBys: [{ dimension: { dimensionName: "hostName" } }, { dimension: { dimensionName: "pagePath" } }],
        limit: 2000,
        offset: 4000,
        keepEmptyRows: false,
      },
    ]);
    expect(JSON.stringify(fake.bodies)).not.toContain("activeUsers");
  });

  it("returns the rows as GA4 returned them, with the time zone", async () => {
    const { result } = fetchWith({
      rows: [row("example.com", "/a%2Fb", "12", "30.25"), row("(not set)", "(not set)", "1", "0")],
      metadata: { timeZone: "Asia/Tokyo" },
    });
    expect(await result).toEqual({
      ok: true,
      rows: [
        ["example.com", "/a%2Fb", 12, 30.25],
        ["(not set)", "(not set)", 1, 0],
      ],
      timeZone: "Asia/Tokyo",
      thresholded: false,
    });
  });

  it("reads subjectToThresholding and dataLossFromOtherRow", async () => {
    for (const [metadata, thresholded] of [
      [{ subjectToThresholding: true }, true],
      [{ dataLossFromOtherRow: true }, true],
      [{ subjectToThresholding: false, dataLossFromOtherRow: false }, false],
      [{ subjectToThresholding: "true" }, false],
      [undefined, false],
    ] as const) {
      const { result } = fetchWith({ rows: [], ...(metadata === undefined ? {} : { metadata }) });
      expect(await result, JSON.stringify(metadata)).toMatchObject({ ok: true, thresholded, timeZone: null });
    }
  });

  it("rejects rows of another date, of another shape or with values that are not numbers", async () => {
    const invalid = { ok: false, retryable: false, code: "invalid_response", message: null };
    for (const body of [
      { rows: [row("example.com", "/", "1", "1", "20261021")] },
      { rows: [{ dimensionValues: [{ value: "20261020" }, { value: "/" }], metricValues: [{ value: "1" }, { value: "1" }] }] },
      { rows: [{ ...row("example.com", "/", "1", "1"), metricValues: [{ value: "1" }] }] },
      { rows: [row("example.com", "/", "x", "1")] },
      { rows: [row("example.com", "/", "1", "")] },
      { rows: {} },
      [],
    ]) {
      const { result } = fetchWith(body);
      expect(await result, JSON.stringify(body)).toEqual(invalid);
    }
  });

  it("returns thresholded from fetchLandingPage as well, without changing its rows", async () => {
    const fake = answering({
      rows: [
        {
          dimensionValues: [{ value: "20261020" }, { value: "/a" }, { value: "Direct" }],
          metricValues: [{ value: "5" }, { value: "2" }, { value: "1.5" }],
        },
      ],
      metadata: { timeZone: "Asia/Tokyo", subjectToThresholding: true },
    });
    expect(await fetchLandingPage({ accessToken: "t", property: "123", date: DATE, offset: 0, fetcher: fake.fetcher })).toEqual({
      ok: true,
      rows: [["/a", "Direct", 5, 2, 1.5]],
      timeZone: "Asia/Tokyo",
      thresholded: true,
    });
  });
});
