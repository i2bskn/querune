import type { CoreHooks } from "@i2bskn/workers-app-core";
import type { Bindings } from "../env";

type LinkOrCreateArgs = Parameters<NonNullable<CoreHooks<Bindings, undefined>["beforeOidcUserLinkOrCreate"]>>[0];

// OIDC_REQUIRE_GOOGLE_HD: unset, "" and "false" disable the check, "true" enables it. Anything else, including
// non-string values from JSON variables, is a configuration error (null).
export function parseRequireGoogleHd(value: unknown): boolean | null {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  return null;
}

// Google guarantees the current ownership of an email only for Gmail and for Google Workspace accounts, whose ID
// tokens carry a non-empty hd. The hd is not compared with the email domain: a Workspace can have several domains.
// The email is already trimmed and lowercased by workers-app-core.
export function hasGoogleHostedDomain(email: string, claims: Readonly<Record<string, unknown>>): boolean {
  if (email.endsWith("@gmail.com")) return true;
  const { hd } = claims;
  return typeof hd === "string" && hd.trim() !== "";
}

// beforeOidcUserLinkOrCreate: the first sign-in of an invited user ("link") and the creation of the first admin by
// INITIAL_ADMIN_EMAIL ("create"). Users already linked by issuer and subject are not checked again. The issuer is not
// checked: enable this only when every login method of the IdP is Google (docs/settings.md).
export async function requireGoogleHostedDomain({ env, email, claims }: LinkOrCreateArgs): Promise<boolean> {
  const enabled = parseRequireGoogleHd(env.OIDC_REQUIRE_GOOGLE_HD);
  if (enabled === null) throw new Error("invalid configuration: OIDC_REQUIRE_GOOGLE_HD");
  if (!enabled || hasGoogleHostedDomain(email, claims)) return true;
  // Never log claim values or the email.
  console.warn("oidc login rejected", { reason: "google_hd_missing" });
  return false;
}
