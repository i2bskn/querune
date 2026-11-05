// Validation of the articles and records, shared by the REST API and the MCP tools so that both inputs behave the
// same. Every normalizer returns the stored value or the error code and message of the item.
import { RECORD_KINDS, RECORD_STATUSES } from "../db/schema";
import { ARTICLE_ID_PATTERN } from "../ids";
import { normalizeDisplayName } from "../routes/api";
import { isValidDate } from "../sync/dates";

export const MAX_ARTICLES_PER_SITE = 1000;
export const MAX_RECORDS_PER_SITE = 2000;
export const MAX_ARTICLES_PER_RECORD = 5;
export const TITLE_MAX = 200;
export const URL_MAX = 2048;
export const TEXT_MAX = 10000;
export const MAX_TAGS = 20;
export const TAG_MAX = 50;

export type RecordKind = (typeof RECORD_KINDS)[number];
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export type Invalid = { ok: false; code: string; message: string };
export type Check<T> = { ok: true; value: T } | Invalid;

function invalid(code: string, message: string): Invalid {
  return { ok: false, code, message };
}

export const messages = {
  title: `タイトルは制御文字を含まない 1〜${TITLE_MAX} 文字にしてください`,
  url: `URL は http または https で始まる ${URL_MAX} 文字以内の正しい形式にしてください（ユーザー名とパスワードは含められません）`,
  date: "日付は YYYY-MM-DD の形式で入力してください",
  period: "期間は開始日と終了日を YYYY-MM-DD の形式で両方指定し、開始日は終了日以前にしてください",
  tags: `タグは ${MAX_TAGS} 個まで、それぞれ制御文字と「,」「、」「，」を含まない 1〜${TAG_MAX} 文字にしてください`,
  note: `メモは改行とタブ以外の制御文字を含まない ${TEXT_MAX} 文字以内にしてください`,
  content: `内容は改行とタブ以外の制御文字を含まない ${TEXT_MAX} 文字以内にしてください`,
  kind: "種類は action・review・note のいずれかにしてください",
  status: "状態は planned・done・canceled のいずれかにしてください",
  articles: `記事は同じサイトの登録済みの記事を ${MAX_ARTICLES_PER_RECORD} 件まで指定してください`,
  noItem: "変更する項目を指定してください",
} as const;

export function unknownFieldError(key: string): Invalid {
  return invalid("unknown_field", `未知の項目があります: ${key}`);
}

export function normalizeTitle(value: unknown): Check<string> {
  const title = normalizeDisplayName(value, TITLE_MAX);
  return title === null ? invalid("invalid_title", messages.title) : { ok: true, value: title };
}

// null or blank is "no URL". Otherwise an http or https URL without credentials; the fragment is removed and the
// query is kept. The host is not compared with the site.
export function normalizeArticleUrl(value: unknown): Check<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return invalid("invalid_url", messages.url);
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > URL_MAX) return invalid("invalid_url", messages.url);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return invalid("invalid_url", messages.url);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return invalid("invalid_url", messages.url);
  if (url.username !== "" || url.password !== "") return invalid("invalid_url", messages.url);
  url.hash = "";
  if (url.href.length > URL_MAX) return invalid("invalid_url", messages.url);
  return { ok: true, value: url.href };
}

// null or "" clears the date. Otherwise a YYYY-MM-DD date that exists.
function normalizeDateWith(value: unknown, code: string, message: string): Check<string | null> {
  if (value === null || value === "") return { ok: true, value: null };
  return isValidDate(value) ? { ok: true, value } : invalid(code, message);
}

export function normalizeDate(value: unknown): Check<string | null> {
  return normalizeDateWith(value, "invalid_date", messages.date);
}

export function normalizePeriodEnd(value: unknown): Check<string | null> {
  return normalizeDateWith(value, "invalid_period", messages.period);
}

// Both ends or neither, and start <= end.
export function checkPeriod(start: string | null, end: string | null): Check<{ start: string | null; end: string | null }> {
  if ((start === null) !== (end === null)) return invalid("invalid_period", messages.period);
  if (start !== null && end !== null && start > end) return invalid("invalid_period", messages.period);
  return { ok: true, value: { start, end } };
}

const TAG_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const TAG_SEPARATORS = /[,、，]/;

// One tag: trimmed and NFC normalized, 1 to 50 code points, without control characters or separators. null if invalid.
export function normalizeTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tag = value.trim().normalize("NFC");
  const length = [...tag].length;
  if (length < 1 || length > TAG_MAX || TAG_CONTROL.test(tag) || TAG_SEPARATORS.test(tag)) return null;
  return tag;
}

// An array of tags. Duplicates (case-sensitive) are removed keeping the first; the order is kept. Up to 20 tags.
export function normalizeTags(value: unknown): Check<string[]> {
  if (!Array.isArray(value)) return invalid("invalid_tags", messages.tags);
  const tags: string[] = [];
  for (const item of value) {
    const tag = normalizeTag(item);
    if (tag === null) return invalid("invalid_tags", messages.tags);
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) return invalid("invalid_tags", messages.tags);
  return { ok: true, value: tags };
}

// Control characters other than \n and \t, after the line breaks are normalized.
const TEXT_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

// Free text: \r\n and \r become \n; up to 10,000 code points. Not trimmed.
function normalizeText(value: unknown, code: string, message: string): Check<string> {
  if (typeof value !== "string") return invalid(code, message);
  const text = value.replace(/\r\n?/g, "\n");
  if (TEXT_CONTROL.test(text) || [...text].length > TEXT_MAX) return invalid(code, message);
  return { ok: true, value: text };
}

export function normalizeNote(value: unknown): Check<string> {
  return normalizeText(value, "invalid_note", messages.note);
}

export function normalizeContent(value: unknown): Check<string> {
  return normalizeText(value, "invalid_content", messages.content);
}

export function normalizeKind(value: unknown): Check<RecordKind> {
  return (RECORD_KINDS as readonly unknown[]).includes(value)
    ? { ok: true, value: value as RecordKind }
    : invalid("invalid_kind", messages.kind);
}

export function normalizeStatus(value: unknown): Check<RecordStatus> {
  return (RECORD_STATUSES as readonly unknown[]).includes(value)
    ? { ok: true, value: value as RecordStatus }
    : invalid("invalid_status", messages.status);
}

// Article IDs of a record: well-formed, duplicates removed, up to 5. Whether they exist is checked with the database.
export function normalizeArticleIds(value: unknown): Check<string[]> {
  if (!Array.isArray(value)) return invalid("invalid_articles", messages.articles);
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !ARTICLE_ID_PATTERN.test(item)) return invalid("invalid_articles", messages.articles);
    if (!ids.includes(item)) ids.push(item);
  }
  if (ids.length > MAX_ARTICLES_PER_RECORD) return invalid("invalid_articles", messages.articles);
  return { ok: true, value: ids };
}

function firstUnknown(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) return key;
  return null;
}

export const ARTICLE_FIELDS = ["title", "url", "published_on", "tags", "note"] as const;

export type ArticleInput = {
  title: string;
  url: string | null;
  publishedOn: string | null;
  tags: string[];
  note: string;
};

// The items of an article in body. With required (create), a missing title is invalid and the other missing items
// get their defaults; otherwise (update) only the given items are returned, and at least one is needed.
export function checkArticleBody(body: Record<string, unknown>, required: true): Check<ArticleInput>;
export function checkArticleBody(body: Record<string, unknown>, required: false): Check<Partial<ArticleInput>>;
export function checkArticleBody(body: Record<string, unknown>, required: boolean): Check<Partial<ArticleInput>> {
  const unknown = firstUnknown(body, ARTICLE_FIELDS);
  if (unknown !== null) return unknownFieldError(unknown);
  if (!required && Object.keys(body).length === 0) return invalid("invalid_request", messages.noItem);
  const value: Partial<ArticleInput> = {};
  if (required || "title" in body) {
    const title = normalizeTitle(body.title);
    if (!title.ok) return title;
    value.title = title.value;
  }
  if ("url" in body) {
    const url = normalizeArticleUrl(body.url);
    if (!url.ok) return url;
    value.url = url.value;
  } else if (required) {
    value.url = null;
  }
  if ("published_on" in body) {
    const date = normalizeDate(body.published_on);
    if (!date.ok) return date;
    value.publishedOn = date.value;
  } else if (required) {
    value.publishedOn = null;
  }
  if ("tags" in body) {
    const tags = normalizeTags(body.tags);
    if (!tags.ok) return tags;
    value.tags = tags.value;
  } else if (required) {
    value.tags = [];
  }
  if ("note" in body) {
    const note = normalizeNote(body.note);
    if (!note.ok) return note;
    value.note = note.value;
  } else if (required) {
    value.note = "";
  }
  return { ok: true, value };
}

export const RECORD_FIELDS = [
  "kind",
  "status",
  "title",
  "date",
  "period_start",
  "period_end",
  "tags",
  "content",
  "article_ids",
] as const;

export type RecordInput = {
  kind: RecordKind;
  status: RecordStatus;
  title: string;
  date: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  tags: string[];
  content: string;
  articleIds: string[];
};

// The items of a record in body, as checkArticleBody. With required, kind and title are needed, status defaults to
// done and the period must be both-or-neither with start <= end. Without required, the period is checked against the
// stored record by the caller (checkPeriod), since one end may be given alone.
export function checkRecordBody(body: Record<string, unknown>, required: true): Check<RecordInput>;
export function checkRecordBody(body: Record<string, unknown>, required: false): Check<Partial<RecordInput>>;
export function checkRecordBody(body: Record<string, unknown>, required: boolean): Check<Partial<RecordInput>> {
  const unknown = firstUnknown(body, RECORD_FIELDS);
  if (unknown !== null) return unknownFieldError(unknown);
  if (!required && Object.keys(body).length === 0) return invalid("invalid_request", messages.noItem);
  const value: Partial<RecordInput> = {};
  if (required || "kind" in body) {
    const kind = normalizeKind(body.kind);
    if (!kind.ok) return kind;
    value.kind = kind.value;
  }
  if ("status" in body) {
    const status = normalizeStatus(body.status);
    if (!status.ok) return status;
    value.status = status.value;
  } else if (required) {
    value.status = "done";
  }
  if (required || "title" in body) {
    const title = normalizeTitle(body.title);
    if (!title.ok) return title;
    value.title = title.value;
  }
  if ("date" in body) {
    const date = normalizeDate(body.date);
    if (!date.ok) return date;
    value.date = date.value;
  } else if (required) {
    value.date = null;
  }
  if ("period_start" in body) {
    const start = normalizePeriodEnd(body.period_start);
    if (!start.ok) return start;
    value.periodStart = start.value;
  } else if (required) {
    value.periodStart = null;
  }
  if ("period_end" in body) {
    const end = normalizePeriodEnd(body.period_end);
    if (!end.ok) return end;
    value.periodEnd = end.value;
  } else if (required) {
    value.periodEnd = null;
  }
  if (required) {
    const period = checkPeriod(value.periodStart ?? null, value.periodEnd ?? null);
    if (!period.ok) return period;
  }
  if ("tags" in body) {
    const tags = normalizeTags(body.tags);
    if (!tags.ok) return tags;
    value.tags = tags.value;
  } else if (required) {
    value.tags = [];
  }
  if ("content" in body) {
    const content = normalizeContent(body.content);
    if (!content.ok) return content;
    value.content = content.value;
  } else if (required) {
    value.content = "";
  }
  if ("article_ids" in body) {
    const ids = normalizeArticleIds(body.article_ids);
    if (!ids.ok) return ids;
    value.articleIds = ids.value;
  } else if (required) {
    value.articleIds = [];
  }
  return { ok: true, value };
}

// The filters of a list (query string or tool arguments), checked with the code invalid_query.
export type ListFilterInput = {
  kind?: string | undefined;
  status?: string | undefined;
  tag?: string | undefined;
  article_id?: string | undefined;
  date_from?: string | undefined;
  date_to?: string | undefined;
};

export type RecordFilters = {
  kind?: RecordKind;
  status?: RecordStatus;
  tag?: string;
  articleId?: string;
  dateFrom?: string;
  dateTo?: string;
};

function invalidQuery(name: string): Invalid {
  return invalid("invalid_query", `絞り込みの条件 ${name} が正しくありません`);
}

export function checkTagFilter(value: string | undefined): Check<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  const tag = normalizeTag(value);
  return tag === null ? invalidQuery("tag") : { ok: true, value: tag };
}

export function checkRecordFilters(input: ListFilterInput): Check<RecordFilters> {
  const filters: RecordFilters = {};
  if (input.kind !== undefined) {
    const kind = normalizeKind(input.kind);
    if (!kind.ok) return invalidQuery("kind");
    filters.kind = kind.value;
  }
  if (input.status !== undefined) {
    const status = normalizeStatus(input.status);
    if (!status.ok) return invalidQuery("status");
    filters.status = status.value;
  }
  const tag = checkTagFilter(input.tag);
  if (!tag.ok) return tag;
  if (tag.value !== undefined) filters.tag = tag.value;
  if (input.article_id !== undefined) {
    if (!ARTICLE_ID_PATTERN.test(input.article_id)) return invalidQuery("article_id");
    filters.articleId = input.article_id;
  }
  if (input.date_from !== undefined) {
    if (!isValidDate(input.date_from)) return invalidQuery("date_from");
    filters.dateFrom = input.date_from;
  }
  if (input.date_to !== undefined) {
    if (!isValidDate(input.date_to)) return invalidQuery("date_to");
    filters.dateTo = input.date_to;
  }
  if (filters.dateFrom !== undefined && filters.dateTo !== undefined && filters.dateFrom > filters.dateTo) {
    return invalid("invalid_query", "絞り込みの開始日は終了日以前にしてください");
  }
  return { ok: true, value: filters };
}

const DIGITS = /^[0-9]+$/;

// A number of the query string: digits only, from min to max. undefined gives the default.
export function checkQueryNumber(
  name: string,
  value: string | undefined,
  min: number,
  max: number,
  fallback: number,
): Check<number> {
  if (value === undefined) return { ok: true, value: fallback };
  if (!DIGITS.test(value)) return invalidQuery(name);
  const n = Number(value);
  if (n < min || n > max) return invalidQuery(name);
  return { ok: true, value: n };
}
