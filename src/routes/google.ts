import { Hono } from "hono";
import type { GoogleStatus } from "../api/types";
import { requireUser } from "../core";
import type { AppEnv } from "../env";
import { parseServiceAccountKey } from "../google/credentials";

// The service account that imports Search Console and GA4. Only its email is shown; never the key.
const googleApi = new Hono<AppEnv>().use("*", requireUser).get("/", async (c) => {
  const account = await parseServiceAccountKey(c.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  let body: GoogleStatus;
  if (account.ok) {
    body = { configured: true, client_email: account.clientEmail, error: null };
  } else if (account.error === "not_configured") {
    body = { configured: false, client_email: null, error: null };
  } else {
    console.warn("google service account key is invalid", { reason: account.reason });
    body = { configured: false, client_email: null, error: "invalid" };
  }
  return c.json(body, 200);
});

export default googleApi;
