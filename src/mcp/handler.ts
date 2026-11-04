import { insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { findUserById } from "../auth/users";
import { createDb } from "../db/client";
import { loadConfig, type AuthMode, type Bindings } from "../env";
import { registerTools } from "./tools";

export const MCP_SCOPE = "mcp";

// Stored in the grant by POST /authorize and passed to the handler as ctx.props. authorizedAt is the time of the
// authorization (UNIX ms), compared with users.mcp_revoked_at.
export type McpProps = { userId: string; authMode: AuthMode; authorizedAt: number };

export function isMcpProps(value: unknown): value is McpProps {
  if (typeof value !== "object" || value === null) return false;
  const { userId, authMode, authorizedAt } = value as Record<string, unknown>;
  return (
    typeof userId === "string" &&
    (authMode === "oidc" || authMode === "password") &&
    typeof authorizedAt === "number" &&
    Number.isFinite(authorizedAt)
  );
}

// The same resource_metadata as the library's 401 for a missing token.
function invalidToken(audience: string): Response {
  const metadataUrl = `${new URL(audience).origin}/.well-known/oauth-protected-resource/mcp`;
  return new Response(null, {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`,
    },
  });
}

// Called by OAuthProvider for /mcp after the access token has been validated.
export const mcpHandler = {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    // Stateless: a GET would open an SSE stream that never carries anything, and there is no session to DELETE.
    if (request.method === "GET" || request.method === "DELETE") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }

    const { auth, props } = ctx as OAuthResourceContext<unknown>;
    if (!auth.scope.includes(MCP_SCOPE)) return insufficientScope(auth, [MCP_SCOPE]);

    const result = loadConfig(env);
    if (!result.ok) {
      console.error("invalid configuration", { invalid: result.invalid });
      return new Response(null, { status: 500 });
    }
    const config = result.config;
    const db = createDb(env.DB);

    // The user is read on every request so that role changes and deletions apply immediately.
    // The grant is kept: a refreshed token also gets 401, and the client then authorizes again.
    if (!isMcpProps(props) || props.authMode !== config.authMode) return invalidToken(auth.audience);
    const user = await findUserById(db, props.userId);
    if (!user) return invalidToken(auth.audience);
    // Grants authorized at or before the last password change or session revocation, including those that the
    // revocation in KV missed because its listing lags behind.
    if (user.mcpRevokedAt !== null && props.authorizedAt <= user.mcpRevokedAt) return invalidToken(auth.audience);

    // A new server and transport per request (stateless).
    const server = new McpServer(
      { name: "querune", version: "0.0.0" },
      // Avoids compiling Ajv on every request.
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    registerTools(server, { db, user });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
