import type {
  Article,
  CreateArticleRequest,
  CreateRecordRequest,
  RecordKind,
  RecordStatus,
  SiteRecord,
} from "../../src/api/types";

// The labels and form values of the articles and records. No JSX here, so that the tests can load it in Node.

export const KIND_LABELS: Record<RecordKind, string> = { action: "施策", review: "レビュー", note: "メモ" };
export const STATUS_LABELS: Record<RecordStatus, string> = { planned: "予定", done: "実施済み", canceled: "中止" };
export const RECORD_KINDS: readonly RecordKind[] = ["action", "review", "note"];
export const RECORD_STATUSES: readonly RecordStatus[] = ["planned", "done", "canceled"];

export function isRecordKind(value: string | null): value is RecordKind {
  return value !== null && (RECORD_KINDS as readonly string[]).includes(value);
}

export function isRecordStatus(value: string | null): value is RecordStatus {
  return value !== null && (RECORD_STATUSES as readonly string[]).includes(value);
}

export const TITLE_MAX = 200;
export const TEXT_MAX = 10000;
export const MAX_ARTICLES_PER_RECORD = 5;

// The tags typed in one field: split on the separators, trimmed, without empty parts. The server checks the rest.
export function splitTags(text: string): string[] {
  return text
    .split(/[,、，]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

export function joinTags(tags: string[]): string {
  return tags.join(", ");
}

// The values of the form of an article, as typed.
export type ArticleFormValues = { title: string; url: string; publishedOn: string; tags: string; note: string };

export const EMPTY_ARTICLE_FORM: ArticleFormValues = { title: "", url: "", publishedOn: "", tags: "", note: "" };

export function articleFormValues(article: Article): ArticleFormValues {
  return {
    title: article.title,
    url: article.url ?? "",
    publishedOn: article.published_on ?? "",
    tags: joinTags(article.tags),
    note: article.note,
  };
}

// The request body for the form values: every item is sent; a blank URL or date as null.
export function articleRequest(values: ArticleFormValues): Required<CreateArticleRequest> {
  return {
    title: values.title,
    url: values.url.trim() === "" ? null : values.url,
    published_on: values.publishedOn === "" ? null : values.publishedOn,
    tags: splitTags(values.tags),
    note: values.note,
  };
}

// The values of the form of a record, as typed. articleIds are the chosen articles, in the order chosen.
export type RecordFormValues = {
  kind: RecordKind;
  status: RecordStatus;
  title: string;
  date: string;
  periodStart: string;
  periodEnd: string;
  tags: string;
  content: string;
  articleIds: string[];
};

export function emptyRecordForm(articleIds: string[] = []): RecordFormValues {
  return {
    kind: "action",
    status: "done",
    title: "",
    date: "",
    periodStart: "",
    periodEnd: "",
    tags: "",
    content: "",
    articleIds,
  };
}

export function recordFormValues(record: SiteRecord): RecordFormValues {
  return {
    kind: record.kind,
    status: record.status,
    title: record.title,
    date: record.date ?? "",
    periodStart: record.period_start ?? "",
    periodEnd: record.period_end ?? "",
    tags: joinTags(record.tags),
    content: record.content,
    articleIds: record.articles.map((article) => article.id),
  };
}

// The request body for the form values: every item is sent; blank dates as null.
export function recordRequest(values: RecordFormValues): Required<CreateRecordRequest> {
  return {
    kind: values.kind,
    status: values.status,
    title: values.title,
    date: values.date === "" ? null : values.date,
    period_start: values.periodStart === "" ? null : values.periodStart,
    period_end: values.periodEnd === "" ? null : values.periodEnd,
    tags: splitTags(values.tags),
    content: values.content,
    article_ids: values.articleIds,
  };
}

// The period as text, e.g. "2026-10-01〜2026-10-31", or null without one.
export function periodText(start: string | null, end: string | null): string | null {
  if (start === null || end === null) return null;
  return `${start}〜${end}`;
}
