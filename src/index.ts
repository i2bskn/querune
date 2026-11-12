import { clock, describeError } from "@i2bskn/workers-app-core";
import app from "./app";
import { core } from "./core";
import { loadConfig, type Bindings } from "./env";
import { enqueueArticleSync } from "./sync/articles";
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

  // The imports of the crons in wrangler.jsonc (src/sync/enqueue.ts), and with the full cron the daily article sync
  // (src/sync/articles.ts). The article sync is queued after the imports so that it does not delay them, and does
  // not need the Google service account key.
  async scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const result = loadConfig(env);
    if (!result.ok) {
      console.error("invalid configuration", { invalid: result.invalid });
      return;
    }
    const mode = syncModeOf(controller.cron);
    ctx.waitUntil(
      (async () => {
        await runDailySync({
          db: env.DB,
          queue: env.SYNC_QUEUE,
          now: clock.now(),
          serviceAccountKey: env.GOOGLE_SERVICE_ACCOUNT_KEY,
          mode,
        });
        if (mode !== "full") return;
        try {
          await enqueueArticleSync(env.DB, env.SYNC_QUEUE);
        } catch (error) {
          console.error("article sync enqueue failed", describeError(error));
        }
      })(),
    );
  },
} satisfies ExportedHandler<Bindings>;
