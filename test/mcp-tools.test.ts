import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRow } from "../src/db/schema";
import { mcpHandler } from "../src/mcp/handler";
import { createSite, createUser, ORIGIN, resetDb } from "./helpers";

const MCP_ACCEPT = "application/json, text/event-stream";

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
type McpSite = {
  id: string;
  name: string;
  url: string;
  gsc_property: string | null;
  ga4_property_id: string | null;
};

let alice: UserRow;

beforeEach(async () => {
  await resetDb();
  alice = await createUser({ email: "alice@example.com" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

async function rpc(user: UserRow, method: string, params: unknown, sharedEnv: Cloudflare.Env = env): Promise<unknown> {
  const ctx = Object.assign(createExecutionContext(), {
    props: { userId: user.id, authMode: "password", authorizedAt: Date.now() },
    auth: { token: "t", audience: `${ORIGIN}/mcp`, scope: ["mcp"], clientId: "test-client" },
  }) as unknown as OAuthResourceContext<unknown>;
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { Accept: MCP_ACCEPT, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = await mcpHandler.fetch(request, sharedEnv, ctx);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result;
}

function callTool(user: UserRow, name: string, args: Record<string, unknown>, sharedEnv?: Cloudflare.Env) {
  return rpc(user, "tools/call", { name, arguments: args }, sharedEnv) as Promise<ToolResult>;
}

function parse<T>(result: ToolResult): T {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? "") as T;
}

describe("tools/list", () => {
  it("lists list_sites only, as a read-only tool", async () => {
    const result = (await rpc(alice, "tools/list", {})) as {
      tools: {
        name: string;
        annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
        inputSchema: { additionalProperties?: unknown };
      }[];
    };
    expect(result.tools.map((tool) => tool.name)).toEqual(["list_sites"]);
    expect(result.tools[0]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(result.tools[0]?.inputSchema.additionalProperties).toBe(false);
  });
});

describe("list_sites", () => {
  it("returns every site by name, then by ID", async () => {
    const b = await createSite({ name: "B", url: "https://b.example.com", gscProperty: "sc-domain:b.example.com" });
    const a2 = await createSite({ name: "A", url: "https://a2.example.com", ga4PropertyId: "123456" });
    const a1 = await createSite({ name: "A", url: "https://a1.example.com" });
    // Sites are shared: another user sees the same list.
    const bob = await createUser({ email: "bob@example.com" });

    for (const user of [alice, bob]) {
      const body = parse<{ sites: McpSite[] }>(await callTool(user, "list_sites", {}));
      const sameName = [a1, a2].sort((x, y) => (x.id < y.id ? -1 : 1));
      expect(body.sites).toEqual([
        ...sameName.map((site) => ({
          id: site.id,
          name: "A",
          url: site.url,
          gsc_property: null,
          ga4_property_id: site.ga4PropertyId,
        })),
        { id: b.id, name: "B", url: "https://b.example.com", gsc_property: "sc-domain:b.example.com", ga4_property_id: null },
      ]);
    }
  });

  it("returns an empty list without sites", async () => {
    expect(parse<{ sites: McpSite[] }>(await callTool(alice, "list_sites", {}))).toEqual({ sites: [] });
  });

  it("rejects unknown arguments", async () => {
    const result = await callTool(alice, "list_sites", { limit: 10 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^MCP error -32602: Input validation error: Invalid arguments for tool /);
  });

  it("answers internal_error without the database message when the query fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            if (/from "sites"/i.test(query)) throw new Error("D1 is down");
            return target.prepare(query);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await callTool(alice, "list_sites", {}, { ...env, DB: failing });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      error: { code: "internal_error", message: "サーバーでエラーが発生しました" },
    });
    expect(errorLog).toHaveBeenCalledWith("mcp tool failed", expect.objectContaining({ tool: "list_sites" }));
  });
});
