// The Google service account key (GOOGLE_SERVICE_ACCOUNT_KEY) and the access tokens obtained with it.
//
// The key, the JWTs and the access tokens are secrets: they never reach logs, error messages or API responses. The
// exceptions of JSON.parse, the PEM decoding, importKey and sign are never passed on either (the message of a
// JSON.parse exception contains part of its input); they are replaced with a reason.

import { base64Url } from "../ids";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_SCOPES =
  "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly";
const TOKEN_LIFETIME_SECONDS = 3600;
// A cached token is used until this long before it expires.
const TOKEN_REUSE_MARGIN_MS = 60 * 1000;
export const GOOGLE_FETCH_TIMEOUT_MS = 30 * 1000;

export type InvalidKeyReason = "json" | "missing_field" | "pem" | "import";

export type ServiceAccount =
  | { ok: true; clientEmail: string; privateKey: CryptoKey }
  | { ok: false; error: "not_configured" }
  | { ok: false; error: "invalid"; reason: InvalidKeyReason };

const PEM_PATTERN = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/;

function decodePem(pem: string): Uint8Array<ArrayBuffer> | null {
  const match = PEM_PATTERN.exec(pem.trim());
  if (!match) return null;
  try {
    const binary = atob((match[1] ?? "").replace(/\s+/g, ""));
    if (binary.length === 0) return null;
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// Reads the key: the JSON of a service account key as downloaded from Google Cloud. Only client_email and private_key
// (PKCS#8 PEM) are used; token_uri is ignored. Never throws.
export async function parseServiceAccountKey(value: string | undefined): Promise<ServiceAccount> {
  if (value === undefined || value.trim() === "") return { ok: false, error: "not_configured" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, error: "invalid", reason: "json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "invalid", reason: "json" };
  }
  const { client_email: clientEmail, private_key: privateKeyPem } = parsed as Record<string, unknown>;
  if (typeof clientEmail !== "string" || clientEmail === "" || typeof privateKeyPem !== "string") {
    return { ok: false, error: "invalid", reason: "missing_field" };
  }
  const der = decodePem(privateKeyPem);
  if (der === null) return { ok: false, error: "invalid", reason: "pem" };
  try {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return { ok: true, clientEmail, privateKey };
  } catch {
    return { ok: false, error: "invalid", reason: "import" };
  }
}

const encoder = new TextEncoder();

function encodeJson(value: unknown): string {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

// The signed JWT for the token request, or null if signing failed.
export async function createAssertion(
  account: { clientEmail: string; privateKey: CryptoKey },
  now: number,
): Promise<string | null> {
  const iat = Math.floor(now / 1000);
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const claims = encodeJson({
    iss: account.clientEmail,
    scope: GOOGLE_SCOPES,
    aud: TOKEN_URL,
    iat,
    exp: iat + TOKEN_LIFETIME_SECONDS,
  });
  const input = `${header}.${claims}`;
  try {
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", account.privateKey, encoder.encode(input));
    return `${input}.${base64Url(new Uint8Array(signature))}`;
  } catch {
    return null;
  }
}

type CachedToken = { clientEmail: string; accessToken: string; expiresAt: number };

let cachedToken: CachedToken | null = null;

// Drops the cached access token, e.g. after Google answered 401 to it.
export function clearGoogleTokenCache(): void {
  cachedToken = null;
}

export type AccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: "not_configured" | "credentials_invalid" | "retryable" };

export type AccessTokenOptions = { now: number; fetcher?: typeof fetch };

// The error field of the token endpoint's error response (e.g. invalid_grant), or null.
async function tokenErrorField(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    return typeof error === "string" ? error.slice(0, 100) : null;
  } catch {
    return null;
  }
}

// An access token for the Search Console and GA4 APIs. credentials_invalid: the key is invalid or Google rejected it
// (400, 401). retryable: Google or the network failed and a later try may succeed. Never throws.
export async function getGoogleAccessToken(
  key: string | undefined,
  options: AccessTokenOptions,
): Promise<AccessTokenResult> {
  const account = await parseServiceAccountKey(key);
  if (!account.ok) {
    if (account.error === "not_configured") return { ok: false, error: "not_configured" };
    console.warn("google service account key is invalid", { reason: account.reason });
    return { ok: false, error: "credentials_invalid" };
  }
  const { now } = options;
  if (
    cachedToken !== null &&
    cachedToken.clientEmail === account.clientEmail &&
    now < cachedToken.expiresAt - TOKEN_REUSE_MARGIN_MS
  ) {
    return { ok: true, accessToken: cachedToken.accessToken };
  }
  const assertion = await createAssertion(account, now);
  if (assertion === null) {
    console.warn("google service account key is invalid", { reason: "sign" });
    return { ok: false, error: "credentials_invalid" };
  }
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
  } catch {
    // The exception is not logged: the request carries the JWT.
    console.warn("google token request failed", { reason: "network" });
    return { ok: false, error: "retryable" };
  }
  if (res.status === 400 || res.status === 401) {
    console.warn("google token request rejected", { status: res.status, error: await tokenErrorField(res) });
    return { ok: false, error: "credentials_invalid" };
  }
  if (res.status !== 200) {
    console.warn("google token request failed", { status: res.status });
    return { ok: false, error: "retryable" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const { access_token: accessToken, expires_in: expiresIn } =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof accessToken !== "string" || accessToken === "" || typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    console.warn("google token response is malformed", { status: res.status });
    return { ok: false, error: "retryable" };
  }
  cachedToken = { clientEmail: account.clientEmail, accessToken, expiresAt: now + expiresIn * 1000 };
  return { ok: true, accessToken };
}
