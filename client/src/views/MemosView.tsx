import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ArticleSummary, MemoList, MemoListQuery, Site, TagList } from "../../../src/api/types";
import { createMemo } from "../actions";
import { ArticleIcon, CloseIcon, PlusIcon, SearchIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadMemoPage, loadMemosView, useView } from "../load";
import { MarkdownBody, excerptText } from "../markdown";
import { formatShortDate, localDate } from "../numbers";
import { MAX_ARTICLES_PER_MEMO, type MemoFormValues, TEXT_MAX, TITLE_MAX, emptyMemoForm, memoRequest } from "../records";
import { isValidId, navigate, searchParams } from "../router";
import { setCurrentSite } from "../siteContext";
import { CREATE_UNKNOWN_MESSAGE, SITE_GONE_MESSAGE, handleItemResult } from "./ArticlesView";
import { ViewStatus, useDocumentTitle, useFlashNotice, viewTitle } from "./common";

export type MemoFilters = { q: string | null; tag: string | null };

// The filters of the screen, from the query string. Blank values are ignored.
export function memoFilters(path: string): MemoFilters {
  const params = searchParams(path);
  const clean = (value: string | null) => (value === null || value.trim() === "" ? null : value.trim());
  return { q: clean(params.get("q")), tag: clean(params.get("tag")) };
}

function filtersQuery(filters: MemoFilters): MemoListQuery {
  const query: MemoListQuery = {};
  if (filters.q !== null) query.q = filters.q;
  if (filters.tag !== null) query.tag = filters.tag;
  return query;
}

type MemoItem = MemoList["memos"][number];

// The memos of a site: search, tags, and the list by month. ?new=1 opens the editor; ?article=<id> opens it with
// that article of the site chosen.
export function MemosView({ client, siteId, path }: { client: ApiClient; siteId: string; path: string }) {
  const filters = memoFilters(path);
  const query = filtersQuery(filters);
  const [state, reload] = useView(
    () => loadMemosView(client, siteId, query),
    `memos:${siteId}:${filters.q ?? ""}:${filters.tag ?? ""}`,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const params = searchParams(path);
  const [composing, setComposing] = useState(params.get("new") === "1" || params.get("article") !== null);
  useFlashNotice(setNotice);
  useDocumentTitle(viewTitle(state, (data) => `メモ - ${data.site.name}`));
  useEffect(() => {
    if (state.kind === "ready") setCurrentSite(state.data.site.id);
  }, [state]);

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={SITE_GONE_MESSAGE} onReload={reload} />;
  }
  const { site, memos, tags, articles } = state.data;
  const requested = params.get("article");
  const preselected =
    requested !== null && isValidId(requested) && articles.some((article) => article.id === requested) ? requested : null;

  function moveTo(next: MemoFilters) {
    const search = new URLSearchParams(filtersQuery(next) as Record<string, string>).toString();
    navigate(`/sites/${site.id}/memos${search === "" ? "" : `?${search}`}`, { keepScroll: true });
  }

  const filtered = filters.q !== null || filters.tag !== null;

  return (
    <main className="page">
      <header className="page-head">
        <div className="page-head-text">
          <p className="eyebrow">{site.name}</p>
          <h1>メモ</h1>
          <p className="lead">調査・計測の変更・競合の観察・記事のアイデアなど。書いた日が実績のグラフに<span className="nowrap"> ◆ で並びます。</span></p>
        </div>
        {!composing && (
          <button type="button" className="button-primary" onClick={() => setComposing(true)}>
            <PlusIcon />
            メモを書く
          </button>
        )}
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {composing && (
        <Composer
          key={preselected ?? ""}
          client={client}
          site={site}
          articles={articles}
          preselected={preselected}
          onClose={() => setComposing(false)}
        />
      )}
      <div className="memo-tools">
        <SearchForm value={filters.q} onSearch={(q) => moveTo({ ...filters, q })} />
        <TagChips tags={tags} value={filters.tag} onChange={(tag) => moveTo({ ...filters, tag })} />
      </div>
      {filtered && (
        <p className="result-line" role="status">
          {filters.q !== null && <>「{filters.q}」</>}
          {filters.tag !== null && <>タグ「{filters.tag}」</>}
          のメモ {memos.memos.length}
          {memos.next_offset !== null ? "+" : ""} 件
          <button type="button" className="link-button" onClick={() => moveTo({ q: null, tag: null })}>
            絞り込みを解除
          </button>
        </p>
      )}
      <MemoPages
        client={client}
        siteId={site.id}
        query={query}
        first={memos}
        highlight={filters.q}
        emptyMessage={filtered ? "条件に合うメモはありません。" : "メモはまだありません。右上の「メモを書く」から始めましょう。"}
      />
    </main>
  );
}

function SearchForm({ value, onSearch }: { value: string | null; onSearch: (q: string | null) => void }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  return (
    <form
      className="search"
      role="search"
      aria-label="メモを検索"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(text.trim() === "" ? null : text.trim());
      }}
    >
      <SearchIcon />
      <input
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="タイトルと本文から探す"
        aria-label="検索する言葉"
        maxLength={100}
        enterKeyHint="search"
      />
      {text !== "" && (
        <button
          type="button"
          className="icon-button search-clear"
          aria-label="検索を消す"
          onClick={() => {
            setText("");
            if (value !== null) onSearch(null);
          }}
        >
          <CloseIcon />
        </button>
      )}
      <button type="submit" className="button-secondary search-submit">
        検索
      </button>
    </form>
  );
}

// The tags used by the memos, the most used first. Choosing the chosen tag again clears it.
function TagChips({ tags, value, onChange }: { tags: TagList; value: string | null; onChange: (tag: string | null) => void }) {
  const used = tags.tags.filter((tag) => tag.memos > 0);
  if (used.length === 0 && value === null) return null;
  const names = used.map((tag) => tag.tag);
  if (value !== null && !names.includes(value)) names.unshift(value);
  return (
    <div className="chips chips-scroll" role="group" aria-label="タグで絞り込む">
      <button type="button" className="chip" aria-pressed={value === null} onClick={() => onChange(null)}>
        すべて
      </button>
      {names.map((name) => {
        const count = used.find((tag) => tag.tag === name)?.memos;
        return (
          <button
            key={name}
            type="button"
            className="chip"
            aria-pressed={value === name}
            onClick={() => onChange(value === name ? null : name)}
          >
            {name}
            {count !== undefined && <span className="chip-count">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// The words of the search shown marked in a text.
function Highlight({ text, words }: { text: string; words: string | null }) {
  if (words === null || words === "") return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = words.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

// An excerpt of the preview around the first match, so that the reason for a search hit is visible.
function excerptOf(preview: string, words: string | null): string {
  const text = excerptText(preview);
  if (words === null) return text;
  const at = text.toLowerCase().indexOf(words.toLowerCase());
  return at > 40 ? `…${text.slice(at - 30)}` : text;
}

function monthOf(ms: number): string {
  const date = localDate(ms);
  return `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月`;
}

// The memos by month with "さらに表示" for the next pages.
export function MemoPages({
  client,
  siteId,
  query,
  first,
  emptyMessage,
  highlight = null,
  compact = false,
}: {
  client: ApiClient;
  siteId: string;
  query: MemoListQuery;
  first: MemoList;
  emptyMessage: string;
  highlight?: string | null;
  compact?: boolean;
}) {
  const [more, setMore] = useState<MemoItem[]>([]);
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
  if (memos.length === 0) return <p className="empty-note">{emptyMessage}</p>;
  const groups: { month: string; memos: MemoItem[] }[] = [];
  for (const memo of memos) {
    const month = monthOf(memo.created_at);
    const last = groups[groups.length - 1];
    if (last?.month === month) last.memos.push(memo);
    else groups.push({ month, memos: [memo] });
  }
  return (
    <div className={compact ? "memo-list memo-list-compact" : "memo-list"}>
      {groups.map((group) => (
        <section key={group.month} className="memo-month" aria-label={group.month}>
          {!compact && <h2 className="memo-month-title">{group.month}</h2>}
          <ol className="memo-items">
            {group.memos.map((memo) => (
              <li key={memo.id}>
                <Link to={`/memos/${memo.id}`} className="memo-item">
                  <time className="memo-date" dateTime={new Date(memo.created_at).toISOString()}>
                    {formatShortDate(localDate(memo.created_at))}
                  </time>
                  <span className="memo-main">
                    <span className="memo-title">
                      <Highlight text={memo.title} words={highlight} />
                    </span>
                    {memo.content_preview !== "" && (
                      <span className="memo-excerpt">
                        <Highlight text={excerptOf(memo.content_preview, highlight)} words={highlight} />
                      </span>
                    )}
                    {(memo.tags.length > 0 || memo.articles.length > 0) && (
                      <span className="memo-meta">
                        {memo.tags.map((tag) => (
                          <span key={tag} className="tag">
                            {tag}
                          </span>
                        ))}
                        {memo.articles.map((article) => (
                          <span key={article.id} className="memo-article">
                            <ArticleIcon />
                            <span className="sr-only">記事: </span>
                            <span className="memo-article-title">{article.title}</span>
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {nextOffset !== null && (
        <div className="actions">
          <button type="button" onClick={() => void loadMore(nextOffset)} disabled={loading}>
            さらに表示
          </button>
          {failure !== null && <p role="alert">{failure}</p>}
        </div>
      )}
    </div>
  );
}

function Composer({
  client,
  site,
  articles,
  preselected,
  onClose,
}: {
  client: ApiClient;
  site: Site;
  articles: ArticleSummary[];
  preselected: string | null;
  onClose: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState<MemoFormValues>(() => emptyMemoForm(preselected === null ? [] : [preselected]));
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

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

  return (
    <form className="panel editor" aria-label="メモを書く" onSubmit={(event) => void onSubmit(event)}>
      <MemoFields values={values} onChange={setValues} articles={articles} disabled={sending} titleRef={titleRef} />
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={sending}>
          保存
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

// The fields of a memo, shared by the new and the edit forms: the title, the body in Markdown with a preview, the
// tags and the articles (left out when the site has none).
export function MemoFields({
  values,
  onChange,
  articles,
  disabled,
  titleRef,
}: {
  values: MemoFormValues;
  onChange: (values: MemoFormValues) => void;
  articles: ArticleSummary[];
  disabled: boolean;
  titleRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <>
      <label className="field">
        <span className="sr-only">タイトル（{TITLE_MAX}&nbsp;文字以内）</span>
        <input
          ref={titleRef}
          type="text"
          className="title-input"
          value={values.title}
          onChange={(event) => onChange({ ...values, title: event.target.value })}
          autoComplete="off"
          required
          maxLength={TITLE_MAX}
          placeholder="タイトル"
          disabled={disabled}
        />
      </label>
      <MarkdownField value={values.content} onChange={(content) => onChange({ ...values, content })} disabled={disabled} />
      <div className="field-row">
        <label className="field">
          <span className="field-label">
            タグ<span className="optional">任意</span>
          </span>
          <input
            type="text"
            value={values.tags}
            onChange={(event) => onChange({ ...values, tags: event.target.value })}
            autoComplete="off"
            placeholder="例: 計測, 競合"
            disabled={disabled}
          />
          <span className="field-hint">カンマか読点で区切ります</span>
        </label>
        {articles.length > 0 && (
          <ArticlePicker
            chosen={values.articleIds}
            articles={articles}
            onChange={(articleIds) => onChange({ ...values, articleIds })}
            disabled={disabled}
          />
        )}
      </div>
    </>
  );
}

// The body: a textarea for Markdown and a preview of it.
export function MarkdownField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const id = useId();
  const length = [...value].length;
  return (
    <div className="md-field">
      <div className="md-tabs" role="tablist" aria-label="本文">
        <button
          type="button"
          role="tab"
          id={`${id}-write`}
          aria-selected={mode === "write"}
          aria-controls={`${id}-panel`}
          onClick={() => setMode("write")}
        >
          書く
        </button>
        <button
          type="button"
          role="tab"
          id={`${id}-preview`}
          aria-selected={mode === "preview"}
          aria-controls={`${id}-panel`}
          onClick={() => setMode("preview")}
        >
          プレビュー
        </button>
        <span className={length > TEXT_MAX ? "md-count md-count-over" : "md-count"}>
          {length.toLocaleString("ja-JP")} / {TEXT_MAX.toLocaleString("ja-JP")}
        </span>
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${mode}`}>
        {mode === "write" ? (
          <textarea
            className="md-input"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            rows={12}
            placeholder={"本文（Markdown が使えます）\n\n## 見出し\n- 箇条書き\n**強調** [リンク](https://example.com) `コード`"}
            aria-label="本文（Markdown）"
            disabled={disabled}
          />
        ) : value.trim() === "" ? (
          <p className="md-empty">プレビューする本文がありません。</p>
        ) : (
          <div className="md-preview">
            <MarkdownBody source={value} />
          </div>
        )}
      </div>
    </div>
  );
}

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
  const titles = new Map(articles.map((article) => [article.id, article.title]));
  const choices = articles.filter((article) => !chosen.includes(article.id));
  const full = chosen.length >= MAX_ARTICLES_PER_MEMO;

  return (
    <fieldset className="field picker" disabled={disabled}>
      <legend className="field-label">
        関連する記事<span className="optional">任意・{MAX_ARTICLES_PER_MEMO}&nbsp;件まで</span>
      </legend>
      <select
        aria-label="関連する記事を追加"
        value=""
        onChange={(event) => {
          if (event.target.value !== "") onChange([...chosen, event.target.value]);
        }}
        disabled={full || choices.length === 0}
      >
        <option value="">{full ? "上限に達しました" : "記事を選んで追加"}</option>
        {choices.map((article) => (
          <option key={article.id} value={article.id}>
            {article.title}
          </option>
        ))}
      </select>
      {chosen.length > 0 && (
        <ul className="picker-list">
          {chosen.map((id) => (
            <li key={id}>
              <span>{titles.get(id) ?? "削除された記事"}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={`${titles.get(id) ?? "記事"} を外す`}
                onClick={() => onChange(chosen.filter((other) => other !== id))}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
