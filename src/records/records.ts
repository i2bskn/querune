import type { RecordSummary, SiteRecord, TagList } from "../api/types";
import type { Db } from "@i2bskn/workers-app-core";
import { newRecordId, RECORD_ID_PATTERN, SITE_ID_PATTERN } from "../ids";
import {
  add,
  badRequest,
  failure,
  notFound,
  parseTags,
  recordNotFound,
  siteExists,
  siteNotFound,
  TAG_FILTER_SQL,
  where,
  type Outcome,
} from "./common";
import {
  checkPeriod,
  MAX_RECORDS_PER_SITE,
  messages,
  type RecordFilters,
  type RecordInput,
  type RecordKind,
  type RecordStatus,
} from "./validate";

const limitMessage = `記録は 1 サイトにつき ${MAX_RECORDS_PER_SITE} 件まで登録できます`;

// Undated first, then the newest. Used by every list of records.
export const RECORD_ORDER = "date IS NOT NULL, date DESC, id DESC";
// The characters of the content that the lists return, cut in SQL (substr counts characters).
export const CONTENT_PREVIEW_LENGTH = 300;
export const MAX_TAGS_LISTED = 200;

const RECORD_COLUMNS = "id, site_id, kind, status, title, date, period_start, period_end, tags, created_at, updated_at";

type RecordColumns = {
  id: string;
  site_id: string;
  kind: RecordKind;
  status: RecordStatus;
  title: string;
  date: string | null;
  period_start: string | null;
  period_end: string | null;
  tags: string;
  created_at: number;
  updated_at: number;
};

function toSummary(row: RecordColumns, linked: { id: string; title: string }[]): RecordSummary {
  return {
    id: row.id,
    site_id: row.site_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    date: row.date,
    period_start: row.period_start,
    period_end: row.period_end,
    tags: parseTags(row.tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
    articles: linked,
  };
}

// The statement that writes the links of a record: only the articles of the site that still exist, and only while the
// record exists (it was not skipped by the limit nor deleted meanwhile). The IDs are one JSON array.
function linkStatement(d1: D1Database, recordId: string, siteId: string, articleIds: string[]): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO record_articles (record_id, article_id)
      SELECT ?, id FROM articles
      WHERE site_id = ? AND id IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM records WHERE id = ?)`,
    )
    .bind(recordId, siteId, JSON.stringify(articleIds), recordId);
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

export async function findRecord(db: Db, id: string): Promise<SiteRecord | null> {
  if (!RECORD_ID_PATTERN.test(id)) return null;
  const d1 = db.$client;
  const [main, linked] = await d1.batch([
    d1.prepare(`SELECT ${RECORD_COLUMNS}, content FROM records WHERE id = ?`).bind(id),
    d1
      .prepare(
        `SELECT id, title, url FROM articles
        WHERE id IN (SELECT article_id FROM record_articles WHERE record_id = ?) ORDER BY title, id`,
      )
      .bind(id),
  ]);
  const row = main?.results[0] as (RecordColumns & { content: string }) | undefined;
  if (!row) return null;
  const articles = (linked?.results ?? []) as { id: string; title: string; url: string | null }[];
  return {
    id: row.id,
    site_id: row.site_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    date: row.date,
    period_start: row.period_start,
    period_end: row.period_end,
    tags: parseTags(row.tags),
    content: row.content,
    articles,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export type RecordListItem = RecordSummary & { content_preview?: string };

// The records of a site, or null when the site is missing. withContentPreview adds the first 300 characters of
// content.
export async function listRecords(
  d1: D1Database,
  siteId: string,
  filters: RecordFilters,
  page: { limit: number; offset: number },
  withContentPreview = false,
): Promise<{ records: RecordListItem[]; nextOffset: number | null } | null> {
  if (!(await siteExists(d1, siteId))) return null;
  const clause = where("site_id = ?", siteId);
  if (filters.kind !== undefined) add(clause, "kind = ?", filters.kind);
  if (filters.status !== undefined) add(clause, "status = ?", filters.status);
  if (filters.tag !== undefined) add(clause, TAG_FILTER_SQL, filters.tag);
  if (filters.articleId !== undefined) {
    add(clause, "id IN (SELECT record_id FROM record_articles WHERE article_id = ?)", filters.articleId);
  }
  // The comparisons leave out the records without a date.
  if (filters.dateFrom !== undefined) add(clause, "date >= ?", filters.dateFrom);
  if (filters.dateTo !== undefined) add(clause, "date <= ?", filters.dateTo);
  const preview = withContentPreview ? `, substr(content, 1, ${CONTENT_PREVIEW_LENGTH}) AS content_preview` : "";
  const { results } = await d1
    .prepare(
      `SELECT ${RECORD_COLUMNS}${preview} FROM records WHERE ${clause.sql.join(" AND ")}
      ORDER BY ${RECORD_ORDER} LIMIT ? OFFSET ?`,
    )
    .bind(...clause.values, page.limit + 1, page.offset)
    .all<RecordColumns & { content_preview?: string }>();
  const rows = results.slice(0, page.limit);
  const nextOffset = results.length > page.limit ? page.offset + page.limit : null;
  const linked = await linkedArticles(
    d1,
    rows.map((row) => row.id),
  );
  return {
    records: rows.map((row) => {
      const summary = toSummary(row, linked.get(row.id) ?? []);
      return withContentPreview ? { ...summary, content_preview: row.content_preview ?? "" } : summary;
    }),
    nextOffset,
  };
}

// The linked articles of each record, by title, then by ID. The IDs are one JSON array.
async function linkedArticles(d1: D1Database, recordIds: string[]): Promise<Map<string, { id: string; title: string }[]>> {
  const byRecord = new Map<string, { id: string; title: string }[]>();
  if (recordIds.length === 0) return byRecord;
  // One query for the page: a JOIN, since each link needs the title of its article.
  const { results } = await d1
    .prepare(
      `SELECT ra.record_id AS record_id, a.id AS id, a.title AS title
      FROM record_articles ra JOIN articles a ON a.id = ra.article_id
      WHERE ra.record_id IN (SELECT value FROM json_each(?))
      ORDER BY a.title, a.id`,
    )
    .bind(JSON.stringify(recordIds))
    .all<{ record_id: string; id: string; title: string }>();
  for (const row of results) {
    const list = byRecord.get(row.record_id) ?? [];
    list.push({ id: row.id, title: row.title });
    byRecord.set(row.record_id, list);
  }
  return byRecord;
}

// The number of records linked to an article.
export async function countRecordsOfArticle(d1: D1Database, articleId: string): Promise<number> {
  const row = await d1
    .prepare("SELECT COUNT(*) AS count FROM record_articles WHERE article_id = ?")
    .bind(articleId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// Creates a record with its links in one batch. The count limit is checked in the INSERT itself. An article deleted
// between the check and the batch is skipped, so the stored links may be fewer than articleIds.
export async function createRecord(db: Db, siteId: string, input: RecordInput, now: number): Promise<Outcome<SiteRecord>> {
  if (!SITE_ID_PATTERN.test(siteId)) return notFound(siteNotFound);
  const d1 = db.$client;
  if (!(await articlesBelong(d1, siteId, input.articleIds))) {
    if (!(await siteExists(d1, siteId))) return notFound(siteNotFound);
    return badRequest({ ok: false, code: "invalid_articles", message: messages.articles });
  }
  const id = newRecordId(now);
  const statements = [
    d1
      .prepare(
        `INSERT INTO records (id, site_id, kind, status, title, date, period_start, period_end, tags, content,
          created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM sites WHERE id = ?) AND (SELECT COUNT(*) FROM records WHERE site_id = ?) < ?`,
      )
      .bind(
        id,
        siteId,
        input.kind,
        input.status,
        input.title,
        input.date,
        input.periodStart,
        input.periodEnd,
        JSON.stringify(input.tags),
        input.content,
        now,
        now,
        siteId,
        siteId,
        MAX_RECORDS_PER_SITE,
      ),
  ];
  if (input.articleIds.length > 0) statements.push(linkStatement(d1, id, siteId, input.articleIds));
  const results = await d1.batch(statements);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    if (!(await siteExists(d1, siteId))) return notFound(siteNotFound);
    return failure(409, "limit_exceeded", limitMessage);
  }
  const created = await findRecord(db, id);
  if (!created) throw new Error("created record not found");
  return { ok: true, value: created };
}

// The columns that a PATCH may set, by input key.
const UPDATE_COLUMNS = {
  kind: "kind",
  status: "status",
  title: "title",
  date: "date",
  periodStart: "period_start",
  periodEnd: "period_end",
  tags: "tags",
  content: "content",
} as const satisfies Partial<Record<keyof RecordInput, string>>;

// Changes the given items and updated_at; articleIds replaces the links. A period end given alone is checked against
// the stored other end. previous is the record before the change.
export async function updateRecord(
  db: Db,
  id: string,
  input: Partial<RecordInput>,
  now: number,
): Promise<Outcome<{ record: SiteRecord; previous: SiteRecord }>> {
  const previous = await findRecord(db, id);
  if (!previous) return notFound(recordNotFound);
  const period = checkPeriod(
    input.periodStart !== undefined ? input.periodStart : previous.period_start,
    input.periodEnd !== undefined ? input.periodEnd : previous.period_end,
  );
  if (!period.ok) return badRequest(period);
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
  const statements = [d1.prepare(`UPDATE records SET ${sets.join(", ")} WHERE id = ?`).bind(...values, id)];
  if (input.articleIds !== undefined) {
    statements.push(d1.prepare("DELETE FROM record_articles WHERE record_id = ?").bind(id));
    if (input.articleIds.length > 0) statements.push(linkStatement(d1, id, previous.site_id, input.articleIds));
  }
  const results = await d1.batch(statements);
  if ((results[0]?.meta.changes ?? 0) === 0) return notFound(recordNotFound);
  const record = await findRecord(db, id);
  if (!record) return notFound(recordNotFound);
  return { ok: true, value: { record, previous } };
}

// Deletes a record; its links are removed by the cascade. false when missing.
export async function deleteRecord(d1: D1Database, id: string): Promise<boolean> {
  if (!RECORD_ID_PATTERN.test(id)) return false;
  const result = await d1.prepare("DELETE FROM records WHERE id = ?").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

// The tags used in a site, the most used first, then by tag; null when the site is missing.
export async function listTags(d1: D1Database, siteId: string): Promise<TagList | null> {
  if (!(await siteExists(d1, siteId))) return null;
  const { results } = await d1
    .prepare(
      `SELECT tag, SUM(in_article) AS articles, SUM(in_record) AS records FROM (
        SELECT j.value AS tag, 1 AS in_article, 0 AS in_record FROM articles, json_each(articles.tags) AS j
        WHERE articles.site_id = ?
        UNION ALL
        SELECT j.value AS tag, 0 AS in_article, 1 AS in_record FROM records, json_each(records.tags) AS j
        WHERE records.site_id = ?
      )
      GROUP BY tag ORDER BY SUM(in_article) + SUM(in_record) DESC, tag ASC LIMIT ?`,
    )
    .bind(siteId, siteId, MAX_TAGS_LISTED + 1)
    .all<{ tag: string; articles: number; records: number }>();
  return {
    tags: results.slice(0, MAX_TAGS_LISTED).map((row) => ({ tag: row.tag, articles: row.articles, records: row.records })),
    truncated: results.length > MAX_TAGS_LISTED,
  };
}
