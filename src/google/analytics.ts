// The GA4 Data API (runReport): one page of the sessions of one day by landing page and channel group.

import { PAGE_ROWS, postGoogle, type GoogleFailure } from "./api";

// [landingPage, sessionDefaultChannelGroup, sessions, engagedSessions, keyEvents], in the order of the columns of
// ga4_landing_daily.
export type AnalyticsRow = (string | number)[];

export type AnalyticsPage = { ok: true; rows: AnalyticsRow[]; timeZone: string | null } | GoogleFailure;

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

// Up to PAGE_ROWS rows of date from offset. Never throws.
export async function fetchLandingPage(params: {
  accessToken: string;
  property: string;
  date: string;
  offset: number;
  fetcher?: typeof fetch;
}): Promise<AnalyticsPage> {
  const res = await postGoogle(
    runReportUrl(params.property),
    params.accessToken,
    {
      dateRanges: [{ startDate: params.date, endDate: params.date }],
      dimensions: [{ name: "date" }, { name: "landingPage" }, { name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }],
      orderBys: [
        { dimension: { dimensionName: "landingPage" } },
        { dimension: { dimensionName: "sessionDefaultChannelGroup" } },
      ],
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
    const dimensions = values(dimensionValues, 3);
    const metrics = values(metricValues, 3);
    if (dimensions === null || metrics === null) return INVALID_RESPONSE;
    const [date, landingPage, channelGroup] = dimensions as [string, string, string];
    // Only the requested day is asked for; its date is YYYYMMDD.
    if (date !== compactDate) return INVALID_RESPONSE;
    const numbers = metrics.map(toNumber);
    if (numbers.some((n) => n === null)) return INVALID_RESPONSE;
    rows.push([landingPage, channelGroup, ...(numbers as number[])]);
  }
  const metadata = record.metadata;
  const timeZone =
    typeof metadata === "object" && metadata !== null ? (metadata as { timeZone?: unknown }).timeZone : undefined;
  return { ok: true, rows, timeZone: typeof timeZone === "string" ? timeZone : null };
}
