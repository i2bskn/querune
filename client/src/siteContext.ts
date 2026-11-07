import { useSyncExternalStore } from "react";

// The site the screens are about, for the navigation: set by every screen of a site once it knows the site (the
// screens of an article or a memo learn it from the API). Remembered in the browser so that the sidebar opens on the
// same site next time. No JSX here, so that the tests can load it in Node.

const STORAGE_KEY = "querune:site";

const listeners = new Set<() => void>();
let current: string | null = readStored();
// Incremented when the sites change (added, renamed, deleted), so that the sidebar loads them again.
let version = 0;

function readStored(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setCurrentSite(id: string | null): void {
  if (current === id) return;
  current = id;
  try {
    if (id === null) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // Private windows may refuse storage; the choice then lasts until the page is closed.
  }
  emit();
}

export function currentSite(): string | null {
  return current;
}

export function useCurrentSite(): string | null {
  return useSyncExternalStore(subscribe, () => current);
}

export function sitesChanged(): void {
  version++;
  emit();
}

export function useSitesVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
