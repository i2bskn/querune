import { SITE_ID_PATTERN } from "../ids";
import type { Invalid } from "./validate";

// The outcome of a database function: the value, or the error for the REST API (status) and the MCP tools (code).
export type Failure = { ok: false; status: 400 | 404 | 409; code: string; message: string };
export type Outcome<T> = { ok: true; value: T } | Failure;

export const siteNotFound = "サイトが見つかりません";
export const articleNotFound = "記事が見つかりません";
export const recordNotFound = "記録が見つかりません";

export function failure(status: Failure["status"], code: string, message: string): Failure {
  return { ok: false, status, code, message };
}

export function badRequest(error: Invalid): Failure {
  return failure(400, error.code, error.message);
}

export function notFound(message: string): Failure {
  return failure(404, "not_found", message);
}

// The tags column (a JSON array of strings). A value of another form is read as no tags.
export function parseTags(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

export async function siteExists(d1: D1Database, siteId: string): Promise<boolean> {
  if (!SITE_ID_PATTERN.test(siteId)) return false;
  const row = await d1.prepare("SELECT 1 AS found FROM sites WHERE id = ?").bind(siteId).first();
  return row !== null;
}

// A WHERE clause built from parts, with the values in the order of the parts.
export type Where = { sql: string[]; values: unknown[] };

export function where(first: string, ...values: unknown[]): Where {
  return { sql: [first], values };
}

export function add(clause: Where, sql: string, ...values: unknown[]): void {
  clause.sql.push(sql);
  clause.values.push(...values);
}

// Exact match on one tag of the JSON array in the tags column.
export const TAG_FILTER_SQL = "EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)";
