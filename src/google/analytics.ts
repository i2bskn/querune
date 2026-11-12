// The GA4 Data API (runReport): one page of one day, either the sessions by landing page and channel group or the
// views by host name and page path.

import { PAGE_ROWS, postGoogle, type GoogleFailure } from "./api";

// [landingPage, sessionDefaultChannelGroup, sessions, engagedSessions, keyEvents], in the order of the columns of
// ga4_landing_daily; or [hostName, pagePath, screenPageViews, userEngagementDuration], in the order of the columns of
// ga4_page_daily.
export type AnalyticsRow = (string | number)[];

// thresholded: the response says that rows may be missing because of thresholding (subjectToThresholding) or were
// aggregated into an "(other)" row (dataLossFromOtherRow).
export type AnalyticsPage = { ok: true; rows: AnalyticsRow[]; timeZone: string | null; thresholded: boolean } | GoogleFailure;

const INVALID_RESPONSE: GoogleFailure = { ok: false, retryable: false, code: "invalid_response", message: null };

export function runReportUrl(property: string): string {
  return `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`;
}

// The value strings of dimensionValues or metricValues, or null if the shape is wrong.
function values(value: unknown, length: number): string[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  const result: string[] = [];
  for (const item of value) {
    const text = typeof item === "object" && item !== null ? (item as { value?: unknown }).value : undefined;
    if (typeof text !== "string") return null;
    result.push(text);
  }
  return result;
}

function toNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

type PageParams = {
  accessToken: string;
  property: string;
  date: string;
  offset: number;
  fetcher?: typeof fetch;
};

// Up to PAGE_ROWS rows of date from offset, with the date dimension first, then the dimensions (the first of them
// sorted first) and the metrics. Each row is the dimensions after date, then the metrics. Never throws.
async function runReportPage(
  params: PageParams,
  dimensions: string[],
  metrics: string[],
): Promise<AnalyticsPage> {
  const res = await postGoogle(
    runReportUrl(params.property),
    params.accessToken,
    {
      dateRanges: [{ startDate: params.date, endDate: params.date }],
      dimensions: [{ name: "date" }, ...dimensions.map((name) => ({ name }))],
      metrics: metrics.map((name) => ({ name })),
      orderBys: dimensions.map((dimensionName) => ({ dimension: { dimensionName } })),
      limit: PAGE_ROWS,
      offset: params.offset,
      keepEmptyRows: false,
    },
    params.fetcher,
  );
  if (!res.ok) return res;
  const body = res.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return INVALID_RESPONSE;
  const record = body as Record<string, unknown>;
  const rawRows = record.rows ?? [];
  if (!Array.isArray(rawRows)) return INVALID_RESPONSE;
  const compactDate = params.date.replace(/-/g, "");
  const rows: AnalyticsRow[] = [];
  for (const raw of rawRows) {
    if (typeof raw !== "object" || raw === null) return INVALID_RESPONSE;
    const { dimensionValues, metricValues } = raw as Record<string, unknown>;
    const dimensionTexts = values(dimensionValues, dimensions.length + 1);
    const metricTexts = values(metricValues, metrics.length);
    if (dimensionTexts === null || metricTexts === null) return INVALID_RESPONSE;
    const [date, ...keys] = dimensionTexts;
    // Only the requested day is asked for; its date is YYYYMMDD.
    if (date !== compactDate) return INVALID_RESPONSE;
    const numbers = metricTexts.map(toNumber);
    if (numbers.some((n) => n === null)) return INVALID_RESPONSE;
    rows.push([...keys, ...(numbers as number[])]);
  }
  const metadata =
    typeof record.metadata === "object" && record.metadata !== null ? (record.metadata as Record<string, unknown>) : {};
  const timeZone = metadata.timeZone;
  return {
    ok: true,
    rows,
    timeZone: typeof timeZone === "string" ? timeZone : null,
    thresholded: metadata.subjectToThresholding === true || metadata.dataLossFromOtherRow === true,
  };
}

// The sessions of date by landing page and channel group. Never throws.
export function fetchLandingPage(params: PageParams): Promise<AnalyticsPage> {
  return runReportPage(
    params,
    ["landingPage", "sessionDefaultChannelGroup"],
    ["sessions", "engagedSessions", "keyEvents"],
  );
}

// The views and the engagement time of date by host name and page path. Users (activeUsers) are not asked for: a
// report with user metrics is more likely to be thresholded, which would drop the views of its rows as well. Never
// throws.
export function fetchPageViews(params: PageParams): Promise<AnalyticsPage> {
  return runReportPage(params, ["hostName", "pagePath"], ["screenPageViews", "userEngagementDuration"]);
}
