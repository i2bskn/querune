import type { Article, CreateArticleRequest, CreateMemoRequest, Memo } from "../../src/api/types";

// The form values of the articles and memos. No JSX here, so that the tests can load it in Node.

export const TITLE_MAX = 200;
export const TEXT_MAX = 10000;
export const MAX_ARTICLES_PER_MEMO = 5;

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

// The values of the form of a memo, as typed. articleIds are the chosen articles, in the order chosen.
export type MemoFormValues = {
  title: string;
  content: string;
  tags: string;
  articleIds: string[];
};

export function emptyMemoForm(articleIds: string[] = []): MemoFormValues {
  return { title: "", content: "", tags: "", articleIds };
}

export function memoFormValues(memo: Memo): MemoFormValues {
  return {
    title: memo.title,
    content: memo.content,
    tags: joinTags(memo.tags),
    articleIds: memo.articles.map((article) => article.id),
  };
}

// The request body for the form values: every item is sent.
export function memoRequest(values: MemoFormValues): Required<CreateMemoRequest> {
  return {
    title: values.title,
    content: values.content,
    tags: splitTags(values.tags),
    article_ids: values.articleIds,
  };
}
