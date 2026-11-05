import { type FormEvent, useState } from "react";
import type { Article, ArticleSummary, Site, TagList } from "../../../src/api/types";
import { type ItemResult, createArticle } from "../actions";
import { PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadArticlesView, useView } from "../load";
import {
  type ArticleFormValues,
  EMPTY_ARTICLE_FORM,
  TEXT_MAX,
  TITLE_MAX,
  articleRequest,
} from "../records";
import { navigate, searchParams } from "../router";
import { ViewStatus, useDocumentTitle, useFlashNotice, viewTitle } from "./common";
import { UNKNOWN_RESULT_MESSAGE } from "./SitesView";

// A create request that got no response may have been saved, so the list is checked before sending it again.
export const CREATE_UNKNOWN_MESSAGE =
  "サーバーに接続できませんでした。登録されたかどうかを一覧で確かめてから、もう一度送信してください";
export const SITE_GONE_MESSAGE = "サイトが見つかりません。削除された可能性があります";

// The article ledger of a site: the list filtered by a tag (?tag=), and the form to add an article.
export function ArticlesView({ client, siteId, path }: { client: ApiClient; siteId: string; path: string }) {
  const tag = searchParams(path).get("tag");
  const [state, reload] = useView(() => loadArticlesView(client, siteId, tag), `articles:${siteId}:${tag ?? ""}`);
  const [notice, setNotice] = useState<string | null>(null);
  useFlashNotice(setNotice);
  useDocumentTitle(viewTitle(state, (data) => `記事 - ${data.site.name}`));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={SITE_GONE_MESSAGE} onReload={reload} />;
  }
  const { site, articles, tags } = state.data;
  const base = `/sites/${site.id}/articles`;

  return (
    <main className="main">
      <SiteBreadcrumb site={site} />
      <header className="page-head">
        <h1>記事</h1>
        <p className="lead">記事の台帳です。公開日のない記事が先、続いて公開日の新しい順に並びます。</p>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <CreateArticleForm client={client} site={site} />
      <TagFilter
        tags={tags}
        value={tag}
        onChange={(next) => navigate(next === null ? base : `${base}?tag=${encodeURIComponent(next)}`)}
      />
      {articles.length === 0 ? (
        <p className="notice">{tag === null ? "記事はまだ登録されていません。" : "このタグの記事はありません。"}</p>
      ) : (
        <ArticleList articles={articles} />
      )}
    </main>
  );
}

// サイト › <site name>, the start of the breadcrumbs of the screens of a site.
export function SiteBreadcrumb({ site, section }: { site: Site; section?: "articles" | "records" }) {
  return (
    <p className="breadcrumb">
      <Link to="/sites">サイト</Link> › <Link to={`/sites/${site.id}`}>{site.name}</Link>
      {section === "articles" && (
        <>
          {" "}
          › <Link to={`/sites/${site.id}/articles`}>記事</Link>
        </>
      )}
      {section === "records" && (
        <>
          {" "}
          › <Link to={`/sites/${site.id}/records`}>記録</Link>
        </>
      )}
    </p>
  );
}

// A select of the tags of the site. null is every tag. A value missing from the tags is kept as an option.
export function TagFilter({
  tags,
  value,
  onChange,
}: {
  tags: TagList;
  value: string | null;
  onChange: (tag: string | null) => void;
}) {
  const names = tags.tags.map((tag) => tag.tag);
  if (value !== null && !names.includes(value)) names.unshift(value);
  return (
    <label className="filter">
      タグ
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}>
        <option value="">すべて</option>
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="tags">
      {tags.map((tag) => (
        <span key={tag} className="tag">
          {tag}
        </span>
      ))}
    </span>
  );
}

function ArticleList({ articles }: { articles: ArticleSummary[] }) {
  return (
    <ul className="list">
      {articles.map((article) => (
        <li key={article.id}>
          <Link to={`/articles/${article.id}`} className="site-link">
            <span className="site-head">
              <span className="site-name">{article.title}</span>
              {article.url !== null && <span className="site-url">{article.url}</span>}
            </span>
            <span className="site-meta">
              <span>公開日: {article.published_on ?? "未設定"}</span>
              <Tags tags={article.tags} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function CreateArticleForm({ client, site }: { client: ApiClient; site: Site }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState<ArticleFormValues>(EMPTY_ARTICLE_FORM);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await createArticle(client, site.id, articleRequest(values));
    if (result.kind === "notFound") {
      setSending(false);
      setFailure(SITE_GONE_MESSAGE);
      return;
    }
    if (handleItemResult(result, setSending, setFailure, CREATE_UNKNOWN_MESSAGE) && result.kind === "ok") {
      navigate(`/articles/${result.item.id}`);
    }
  }

  if (!open) {
    return (
      <div className="actions">
        <button
          type="button"
          className="button-primary"
          onClick={() => {
            setOpen(true);
            setValues(EMPTY_ARTICLE_FORM);
            setFailure(null);
          }}
        >
          <PlusIcon />
          記事を追加
        </button>
      </div>
    );
  }
  return (
    <form className="folder-form" aria-label="記事を追加" onSubmit={(event) => void onSubmit(event)}>
      <ArticleFields values={values} onChange={setValues} disabled={sending} />
      <div className="folder-form-actions">
        <button type="submit" disabled={sending}>
          追加
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

// Settles the state of a form after a request. True when it succeeded; notFound is left to the caller.
export function handleItemResult<T>(
  result: ItemResult<T>,
  setSending: (sending: boolean) => void,
  setFailure: (failure: string | null) => void,
  unknownMessage: string = UNKNOWN_RESULT_MESSAGE,
): boolean {
  switch (result.kind) {
    case "ok":
      setSending(false);
      return true;
    case "notFound":
      setSending(false);
      return false;
    case "error":
      setSending(false);
      setFailure(result.message);
      return false;
    case "unknown":
      setSending(false);
      setFailure(unknownMessage);
      return false;
    case "redirecting":
      // The move to the login page has started; the buttons stay disabled.
      return false;
  }
}

// The fields of an article, shared by the add and the edit forms.
export function ArticleFields({
  values,
  onChange,
  disabled,
}: {
  values: ArticleFormValues;
  onChange: (values: ArticleFormValues) => void;
  disabled: boolean;
}) {
  return (
    <>
      <label>
        タイトル（{TITLE_MAX}&nbsp;文字以内）
        <input
          type="text"
          value={values.title}
          onChange={(event) => onChange({ ...values, title: event.target.value })}
          autoComplete="off"
          required
          disabled={disabled}
        />
      </label>
      <label>
        URL（省略可。# 以降は保存されません）
        <input
          type="url"
          value={values.url}
          onChange={(event) => onChange({ ...values, url: event.target.value })}
          autoComplete="off"
          placeholder="https://example.com/articles/1"
          disabled={disabled}
        />
      </label>
      <label>
        公開日（省略可）
        <input
          type="date"
          value={values.publishedOn}
          onChange={(event) => onChange({ ...values, publishedOn: event.target.value })}
          disabled={disabled}
        />
      </label>
      <TagsField value={values.tags} onChange={(tags) => onChange({ ...values, tags })} disabled={disabled} />
      <label>
        メモ（省略可。{TEXT_MAX}&nbsp;文字以内）
        <textarea
          value={values.note}
          onChange={(event) => onChange({ ...values, note: event.target.value })}
          rows={5}
          disabled={disabled}
        />
      </label>
    </>
  );
}

export function TagsField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label>
      タグ（省略可。カンマか読点で区切ります）
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        placeholder="stage:draft, topic:ai"
        disabled={disabled}
      />
    </label>
  );
}

// The article as plain text details: URL, publish date, tags, note and times.
export function ArticleDetails({ article }: { article: Article }) {
  return (
    <dl className="details">
      <dt>URL</dt>
      <dd>
        {article.url === null ? (
          "未設定"
        ) : (
          <a href={article.url} target="_blank" rel="noopener noreferrer" className="site-url">
            {article.url}
          </a>
        )}
      </dd>
      <dt>公開日</dt>
      <dd>{article.published_on ?? "未設定"}</dd>
      <dt>タグ</dt>
      <dd>{article.tags.length === 0 ? "なし" : <Tags tags={article.tags} />}</dd>
      <dt>メモ</dt>
      <dd>{article.note === "" ? "なし" : <span className="text-body">{article.note}</span>}</dd>
    </dl>
  );
}
