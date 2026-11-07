import type { Memo, MemoSummary, TagList } from "../api/types";
import type { Db } from "@i2bskn/workers-app-core";
import { MEMO_ID_PATTERN, newMemoId, SITE_ID_PATTERN } from "../ids";
import {
  add,
  badRequest,
  failure,
  memoNotFound,
  notFound,
  parseTags,
  siteExists,
  siteNotFound,
  TAG_FILTER_SQL,
  where,
  type Outcome,
} from "./common";
import { MAX_MEMOS_PER_SITE, messages, type MemoFilters, type MemoInput } from "./validate";

const limitMessage = `メモは 1 サイトにつき ${MAX_MEMOS_PER_SITE} 件まで登録できます`;

// The newest first. Used by every list of memos.
export const MEMO_ORDER = "created_at DESC, id DESC";
// The characters of the content that the lists return, cut in SQL (substr counts characters).
export const CONTENT_PREVIEW_LENGTH = 300;
export const MAX_TAGS_LISTED = 200;

const MEMO_COLUMNS = "id, site_id, title, tags, created_at, updated_at";

type MemoColumns = {
  id: string;
  site_id: string;
  title: string;
  tags: string;
  created_at: number;
  updated_at: number;
};

function toSummary(row: MemoColumns, linked: { id: string; title: string }[]): MemoSummary {
  return {
    id: row.id,
    site_id: row.site_id,
    title: row.title,
    tags: parseTags(row.tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
    articles: linked,
  };
}

// The statement that writes the links of a memo: only the articles of the site that still exist, and only while the
// memo exists (it was not skipped by the limit nor deleted meanwhile). The IDs are one JSON array.
function linkStatement(d1: D1Database, memoId: string, siteId: string, articleIds: string[]): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO memo_articles (memo_id, article_id)
      SELECT ?, id FROM articles
      WHERE site_id = ? AND id IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM memos WHERE id = ?)`,
    )
    .bind(memoId, siteId, JSON.stringify(articleIds), memoId);
}

// Whether every article exists in the site.
async function articlesBelong(d1: D1Database, siteId: string, articleIds: string[]): Promise<boolean> {
  if (articleIds.length === 0) return true;
  const { results } = await d1
    .prepare("SELECT id FROM articles WHERE site_id = ? AND id IN (SELECT value FROM json_each(?))")
    .bind(siteId, JSON.stringify(articleIds))
    .all();
  return results.length === articleIds.length;
}

export async function findMemo(db: Db, id: string): Promise<Memo | null> {
  if (!MEMO_ID_PATTERN.test(id)) return null;
  const d1 = db.$client;
  const [main, linked] = await d1.batch([
    d1.prepare(`SELECT ${MEMO_COLUMNS}, content FROM memos WHERE id = ?`).bind(id),
    d1
      .prepare(
        `SELECT id, title, url FROM articles
        WHERE id IN (SELECT article_id FROM memo_articles WHERE memo_id = ?) ORDER BY title, id`,
      )
      .bind(id),
  ]);
  const row = main?.results[0] as (MemoColumns & { content: string }) | undefined;
  if (!row) return null;
  const articles = (linked?.results ?? []) as { id: string; title: string; url: string | null }[];
  return {
    id: row.id,
    site_id: row.site_id,
    title: row.title,
    tags: parseTags(row.tags),
    content: row.content,
    articles,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export type MemoListItem = MemoSummary & { content_preview?: string };

// The memos of a site, or null when the site is missing. withContentPreview adds the first 300 characters of
// content.
export async function listMemos(
  d1: D1Database,
  siteId: string,
  filters: MemoFilters,
  page: { limit: number; offset: number },
  withContentPreview = false,
): Promise<{ memos: MemoListItem[]; nextOffset: number | null } | null> {
  if (!(await siteExists(d1, siteId))) return null;
  const clause = where("site_id = ?", siteId);
  if (filters.q !== undefined) {
    // instr, not LIKE, so that % and _ in the words match themselves. lower() folds ASCII letters only.
    clause.sql.push("(instr(lower(title), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0)");
    clause.values.push(filters.q, filters.q);
  }
  if (filters.tag !== undefined) add(clause, TAG_FILTER_SQL, filters.tag);
  if (filters.articleId !== undefined) {
    add(clause, "id IN (SELECT memo_id FROM memo_articles WHERE article_id = ?)", filters.articleId);
  }
  if (filters.createdAfter !== undefined) add(clause, "created_at >= ?", filters.createdAfter);
  if (filters.createdBefore !== undefined) add(clause, "created_at < ?", filters.createdBefore);
  const preview = withContentPreview ? `, substr(content, 1, ${CONTENT_PREVIEW_LENGTH}) AS content_preview` : "";
  const { results } = await d1
    .prepare(
      `SELECT ${MEMO_COLUMNS}${preview} FROM memos WHERE ${clause.sql.join(" AND ")}
      ORDER BY ${MEMO_ORDER} LIMIT ? OFFSET ?`,
    )
    .bind(...clause.values, page.limit + 1, page.offset)
    .all<MemoColumns & { content_preview?: string }>();
  const rows = results.slice(0, page.limit);
  const nextOffset = results.length > page.limit ? page.offset + page.limit : null;
  const linked = await linkedArticles(
    d1,
    rows.map((row) => row.id),
  );
  return {
    memos: rows.map((row) => {
      const summary = toSummary(row, linked.get(row.id) ?? []);
      return withContentPreview ? { ...summary, content_preview: row.content_preview ?? "" } : summary;
    }),
    nextOffset,
  };
}

// The linked articles of each memo, by title, then by ID. The IDs are one JSON array.
async function linkedArticles(d1: D1Database, memoIds: string[]): Promise<Map<string, { id: string; title: string }[]>> {
  const byMemo = new Map<string, { id: string; title: string }[]>();
  if (memoIds.length === 0) return byMemo;
  // One query for the page: a JOIN, since each link needs the title of its article.
  const { results } = await d1
    .prepare(
      `SELECT ma.memo_id AS memo_id, a.id AS id, a.title AS title
      FROM memo_articles ma JOIN articles a ON a.id = ma.article_id
      WHERE ma.memo_id IN (SELECT value FROM json_each(?))
      ORDER BY a.title, a.id`,
    )
    .bind(JSON.stringify(memoIds))
    .all<{ memo_id: string; id: string; title: string }>();
  for (const row of results) {
    const list = byMemo.get(row.memo_id) ?? [];
    list.push({ id: row.id, title: row.title });
    byMemo.set(row.memo_id, list);
  }
  return byMemo;
}

// The number of memos linked to an article.
export async function countMemosOfArticle(d1: D1Database, articleId: string): Promise<number> {
  const row = await d1
    .prepare("SELECT COUNT(*) AS count FROM memo_articles WHERE article_id = ?")
    .bind(articleId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// Creates a memo with its links in one batch. The count limit is checked in the INSERT itself. An article deleted
// between the check and the batch is skipped, so the stored links may be fewer than articleIds.
export async function createMemo(db: Db, siteId: string, input: MemoInput, now: number): Promise<Outcome<Memo>> {
  if (!SITE_ID_PATTERN.test(siteId)) return notFound(siteNotFound);
  const d1 = db.$client;
  if (!(await articlesBelong(d1, siteId, input.articleIds))) {
    if (!(await siteExists(d1, siteId))) return notFound(siteNotFound);
    return badRequest({ ok: false, code: "invalid_articles", message: messages.articles });
  }
  const id = newMemoId(now);
  const statements = [
    d1
      .prepare(
        `INSERT INTO memos (id, site_id, title, tags, content, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM sites WHERE id = ?) AND (SELECT COUNT(*) FROM memos WHERE site_id = ?) < ?`,
      )
      .bind(
        id,
        siteId,
        input.title,
        JSON.stringify(input.tags),
        input.content,
        now,
        now,
        siteId,
        siteId,
        MAX_MEMOS_PER_SITE,
      ),
  ];
  if (input.articleIds.length > 0) statements.push(linkStatement(d1, id, siteId, input.articleIds));
  const results = await d1.batch(statements);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    if (!(await siteExists(d1, siteId))) return notFound(siteNotFound);
    return failure(409, "limit_exceeded", limitMessage);
  }
  const created = await findMemo(db, id);
  if (!created) throw new Error("created memo not found");
  return { ok: true, value: created };
}

// The columns that a PATCH may set, by input key.
const UPDATE_COLUMNS = {
  title: "title",
  tags: "tags",
  content: "content",
} as const satisfies Partial<Record<keyof MemoInput, string>>;

// Changes the given items and updated_at; articleIds replaces the links. previous is the memo before the change.
export async function updateMemo(
  db: Db,
  id: string,
  input: Partial<MemoInput>,
  now: number,
): Promise<Outcome<{ memo: Memo; previous: Memo }>> {
  const previous = await findMemo(db, id);
  if (!previous) return notFound(memoNotFound);
  const d1 = db.$client;
  if (input.articleIds !== undefined && !(await articlesBelong(d1, previous.site_id, input.articleIds))) {
    return badRequest({ ok: false, code: "invalid_articles", message: messages.articles });
  }
  const sets = ["updated_at = ?"];
  const values: unknown[] = [now];
  for (const [key, column] of Object.entries(UPDATE_COLUMNS) as [keyof typeof UPDATE_COLUMNS, string][]) {
    const value = input[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(key === "tags" ? JSON.stringify(value) : value);
  }
  const statements = [d1.prepare(`UPDATE memos SET ${sets.join(", ")} WHERE id = ?`).bind(...values, id)];
  if (input.articleIds !== undefined) {
    statements.push(d1.prepare("DELETE FROM memo_articles WHERE memo_id = ?").bind(id));
    if (input.articleIds.length > 0) statements.push(linkStatement(d1, id, previous.site_id, input.articleIds));
  }
  const results = await d1.batch(statements);
  if ((results[0]?.meta.changes ?? 0) === 0) return notFound(memoNotFound);
  const memo = await findMemo(db, id);
  if (!memo) return notFound(memoNotFound);
  return { ok: true, value: { memo, previous } };
}

// Deletes a memo; its links are removed by the cascade. false when missing.
export async function deleteMemo(d1: D1Database, id: string): Promise<boolean> {
  if (!MEMO_ID_PATTERN.test(id)) return false;
  const result = await d1.prepare("DELETE FROM memos WHERE id = ?").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

// The tags used in a site, the most used first, then by tag; null when the site is missing.
export async function listTags(d1: D1Database, siteId: string): Promise<TagList | null> {
  if (!(await siteExists(d1, siteId))) return null;
  const { results } = await d1
    .prepare(
      `SELECT tag, SUM(in_article) AS articles, SUM(in_memo) AS memos FROM (
        SELECT j.value AS tag, 1 AS in_article, 0 AS in_memo FROM articles, json_each(articles.tags) AS j
        WHERE articles.site_id = ?
        UNION ALL
        SELECT j.value AS tag, 0 AS in_article, 1 AS in_memo FROM memos, json_each(memos.tags) AS j
        WHERE memos.site_id = ?
      )
      GROUP BY tag ORDER BY SUM(in_article) + SUM(in_memo) DESC, tag ASC LIMIT ?`,
    )
    .bind(siteId, siteId, MAX_TAGS_LISTED + 1)
    .all<{ tag: string; articles: number; memos: number }>();
  return {
    tags: results.slice(0, MAX_TAGS_LISTED).map((row) => ({ tag: row.tag, articles: row.articles, memos: row.memos })),
    truncated: results.length > MAX_TAGS_LISTED,
  };
}
