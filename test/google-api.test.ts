import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, login, resetDb, send, type SessionCookies } from "./helpers";
import { SERVICE_ACCOUNT_EMAIL, sharedServiceAccount } from "./google";

let cookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  const user = await createUser({ email: "member@example.com" });
  cookies = await login(user.email);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

describe("GET /api/v1/google", () => {
  it("returns 401 without a session", async () => {
    const res = await send("/api/v1/google");
    expect(res.status).toBe(401);
  });

  it("shows the email of a configured service account, never the key", async () => {
    const { key } = await sharedServiceAccount();
    const res = await send("/api/v1/google", { cookies, env: { GOOGLE_SERVICE_ACCOUNT_KEY: key } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ configured: true, client_email: SERVICE_ACCOUNT_EMAIL, error: null });
    expect(text).not.toContain("PRIVATE KEY");
  });

  it("is not configured without a key", async () => {
    const res = await send("/api/v1/google", { cookies, env: { GOOGLE_SERVICE_ACCOUNT_KEY: "" } });
    expect(await res.json()).toEqual({ configured: false, client_email: null, error: null });
  });

  it("reports an invalid key without its content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await send("/api/v1/google", { cookies, env: { GOOGLE_SERVICE_ACCOUNT_KEY: '{"private_key": "SECRET' } });
    expect(await res.json()).toEqual({ configured: false, client_email: null, error: "invalid" });
    expect(warn).toHaveBeenCalledWith("google service account key is invalid", { reason: "json" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET");
  });
});
