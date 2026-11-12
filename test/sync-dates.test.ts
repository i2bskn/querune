import { describe, expect, it } from "vitest";
import { yesterdayIn } from "../src/sync/dates";
import { datasetDayOf } from "../src/sync/time-zones";

const at = (iso: string) => Date.parse(iso);

describe("yesterdayIn", () => {
  it("changes at midnight in Tokyo", () => {
    expect(yesterdayIn("Asia/Tokyo", at("2026-11-11T14:59:59Z"))).toBe("2026-11-10");
    expect(yesterdayIn("Asia/Tokyo", at("2026-11-11T15:00:00Z"))).toBe("2026-11-11");
  });

  it("follows daylight saving time in Los Angeles", () => {
    // Daylight saving time starts on 2026-03-08: midnight is 08:00 UTC before it and 07:00 UTC after it.
    expect(yesterdayIn("America/Los_Angeles", at("2026-03-08T07:59:59Z"))).toBe("2026-03-06");
    expect(yesterdayIn("America/Los_Angeles", at("2026-03-08T08:00:00Z"))).toBe("2026-03-07");
    expect(yesterdayIn("America/Los_Angeles", at("2026-03-09T06:59:59Z"))).toBe("2026-03-07");
    expect(yesterdayIn("America/Los_Angeles", at("2026-03-09T07:00:00Z"))).toBe("2026-03-08");
    // It ends on 2026-11-01.
    expect(yesterdayIn("America/Los_Angeles", at("2026-11-01T06:59:59Z"))).toBe("2026-10-30");
    expect(yesterdayIn("America/Los_Angeles", at("2026-11-01T07:00:00Z"))).toBe("2026-10-31");
    expect(yesterdayIn("America/Los_Angeles", at("2026-11-02T07:59:59Z"))).toBe("2026-10-31");
    expect(yesterdayIn("America/Los_Angeles", at("2026-11-02T08:00:00Z"))).toBe("2026-11-01");
  });

  it("follows daylight saving time in New York", () => {
    expect(yesterdayIn("America/New_York", at("2026-03-09T03:59:59Z"))).toBe("2026-03-07");
    expect(yesterdayIn("America/New_York", at("2026-03-09T04:00:00Z"))).toBe("2026-03-08");
  });
});

describe("datasetDayOf", () => {
  const now = at("2026-11-11T18:00:00Z");

  it("uses Pacific Time for Search Console", () => {
    expect(datasetDayOf("gsc_pages", "Asia/Tokyo", now)).toEqual({
      timeZone: "America/Los_Angeles",
      timeZoneKnown: true,
      expectedLatestDate: "2026-11-10",
    });
  });

  it("uses the time zone of the GA4 property, or yesterday in Etc/GMT+12 without a usable one", () => {
    expect(datasetDayOf("ga4_landing_pages", "Asia/Tokyo", now)).toEqual({
      timeZone: "Asia/Tokyo",
      timeZoneKnown: true,
      expectedLatestDate: "2026-11-11",
    });
    for (const zone of [undefined, null, "", "Not/AZone"]) {
      expect(datasetDayOf("ga4_landing_pages", zone, now)).toEqual({
        timeZone: null,
        timeZoneKnown: false,
        expectedLatestDate: "2026-11-10",
      });
    }
  });
});
