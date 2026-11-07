import { describe, expect, it } from "vitest";
import {
  checkArticleBody,
  checkMemoBody,
  checkMemoFilters,
  checkQueryNumber,
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

describe("normalizeArticleIds", () => {
  it("removes duplicates and allows 5", () => {
    expect(normalizeArticleIds([ARTICLE_ID, ARTICLE_ID])).toEqual({ ok: true, value: [ARTICLE_ID] });
    const ids = Array.from({ length: 6 }, (_, i) => `art_01JC9Z8Q4R6T2V7W3X5Y1A0B2${i}`);
    expect(normalizeArticleIds(ids.slice(0, 5)).ok).toBe(true);
    expect(codeOf(normalizeArticleIds(ids))).toBe("invalid_articles");
    expect(codeOf(normalizeArticleIds(["memo_01JC9Z8Q4R6T2V7W3X5Y1A0B2C"]))).toBe("invalid_articles");
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

  it("fills the defaults of a new memo", () => {
    expect(checkMemoBody({ title: " A " }, true)).toEqual({
      ok: true,
      value: { title: "A", content: "", tags: [], articleIds: [] },
    });
  });

  it("returns only the given items of a memo PATCH", () => {
    expect(checkMemoBody({ content: "x" }, false)).toEqual({ ok: true, value: { content: "x" } });
  });

  it("rejects unknown fields, an empty PATCH and values of another type", () => {
    expect(codeOf(checkArticleBody({ title: "A", site_id: "x" }, true))).toBe("unknown_field");
    expect(codeOf(checkMemoBody({ id: "x" }, false))).toBe("unknown_field");
    expect(codeOf(checkMemoBody({}, false))).toBe("invalid_request");
    expect(codeOf(checkArticleBody({}, false))).toBe("invalid_request");
    expect(codeOf(checkArticleBody({ title: 1 }, true))).toBe("invalid_title");
    expect(codeOf(checkArticleBody({ title: "a".repeat(201) }, true))).toBe("invalid_title");
    expect(codeOf(checkMemoBody({}, true))).toBe("invalid_title");
    expect(codeOf(checkMemoBody({ title: "" }, true))).toBe("invalid_title");
    expect(codeOf(checkMemoBody({ title: "A", content: 1 }, true))).toBe("invalid_content");
  });

  it.each(["kind", "status", "date", "period_start", "period_end"])("rejects the old item %s of a memo", (key) => {
    expect(codeOf(checkMemoBody({ title: "A", [key]: null }, true))).toBe("unknown_field");
    expect(codeOf(checkMemoBody({ [key]: null }, false))).toBe("unknown_field");
  });
});

describe("list filters", () => {
  it("checks the filters", () => {
    expect(
      checkMemoFilters({
        tag: " a ",
        article_id: ARTICLE_ID,
        created_after: "2026-10-01T00:00:00+09:00",
        created_before: "2026-10-01T00:00:00Z",
      }),
    ).toEqual({
      ok: true,
      value: {
        tag: "a",
        articleId: ARTICLE_ID,
        createdAfter: Date.parse("2026-09-30T15:00:00Z"),
        createdBefore: Date.parse("2026-10-01T00:00:00Z"),
      },
    });
    for (const input of [
      { tag: "a,b" },
      { article_id: "x" },
      { created_after: "2026-10-01T00:00:00+09:00", created_before: "2026-10-01T00:00:00+09:00" },
      { created_after: "2026-10-02T00:00:00Z", created_before: "2026-10-01T00:00:00Z" },
    ]) {
      expect(codeOf(checkMemoFilters(input))).toBe("invalid_query");
    }
  });

  it.each([
    "2026-10-01T00:00Z",
    "2026-10-01T00:00:00Z",
    "2026-10-01T00:00:00.1Z",
    "2026-10-01T00:00:00.123+09:00",
    "2026-10-01T00:00:00-05:30",
  ])("accepts the date-time %s", (value) => {
    expect(checkMemoFilters({ created_after: value })).toEqual({ ok: true, value: { createdAfter: Date.parse(value) } });
  });

  it.each([
    "2026-10-01T00:00:00",
    "2026-10-01",
    "2026-10-01t00:00:00Z",
    "2026-10-01T00:00:00z",
    "2026-10-01 00:00:00Z",
    "2026-10-01T00:00:00.1234Z",
    "2026-10-01T00:00:00+0900",
    "",
  ])("rejects the date-time %j", (value) => {
    expect(codeOf(checkMemoFilters({ created_after: value }))).toBe("invalid_query");
    expect(codeOf(checkMemoFilters({ created_before: value }))).toBe("invalid_query");
  });

  it("checks the numbers of the query string", () => {
    expect(checkQueryNumber("limit", undefined, 1, 100, 50)).toEqual({ ok: true, value: 50 });
    expect(checkQueryNumber("limit", "100", 1, 100, 50)).toEqual({ ok: true, value: 100 });
    for (const value of ["0", "101", "-1", "1.5", "1e2", " 1", ""]) {
      expect(codeOf(checkQueryNumber("limit", value, 1, 100, 50))).toBe("invalid_query");
    }
  });
});
