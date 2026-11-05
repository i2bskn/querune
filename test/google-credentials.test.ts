import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGoogleTokenCache,
  createAssertion,
  getGoogleAccessToken,
  GOOGLE_SCOPES,
  parseServiceAccountKey,
  TOKEN_URL,
} from "../src/google/credentials";
import { createServiceAccount, fakeGoogle, SERVICE_ACCOUNT_EMAIL, sharedServiceAccount } from "./google";

const NOW = Date.UTC(2026, 10, 5, 3, 0, 0);

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJson(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

beforeEach(() => {
  clearGoogleTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearGoogleTokenCache();
});

describe("parseServiceAccountKey", () => {
  it("reads client_email and the private key", async () => {
    const { key } = await sharedServiceAccount();
    const account = await parseServiceAccountKey(key);
    expect(account.ok).toBe(true);
    if (account.ok) {
      expect(account.clientEmail).toBe(SERVICE_ACCOUNT_EMAIL);
      expect(account.privateKey.type).toBe("private");
    }
  });

  it("is not_configured when unset or blank", async () => {
    for (const value of [undefined, "", "  "]) {
      expect(await parseServiceAccountKey(value)).toEqual({ ok: false, error: "not_configured" });
    }
  });

  it("is invalid with the reason", async () => {
    const { pem } = await sharedServiceAccount();
    const cases: [string, string][] = [
      ["{not json", "json"],
      ['"a string"', "json"],
      [JSON.stringify({ private_key: pem }), "missing_field"],
      [JSON.stringify({ client_email: SERVICE_ACCOUNT_EMAIL }), "missing_field"],
      [JSON.stringify({ client_email: 1, private_key: pem }), "missing_field"],
      [JSON.stringify({ client_email: SERVICE_ACCOUNT_EMAIL, private_key: "not a pem" }), "pem"],
      [
        JSON.stringify({
          client_email: SERVICE_ACCOUNT_EMAIL,
          private_key: "-----BEGIN PRIVATE KEY-----\nA\n-----END PRIVATE KEY-----\n",
        }),
        "pem",
      ],
      [
        JSON.stringify({
          client_email: SERVICE_ACCOUNT_EMAIL,
          private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
        }),
        "import",
      ],
    ];
    for (const [value, reason] of cases) {
      expect(await parseServiceAccountKey(value), value).toEqual({ ok: false, error: "invalid", reason });
    }
  });

  it("never passes the key to the logs when JSON.parse fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = '{"private_key": "-----BEGIN PRIVATE KEY-----SECRET-MATERIAL';
    expect(await parseServiceAccountKey(secret)).toEqual({ ok: false, error: "invalid", reason: "json" });
    expect(await getGoogleAccessToken(secret, { now: NOW, fetcher: fakeGoogle().fetcher })).toEqual({
      ok: false,
      error: "credentials_invalid",
    });
    const logged = JSON.stringify([...error.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain("SECRET-MATERIAL");
    expect(warn).toHaveBeenCalledWith("google service account key is invalid", { reason: "json" });
  });
});

describe("createAssertion", () => {
  it("signs a JWT for the token endpoint", async () => {
    const { key, publicKey } = await sharedServiceAccount();
    const account = await parseServiceAccountKey(key);
    if (!account.ok) throw new Error("invalid key");
    const jwt = await createAssertion(account, NOW);
    if (jwt === null) throw new Error("not signed");
    const [header = "", claims = "", signature = ""] = jwt.split(".");
    expect(decodeJson(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const iat = Math.floor(NOW / 1000);
    expect(decodeJson(claims)).toEqual({
      iss: SERVICE_ACCOUNT_EMAIL,
      scope: GOOGLE_SCOPES,
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    });
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodeBase64Url(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(verified).toBe(true);
  });
});

describe("getGoogleAccessToken", () => {
  it("posts the JWT to the token endpoint and returns the access token", async () => {
    const { key } = await sharedServiceAccount();
    const google = fakeGoogle();
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return google.fetcher(input, init);
    };
    expect(await getGoogleAccessToken(key, { now: NOW, fetcher })).toEqual({ ok: true, accessToken: "test-access-token" });
    expect(requests).toHaveLength(1);
    const request = requests[0] as Request;
    expect(request.url).toBe(TOKEN_URL);
    expect(request.method).toBe("POST");
    expect(request.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    const form = await request.formData();
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(String(form.get("assertion")).split(".")).toHaveLength(3);
  });

  it("ignores token_uri of the key", async () => {
    const { key } = await createServiceAccount({ token_uri: "https://evil.example.com/token" });
    const google = fakeGoogle();
    expect(await getGoogleAccessToken(key, { now: NOW, fetcher: google.fetcher })).toEqual({
      ok: true,
      accessToken: "test-access-token",
    });
    expect(google.tokenCalls).toBe(1);
  });

  it("is not_configured without a key, without a request", async () => {
    const google = fakeGoogle();
    expect(await getGoogleAccessToken(undefined, { now: NOW, fetcher: google.fetcher })).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(google.tokenCalls).toBe(0);
  });

  it("is credentials_invalid on 400 and 401, logging only the status and the error field", async () => {
    const { key } = await sharedServiceAccount();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const status of [400, 401]) {
      const google = fakeGoogle();
      google.token = () =>
        Response.json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, { status });
      expect(await getGoogleAccessToken(key, { now: NOW, fetcher: google.fetcher })).toEqual({
        ok: false,
        error: "credentials_invalid",
      });
      expect(warn).toHaveBeenLastCalledWith("google token request rejected", { status, error: "invalid_grant" });
    }
  });

  it("is retryable on 500, 429 and network errors", async () => {
    const { key } = await sharedServiceAccount();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const answer of [() => new Response("", { status: 500 }), () => new Response("", { status: 429 })]) {
      const google = fakeGoogle();
      google.token = answer;
      expect(await getGoogleAccessToken(key, { now: NOW, fetcher: google.fetcher })).toEqual({
        ok: false,
        error: "retryable",
      });
    }
    const failing: typeof fetch = async () => {
      throw new TypeError("network down");
    };
    expect(await getGoogleAccessToken(key, { now: NOW, fetcher: failing })).toEqual({ ok: false, error: "retryable" });
  });

  it("reuses the token until a minute before it expires, and clearGoogleTokenCache drops it", async () => {
    const { key } = await sharedServiceAccount();
    const google = fakeGoogle();
    let issued = 0;
    google.token = () => Response.json({ access_token: `token-${++issued}`, expires_in: 3600 });
    const get = (now: number) => getGoogleAccessToken(key, { now, fetcher: google.fetcher });
    expect(await get(NOW)).toEqual({ ok: true, accessToken: "token-1" });
    expect(await get(NOW + 3540_000 - 1)).toEqual({ ok: true, accessToken: "token-1" });
    expect(google.tokenCalls).toBe(1);
    expect(await get(NOW + 3540_000)).toEqual({ ok: true, accessToken: "token-2" });
    expect(google.tokenCalls).toBe(2);
    clearGoogleTokenCache();
    expect(await get(NOW + 3540_000)).toEqual({ ok: true, accessToken: "token-3" });
  });

  it("does not reuse the token of another service account", async () => {
    const first = await sharedServiceAccount();
    const second = await createServiceAccount({ client_email: "other@test-project.iam.gserviceaccount.com" });
    const google = fakeGoogle();
    let issued = 0;
    google.token = () => Response.json({ access_token: `token-${++issued}`, expires_in: 3600 });
    expect(await getGoogleAccessToken(first.key, { now: NOW, fetcher: google.fetcher })).toEqual({
      ok: true,
      accessToken: "token-1",
    });
    expect(await getGoogleAccessToken(second.key, { now: NOW, fetcher: google.fetcher })).toEqual({
      ok: true,
      accessToken: "token-2",
    });
  });
});
