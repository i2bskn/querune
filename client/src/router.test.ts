import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClickEvent, matchRoute, navigate, searchParams, shouldHandleClick } from "./router";

describe("matchRoute", () => {
  it("matches the screens", () => {
    expect(matchRoute("/")).toEqual({ name: "home" });
    expect(matchRoute("/sites")).toEqual({ name: "sites" });
  });

  it("matches the users screen exactly", () => {
    expect(matchRoute("/users")).toEqual({ name: "users" });
    expect(matchRoute("/users?a=1")).toEqual({ name: "users" });
    expect(matchRoute("/users/")).toEqual({ name: "notFound" });
    expect(matchRoute("/users/abc")).toEqual({ name: "notFound" });
  });

  it("matches the sites screens", () => {
    const id = "site_01JC9Z8Q4R6T2V7W3X5Y1A0B2C";
    expect(matchRoute("/sites?x=1")).toEqual({ name: "sites" });
    expect(matchRoute(`/sites/${id}`)).toEqual({ name: "siteDetail", id });
    expect(matchRoute(`/sites/${id}?x=1`)).toEqual({ name: "siteDetail", id });
  });

  it("matches the article and record screens", () => {
    const site = "site_01JC9Z8Q4R6T2V7W3X5Y1A0B2C";
    const article = "art_01JC9Z8Q4R6T2V7W3X5Y1A0B2C";
    const record = "rec_01JC9Z8Q4R6T2V7W3X5Y1A0B2C";
    expect(matchRoute(`/sites/${site}/articles`)).toEqual({ name: "siteArticles", id: site });
    expect(matchRoute(`/sites/${site}/articles?tag=a`)).toEqual({ name: "siteArticles", id: site });
    expect(matchRoute(`/sites/${site}/records?article=${article}`)).toEqual({ name: "siteRecords", id: site });
    expect(matchRoute(`/articles/${article}`)).toEqual({ name: "articleDetail", id: article });
    expect(matchRoute(`/records/${record}`)).toEqual({ name: "recordDetail", id: record });
    for (const path of [
      "/articles",
      "/articles/",
      "/records/a.b",
      `/articles/${article}/x`,
      `/sites/${site}/tags`,
      `/sites/${site}/articles/`,
      "/sites/a.b/records",
    ]) {
      expect(matchRoute(path)).toEqual({ name: "notFound" });
    }
  });

  it.each([
    "/sites/",
    "/sites/a/b",
    "/sites/a.b",
    "/sites/%2e%2e",
    "/sites/a%2Fb",
    `/sites/${"a".repeat(65)}`,
  ])("does not match the invalid path %s", (path) => {
    expect(matchRoute(path)).toEqual({ name: "notFound" });
  });

  it("ignores the search part on other screens", () => {
    expect(matchRoute("/?q=a")).toEqual({ name: "home" });
  });

  it.each(["/events", "/sources", "/bots", "/connections", "//sites", "/unknown"])("does not match %s", (path) => {
    expect(matchRoute(path)).toEqual({ name: "notFound" });
  });
});

describe("searchParams", () => {
  it("reads the query of a path", () => {
    expect(searchParams("/sites?a=b.c&d=e_1").get("a")).toBe("b.c");
    expect(searchParams("/sites?a=b.c&d=e_1").get("d")).toBe("e_1");
    expect(searchParams("/sites").toString()).toBe("");
    expect(searchParams("/sites?").toString()).toBe("");
  });
});

describe("navigate", () => {
  // navigate() reads location and calls history and window, which Node does not have.
  function stubBrowser(path: string) {
    const pushState = vi.fn();
    const scrollTo = vi.fn();
    vi.stubGlobal("location", { pathname: path, search: "" });
    vi.stubGlobal("history", { pushState });
    vi.stubGlobal("window", { scrollTo });
    return { pushState, scrollTo };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves to another path", () => {
    const { pushState } = stubBrowser("/a");
    navigate("/b");
    expect(pushState).toHaveBeenCalledWith(null, "", "/b");
  });

  it("replaces the current entry of the history with replace", () => {
    const pushState = vi.fn();
    const replaceState = vi.fn();
    vi.stubGlobal("location", { pathname: "/sites/site_1", search: "" });
    vi.stubGlobal("history", { pushState, replaceState });
    vi.stubGlobal("window", { scrollTo: vi.fn() });
    navigate("/sites", { replace: true });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/sites");
    expect(pushState).not.toHaveBeenCalled();
  });
});

describe("shouldHandleClick", () => {
  const click: ClickEvent = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };

  it("handles a plain left click", () => {
    expect(shouldHandleClick(click)).toBe(true);
  });

  it("leaves a click whose default is prevented", () => {
    expect(shouldHandleClick({ ...click, defaultPrevented: true })).toBe(false);
  });

  it("leaves a middle click", () => {
    expect(shouldHandleClick({ ...click, button: 1 })).toBe(false);
  });

  it.each(["metaKey", "ctrlKey", "shiftKey", "altKey"] as const)("leaves a click with %s", (key) => {
    expect(shouldHandleClick({ ...click, [key]: true })).toBe(false);
  });

  it("leaves a link with a target", () => {
    expect(shouldHandleClick(click, "_blank")).toBe(false);
  });
});
