import { eq } from "drizzle-orm";
import type { Article, ArticleSummary } from "../api/types";
import { isUniqueViolation, type Db } from "@i2bskn/workers-app-core";
import { articles, type ArticleRow } from "../db/schema";
import { ARTICLE_ID_PATTERN, newArticleId, SITE_ID_PATTERN } from "../ids";
import {
  add,
  articleNotFound,
  failure,
  notFound,
  parseTags,
  siteExists,
  siteNotFound,
  TAG_FILTER_SQL,
  where,
  type Outcome,
} from "./common";
import { MAX_ARTICLES_PER_SITE, type ArticleInput } from "./validate";

const urlConflictMessage = "この URL の記事は同じサイトに登録済みです";
const limitMessage = `記事は 1 サイトにつき ${MAX_ARTICLES_PER_SITE} 件まで登録できます`;

// Unpublished first, then the newest. Used by every list of articles.
export const ARTICLE_ORDER = "published_on IS NOT NULL, published_on DESC, id DESC";
// The characters of the note that the lists return, cut in SQL (substr counts characters).
export const NOTE_PREVIEW_LENGTH = 200;

export function toApiArticle(row: ArticleRow): Article {
  return {
    id: row.id,
    site_id: row.siteId,
    title: row.title,
    url: row.url,
    published_on: row.publishedOn,
    tags: parseTags(row.tags),
    note: row.note,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

type SummaryColumns = {
  id: string;
  site_id: string;
  title: string;
  url: string | null;
  published_on: string | null;
  tags: string;
  created_at: number;
  updated_at: number;
};

function toSummary(row: SummaryColumns): ArticleSummary {
  return {
    id: row.id,
    site_id: row.site_id,
    title: row.title,
    url: row.url,
    published_on: row.published_on,
    tags: parseTags(row.tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function findArticle(db: Db, id: string): Promise<Article | null> {
  if (!ARTICLE_ID_PATTERN.test(id)) return null;
  const row = await db.select().from(articles).where(eq(articles.id, id)).get();
  return row ? toApiArticle(row) : null;
}

export type ArticleListOptions = {
  tag?: string | undefined;
  // true: published_on is set; false: it is not; undefined: both.
  published?: boolean | undefined;
  // ASCII-case-insensitive substring of the title.
  titleContains?: string | undefined;
  // Without page, every article of the site (at most MAX_ARTICLES_PER_SITE).
  page?: { limit: number; offset: number } | undefined;
};

export type ArticleListItem = ArticleSummary & { note_preview?: string };

// The articles of a site, or null when the site is missing. withNotePreview adds the first 200 characters of note.
export async function listArticles(
  d1: D1Database,
  siteId: string,
  options: ArticleListOptions,
  withNotePreview = false,
): Promise<{ articles: ArticleListItem[]; nextOffset: number | null } | null> {
  if (!(await siteExists(d1, siteId))) return null;
  const clause = where("site_id = ?", siteId);
  if (options.tag !== undefined) add(clause, TAG_FILTER_SQL, options.tag);
  if (options.published === true) add(clause, "published_on IS NOT NULL");
  if (options.published === false) add(clause, "published_on IS NULL");
  // instr instead of LIKE, so that % and _ match as they are. lower folds ASCII only.
  if (options.titleContains !== undefined) add(clause, "instr(lower(title), lower(?)) > 0", options.titleContains);
  const preview = withNotePreview ? `, substr(note, 1, ${NOTE_PREVIEW_LENGTH}) AS note_preview` : "";
  let sql = `SELECT id, site_id, title, url, published_on, tags, created_at, updated_at${preview}
    FROM articles WHERE ${clause.sql.join(" AND ")} ORDER BY ${ARTICLE_ORDER}`;
  const values = [...clause.values];
  if (options.page) {
    sql += " LIMIT ? OFFSET ?";
    values.push(options.page.limit + 1, options.page.offset);
  }
  const { results } = await d1
    .prepare(sql)
    .bind(...values)
    .all<SummaryColumns & { note_preview?: string }>();
  let rows = results;
  let nextOffset: number | null = null;
  if (options.page && rows.length > options.page.limit) {
    rows = rows.slice(0, options.page.limit);
    nextOffset = options.page.offset + options.page.limit;
  }
  return {
    articles: rows.map((row) =>
      withNotePreview ? { ...toSummary(row), note_preview: row.note_preview ?? "" } : toSummary(row),
    ),
    nextOffset,
  };
}

// Creates an article. The count limit is checked in the INSERT itself, so that concurrent requests cannot go over it.
export async function createArticle(db: Db, siteId: string, input: ArticleInput, now: number): Promise<Outcome<Article>> {
  if (!SITE_ID_PATTERN.test(siteId)) return notFound(siteNotFound);
  const d1 = db.$client;
  const id = newArticleId(now);
  let changes: number;
  try {
    const result = await d1
      .prepare(
        `INSERT INTO articles (id, site_id, title, url, published_on, tags, note, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM sites WHERE id = ?) AND (SELECT COUNT(*) FROM articles WHERE site_id = ?) < ?`,
      )
      .bind(
        id,
        siteId,
        input.title,
        input.url,
        input.publishedOn,
        JSON.stringify(input.tags),
        input.note,
        now,
        now,
        siteId,
        siteId,
        MAX_ARTICLES_PER_SITE,
      )
      .run();
    changes = result.meta.changes ?? 0;
  } catch (error) {
    if (isUniqueViolation(error)) return failure(409, "url_conflict", urlConflictMessage);
    throw error;
  }
  if (changes === 0) {
    if (!(await siteExists(d1, siteId))) return notFound(siteNotFound);
    return failure(409, "limit_exceeded", limitMessage);
  }
  const created = await findArticle(db, id);
  if (!created) throw new Error("created article not found");
  return { ok: true, value: created };
}

// Changes the given items and updated_at. previous is the article before the change.
export async function updateArticle(
  db: Db,
  id: string,
  input: Partial<ArticleInput>,
  now: number,
): Promise<Outcome<{ article: Article; previous: Article }>> {
  const previous = await findArticle(db, id);
  if (!previous) return notFound(articleNotFound);
  const set: Partial<ArticleRow> = { updatedAt: now };
  if (input.title !== undefined) set.title = input.title;
  if (input.url !== undefined) set.url = input.url;
  if (input.publishedOn !== undefined) set.publishedOn = input.publishedOn;
  if (input.tags !== undefined) set.tags = JSON.stringify(input.tags);
  if (input.note !== undefined) set.note = input.note;
  let changes: number;
  try {
    const result = await db.update(articles).set(set).where(eq(articles.id, id)).run();
    changes = result.meta.changes ?? 0;
  } catch (error) {
    if (isUniqueViolation(error)) return failure(409, "url_conflict", urlConflictMessage);
    throw error;
  }
  if (changes === 0) return notFound(articleNotFound);
  const article = await findArticle(db, id);
  if (!article) return notFound(articleNotFound);
  return { ok: true, value: { article, previous } };
}

// Deletes an article; its links to memos are removed by the cascade and the memos stay. false when missing.
export async function deleteArticle(db: Db, id: string): Promise<boolean> {
  if (!ARTICLE_ID_PATTERN.test(id)) return false;
  const result = await db.delete(articles).where(eq(articles.id, id)).run();
  return (result.meta.changes ?? 0) > 0;
}
