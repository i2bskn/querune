// Validation of the articles and memos, shared by the REST API and the MCP tools so that both inputs behave the
// same. Every normalizer returns the stored value or the error code and message of the item.
import { ARTICLE_ID_PATTERN } from "../ids";
import { normalizeDisplayName } from "../routes/api";
import { isValidDate } from "../sync/dates";

export const MAX_ARTICLES_PER_SITE = 1000;
export const MAX_MEMOS_PER_SITE = 2000;
export const MAX_ARTICLES_PER_MEMO = 5;
export const TITLE_MAX = 200;
export const URL_MAX = 2048;
export const TEXT_MAX = 10000;
export const MAX_TAGS = 20;
export const TAG_MAX = 50;

export type Invalid = { ok: false; code: string; message: string };
export type Check<T> = { ok: true; value: T } | Invalid;

function invalid(code: string, message: string): Invalid {
  return { ok: false, code, message };
}

export const messages = {
  title: `タイトルは制御文字を含まない 1〜${TITLE_MAX} 文字にしてください`,
  url: `URL は http または https で始まる ${URL_MAX} 文字以内の正しい形式にしてください（ユーザー名とパスワードは含められません）`,
  date: "日付は YYYY-MM-DD の形式で入力してください",
  tags: `タグは ${MAX_TAGS} 個まで、それぞれ制御文字と「,」「、」「，」を含まない 1〜${TAG_MAX} 文字にしてください`,
  note: `備考は改行とタブ以外の制御文字を含まない ${TEXT_MAX} 文字以内にしてください`,
  content: `本文は改行とタブ以外の制御文字を含まない ${TEXT_MAX} 文字以内にしてください`,
  articles: `記事は同じサイトの登録済みの記事を ${MAX_ARTICLES_PER_MEMO} 件まで指定してください`,
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

// Article IDs of a memo: well-formed, duplicates removed, up to 5. Whether they exist is checked with the database.
export function normalizeArticleIds(value: unknown): Check<string[]> {
  if (!Array.isArray(value)) return invalid("invalid_articles", messages.articles);
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !ARTICLE_ID_PATTERN.test(item)) return invalid("invalid_articles", messages.articles);
    if (!ids.includes(item)) ids.push(item);
  }
  if (ids.length > MAX_ARTICLES_PER_MEMO) return invalid("invalid_articles", messages.articles);
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

export const MEMO_FIELDS = ["title", "content", "tags", "article_ids"] as const;

export type MemoInput = {
  title: string;
  content: string;
  tags: string[];
  articleIds: string[];
};

// The items of a memo in body, as checkArticleBody: with required, title is needed and the other missing items get
// their defaults.
export function checkMemoBody(body: Record<string, unknown>, required: true): Check<MemoInput>;
export function checkMemoBody(body: Record<string, unknown>, required: false): Check<Partial<MemoInput>>;
export function checkMemoBody(body: Record<string, unknown>, required: boolean): Check<Partial<MemoInput>> {
  const unknown = firstUnknown(body, MEMO_FIELDS);
  if (unknown !== null) return unknownFieldError(unknown);
  if (!required && Object.keys(body).length === 0) return invalid("invalid_request", messages.noItem);
  const value: Partial<MemoInput> = {};
  if (required || "title" in body) {
    const title = normalizeTitle(body.title);
    if (!title.ok) return title;
    value.title = title.value;
  }
  if ("content" in body) {
    const content = normalizeContent(body.content);
    if (!content.ok) return content;
    value.content = content.value;
  } else if (required) {
    value.content = "";
  }
  if ("tags" in body) {
    const tags = normalizeTags(body.tags);
    if (!tags.ok) return tags;
    value.tags = tags.value;
  } else if (required) {
    value.tags = [];
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

// The filters of the list of memos (query string or tool arguments), checked with the code invalid_query.
export type MemoFilterInput = {
  tag?: string | undefined;
  article_id?: string | undefined;
  created_after?: string | undefined;
  created_before?: string | undefined;
};

// Times are UNIX time in milliseconds: createdAfter is included, createdBefore is not.
export type MemoFilters = {
  tag?: string;
  articleId?: string;
  createdAfter?: number;
  createdBefore?: number;
};

function invalidQuery(name: string): Invalid {
  return invalid("invalid_query", `絞り込みの条件 ${name} が正しくありません`);
}

export function checkTagFilter(value: string | undefined): Check<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  const tag = normalizeTag(value);
  return tag === null ? invalidQuery("tag") : { ok: true, value: tag };
}

// An RFC 3339 date-time with an offset: YYYY-MM-DDTHH:MM, optional :SS with optional fractional seconds (1 to 3
// digits), then Z or ±HH:MM. Uppercase T and Z only.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// The UNIX time in milliseconds of an RFC 3339 date-time with an offset, or null. Date.parse decides the rest: V8
// rolls over values such as 2026-02-30 or T24:00, and they are accepted.
export function parseDateTime(value: string): number | null {
  if (!DATE_TIME.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export function checkMemoFilters(input: MemoFilterInput): Check<MemoFilters> {
  const filters: MemoFilters = {};
  const tag = checkTagFilter(input.tag);
  if (!tag.ok) return tag;
  if (tag.value !== undefined) filters.tag = tag.value;
  if (input.article_id !== undefined) {
    if (!ARTICLE_ID_PATTERN.test(input.article_id)) return invalidQuery("article_id");
    filters.articleId = input.article_id;
  }
  if (input.created_after !== undefined) {
    const time = parseDateTime(input.created_after);
    if (time === null) return invalidQuery("created_after");
    filters.createdAfter = time;
  }
  if (input.created_before !== undefined) {
    const time = parseDateTime(input.created_before);
    if (time === null) return invalidQuery("created_before");
    filters.createdBefore = time;
  }
  if (
    filters.createdAfter !== undefined &&
    filters.createdBefore !== undefined &&
    filters.createdAfter >= filters.createdBefore
  ) {
    return invalid("invalid_query", "絞り込みの開始時刻は終了時刻より前にしてください");
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
