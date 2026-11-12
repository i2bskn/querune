import { clock } from "@i2bskn/workers-app-core";
import app from "./app";
import { core } from "./core";
import { loadConfig, type Bindings } from "./env";
import { handleSyncQueue } from "./sync/consumer";
import { runDailySync, syncModeOf } from "./sync/enqueue";

export type { AppType } from "./app";

export default {
  // OAuth and /mcp through OAuthProvider on origins that can host them, everything else through the app. The OAuth
  // paths are /mcp, /mcp/*, /oauth/*, /.well-known/* and /authorize: keep them in run_worker_first in wrangler.jsonc.
  fetch: core.fetch(app),

  // The sync queue and its dead letter queue (src/sync/consumer.ts).
  async queue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
    await handleSyncQueue(batch, env);
  },

  // The imports of the crons in wrangler.jsonc (src/sync/enqueue.ts).
  async scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const result = loadConfig(env);
    if (!result.ok) {
      console.error("invalid configuration", { invalid: result.invalid });
      return;
    }
    ctx.waitUntil(
      runDailySync({
        db: env.DB,
        queue: env.SYNC_QUEUE,
        now: clock.now(),
        serviceAccountKey: env.GOOGLE_SERVICE_ACCOUNT_KEY,
        mode: syncModeOf(controller.cron),
      }),
    );
  },
} satisfies ExportedHandler<Bindings>;
