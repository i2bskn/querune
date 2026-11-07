import type { User } from "../../src/api/types";
import type { Route } from "./router";

// The navigation. No JSX here, so that the tests can load it in Node; the icons are mapped in views/Shell.tsx.

// The screens of one site, in the order they are shown.
export type SiteNavItemId = "performance" | "articles" | "memos" | "data" | "settings";

export type SiteNavItem = { id: SiteNavItemId; label: string; path: (siteId: string) => string };

export const SITE_NAV: readonly SiteNavItem[] = [
  { id: "performance", label: "実績", path: (id) => `/sites/${id}` },
  { id: "memos", label: "メモ", path: (id) => `/sites/${id}/memos` },
  { id: "articles", label: "記事", path: (id) => `/sites/${id}/articles` },
  { id: "data", label: "データの取り込み", path: (id) => `/sites/${id}/data` },
  { id: "settings", label: "サイトの設定", path: (id) => `/sites/${id}/settings` },
];

// The screens outside a site.
export type GlobalNavItemId = "sites" | "users";

export type GlobalNavItem = { id: GlobalNavItemId; label: string; to: string; adminOnly?: boolean };

export const GLOBAL_NAV: readonly GlobalNavItem[] = [
  { id: "sites", label: "すべてのサイト", to: "/" },
  // Shown only to admins; the server checks it again.
  { id: "users", label: "ユーザー", to: "/users", adminOnly: true },
];

export function globalNavFor(role: User["role"]): GlobalNavItem[] {
  return GLOBAL_NAV.filter((item) => role === "admin" || item.adminOnly !== true);
}

// The site that a route is about, when the path says so. The screens of an article or a memo learn their site from
// the API (siteContext.ts).
export function siteOfRoute(route: Route): string | null {
  switch (route.name) {
    case "siteDetail":
    case "siteArticles":
    case "siteMemos":
    case "siteData":
    case "siteSettings":
      return route.id;
    default:
      return null;
  }
}

// The item of the site navigation that a route belongs to.
export function currentSiteNavItem(route: Route): SiteNavItemId | null {
  switch (route.name) {
    case "siteDetail":
      return "performance";
    case "siteArticles":
    case "articleDetail":
      return "articles";
    case "siteMemos":
    case "memoDetail":
      return "memos";
    case "siteData":
      return "data";
    case "siteSettings":
      return "settings";
    default:
      return null;
  }
}

// "page" on the screen of an item itself, "location" on a screen inside it (an article, a memo).
export function ariaCurrentForSite(route: Route, item: SiteNavItemId): "page" | "location" | undefined {
  if (currentSiteNavItem(route) !== item) return undefined;
  return route.name === "articleDetail" || route.name === "memoDetail" ? "location" : "page";
}

export function ariaCurrentForGlobal(route: Route, item: GlobalNavItemId): "page" | undefined {
  if (item === "sites") return route.name === "home" || route.name === "sites" ? "page" : undefined;
  return route.name === "users" ? "page" : undefined;
}
