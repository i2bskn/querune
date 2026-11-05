import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "users" }
  | { name: "sites" }
  | { name: "siteDetail"; id: string }
  | { name: "siteArticles"; id: string }
  | { name: "siteRecords"; id: string }
  | { name: "articleDetail"; id: string }
  | { name: "recordDetail"; id: string }
  | { name: "notFound" };

// hc() puts params into the URL without encoding them, so IDs are limited to characters that cannot
// change the path (no "/", "." or "%"). Server IDs (UUIDs and prefixed ULIDs) always match.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Whether an ID may be put into a link or an API URL. Not decoded first.
export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

// path is the pathname followed by the search part, if any. The search part is ignored.
export function matchRoute(path: string): Route {
  const index = path.indexOf("?");
  const pathname = index === -1 ? path : path.slice(0, index);
  if (pathname === "/") return { name: "home" };
  if (pathname === "/users") return { name: "users" };
  if (pathname === "/sites") return { name: "sites" };
  const site = /^\/sites\/([^/]+)$/.exec(pathname);
  if (site?.[1] !== undefined && isValidId(site[1])) return { name: "siteDetail", id: site[1] };
  const siteContent = /^\/sites\/([^/]+)\/(articles|records)$/.exec(pathname);
  if (siteContent?.[1] !== undefined && isValidId(siteContent[1])) {
    return { name: siteContent[2] === "articles" ? "siteArticles" : "siteRecords", id: siteContent[1] };
  }
  const item = /^\/(articles|records)\/([^/]+)$/.exec(pathname);
  if (item?.[2] !== undefined && isValidId(item[2])) {
    return { name: item[1] === "articles" ? "articleDetail" : "recordDetail", id: item[2] };
  }
  return { name: "notFound" };
}

// The query of a path (the part after "?"), empty without one.
export function searchParams(path: string): URLSearchParams {
  const index = path.indexOf("?");
  return new URLSearchParams(index === -1 ? "" : path.slice(index + 1));
}

// Notified by navigate(); popstate covers the back and forward buttons.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

// Includes the search part, so that a change of the query alone renders again.
function getPath(): string {
  return location.pathname + location.search;
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, getPath);
}

// Moves to a path inside the SPA. The scroll position is not restored on back; that is left to the browser. replace
// takes the place of the current entry of the history (a screen that only moves on), so that back does not return to
// it.
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path !== getPath()) {
    if (options.replace === true) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
    for (const listener of listeners) listener();
  }
  window.scrollTo(0, 0);
}

export type ClickEvent = {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

// Whether a click on a link is handled by the SPA. Other clicks (new tab, new window, download, a
// target attribute) are left to the browser.
export function shouldHandleClick(event: ClickEvent, target?: string): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    target === undefined
  );
}
