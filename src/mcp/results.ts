import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describeError } from "../auth/middleware";

// The results and errors shared by the MCP tools.

const internalError = "サーバーでエラーが発生しました";

export const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export type ToolErrorCode =
  | "internal_error"
  | "not_found"
  | "invalid_argument"
  | "not_configured"
  | "url_conflict"
  | "limit_exceeded";

export function ok(result: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

export function toolError(code: ToolErrorCode, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] };
}

// Runs a tool. An unexpected exception is logged and answered with internal_error, without the database message.
export async function safely(
  tool: string,
  ids: Record<string, unknown>,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    console.error("mcp tool failed", { tool, ...ids, ...describeError(error) });
    return toolError("internal_error", internalError);
  }
}
