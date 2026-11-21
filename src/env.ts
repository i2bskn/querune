import type { AppEnv as CoreAppEnv, CoreBindings } from "@i2bskn/workers-app-core";
import type { SyncMessage } from "./sync/enqueue";

export { loadConfig, type AuthMode, type Config } from "@i2bskn/workers-app-core";

// Login, sessions, user management and MCP OAuth come from @i2bskn/workers-app-core (src/core.ts).
export type Bindings = CoreBindings & {
  // The imports of Search Console and GA4 (src/sync/).
  SYNC_QUEUE: Queue<SyncMessage>;
  // The JSON of a Google service account key. Optional: without it nothing is imported. Not part of loadConfig, so that
  // a missing or invalid key never stops the rest of the app.
  GOOGLE_SERVICE_ACCOUNT_KEY?: string;
  // "true" requires a Google hd claim at the first OIDC sign-in, except for Gmail (src/auth/google-hd.ts). Not part
  // of loadConfig, which belongs to workers-app-core: an invalid value fails only that sign-in with 500.
  OIDC_REQUIRE_GOOGLE_HD?: string;
};

export type AppEnv = CoreAppEnv<Bindings>;
