import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("drizzle/migrations");
  return {
    test: {
      projects: [
        // Worker tests, run in workerd.
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  AUTH_MODE: "password",
                  JWT_SECRET: "test-secret-test-secret-test-secret-0123",
                  // PBKDF2 with few iterations instead of the default scrypt (about 150ms of CPU per hash), so that
                  // the setup, users, password changes and the dummy check at login stay fast. Same as
                  // TEST_HASH_CONFIG of test/helpers.ts; test/core-smoke.test.ts checks the default scrypt once.
                  PASSWORD_HASH_ALGORITHM: "pbkdf2",
                  PASSWORD_PBKDF2_ITERATIONS: "10000",
                },
                // The producer sends to a queue that has no consumer, so that the consumer of wrangler.jsonc never
                // runs in the background during tests. Consumer tests call the queue handler directly.
                queueProducers: { SYNC_QUEUE: { queueName: "querune-sync-test" } },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/**/*.test.ts"],
            setupFiles: ["./test/setup.ts"],
            testTimeout: 30000,
          },
        },
        // Client tests that need no browser, run in Node.
        {
          test: {
            name: "client",
            include: ["client/**/*.test.{ts,tsx}"],
            environment: "node",
          },
        },
      ],
    },
  };
});
