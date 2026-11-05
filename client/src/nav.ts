import type { User } from "../../src/api/types";
import type { Route } from "./router";

// The items of the main navigation. No JSX here, so that the tests can load it in Node; the icons are mapped in
// views/Sidebar.tsx.
export type NavItemId = "overview" | "sites" | "users";

export type NavItem = {
  id: NavItemId;
  label: string;
  to: string;
  // Shown only to admins; the server checks it again.
  adminOnly?: boolean;
};

export type NavGroup = {
  id: string;
  // null: the group is shown without a label.
  label: string | null;
  items: readonly NavItem[];
};

// In the order they are shown.
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "sites",
    label: "サイト",
    items: [
      { id: "overview", label: "概要", to: "/" },
      { id: "sites", label: "サイト", to: "/sites" },
    ],
  },
  {
    id: "admin",
    label: "管理",
    items: [{ id: "users", label: "ユーザー", to: "/users", adminOnly: true }],
  },
];

// The groups a user sees: admin-only items are left out for members, and so are groups left with no items.
export function navGroupsFor(role: User["role"]): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => role === "admin" || item.adminOnly !== true),
  })).filter((group) => group.items.length > 0);
}

// The item a screen belongs to.
export function currentNavItem(route: Route): NavItemId | null {
  switch (route.name) {
    case "home":
      return "overview";
    case "sites":
    case "siteDetail":
    case "siteArticles":
    case "siteRecords":
    case "articleDetail":
    case "recordDetail":
      return "sites";
    case "users":
      return "users";
    case "notFound":
      return null;
  }
}

// The top screen of each item.
const TOP_SCREEN: Record<NavItemId, Route["name"]> = {
  overview: "home",
  sites: "sites",
  users: "users",
};

// "page" on the top screen of an item, "location" on a screen inside it, and nothing elsewhere.
export function ariaCurrentFor(route: Route, item: NavItemId): "page" | "location" | undefined {
  if (currentNavItem(route) !== item) return undefined;
  return route.name === TOP_SCREEN[item] ? "page" : "location";
}
