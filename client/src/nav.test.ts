import { describe, expect, it } from "vitest";
import { ariaCurrentFor, currentNavItem, navGroupsFor } from "./nav";
import type { Route } from "./router";

describe("navGroupsFor", () => {
  it("shows the sites to members, without the users", () => {
    const groups = navGroupsFor("member");
    expect(groups.map((group) => group.label)).toEqual(["サイト"]);
    expect(groups[0]?.items.map((item) => [item.id, item.label, item.to])).toEqual([
      ["overview", "概要", "/"],
      ["sites", "サイト", "/sites"],
    ]);
    expect(groups.flatMap((group) => group.items.map((item) => item.id))).not.toContain("users");
  });

  it("shows the users to admins under 管理", () => {
    const groups = navGroupsFor("admin");
    expect(groups.map((group) => group.label)).toEqual(["サイト", "管理"]);
    expect(groups.at(-1)?.items.map((item) => [item.id, item.label, item.to])).toEqual([["users", "ユーザー", "/users"]]);
  });
});

describe("currentNavItem", () => {
  it.each<[Route, ReturnType<typeof currentNavItem>]>([
    [{ name: "home" }, "overview"],
    [{ name: "sites" }, "sites"],
    [{ name: "siteDetail", id: "site_1" }, "sites"],
    [{ name: "siteArticles", id: "site_1" }, "sites"],
    [{ name: "siteRecords", id: "site_1" }, "sites"],
    [{ name: "articleDetail", id: "art_1" }, "sites"],
    [{ name: "recordDetail", id: "rec_1" }, "sites"],
    [{ name: "users" }, "users"],
    [{ name: "notFound" }, null],
  ])("maps %o", (route, expected) => {
    expect(currentNavItem(route)).toBe(expected);
  });
});

describe("ariaCurrentFor", () => {
  it("is page on the top screen of the item", () => {
    expect(ariaCurrentFor({ name: "home" }, "overview")).toBe("page");
    expect(ariaCurrentFor({ name: "sites" }, "sites")).toBe("page");
    expect(ariaCurrentFor({ name: "users" }, "users")).toBe("page");
  });

  it("is location on a screen inside the item", () => {
    expect(ariaCurrentFor({ name: "siteDetail", id: "site_1" }, "sites")).toBe("location");
    expect(ariaCurrentFor({ name: "articleDetail", id: "art_1" }, "sites")).toBe("location");
  });

  it("is undefined for other items and on the not found screen", () => {
    expect(ariaCurrentFor({ name: "home" }, "sites")).toBeUndefined();
    expect(ariaCurrentFor({ name: "siteDetail", id: "site_1" }, "overview")).toBeUndefined();
    for (const item of ["overview", "sites", "users"] as const) {
      expect(ariaCurrentFor({ name: "notFound" }, item)).toBeUndefined();
    }
  });
});
