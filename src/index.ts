import app from "./app";
import { loadConfig, type Bindings, type Config } from "./env";
import { getOAuthProvider } from "./mcp/provider";

export type { AppType } from "./app";

// Paths served by OAuthProvider or the authorization page. They are never forwarded to another host.
// When adding a top-level path here, add it to run_worker_first in wrangler.jsonc as well.
function isOAuthPath(path: string): boolean {
  return (
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    path.startsWith("/oauth/") ||
    path.startsWith("/.well-known/") ||
    path === "/authorize"
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

// The origin that hosts OAuth and MCP for this request, or null if the request cannot use them.
function resolveOrigin(config: Config, url: URL): string | null {
  if (config.oidc) return url.origin === config.oidc.appOrigin ? url.origin : null;
  // OAuth requires https, except on loopback hosts for local development.
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    return url.origin;
  }
  return null;
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const result = loadConfig(env);
    // The app answers with the same 500 as for any other path (loadConfigMiddleware).
    if (!result.ok) return app.fetch(request, env, ctx);

    const url = new URL(request.url);
    const origin = resolveOrigin(result.config, url);
    if (origin === null) {
      if (isOAuthPath(url.pathname)) return new Response(null, { status: 404 });
      // In oidc mode, unifyHost redirects pages to APP_ORIGIN.
      return app.fetch(request, env, ctx);
    }
    // A shallow copy per request: OAuthProvider sets env.OAUTH_PROVIDER only when it is missing,
    // so a shared env would keep the helpers of the first origin.
    return getOAuthProvider(origin).fetch(request, { ...env }, ctx);
  },
} satisfies ExportedHandler<Bindings>;
