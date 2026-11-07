// The handlers of the articles, memos and tags of a site (/api/v1/sites/:id/...), mounted on the sites router so
// that its requireUser runs once. The items themselves are served by routes/articles.ts and routes/memos.ts.
import type { Context, MiddlewareHandler } from "hono";
import { createFactory } from "hono/factory";
import type {
  ArticleList,
  ArticleListQuery,
  CreateArticleRequest,
  CreateMemoRequest,
  MemoList,
  MemoListQuery,
} from "../api/types";
import { apiError, clock, jsonBody } from "@i2bskn/workers-app-core";
import type { AppEnv } from "../env";
import { createArticle, listArticles } from "../records/articles";
import { siteNotFound, type Failure } from "../records/common";
import { createMemo, listMemos, listTags } from "../records/memos";
import {
  checkArticleBody,
  checkMemoBody,
  checkMemoFilters,
  checkQueryNumber,
  checkTagFilter,
  MAX_MEMOS_PER_SITE,
  type ArticleInput,
  type Check,
  type MemoFilters,
  type MemoInput,
} from "../records/validate";

const factory = createFactory<AppEnv>();

// The :id of the path. The handlers are made without their path, so the parameter is typed as optional; an empty ID
// is not found.
function siteIdOf(c: Context<AppEnv>): string {
  return c.req.param("id") ?? "";
}

// The error response of a failure of src/records/.
export function failureResponse(c: Context<AppEnv>, result: Failure) {
  return apiError(c, result.status, result.code, result.message);
}

// Validates the query string and passes the result to c.req.valid("query"). Unknown parameters are ignored.
function queryCheck<In, Out extends object>(
  check: (query: Record<string, string>) => Check<Out>,
): MiddlewareHandler<AppEnv, string, { in: { query: In }; out: { query: Out } }> {
  return async (c, next) => {
    const result = check(c.req.query());
    if (!result.ok) return apiError(c, 400, result.code, result.message);
    c.req.addValidatedData("query", result.value);
    return next();
  };
}

// Validates the JSON body with a checker of src/records/validate.ts.
export function recordsJsonBody<In, Out extends object>(check: (body: Record<string, unknown>) => Check<Out>) {
  return jsonBody<In, Out>((body, c) => {
    const result = check(body);
    return result.ok ? result : apiError(c, 400, result.code, result.message);
  });
}

const articleListQuery = queryCheck<ArticleListQuery, { tag?: string | undefined }>((query) => {
  const tag = checkTagFilter(query.tag);
  return tag.ok ? { ok: true, value: { tag: tag.value } } : tag;
});

export const listSiteArticles = factory.createHandlers(articleListQuery, async (c) => {
  const { tag } = c.req.valid("query");
  const result = await listArticles(c.get("db").$client, siteIdOf(c), { tag });
  if (!result) return apiError(c, 404, "not_found", siteNotFound);
  const body: ArticleList = { articles: result.articles };
  return c.json(body, 200);
});

export const createSiteArticle = factory.createHandlers(
  recordsJsonBody<CreateArticleRequest, ArticleInput>((body) => checkArticleBody(body, true)),
  async (c) => {
    const result = await createArticle(c.get("db"), siteIdOf(c), c.req.valid("json"), clock.now());
    if (!result.ok) return failureResponse(c, result);
    return c.json(result.value, 201);
  },
);

const MEMO_LIMIT_DEFAULT = 50;
const MEMO_LIMIT_MAX = 100;

const memoListQuery = queryCheck<MemoListQuery, { filters: MemoFilters; limit: number; offset: number }>((query) => {
  const filters = checkMemoFilters(query);
  if (!filters.ok) return filters;
  const limit = checkQueryNumber("limit", query.limit, 1, MEMO_LIMIT_MAX, MEMO_LIMIT_DEFAULT);
  if (!limit.ok) return limit;
  const offset = checkQueryNumber("offset", query.offset, 0, MAX_MEMOS_PER_SITE, 0);
  if (!offset.ok) return offset;
  return { ok: true, value: { filters: filters.value, limit: limit.value, offset: offset.value } };
});

export const listSiteMemos = factory.createHandlers(memoListQuery, async (c) => {
  const { filters, limit, offset } = c.req.valid("query");
  const result = await listMemos(c.get("db").$client, siteIdOf(c), filters, { limit, offset }, true);
  if (!result) return apiError(c, 404, "not_found", siteNotFound);
  const body: MemoList = {
    memos: result.memos.map((memo) => ({ ...memo, content_preview: memo.content_preview ?? "" })),
    next_offset: result.nextOffset,
  };
  return c.json(body, 200);
});

export const createSiteMemo = factory.createHandlers(
  recordsJsonBody<CreateMemoRequest, MemoInput>((body) => checkMemoBody(body, true)),
  async (c) => {
    const result = await createMemo(c.get("db"), siteIdOf(c), c.req.valid("json"), clock.now());
    if (!result.ok) return failureResponse(c, result);
    return c.json(result.value, 201);
  },
);

export const listSiteTags = factory.createHandlers(async (c) => {
  const result = await listTags(c.get("db").$client, siteIdOf(c));
  if (!result) return apiError(c, 404, "not_found", siteNotFound);
  return c.json(result, 200);
});
