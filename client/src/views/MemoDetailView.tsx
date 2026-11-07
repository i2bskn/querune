import { type FormEvent, useEffect, useState } from "react";
import type { ArticleSummary, Memo, Site } from "../../../src/api/types";
import { deleteMemo, updateMemo } from "../actions";
import { setFlash } from "../flash";
import { formatDateTime } from "../format";
import { ArrowLeftIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadInsightsAround, loadMemoDetail, useView } from "../load";
import { addDays, changeOf, formatCount, formatShortDate, localDate } from "../numbers";
import { TrendChart } from "./charts";
import { Delta } from "./metrics";
import { MarkdownBody } from "../markdown";
import { memoFormValues, memoRequest } from "../records";
import { navigate } from "../router";
import { setCurrentSite } from "../siteContext";
import { handleItemResult } from "./ArticlesView";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { MemoFields } from "./MemosView";
import { UNKNOWN_RESULT_MESSAGE } from "./SitesView";

const GONE_MESSAGE = "メモが見つかりません。削除された可能性があります";

// One memo: the body as Markdown, the tags and articles beside it, the edit form and the deletion.
export function MemoDetailView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadMemoDetail(client, id), `memo:${id}`);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  useDocumentTitle(viewTitle(state, (data) => data.memo.title));
  useEffect(() => {
    if (state.kind === "ready") setCurrentSite(state.data.site.id);
  }, [state]);

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={GONE_MESSAGE} onReload={reload} />;
  }
  const { memo, site, articles } = state.data;

  return (
    <main className="page">
      <p className="back">
        <Link to={`/sites/${site.id}/memos`}>
          <ArrowLeftIcon />
          メモの一覧
        </Link>
      </p>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {editing ? (
        <EditMemoForm
          key={memo.updated_at}
          client={client}
          memo={memo}
          articles={articles}
          onCancel={() => setEditing(false)}
          onUpdated={() => {
            setEditing(false);
            setNotice("メモを更新しました");
            reload();
          }}
          onGone={reload}
        />
      ) : (
        <>
          <header className="page-head memo-head">
            <div className="page-head-text">
              <p className="eyebrow memo-eyebrow">
                <time dateTime={new Date(memo.created_at).toISOString()}>{formatDateTime(memo.created_at)}</time>
              </p>
              <h1>{memo.title}</h1>
            </div>
            <div className="memo-actions">
              <button type="button" className="button-primary" onClick={() => setEditing(true)}>
                編集
              </button>
              <DeleteMemo client={client} memo={memo} onGone={reload} />
            </div>
          </header>
          <div className="memo-layout">
            <article className="memo-doc">
              {memo.content.trim() === "" ? <p className="hint">本文はありません。</p> : <MarkdownBody source={memo.content} />}
              {(site.gsc_property !== null || site.ga4_property_id !== null) && (
                <MemoContext client={client} memo={memo} site={site} />
              )}
            </article>
            <aside className="memo-aside" aria-label="メモの情報">
              <dl className="facts">
                <div>
                  <dt>タグ</dt>
                  <dd>
                    {memo.tags.length === 0 ? (
                      <span className="hint">なし</span>
                    ) : (
                      <span className="tags">
                        {memo.tags.map((tag) => (
                          <Link key={tag} to={`/sites/${site.id}/memos?tag=${encodeURIComponent(tag)}`} className="tag">
                            {tag}
                          </Link>
                        ))}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>関連する記事</dt>
                  <dd>
                    {memo.articles.length === 0 ? (
                      <span className="hint">なし</span>
                    ) : (
                      <ul className="plain-list">
                        {memo.articles.map((article) => (
                          <li key={article.id}>
                            <Link to={`/articles/${article.id}`}>{article.title}</Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>更新</dt>
                  <dd>
                    <time dateTime={new Date(memo.updated_at).toISOString()} className="nowrap">
                      {formatDateTime(memo.updated_at)}
                    </time>
                  </dd>
                </div>
              </dl>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}

const AROUND_DAYS = 14;

// The figures around the day of the memo: 14 days before and after it, with the memos of those days marked, and the
// daily average before against after. Answers "did it change after this?" without leaving the memo.
function MemoContext({ client, memo, site }: { client: ApiClient; memo: Memo; site: Site }) {
  const day = localDate(memo.created_at);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const wanted = addDays(day, AROUND_DAYS - 1);
  const end = wanted < yesterday ? wanted : yesterday;
  const [state] = useView(
    () => loadInsightsAround(client, site.id, end, AROUND_DAYS * 2),
    `memo-around:${site.id}:${end}`,
  );
  if (state.kind !== "ready") return null;
  const insights = state.data;
  const useSearch = insights.search !== null;
  const daily = useSearch
    ? (insights.search?.daily ?? []).map((d) => ({ date: d.date, value: d.clicks }))
    : (insights.sessions?.daily ?? []).map((d) => ({ date: d.date, value: d.sessions }));
  const current = daily.slice(daily.length - insights.period.days);
  if (current.every((d) => d.value === null)) return null;
  const average = (list: typeof current) => {
    const values = list.map((d) => d.value).filter((v): v is number => v !== null);
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  };
  const before = average(current.filter((d) => d.date < day));
  const after = average(current.filter((d) => d.date >= day));
  const label = useSearch ? "クリック" : "セッション";
  return (
    <section className="memo-context" aria-labelledby="memo-context">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="memo-context">
            このメモの前後の{label}
          </h2>
          <p className="panel-caption">
            {formatShortDate(insights.period.start)}〜{formatShortDate(insights.period.end)}・大きい ◆ がこのメモ
          </p>
        </div>
        <p className="around">
          <span>
            前の {AROUND_DAYS} 日の 1 日平均{" "}
            <strong>{before === null ? "—" : formatCount(Math.round(before * 10) / 10)}</strong>
          </span>
          <span aria-hidden="true">→</span>
          <span>
            メモ以降 <strong>{after === null ? "—" : formatCount(Math.round(after * 10) / 10)}</strong>
          </span>
          <Delta change={changeOf(after, before)} label="メモの前から" />
        </p>
      </div>
      <TrendChart
        label={label}
        dates={current.map((d) => d.date)}
        values={current.map((d) => d.value)}
        previous={null}
        previousDates={null}
        format={formatCount}
        tone={useSearch ? "search" : "sessions"}
        memos={insights.memos}
        highlight={memo.id}
        height={200}
      />
      <p className="hint">
        <Link to={`/sites/${site.id}`}>実績を開く</Link>
      </p>
    </section>
  );
}

function EditMemoForm({
  client,
  memo,
  articles,
  onCancel,
  onUpdated,
  onGone,
}: {
  client: ApiClient;
  memo: Memo;
  articles: ArticleSummary[];
  onCancel: () => void;
  onUpdated: () => void;
  onGone: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState(() => memoFormValues(memo));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await updateMemo(client, memo.id, memoRequest(values));
    if (handleItemResult(result, setSending, setFailure)) onUpdated();
    else if (result.kind === "notFound") onGone();
  }

  return (
    <form className="panel editor" aria-label="メモの編集" onSubmit={(event) => void onSubmit(event)}>
      <MemoFields values={values} onChange={setValues} articles={articles} disabled={sending} />
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={sending}>
          保存
        </button>
        <button type="button" onClick={onCancel} disabled={sending}>
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

// The deletion, confirmed with a second button.
function DeleteMemo({ client, memo, onGone }: { client: ApiClient; memo: Memo; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onDelete() {
    setSending(true);
    setFailure(null);
    const result = await deleteMemo(client, memo.id);
    switch (result.kind) {
      case "ok":
        setFlash("メモを削除しました");
        navigate(`/sites/${memo.site_id}/memos`);
        return;
      case "notFound":
        setSending(false);
        onGone();
        return;
      case "error":
        setSending(false);
        setFailure(result.message);
        return;
      case "unknown":
        setSending(false);
        setFailure(UNKNOWN_RESULT_MESSAGE);
        return;
      case "redirecting":
        return;
    }
  }

  if (!open) {
    return (
      <button type="button" className="button-danger-outline" onClick={() => setOpen(true)}>
        削除
      </button>
    );
  }
  return (
    <div className="confirm" role="group" aria-label="メモを削除">
      <p>このメモを削除します。元に戻せません。</p>
      <div className="form-actions">
        <button type="button" className="button-danger" onClick={() => void onDelete()} disabled={sending}>
          削除する
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && (
        <p className="form-error" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
