import { afterEach, describe, expect, it, vi } from "vitest";
import { hasGoogleHostedDomain, parseRequireGoogleHd, requireGoogleHostedDomain } from "../src/auth/google-hd";
import type { Bindings } from "../src/env";

type Args = Parameters<typeof requireGoogleHostedDomain>[0];

// The hook is called by workers-app-core at the first OIDC sign-in. The test helpers have no IdP, so the hook is
// called directly here; the core tests cover that it runs before any user write or session.
function check(options: {
  setting?: unknown;
  email: string;
  claims?: Record<string, unknown>;
  operation?: "link" | "create";
}): Promise<boolean> {
  const env = (options.setting === undefined ? {} : { OIDC_REQUIRE_GOOGLE_HD: options.setting }) as Bindings;
  return requireGoogleHostedDomain({
    operation: options.operation ?? "link",
    env,
    db: {} as Args["db"],
    issuer: "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client",
    subject: "subject-1",
    email: options.email,
    claims: options.claims ?? {},
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRequireGoogleHd", () => {
  it("is disabled when unset, empty or false", () => {
    expect(parseRequireGoogleHd(undefined)).toBe(false);
    expect(parseRequireGoogleHd("")).toBe(false);
    expect(parseRequireGoogleHd("false")).toBe(false);
  });

  it("is enabled only by true", () => {
    expect(parseRequireGoogleHd("true")).toBe(true);
  });

  it("rejects other values", () => {
    for (const value of ["yes", "TRUE", "1", " true", true, 1, null]) {
      expect(parseRequireGoogleHd(value)).toBeNull();
    }
  });
});

describe("hasGoogleHostedDomain", () => {
  it("accepts Gmail without hd", () => {
    expect(hasGoogleHostedDomain("someone@gmail.com", {})).toBe(true);
  });

  it("accepts a non-empty hd, even when it differs from the email domain", () => {
    expect(hasGoogleHostedDomain("someone@partner.example", { hd: "partner.example" })).toBe(true);
    expect(hasGoogleHostedDomain("someone@alias.example", { hd: "partner.example" })).toBe(true);
  });

  it("rejects a missing, empty or non-string hd", () => {
    for (const hd of [undefined, "", "  ", 1, null, true, ["partner.example"], { domain: "partner.example" }]) {
      expect(hasGoogleHostedDomain("someone@partner.example", hd === undefined ? {} : { hd })).toBe(false);
    }
  });

  it("does not treat lookalikes of Gmail as Gmail", () => {
    for (const email of ["someone@sub.gmail.com", "someone@gmail.com.example", "someone@googlemail.com"]) {
      expect(hasGoogleHostedDomain(email, {})).toBe(false);
    }
  });
});

describe("requireGoogleHostedDomain", () => {
  it("allows everyone while disabled", async () => {
    for (const setting of [undefined, "", "false"]) {
      expect(await check({ setting, email: "someone@partner.example" })).toBe(true);
    }
  });

  it("allows Gmail and Workspace accounts while enabled", async () => {
    for (const operation of ["link", "create"] as const) {
      expect(await check({ setting: "true", email: "someone@gmail.com", operation })).toBe(true);
      expect(
        await check({ setting: "true", email: "someone@partner.example", claims: { hd: "partner.example" }, operation }),
      ).toBe(true);
    }
  });

  it("rejects other accounts while enabled, without logging the email or claims", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const operation of ["link", "create"] as const) {
      expect(await check({ setting: "true", email: "someone@partner.example", claims: { hd: "" }, operation })).toBe(
        false,
      );
    }
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(call).toEqual(["oidc login rejected", { reason: "google_hd_missing" }]);
    }
  });

  it("throws on an invalid setting", async () => {
    for (const setting of ["yes", "TRUE", true]) {
      await expect(check({ setting, email: "someone@gmail.com" })).rejects.toThrow("OIDC_REQUIRE_GOOGLE_HD");
    }
  });
});
