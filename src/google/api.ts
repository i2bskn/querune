// The requests to the Search Console and GA4 APIs, and how their failures are sorted.

import { clearGoogleTokenCache, GOOGLE_FETCH_TIMEOUT_MS } from "./credentials";

// The rows of one page: PAGE_ROWS at most per message (src/sync/consumer.ts).
export const PAGE_ROWS = 2000;

const ERROR_MESSAGE_MAX_LENGTH = 500;

// Failures that a later try will not fix. message is Google's message, or "HTTP <status>".
export type GoogleFailureCode = "invalid_request" | "permission_denied" | "property_not_found" | "invalid_response";

export type GoogleFailure =
  | { ok: false; retryable: false; code: GoogleFailureCode; message: string | null }
  // 401, 429, 5xx, a network error or the timeout. status is null without a response.
  | { ok: false; retryable: true; status: number | null };

export type GoogleResponse = { ok: true; body: unknown } | GoogleFailure;

export function truncateMessage(message: string): string {
  return [...message].slice(0, ERROR_MESSAGE_MAX_LENGTH).join("");
}

// error.message of Google's error body, cut to 500 characters, or null.
async function googleErrorMessage(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    const message = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : undefined;
    return typeof message === "string" && message !== "" ? truncateMessage(message) : null;
  } catch {
    return null;
  }
}

// Posts body as JSON with the access token. Never throws.
export async function postGoogle(
  url: string,
  accessToken: string,
  body: unknown,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<GoogleResponse> {
  let res: Response;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, retryable: true, status: null };
  }
  if (res.status === 200) {
    try {
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false, retryable: false, code: "invalid_response", message: null };
    }
  }
  const fallback = `HTTP ${res.status}`;
  switch (res.status) {
    case 400:
      return { ok: false, retryable: false, code: "invalid_request", message: (await googleErrorMessage(res)) ?? fallback };
    case 403:
      // null: the caller shows its own message.
      return { ok: false, retryable: false, code: "permission_denied", message: await googleErrorMessage(res) };
    case 404:
      return { ok: false, retryable: false, code: "property_not_found", message: (await googleErrorMessage(res)) ?? fallback };
    case 401:
      // The cached token may have been revoked or expired early.
      clearGoogleTokenCache();
      return { ok: false, retryable: true, status: 401 };
    default:
      if (res.status === 429 || res.status >= 500) return { ok: false, retryable: true, status: res.status };
      // Other statuses are not expected from these APIs; they are not retried.
      return { ok: false, retryable: false, code: "invalid_response", message: fallback };
  }
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
