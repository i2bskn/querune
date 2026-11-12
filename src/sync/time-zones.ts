// The time zone of the dates of each dataset, and the latest date that the imports are expected to have.

import { isGa4Dataset } from "../db/schema";
import type { Dataset } from "./enqueue";
import { isUsableTimeZone, yesterdayIn } from "./dates";

// The dates of Search Console are in Pacific Time.
export const SEARCH_CONSOLE_TIME_ZONE = "America/Los_Angeles";
// The time zone with the latest calendar day on earth (UTC-12). Yesterday there is never a future day in the time
// zone of any GA4 property, so it is used until the time zone of the property is known.
export const LATEST_TIME_ZONE = "Etc/GMT+12";

// The key of a GA4 property of a site in the map of ga4TimeZonesStatement.
export function ga4TimeZoneKey(siteId: string, property: string): string {
  return `${siteId}\n${property}`;
}

// The time zone recorded by the latest successful GA4 import (of either GA4 dataset) of each site and property (every
// site, or the one of siteId), and how to read it. The values are not checked: use them through datasetDayOf.
export function ga4TimeZonesStatement(
  db: D1Database,
  siteId: string | null,
): { statement: D1PreparedStatement; read: (rows: Record<string, unknown>[]) => Map<string, string> } {
  // With MAX, SQLite takes the bare columns from the row with the maximum.
  const sql = `SELECT site_id, property, last_time_zone, MAX(last_succeeded_at) AS at FROM sync_days
    WHERE dataset IN ('ga4_landing_pages', 'ga4_pages') AND last_succeeded_at IS NOT NULL AND last_time_zone IS NOT NULL
    ${siteId === null ? "" : "AND site_id = ?"}
    GROUP BY site_id, property`;
  const statement = siteId === null ? db.prepare(sql) : db.prepare(sql).bind(siteId);
  const read = (rows: Record<string, unknown>[]): Map<string, string> => {
    const zones = new Map<string, string>();
    for (const row of rows) {
      if (typeof row.site_id !== "string" || typeof row.property !== "string") continue;
      if (typeof row.last_time_zone !== "string") continue;
      zones.set(ga4TimeZoneKey(row.site_id, row.property), row.last_time_zone);
    }
    return zones;
  };
  return { statement, read };
}

export type DatasetDay = {
  // The time zone of the dates; null for GA4 while the time zone of the property is not known.
  timeZone: string | null;
  timeZoneKnown: boolean;
  // Yesterday in the time zone (in LATEST_TIME_ZONE while it is not known).
  expectedLatestDate: string;
};

// The time zone and the expected latest date of a dataset. ga4TimeZone is the time zone recorded for the current
// GA4 property (ga4TimeZonesStatement), ignored for Search Console.
export function datasetDayOf(dataset: Dataset, ga4TimeZone: string | null | undefined, now: number): DatasetDay {
  if (!isGa4Dataset(dataset)) {
    return {
      timeZone: SEARCH_CONSOLE_TIME_ZONE,
      timeZoneKnown: true,
      expectedLatestDate: yesterdayIn(SEARCH_CONSOLE_TIME_ZONE, now),
    };
  }
  if (isUsableTimeZone(ga4TimeZone)) {
    return { timeZone: ga4TimeZone, timeZoneKnown: true, expectedLatestDate: yesterdayIn(ga4TimeZone, now) };
  }
  return { timeZone: null, timeZoneKnown: false, expectedLatestDate: yesterdayIn(LATEST_TIME_ZONE, now) };
}
