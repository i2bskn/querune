// The Search Analytics API of Search Console: one page of the rows of one day.

import { isFiniteNumber, PAGE_ROWS, postGoogle, type GoogleFailure } from "./api";

export type SearchConsoleDataset = "gsc_pages" | "gsc_queries";

// The values of a row, in the order of the columns of gsc_page_daily ([page, clicks, impressions, position]) or
// gsc_query_daily ([page, query, clicks, impressions, position]).
export type SearchConsoleRow = (string | number)[];

export type SearchConsolePage =
  | { ok: true; rows: SearchConsoleRow[]; firstIncompleteDate: string | null }
  | GoogleFailure;

const INVALID_RESPONSE: GoogleFailure = { ok: false, retryable: false, code: "invalid_response", message: null };

export function searchAnalyticsUrl(property: string): string {
  return `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
}

// The first date of the incomplete (fresh) data in the response metadata, or null.
function firstIncompleteDate(body: Record<string, unknown>): string | null {
  const metadata = body.metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const { firstIncompleteDate: camel, first_incomplete_date: snake } = metadata as Record<string, unknown>;
  const value = typeof camel === "string" ? camel : snake;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

// Up to PAGE_ROWS rows of date from offset, including fresh data (dataState "all"). The rows are grouped by date as
// well, which the API needs to return first_incomplete_date; the date is checked and left out of the rows. Never
// throws.
export async function fetchSearchAnalyticsPage(params: {
  accessToken: string;
  property: string;
  dataset: SearchConsoleDataset;
  date: string;
  offset: number;
  fetcher?: typeof fetch;
}): Promise<SearchConsolePage> {
  const dimensions = params.dataset === "gsc_pages" ? ["date", "page"] : ["date", "page", "query"];
  const res = await postGoogle(
    searchAnalyticsUrl(params.property),
    params.accessToken,
    {
      startDate: params.date,
      endDate: params.date,
      dimensions,
      type: "web",
      dataState: "all",
      rowLimit: PAGE_ROWS,
      startRow: params.offset,
    },
    params.fetcher,
  );
  if (!res.ok) return res;
  const body = res.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return INVALID_RESPONSE;
  const record = body as Record<string, unknown>;
  const rawRows = record.rows ?? [];
  if (!Array.isArray(rawRows)) return INVALID_RESPONSE;
  const rows: SearchConsoleRow[] = [];
  for (const raw of rawRows) {
    if (typeof raw !== "object" || raw === null) return INVALID_RESPONSE;
    const { keys, clicks, impressions, position } = raw as Record<string, unknown>;
    if (!Array.isArray(keys) || keys.length !== dimensions.length) return INVALID_RESPONSE;
    if (!keys.every((key) => typeof key === "string")) return INVALID_RESPONSE;
    // Only the requested day is asked for.
    if (keys[0] !== params.date) return INVALID_RESPONSE;
    if (!isFiniteNumber(clicks) || !isFiniteNumber(impressions) || !isFiniteNumber(position)) return INVALID_RESPONSE;
    rows.push([...(keys.slice(1) as string[]), clicks, impressions, position]);
  }
  return { ok: true, rows, firstIncompleteDate: firstIncompleteDate(record) };
}
