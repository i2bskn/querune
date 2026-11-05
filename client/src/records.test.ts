import { describe, expect, it } from "vitest";
import { articleRequest, emptyRecordForm, periodText, recordRequest, splitTags } from "./records";

describe("splitTags", () => {
  it("splits on the separators, trims and drops empty parts", () => {
    expect(splitTags(" a, b、c，d ,, ")).toEqual(["a", "b", "c", "d"]);
    expect(splitTags("")).toEqual([]);
  });
});

describe("requests", () => {
  it("sends blank URL and dates as null", () => {
    expect(articleRequest({ title: "T", url: "  ", publishedOn: "", tags: "a, b", note: "n" })).toEqual({
      title: "T",
      url: null,
      published_on: null,
      tags: ["a", "b"],
      note: "n",
    });
    expect(recordRequest({ ...emptyRecordForm(["art_1"]), title: "R", periodStart: "2026-01-01", periodEnd: "2026-01-31" })).toEqual({
      kind: "action",
      status: "done",
      title: "R",
      date: null,
      period_start: "2026-01-01",
      period_end: "2026-01-31",
      tags: [],
      content: "",
      article_ids: ["art_1"],
    });
  });

  it("shows a period only with both ends", () => {
    expect(periodText("2026-01-01", "2026-01-31")).toBe("2026-01-01〜2026-01-31");
    expect(periodText(null, null)).toBeNull();
  });
});
