import { describe, expect, it } from "vitest";
import {
  SITE_NAV,
  ariaCurrentForGlobal,
  ariaCurrentForSite,
  currentSiteNavItem,
  globalNavFor,
  siteOfRoute,
} from "./nav";
import type { Route } from "./router";

describe("globalNavFor", () => {
  it("shows the sites to members, without the users", () => {
    expect(globalNavFor("member").map((item) => [item.id, item.to])).toEqual([["sites", "/"]]);
  });

  it("shows the users to admins", () => {
    expect(globalNavFor("admin").map((item) => [item.id, item.to])).toEqual([
      ["sites", "/"],
      ["users", "/users"],
    ]);
  });
});

describe("SITE_NAV", () => {
  it("links the screens of a site", () => {
    expect(SITE_NAV.map((item) => [item.id, item.path("site_1")])).toEqual([
      ["performance", "/sites/site_1"],
      ["memos", "/sites/site_1/memos"],
      ["articles", "/sites/site_1/articles"],
      ["data", "/sites/site_1/data"],
      ["settings", "/sites/site_1/settings"],
    ]);
  });
});

describe("siteOfRoute", () => {
  it.each<[Route, string | null]>([
    [{ name: "siteDetail", id: "site_1" }, "site_1"],
    [{ name: "siteArticles", id: "site_1" }, "site_1"],
    [{ name: "siteMemos", id: "site_1" }, "site_1"],
    [{ name: "siteData", id: "site_1" }, "site_1"],
    [{ name: "siteSettings", id: "site_1" }, "site_1"],
    [{ name: "articleDetail", id: "art_1" }, null],
    [{ name: "memoDetail", id: "memo_1" }, null],
    [{ name: "home" }, null],
    [{ name: "users" }, null],
  ])("maps %o", (route, expected) => {
    expect(siteOfRoute(route)).toBe(expected);
  });
});

describe("currentSiteNavItem", () => {
  it.each<[Route, string | null]>([
    [{ name: "siteDetail", id: "site_1" }, "performance"],
    [{ name: "siteArticles", id: "site_1" }, "articles"],
    [{ name: "articleDetail", id: "art_1" }, "articles"],
    [{ name: "siteMemos", id: "site_1" }, "memos"],
    [{ name: "memoDetail", id: "memo_1" }, "memos"],
    [{ name: "siteData", id: "site_1" }, "data"],
    [{ name: "siteSettings", id: "site_1" }, "settings"],
    [{ name: "home" }, null],
    [{ name: "sites" }, null],
    [{ name: "users" }, null],
    [{ name: "notFound" }, null],
  ])("maps %o", (route, expected) => {
    expect(currentSiteNavItem(route)).toBe(expected);
  });
});

describe("ariaCurrentForSite", () => {
  it("is page on the screen of the item", () => {
    expect(ariaCurrentForSite({ name: "siteMemos", id: "site_1" }, "memos")).toBe("page");
  });

  it("is location on a screen inside the item", () => {
    expect(ariaCurrentForSite({ name: "memoDetail", id: "memo_1" }, "memos")).toBe("location");
    expect(ariaCurrentForSite({ name: "articleDetail", id: "art_1" }, "articles")).toBe("location");
  });

  it("is undefined for other items", () => {
    expect(ariaCurrentForSite({ name: "siteMemos", id: "site_1" }, "articles")).toBeUndefined();
    expect(ariaCurrentForSite({ name: "notFound" }, "memos")).toBeUndefined();
  });
});

describe("ariaCurrentForGlobal", () => {
  it("marks the list of sites on / and /sites", () => {
    expect(ariaCurrentForGlobal({ name: "home" }, "sites")).toBe("page");
    expect(ariaCurrentForGlobal({ name: "sites" }, "sites")).toBe("page");
    expect(ariaCurrentForGlobal({ name: "siteDetail", id: "site_1" }, "sites")).toBeUndefined();
  });

  it("marks the users on /users", () => {
    expect(ariaCurrentForGlobal({ name: "users" }, "users")).toBe("page");
    expect(ariaCurrentForGlobal({ name: "home" }, "users")).toBeUndefined();
  });
});
