import type { Context, Next } from "hono";
import { createCore } from "@i2bskn/workers-app-core";
import { BRAND_NAME, BRAND_TAGLINE } from "./brand";
import type { AppEnv, Bindings } from "./env";
import { registerTools } from "./mcp/tools";

// Login, sessions, user management and the MCP OAuth authorization server.
export const core = createCore<Bindings>({
  brand: { id: "querune", name: BRAND_NAME, tagline: BRAND_TAGLINE },
  mcp: {
    serverInfo: { name: "querune", version: "0.0.0" },
    register: (server, { db, user }) => registerTools(server, { db, user }),
  },
  consent: {
    // Keep this in line with the tools of src/mcp/tools.ts and src/mcp/record-tools.ts.
    description:
      "許可すると、このアプリはあなたとして、このQueruneに登録されたサイトの一覧と、取り込んだ Search Console・GA4 の集計と取り込みの状況を読み取れるようになります。また、サイトの記事と記録（施策・レビュー・メモ）を読み取り、登録・編集できるようになります。このアプリから削除はできません。",
  },
});

// The signed-in user, for the app's API routes. A function declaration rather than a constant: src/routes/sites.ts
// uses it while this module may still be loading (core.ts -> mcp/tools.ts -> routes/sites.ts -> core.ts), and
// function declarations are available before the module runs.
export function requireUser(c: Context<AppEnv>, next: Next) {
  return core.middleware.requireUser(c, next);
}
