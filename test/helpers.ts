import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { hashPassword } from "../src/auth/password";
import { createDb, type Db } from "../src/db/client";
import { sites, users, type SiteRow, type UserRow } from "../src/db/schema";
import type { Bindings } from "../src/env";
import worker from "../src/index";
import { newSiteId } from "../src/ids";
import type { SyncMessage } from "../src/sync/enqueue";

export const ORIGIN = "https://querune.test";
export const OIDC_ORIGIN = "https://wiki.example.com";
export const PASSWORD = "correct horse battery";

export const db = createDb(env.DB);

export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM gsc_page_daily"),
    env.DB.prepare("DELETE FROM gsc_query_daily"),
    env.DB.prepare("DELETE FROM ga4_landing_daily"),
    env.DB.prepare("DELETE FROM sync_days"),
    env.DB.prepare("DELETE FROM pending_purges"),
    env.DB.prepare("DELETE FROM record_articles"),
    env.DB.prepare("DELETE FROM records"),
    env.DB.prepare("DELETE FROM articles"),
    env.DB.prepare("DELETE FROM sites"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM users"),
  ]);
}

// The default allowlist of the OIDC tests: a domain (not "*"), so that the domain match is exercised end to
// end. Every email that the tests sign in with through OIDC is in this domain.
export const OIDC_ALLOWED_EMAILS = "example.com";

export const oidcEnv: Partial<Bindings> = {
  AUTH_MODE: "oidc",
  APP_ORIGIN: OIDC_ORIGIN,
  OIDC_ISSUER: "https://idp.example.com",
  OIDC_CLIENT_ID: "querune-client",
  OIDC_CLIENT_SECRET: "client-secret",
  ALLOWED_EMAILS: OIDC_ALLOWED_EMAILS,
};

export type RequestOptions = {
  method?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  form?: Record<string, string>;
  json?: unknown;
  // Sent as is, without a Content-Type.
  body?: BodyInit;
  env?: Partial<Bindings>;
  // Passed to the Worker as is, without the per-request copy. Overrides env.
  sharedEnv?: Cloudflare.Env;
  // Origin header for non-GET requests. Defaults to the request origin; null omits it.
  origin?: string | null;
};

export async function send(url: string, options: RequestOptions = {}): Promise<Response> {
  const fullUrl = new URL(url, ORIGIN);
  const method =
    options.method ?? (options.form || options.json !== undefined || options.body !== undefined ? "POST" : "GET");
  const headers = new Headers(options.headers);
  const origin = options.origin === undefined ? fullUrl.origin : options.origin;
  if (method !== "GET" && method !== "HEAD" && origin !== null) {
    headers.set("Origin", origin);
  }
  if (options.cookies) {
    headers.set(
      "Cookie",
      Object.entries(options.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    );
  }
  let body: BodyInit | undefined;
  if (options.form) {
    body = new URLSearchParams(options.form);
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  } else if (options.json !== undefined) {
    body = typeof options.json === "string" ? options.json : JSON.stringify(options.json);
    headers.set("Content-Type", "application/json");
  } else if (options.body !== undefined) {
    body = options.body;
  }
  const request = new Request(fullUrl, { method, headers, body, redirect: "manual" });
  // Through the Worker entry point (OAuthProvider), like production.
  return worker.fetch(request, options.sharedEnv ?? { ...env, ...options.env }, createExecutionContext());
}

export type SetCookie = { value: string; maxAge: number | null; raw: string };

export function setCookies(res: Response): Record<string, SetCookie> {
  const result: Record<string, SetCookie> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair = "", ...attributes] = raw.split(";").map((s) => s.trim());
    const index = pair.indexOf("=");
    const maxAge = attributes.find((a) => a.toLowerCase().startsWith("max-age="));
    result[pair.slice(0, index)] = {
      value: pair.slice(index + 1),
      maxAge: maxAge ? Number(maxAge.split("=")[1]) : null,
      raw,
    };
  }
  return result;
}

export type SessionCookies = { "__Host-querune_at": string; "__Host-querune_rt": string };

export function sessionCookies(res: Response): SessionCookies {
  const cookies = setCookies(res);
  const at = cookies["__Host-querune_at"]?.value;
  const rt = cookies["__Host-querune_rt"]?.value;
  if (!at || !rt) throw new Error(`session cookies are missing: ${res.headers.getSetCookie().join(" | ")}`);
  return { "__Host-querune_at": at, "__Host-querune_rt": rt };
}

export async function createUser(params: {
  email: string;
  role?: "admin" | "member";
  password?: string | null;
  createdAt?: number;
}): Promise<UserRow> {
  const now = params.createdAt ?? Date.now();
  const password = params.password === undefined ? PASSWORD : params.password;
  const [user] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email: params.email,
      role: params.role ?? "member",
      passwordHash: password === null ? null : await hashPassword(password),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!user) throw new Error("failed to create user");
  return user;
}

export async function login(email: string, password = PASSWORD): Promise<SessionCookies> {
  const res = await send("/auth/login", { form: { email, password, next: "/" } });
  if (res.status !== 303) throw new Error(`login failed: ${res.status}`);
  return sessionCookies(res);
}

// A Db whose D1 binding runs before() once, right before the first statement matching pattern runs (alone
// or in a batch), as if another request changed the data between the checks of a service and its write.
export function dbChangingBefore(pattern: RegExp, before: () => Promise<unknown>): Db {
  const real = env.DB;
  const wrapped = new WeakMap<object, D1PreparedStatement>();
  let done = false;
  async function runBefore() {
    if (done) return;
    done = true;
    await before();
  }
  const d1 = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!pattern.test(query)) return statement;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              const wrapper = {
                all: async () => (await runBefore(), bound.all()),
                raw: async () => (await runBefore(), bound.raw()),
                run: async () => (await runBefore(), bound.run()),
                first: async () => (await runBefore(), bound.first()),
              };
              wrapped.set(wrapper, bound);
              return wrapper;
            },
          };
        };
      }
      if (prop === "batch") {
        return async (statements: object[]) => {
          if (statements.some((statement) => wrapped.has(statement))) await runBefore();
          return target.batch(statements.map((statement) => wrapped.get(statement) ?? (statement as D1PreparedStatement)));
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return createDb(d1);
}

export async function countTable(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return row?.count ?? 0;
}

// A D1 binding with some methods replaced, e.g. batch.
export function d1With(overrides: Partial<Record<keyof D1Database, unknown>>): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop in overrides) return overrides[prop as keyof D1Database];
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// The most values that D1 accepts in one statement.
export const D1_MAX_BOUND_VALUES = 100;

export type LargeBind = { sql: string; count: number };

// A D1 binding that records the statements bound with more than D1_MAX_BOUND_VALUES values, which the local D1 may
// accept but D1 does not. Nothing is thrown, since some callers (acceptEvent) swallow errors: the tests check that
// large is empty. prepare returns the real statement with only bind replaced, and bind returns the real bound
// statement, so that batch and the statements run without bind work as they are.
export function d1RecordingLargeBinds(): { d1: D1Database; large: LargeBind[] } {
  const large: LargeBind[] = [];
  const d1 = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(statementTarget, statementProp) {
              if (statementProp === "bind") {
                return (...values: unknown[]) => {
                  if (values.length > D1_MAX_BOUND_VALUES) large.push({ sql: query, count: values.length });
                  return statementTarget.bind(...values);
                };
              }
              const value: unknown = Reflect.get(statementTarget, statementProp, statementTarget);
              return typeof value === "function" ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { d1, large };
}

// The JWT_SECRET of vitest.config.ts.
export const TEST_JWT_SECRET = "test-secret-test-secret-test-secret-0123";

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
