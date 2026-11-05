import { describe, expect, it } from "vitest";
import {
  checkArticleBody,
  checkPeriod,
  checkQueryNumber,
  checkRecordBody,
  checkRecordFilters,
  normalizeArticleIds,
  normalizeArticleUrl,
  normalizeContent,
  normalizeDate,
  normalizeNote,
  normalizeTags,
} from "../src/records/validate";

const ARTICLE_ID = "art_01JC9Z8Q4R6T2V7W3X5Y1A0B2C";

function codeOf(result: { ok: boolean; code?: string }): string | undefined {
  return result.ok ? undefined : result.code;
}

describe("normalizeArticleUrl", () => {
  it("removes the fragment and keeps the query", () => {
    expect(normalizeArticleUrl("  https://Example.com/a/b?x=1&y=2#top ")).toEqual({
      ok: true,
      value: "https://example.com/a/b?x=1&y=2",
    });
    expect(normalizeArticleUrl("http://example.com")).toEqual({ ok: true, value: "http://example.com/" });
  });

  it("reads null and blank as no URL", () => {
    expect(normalizeArticleUrl(null)).toEqual({ ok: true, value: null });
    expect(normalizeArticleUrl("   ")).toEqual({ ok: true, value: null });
  });

  it.each([
    ["ftp://example.com/a"],
    ["javascript:alert(1)"],
    ["not a url"],
    ["https://user:pass@example.com/"],
    ["https://user@example.com/"],
    [`https://example.com/${"a".repeat(2048)}`],
    [1],
    [["https://example.com/"]],
  ])("rejects %s", (value) => {
    expect(codeOf(normalizeArticleUrl(value))).toBe("invalid_url");
  });

  it("rejects a URL whose normalized form is too long", () => {
    // Spaces are percent-encoded, so the href grows past the limit.
    const value = `https://example.com/${"a b".repeat(600)}`;
    expect(value.length).toBeLessThanOrEqual(2048);
    expect(codeOf(normalizeArticleUrl(value))).toBe("invalid_url");
  });
});

describe("normalizeTags", () => {
  it("trims, normalizes to NFC and removes duplicates keeping the order", () => {
    const decomposed = "ガ"; // カ + combining dakuten
    expect(normalizeTags([" stage:draft ", "topic:ai", "stage:draft", decomposed, "ガ", "Topic:AI"])).toEqual({
      ok: true,
      value: ["stage:draft", "topic:ai", "ガ", "Topic:AI"],
    });
    expect(normalizeTags([])).toEqual({ ok: true, value: [] });
  });

  it.each([
    [["a,b"]],
    [["a、b"]],
    [["a，b"]],
    [["a\u0007"]],
    [["a\nb"]],
    [["   "]],
    [[""]],
    [["a".repeat(51)]],
    [[1]],
    ["a"],
    [null],
  ])("rejects %j", (value) => {
    expect(codeOf(normalizeTags(value))).toBe("invalid_tags");
  });

  it("allows 50 code points and 20 tags", () => {
    expect(normalizeTags(["😀".repeat(50)]).ok).toBe(true);
    const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(normalizeTags(twenty).ok).toBe(true);
    expect(codeOf(normalizeTags([...twenty, "t20"]))).toBe("invalid_tags");
    // Duplicates do not count.
    expect(normalizeTags([...twenty, "t0"]).ok).toBe(true);
  });
});

describe("text", () => {
  it("normalizes CRLF and CR to LF and keeps the whitespace", () => {
    expect(normalizeNote("  a\r\nb\rc\n\td  ")).toEqual({ ok: true, value: "  a\nb\nc\n\td  " });
    expect(normalizeContent("   ")).toEqual({ ok: true, value: "   " });
    expect(normalizeContent("")).toEqual({ ok: true, value: "" });
  });

  it("rejects control characters other than LF and tab", () => {
    expect(codeOf(normalizeNote("a\u0000b"))).toBe("invalid_note");
    expect(codeOf(normalizeContent("a\u001Bb"))).toBe("invalid_content");
    expect(codeOf(normalizeContent("a\u0085b"))).toBe("invalid_content");
    expect(codeOf(normalizeContent(1))).toBe("invalid_content");
  });

  it("counts the length in code points", () => {
    expect(normalizeContent("😀".repeat(10000)).ok).toBe(true);
    expect(codeOf(normalizeContent("😀".repeat(10001)))).toBe("invalid_content");
    // A CRLF counts as one character after the normalization.
    expect(normalizeNote("\r\n".repeat(10000)).ok).toBe(true);
  });
});

describe("dates", () => {
  it("accepts existing dates and clears with null or an empty string", () => {
    expect(normalizeDate("2026-02-28")).toEqual({ ok: true, value: "2026-02-28" });
    expect(normalizeDate(null)).toEqual({ ok: true, value: null });
    expect(normalizeDate("")).toEqual({ ok: true, value: null });
    expect(codeOf(normalizeDate("2026-02-30"))).toBe("invalid_date");
    expect(codeOf(normalizeDate("2026/02/01"))).toBe("invalid_date");
    expect(codeOf(normalizeDate(20260201))).toBe("invalid_date");
  });
});

describe("period", () => {
  it("needs both ends or neither, with start <= end", () => {
    expect(checkPeriod(null, null).ok).toBe(true);
    expect(checkPeriod("2026-01-01", "2026-01-01").ok).toBe(true);
    expect(codeOf(checkPeriod("2026-01-01", null))).toBe("invalid_period");
    expect(codeOf(checkPeriod(null, "2026-01-01"))).toBe("invalid_period");
    expect(codeOf(checkPeriod("2026-01-02", "2026-01-01"))).toBe("invalid_period");
  });

  it("checks the period of a new record", () => {
    const base = { kind: "review", title: "t" };
    expect(checkRecordBody({ ...base, period_start: "2026-01-01", period_end: "2026-01-31" }, true).ok).toBe(true);
    expect(codeOf(checkRecordBody({ ...base, period_start: "2026-01-01" }, true))).toBe("invalid_period");
    expect(codeOf(checkRecordBody({ ...base, period_start: "x", period_end: "2026-01-31" }, true))).toBe(
      "invalid_period",
    );
  });

  it("leaves a single end of a PATCH to the check against the stored record", () => {
    const patch = checkRecordBody({ period_end: "2026-02-01" }, false);
    expect(patch).toEqual({ ok: true, value: { periodEnd: "2026-02-01" } });
    // With the stored start, the result is valid or not.
    expect(checkPeriod("2026-01-01", "2026-02-01").ok).toBe(true);
    expect(codeOf(checkPeriod("2026-03-01", "2026-02-01"))).toBe("invalid_period");
  });
});

describe("normalizeArticleIds", () => {
  it("removes duplicates and allows 5", () => {
    expect(normalizeArticleIds([ARTICLE_ID, ARTICLE_ID])).toEqual({ ok: true, value: [ARTICLE_ID] });
    const ids = Array.from({ length: 6 }, (_, i) => `art_01JC9Z8Q4R6T2V7W3X5Y1A0B2${i}`);
    expect(normalizeArticleIds(ids.slice(0, 5)).ok).toBe(true);
    expect(codeOf(normalizeArticleIds(ids))).toBe("invalid_articles");
    expect(codeOf(normalizeArticleIds(["rec_01JC9Z8Q4R6T2V7W3X5Y1A0B2C"]))).toBe("invalid_articles");
    expect(codeOf(normalizeArticleIds(ARTICLE_ID))).toBe("invalid_articles");
  });
});

describe("bodies", () => {
  it("fills the defaults of a new article", () => {
    expect(checkArticleBody({ title: " A " }, true)).toEqual({
      ok: true,
      value: { title: "A", url: null, publishedOn: null, tags: [], note: "" },
    });
  });

  it("fills the defaults of a new record", () => {
    expect(checkRecordBody({ kind: "action", title: "A" }, true)).toEqual({
      ok: true,
      value: {
        kind: "action",
        status: "done",
        title: "A",
        date: null,
        periodStart: null,
        periodEnd: null,
        tags: [],
        content: "",
        articleIds: [],
      },
    });
  });

  it("rejects unknown fields, an empty PATCH and values of another type", () => {
    expect(codeOf(checkArticleBody({ title: "A", site_id: "x" }, true))).toBe("unknown_field");
    expect(codeOf(checkRecordBody({ id: "x" }, false))).toBe("unknown_field");
    expect(codeOf(checkArticleBody({}, false))).toBe("invalid_request");
    expect(codeOf(checkArticleBody({ title: 1 }, true))).toBe("invalid_title");
    expect(codeOf(checkArticleBody({ title: "a".repeat(201) }, true))).toBe("invalid_title");
    expect(codeOf(checkRecordBody({ kind: "plan", title: "A" }, true))).toBe("invalid_kind");
    expect(codeOf(checkRecordBody({ kind: "note", title: "A", status: "doing" }, true))).toBe("invalid_status");
    expect(codeOf(checkRecordBody({ title: "A" }, true))).toBe("invalid_kind");
  });
});

describe("list filters", () => {
  it("checks the filters", () => {
    expect(checkRecordFilters({ kind: "review", tag: " a ", date_from: "2026-01-01", date_to: "2026-01-01" })).toEqual({
      ok: true,
      value: { kind: "review", tag: "a", dateFrom: "2026-01-01", dateTo: "2026-01-01" },
    });
    for (const input of [
      { kind: "x" },
      { status: "x" },
      { tag: "a,b" },
      { article_id: "x" },
      { date_from: "2026-13-01" },
      { date_from: "2026-01-02", date_to: "2026-01-01" },
    ]) {
      expect(codeOf(checkRecordFilters(input))).toBe("invalid_query");
    }
  });

  it("checks the numbers of the query string", () => {
    expect(checkQueryNumber("limit", undefined, 1, 100, 50)).toEqual({ ok: true, value: 50 });
    expect(checkQueryNumber("limit", "100", 1, 100, 50)).toEqual({ ok: true, value: 100 });
    for (const value of ["0", "101", "-1", "1.5", "1e2", " 1", ""]) {
      expect(codeOf(checkQueryNumber("limit", value, 1, 100, 50))).toBe("invalid_query");
    }
  });
});
