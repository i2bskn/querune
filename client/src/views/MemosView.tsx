import { type FormEvent, useState } from "react";
import type { ArticleSummary, MemoList, MemoListQuery, MemoSummary, Site } from "../../../src/api/types";
import { createMemo } from "../actions";
import { formatDateTime } from "../format";
import { PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadMemoPage, loadMemosView, useView } from "../load";
import {
  MAX_ARTICLES_PER_MEMO,
  type MemoFormValues,
  TEXT_MAX,
  TITLE_MAX,
  emptyMemoForm,
  memoRequest,
} from "../records";
import { isValidId, navigate, searchParams } from "../router";
import {
  CREATE_UNKNOWN_MESSAGE,
  SITE_GONE_MESSAGE,
  SiteBreadcrumb,
  TagFilter,
  Tags,
  TagsField,
  handleItemResult,
} from "./ArticlesView";
import { ViewStatus, useDocumentTitle, useFlashNotice, viewTitle } from "./common";

// The filters of the screen, from the query string. A blank tag is ignored.
export function memoFilters(path: string): { tag: string | null } {
  const tag = searchParams(path).get("tag");
  return { tag: tag === null || tag.trim() === "" ? null : tag };
}

function filtersQuery(filters: { tag: string | null }): MemoListQuery {
  const query: MemoListQuery = {};
  if (filters.tag !== null) query.tag = filters.tag;
  return query;
}

// The memos of a site: the list filtered by tag, and the form to add a memo. ?article=<id> opens the form with that
// article of the site chosen.
export function MemosView({ client, siteId, path }: { client: ApiClient; siteId: string; path: string }) {
  const filters = memoFilters(path);
  const query = filtersQuery(filters);
  const [state, reload] = useView(() => loadMemosView(client, siteId, query), `memos:${siteId}:${filters.tag ?? ""}`);
  const [notice, setNotice] = useState<string | null>(null);
  useFlashNotice(setNotice);
  useDocumentTitle(viewTitle(state, (data) => `メモ - ${data.site.name}`));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={SITE_GONE_MESSAGE} onReload={reload} />;
  }
  const { site, memos, tags, articles } = state.data;
  const requested = searchParams(path).get("article");
  const preselected =
    requested !== null && isValidId(requested) && articles.some((article) => article.id === requested) ? requested : null;

  function moveTo(next: { tag: string | null }) {
    const params = new URLSearchParams(filtersQuery(next) as Record<string, string>).toString();
    navigate(`/sites/${site.id}/memos${params === "" ? "" : `?${params}`}`);
  }

  return (
    <main className="main">
      <SiteBreadcrumb site={site} />
      <header className="page-head">
        <h1>メモ</h1>
        <p className="lead">
          サイトについて残しておきたいことを書く場所です。調査、計測の変更、競合の観察、記事のアイデアなど。新しく作成した順に並びます。
        </p>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <CreateMemoForm
        // Keyed by the article, so that a link for another article opens the form again.
        key={preselected ?? ""}
        client={client}
        site={site}
        articles={articles}
        preselected={preselected}
      />
      <div className="filters">
        <TagFilter tags={tags} value={filters.tag} onChange={(tag) => moveTo({ tag })} />
      </div>
      <MemoPages
        client={client}
        siteId={site.id}
        query={query}
        first={memos}
        emptyMessage={filters.tag === null ? "メモはまだ登録されていません。" : "このタグのメモはありません。"}
      />
    </main>
  );
}

// A list of memos with "さらに表示" for the next pages.
export function MemoPages({
  client,
  siteId,
  query,
  first,
  emptyMessage,
}: {
  client: ApiClient;
  siteId: string;
  query: MemoListQuery;
  first: MemoList;
  emptyMessage: string;
}) {
  const [more, setMore] = useState<MemoSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(first.next_offset);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function loadMore(offset: number) {
    setLoading(true);
    setFailure(null);
    const page = await loadMemoPage(client, siteId, { ...query, offset: String(offset) });
    setLoading(false);
    if (page.kind === "ready") {
      setMore((memos) => [...memos, ...page.data.memos]);
      setNextOffset(page.data.next_offset);
    } else if (page.kind === "error") {
      setFailure(page.message);
    } else if (page.kind === "notFound") {
      setFailure(SITE_GONE_MESSAGE);
    }
  }

  const memos = [...first.memos, ...more];
  if (memos.length === 0) return <p className="notice">{emptyMessage}</p>;
  return (
    <>
      <ul className="list">
        {memos.map((memo) => (
          <li key={memo.id}>
            <MemoRow memo={memo} />
          </li>
        ))}
      </ul>
      {nextOffset !== null && (
        <div className="actions">
          <button type="button" onClick={() => void loadMore(nextOffset)} disabled={loading}>
            さらに表示
          </button>
          {failure !== null && <p role="alert">{failure}</p>}
        </div>
      )}
    </>
  );
}

function MemoRow({ memo }: { memo: MemoSummary }) {
  return (
    <Link to={`/memos/${memo.id}`} className="site-link">
      <span className="site-head">
        <span className="site-name">{memo.title}</span>
        <span className="site-url">{formatDateTime(memo.created_at)}</span>
      </span>
      <span className="site-meta">
        {memo.articles.length > 0 && <span>記事: {memo.articles.map((article) => article.title).join("、")}</span>}
        <Tags tags={memo.tags} />
      </span>
    </Link>
  );
}

function CreateMemoForm({
  client,
  site,
  articles,
  preselected,
}: {
  client: ApiClient;
  site: Site;
  articles: ArticleSummary[];
  preselected: string | null;
}) {
  const initial = () => emptyMemoForm(preselected === null ? [] : [preselected]);
  const [open, setOpen] = useState(preselected !== null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState<MemoFormValues>(initial);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await createMemo(client, site.id, memoRequest(values));
    if (result.kind === "notFound") {
      setSending(false);
      setFailure(SITE_GONE_MESSAGE);
      return;
    }
    if (handleItemResult(result, setSending, setFailure, CREATE_UNKNOWN_MESSAGE) && result.kind === "ok") {
      navigate(`/memos/${result.item.id}`);
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
            setValues(initial());
            setFailure(null);
          }}
        >
          <PlusIcon />
          メモを追加
        </button>
      </div>
    );
  }
  return (
    <form className="folder-form" aria-label="メモを追加" onSubmit={(event) => void onSubmit(event)}>
      <MemoFields values={values} onChange={setValues} articles={articles} disabled={sending} />
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

// The fields of a memo, shared by the add and the edit forms. The articles are left out when the site has none.
export function MemoFields({
  values,
  onChange,
  articles,
  disabled,
}: {
  values: MemoFormValues;
  onChange: (values: MemoFormValues) => void;
  // The articles of the site to choose from.
  articles: ArticleSummary[];
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
        本文（省略可。{TEXT_MAX}&nbsp;文字以内）
        <textarea
          value={values.content}
          onChange={(event) => onChange({ ...values, content: event.target.value })}
          rows={12}
          disabled={disabled}
        />
      </label>
      <TagsField
        value={values.tags}
        onChange={(tags) => onChange({ ...values, tags })}
        placeholder="例: 計測, 競合"
        disabled={disabled}
      />
      {articles.length > 0 && (
        <ArticlePicker
          chosen={values.articleIds}
          articles={articles}
          onChange={(articleIds) => onChange({ ...values, articleIds })}
          disabled={disabled}
        />
      )}
    </>
  );
}

// The articles of a memo: a select to add one, and the chosen ones with a button to remove each.
function ArticlePicker({
  chosen,
  articles,
  onChange,
  disabled,
}: {
  chosen: string[];
  articles: ArticleSummary[];
  onChange: (articleIds: string[]) => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState("");
  const titles = new Map(articles.map((article) => [article.id, article.title]));
  const choices = articles.filter((article) => !chosen.includes(article.id));
  const full = chosen.length >= MAX_ARTICLES_PER_MEMO;

  return (
    <fieldset className="picker" disabled={disabled}>
      <legend>関連する記事（省略可。{MAX_ARTICLES_PER_MEMO}&nbsp;件まで）</legend>
      {chosen.length > 0 && (
        <ul className="picker-list">
          {chosen.map((id) => (
            <li key={id}>
              <span>{titles.get(id) ?? "削除された記事"}</span>
              <button type="button" onClick={() => onChange(chosen.filter((other) => other !== id))}>
                外す
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="picker-add">
        <select
          aria-label="追加する記事"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={full || choices.length === 0}
        >
          <option value="">記事を選ぶ</option>
          {choices.map((article) => (
            <option key={article.id} value={article.id}>
              {article.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={full || selected === "" || chosen.includes(selected)}
          onClick={() => {
            onChange([...chosen, selected]);
            setSelected("");
          }}
        >
          追加
        </button>
      </div>
    </fieldset>
  );
}
