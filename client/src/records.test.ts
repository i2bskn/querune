import { describe, expect, it } from "vitest";
import { articleRequest, emptyMemoForm, memoFormValues, memoRequest, splitTags } from "./records";

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
    expect(memoRequest({ ...emptyMemoForm(["art_1"]), title: "M", tags: "計測、 競合" })).toEqual({
      title: "M",
      content: "",
      tags: ["計測", "競合"],
      article_ids: ["art_1"],
    });
  });

  it("fills the form of a memo from the stored memo", () => {
    expect(
      memoFormValues({
        id: "memo_1",
        site_id: "site_1",
        title: "M",
        tags: ["a", "b"],
        content: "body",
        articles: [{ id: "art_1", title: "A", url: null }],
        created_at: 1,
        updated_at: 2,
      }),
    ).toEqual({ title: "M", content: "body", tags: "a, b", articleIds: ["art_1"] });
  });
});
