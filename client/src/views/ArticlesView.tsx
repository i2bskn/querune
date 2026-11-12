import { type FormEvent, useEffect, useState } from "react";
import type { ArticleSummary, Site, TagList } from "../../../src/api/types";
import { type ItemResult, createArticle } from "../actions";
import { PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadArticlesView, useView } from "../load";
import { formatDate, shortUrl } from "../numbers";
import { type ArticleFormValues, EMPTY_ARTICLE_FORM, TEXT_MAX, TITLE_MAX, articleRequest } from "../records";
import { navigate, searchParams } from "../router";
import { setCurrentSite } from "../siteContext";
import { ViewStatus, useDocumentTitle, useFlashNotice, viewTitle } from "./common";
import { SitemapImport } from "./SitemapImport";
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
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  useFlashNotice(setNotice);
  useDocumentTitle(viewTitle(state, (data) => `記事 - ${data.site.name}`));
  useEffect(() => {
    if (state.kind === "ready") setCurrentSite(state.data.site.id);
  }, [state]);

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={SITE_GONE_MESSAGE} onReload={reload} />;
  }
  const { site, articles, tags } = state.data;
  const base = `/sites/${site.id}/articles`;

  return (
    <main className="page">
      <header className="page-head">
        <div className="page-head-text">
          <p className="eyebrow">{site.name}</p>
          <h1>記事</h1>
          <p className="lead">記事の台帳です。サービス紹介などの固定ページも登録できます。サイトマップに新しく載ったページは毎日自動で登録します。URL を登録した記事は開くと検索とセッションの推移を見られます。</p>
        </div>
        {!adding && !importing && (
          <div className="page-head-actions">
            <button type="button" onClick={() => setImporting(true)}>
              サイトマップから取り込む
            </button>
            <button type="button" className="button-primary" onClick={() => setAdding(true)}>
              <PlusIcon />
              記事を追加
            </button>
          </div>
        )}
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {adding && <CreateArticleForm client={client} site={site} onClose={() => setAdding(false)} />}
      {importing ? (
        // The panel takes the place of the list, so that no change of tag reloads the view (and unmounts the panel)
        // while it is open. The list is reloaded after closing if anything was sent.
        <SitemapImport
          client={client}
          site={site}
          onClose={(sent) => {
            setImporting(false);
            if (sent) reload();
          }}
        />
      ) : (
        <>
          <TagFilter
            tags={tags}
            value={tag}
            onChange={(next) =>
              navigate(next === null ? base : `${base}?tag=${encodeURIComponent(next)}`, { keepScroll: true })
            }
          />
          {articles.length === 0 ? (
            <p className="empty-note">
              {tag === null ? "記事はまだ登録されていません。" : "このタグの記事はありません。"}
            </p>
          ) : (
            <ArticleList articles={articles} site={site} />
          )}
        </>
      )}
    </main>
  );
}

// The tags used by the articles as buttons. Choosing the chosen tag again clears it.
export function TagFilter({
  tags,
  value,
  onChange,
}: {
  tags: TagList;
  value: string | null;
  onChange: (tag: string | null) => void;
}) {
  const used = tags.tags.filter((tag) => tag.articles > 0);
  if (used.length === 0 && value === null) return null;
  const names = used.map((tag) => tag.tag);
  if (value !== null && !names.includes(value)) names.unshift(value);
  return (
    <div className="chips chips-scroll" role="group" aria-label="タグで絞り込む">
      <button type="button" className="chip" aria-pressed={value === null} onClick={() => onChange(null)}>
        すべて
      </button>
      {names.map((name) => (
        <button
          key={name}
          type="button"
          className="chip"
          aria-pressed={value === name}
          onClick={() => onChange(value === name ? null : name)}
        >
          {name}
          {used.find((tag) => tag.tag === name) !== undefined && (
            <span className="chip-count">{used.find((tag) => tag.tag === name)?.articles}</span>
          )}
        </button>
      ))}
    </div>
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

function ArticleList({ articles, site }: { articles: ArticleSummary[]; site: Site }) {
  return (
    <ul className="article-list">
      <li className="article-head" aria-hidden="true">
        <span>記事</span>
        <span>公開日</span>
        <span>タグ</span>
      </li>
      {articles.map((article) => (
        <li key={article.id}>
          <Link to={`/articles/${article.id}`} className="article-row">
            <span className="article-main">
              <span className="article-title">{article.title}</span>
              <span className="article-url mono">{article.url === null ? "URL 未設定" : shortUrl(article.url, site.url)}</span>
            </span>
            <span className="article-date">
              {article.published_on === null ? <span className="pill">公開日なし</span> : formatDate(article.published_on)}
            </span>
            <Tags tags={article.tags} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function CreateArticleForm({ client, site, onClose }: { client: ApiClient; site: Site; onClose: () => void }) {
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

  return (
    <form className="panel form editor" aria-label="記事を追加" onSubmit={(event) => void onSubmit(event)}>
      <h2 className="panel-title">記事を追加</h2>
      <ArticleFields values={values} onChange={setValues} disabled={sending} />
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={sending}>
          追加
        </button>
        <button type="button" onClick={onClose} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && (
        <p className="form-error" role="alert">
          {failure}
        </p>
      )}
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
      <label className="field">
        <span className="field-label">タイトル</span>
        <input
          type="text"
          value={values.title}
          onChange={(event) => onChange({ ...values, title: event.target.value })}
          autoComplete="off"
          required
          maxLength={TITLE_MAX}
          disabled={disabled}
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-label">
            URL<span className="optional">任意</span>
          </span>
          <input
            type="url"
            value={values.url}
            onChange={(event) => onChange({ ...values, url: event.target.value })}
            autoComplete="off"
            placeholder="https://example.com/articles/1"
            disabled={disabled}
          />
          <span className="field-hint">Search Console のページと同じ URL にすると実績を表示できます</span>
        </label>
        <label className="field">
          <span className="field-label">
            公開日<span className="optional">任意</span>
          </span>
          <input
            type="date"
            value={values.publishedOn}
            onChange={(event) => onChange({ ...values, publishedOn: event.target.value })}
            disabled={disabled}
          />
        </label>
      </div>
      <label className="field">
        <span className="field-label">
          タグ<span className="optional">任意</span>
        </span>
        <input
          type="text"
          value={values.tags}
          onChange={(event) => onChange({ ...values, tags: event.target.value })}
          autoComplete="off"
          placeholder="例: AI, セキュリティ"
          disabled={disabled}
        />
        <span className="field-hint">カンマか読点で区切ります</span>
      </label>
      <label className="field">
        <span className="field-label">
          備考<span className="optional">任意・{TEXT_MAX.toLocaleString("ja-JP")}&nbsp;文字以内</span>
        </span>
        <textarea
          value={values.note}
          onChange={(event) => onChange({ ...values, note: event.target.value })}
          rows={4}
          disabled={disabled}
        />
      </label>
    </>
  );
}

