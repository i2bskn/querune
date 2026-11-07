import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createTestHelpers,
  type RequestOptions as CoreRequestOptions,
  type SessionCookies as CoreSessionCookies,
} from "@i2bskn/workers-app-core/testing";
import { sites, type SiteRow } from "../src/db/schema";
import worker from "../src/index";
import { newSiteId } from "../src/ids";
import type { SyncMessage } from "../src/sync/enqueue";

export {
  D1_MAX_BOUND_VALUES,
  PASSWORD,
  TEST_JWT_SECRET,
  type LargeBind,
  type SetCookie,
} from "@i2bskn/workers-app-core/testing";

export const ORIGIN = "https://querune.test";

// Login, users and requests through the Worker entry point (OAuthProvider), like production.
const helpers = createTestHelpers({
  worker,
  env,
  createExecutionContext,
  waitOnExecutionContext,
  brandId: "querune",
  origin: ORIGIN,
});

export const {
  db,
  send,
  setCookies,
  sessionCookies,
  login,
  createUser,
  dbChangingBefore,
  d1With,
  d1RecordingLargeBinds,
  countTable,
} = helpers;

export type RequestOptions = CoreRequestOptions<Cloudflare.Env>;
export type SessionCookies = CoreSessionCookies<"querune">;

// The tables of the app, children first. sessions and users are deleted after them.
const APP_TABLES = [
  "gsc_page_daily",
  "gsc_query_daily",
  "ga4_landing_daily",
  "sync_days",
  "pending_purges",
  "memo_articles",
  "memos",
  "articles",
  "sites",
];

export function resetDb(): Promise<void> {
  return helpers.resetDb(APP_TABLES);
}

let siteSequence = 0;

// Inserts a site directly. url defaults to a unique origin.
export async function createSite(
  params: { name?: string; url?: string; gscProperty?: string | null; ga4PropertyId?: string | null; createdAt?: number } = {},
): Promise<SiteRow> {
  siteSequence += 1;
  const now = params.createdAt ?? Date.now();
  const [site] = await db
    .insert(sites)
    .values({
      id: newSiteId(now),
      name: params.name ?? `Site ${siteSequence}`,
      url: params.url ?? `https://site-${siteSequence}.example.com`,
      gscProperty: params.gscProperty ?? null,
      ga4PropertyId: params.ga4PropertyId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!site) throw new Error("failed to create site");
  return site;
}

// A sync queue that records the messages sent to it. fail makes send and sendBatch throw; failAfter makes them throw
// after that many successful calls.
export type FakeQueue = Queue<SyncMessage> & {
  messages: SyncMessage[];
  calls: number;
  fail: boolean;
  failAfter: number | null;
};

export function fakeQueue(): FakeQueue {
  const queue = {
    messages: [] as SyncMessage[],
    calls: 0,
    fail: false,
    failAfter: null as number | null,
    check() {
      if (queue.fail || (queue.failAfter !== null && queue.calls >= queue.failAfter)) throw new Error("queue is down");
      queue.calls++;
    },
    async send(body: SyncMessage) {
      queue.check();
      queue.messages.push(body);
    },
    async sendBatch(messages: Iterable<MessageSendRequest<SyncMessage>>) {
      queue.check();
      for (const message of messages) queue.messages.push(message.body);
    },
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 };
    },
  };
  return queue as unknown as FakeQueue;
}

// A queue message that records ack and retry.
export type FakeMessage = Message<unknown> & { acked: boolean; retried: { delaySeconds?: number } | null };

export function fakeMessage(body: unknown, attempts = 1): FakeMessage {
  const message = {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    acked: false,
    retried: null as { delaySeconds?: number } | null,
    ack() {
      message.acked = true;
    },
    retry(options?: { delaySeconds?: number }) {
      message.retried = options ?? {};
    },
  };
  return message as unknown as FakeMessage;
}

export function fakeBatch(queue: string, messages: FakeMessage[]): MessageBatch<unknown> {
  return {
    queue,
    messages,
    ackAll() {
      for (const message of messages) message.ack();
    },
    retryAll(options?: { delaySeconds?: number }) {
      for (const message of messages) message.retry(options);
    },
  } as unknown as MessageBatch<unknown>;
}

// Counts the statements and batches that reach D1 (a batch counts as one query, as D1 counts it).
export function d1Counting(): { d1: D1Database; count: () => number } {
  let count = 0;
  const d1 = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          const wrap = (bound: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(bound, {
              get(statementTarget, statementProp) {
                if (statementProp === "bind") {
                  return (...values: unknown[]) => wrap(statementTarget.bind(...values));
                }
                if (statementProp === "all" || statementProp === "run" || statementProp === "first" || statementProp === "raw") {
                  count++;
                }
                const value: unknown = Reflect.get(statementTarget, statementProp, statementTarget);
                return typeof value === "function" ? value.bind(statementTarget) : value;
              },
            });
          return wrap(statement);
        };
      }
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          count++;
          return target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { d1, count: () => count };
}
