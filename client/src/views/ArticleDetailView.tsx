import { type FormEvent, useEffect, useRef, useState } from "react";
import type { Article, InsightsResponse } from "../../../src/api/types";
import { deleteArticle, updateArticle } from "../actions";
import { setFlash } from "../flash";
import { formatDateTime } from "../format";
import { ArrowLeftIcon, ExternalIcon, PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadArticleDetail, loadArticleInsights, loadMemoPage, useView } from "../load";
import {
  type Change,
  changeOf,
  formatAxis,
  formatCount,
  formatDate,
  formatPercent,
  formatPosition,
} from "../numbers";
import { articleFormValues, articleRequest } from "../records";
import { navigate } from "../router";
import { setCurrentSite } from "../siteContext";
import { ArticleFields, Tags, handleItemResult } from "./ArticlesView";
import { BarRow, TrendChart } from "./charts";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { Delta, KpiButton } from "./metrics";
import { MemoPages } from "./MemosView";
import { UNKNOWN_RESULT_MESSAGE } from "./SitesView";

const GONE_MESSAGE = "記事が見つかりません。削除された可能性があります";
const MEMOS_PAGE = "50";

// One article: its search and sessions over time with its memos on them, the queries that bring it visitors, the
// memos, and the edit form and the deletion.
export function ArticleDetailView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadArticleDetail(client, id), `article:${id}`);
  const [notice, setNotice] = useState<string | null>(null);
  const infoRef = useRef<HTMLDetailsElement>(null);
  useDocumentTitle(viewTitle(state, (data) => data.article.title));
  useEffect(() => {
    if (state.kind === "ready") setCurrentSite(state.data.site.id);
  }, [state]);

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={GONE_MESSAGE} onReload={reload} />;
  }
  const { article, site } = state.data;

  return (
    <main className="page page-wide">
      <p className="back">
        <Link to={`/sites/${site.id}/articles`}>
          <ArrowLeftIcon />
          記事の一覧
        </Link>
      </p>
      <header className="page-head">
        <div className="page-head-text">
          <p className="eyebrow">
            {article.published_on === null ? "未公開" : `${formatDate(article.published_on)} 公開`}
          </p>
          <h1>{article.title}</h1>
          {article.url !== null && (
            <p className="lead">
              <a href={article.url} target="_blank" rel="noopener noreferrer" className="mono">
                {article.url}
                <ExternalIcon />
              </a>
            </p>
          )}
          <Tags tags={article.tags} />
        </div>
        <button
          type="button"
          className="button-primary"
          onClick={() => {
            const details = infoRef.current;
            if (details === null) return;
            details.open = true;
            details.scrollIntoView({ block: "start" });
            details.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
          }}
        >
          編集
        </button>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {article.url === null ? (
        <section className="panel empty-panel">
          <h2 className="panel-title">URL を登録すると実績を表示できます</h2>
          <p>Search Console のページと同じ URL を、下の「記事の情報」で登録してください。</p>
        </section>
      ) : (
        <ArticleInsights client={client} article={article} />
      )}
      <section className="panel" aria-labelledby="article-memos">
        <div className="panel-head">
          <div>
            <h2 className="panel-title" id="article-memos">
              この記事のメモ
            </h2>
            <p className="panel-caption">グラフの ◆ はこの記事にひも付いたメモです</p>
          </div>
          <Link to={`/sites/${site.id}/memos?article=${article.id}`} className="button button-secondary">
            <PlusIcon />
            メモを書く
          </Link>
        </div>
        <LinkedMemos client={client} article={article} />
      </section>
      <details ref={infoRef} className="panel disclosure">
        <summary>
          <span className="panel-title">記事の情報</span>
          <span className="panel-caption">
            <span className="nowrap">登録 {formatDateTime(article.created_at)}</span>
            <span className="nowrap">・更新 {formatDateTime(article.updated_at)}</span>
          </span>
        </summary>
        {article.note !== "" && (
          <div className="note-block">
            <p className="field-label">備考</p>
            <p className="text-body">{article.note}</p>
          </div>
        )}
        <EditArticleForm
          key={article.updated_at}
          client={client}
          article={article}
          onUpdated={() => {
            setNotice("記事を更新しました");
            reload();
          }}
          onGone={reload}
        />
        <DeleteArticle client={client} article={article} onGone={reload} />
      </details>
    </main>
  );
}

type ArticleMetric = "clicks" | "impressions" | "position" | "sessions";

const ARTICLE_METRICS: { id: ArticleMetric; label: string }[] = [
  { id: "clicks", label: "クリック" },
  { id: "impressions", label: "表示回数" },
  { id: "position", label: "平均掲載順位" },
  { id: "sessions", label: "セッション" },
];

function ArticleInsights({ client, article }: { client: ApiClient; article: Article }) {
  const [days, setDays] = useState(90);
  const [metric, setMetric] = useState<ArticleMetric>("clicks");
  const [state, reload] = useView(
    () => loadArticleInsights(client, article.site_id, article.id, days),
    `article-insights:${article.id}:${article.updated_at}:${days}`,
  );
  if (state.kind === "loading") {
    return (
      <section className="panel chart-panel">
        <p className="status" role="status">
          読み込み中…
        </p>
      </section>
    );
  }
  if (state.kind !== "ready") {
    return (
      <section className="panel">
        <p role="alert">実績を読み込めませんでした。</p>
        <button type="button" onClick={reload}>
          再読み込み
        </button>
      </section>
    );
  }
  const insights = state.data;
  const search = insights.search;
  const sessions = insights.sessions;
  const options = ARTICLE_METRICS.filter((option) => (option.id === "sessions" ? sessions !== null : search !== null));
  const chosen = options.some((option) => option.id === metric) ? metric : (options[0]?.id ?? "clicks");
  const series = articleSeries(insights, chosen);
  const dates = (search?.daily ?? sessions?.daily ?? []).map((day) => day.date);
  const n = insights.period.days;
  const currentDates = dates.slice(dates.length - n);
  const previousDates = dates.slice(0, dates.length - n);
  const tone = chosen === "sessions" ? "sessions" : "search";
  const format = chosen === "position" ? formatPosition : formatCount;
  const max = Math.max(0, ...(search?.queries ?? []).map((row) => row.clicks));
  // The previous period reaches back before the article was published: its change is not a fair comparison.
  const beforePublish = article.published_on !== null && article.published_on > insights.previous_period.start;

  return (
    <>
      <section className="panel chart-panel" aria-labelledby="article-chart">
        <div className="panel-head">
          <div>
            <h2 className="panel-title" id="article-chart">
              この記事の推移
            </h2>
            <p className="panel-caption">
              {formatDate(insights.period.start)}〜{formatDate(insights.period.end)}・前の {n} 日と比較
              {beforePublish && (
                <span className="caption-note">前の期間は公開前の日を含むため、増減を色で評価していません</span>
              )}
            </p>
          </div>
          <div className="segmented" role="group" aria-label="期間">
            {[28, 90, 180].map((d) => (
              <button key={d} type="button" aria-pressed={d === days} onClick={() => setDays(d)}>
                {d}日
              </button>
            ))}
          </div>
        </div>
        <div className="kpi-row" role="group" aria-label="表示する指標">
          {options.map((option) => {
            const totals = articleTotals(insights, option.id);
            const isPosition = option.id === "position";
            const optionSeries = articleSeries(insights, option.id);
            return (
              <KpiButton
                key={option.id}
                label={option.label}
                value={
                  totals.current === null ? "—" : isPosition ? formatPosition(totals.current) : formatCount(totals.current)
                }
                change={muted(
                  changeOf(totals.current, totals.previous, isPosition ? { kind: "difference", betterWhenLower: true } : {}),
                  beforePublish,
                )}
                values={optionSeries?.current ?? []}
                previous={optionSeries?.previous ?? null}
                tone={option.id === "sessions" ? "sessions" : "search"}
                invert={isPosition}
                selected={option.id === chosen}
                onSelect={() => setMetric(option.id)}
                note={isPosition ? "小さいほど上位" : undefined}
              />
            );
          })}
        </div>
        <ul className="legend legend-row" aria-label="凡例">
          <li>
            <span className={`swatch swatch-current swatch-${tone}`} aria-hidden="true" />
            この期間
          </li>
          <li>
            <span className="swatch swatch-previous" aria-hidden="true" />
            前の期間
          </li>
          <li>
            <span className="swatch swatch-memo" aria-hidden="true" />
            この記事のメモ
          </li>
          <li>
            <span className="swatch swatch-gap" aria-hidden="true" />
            データなし
          </li>
          {article.published_on !== null && (
            <li>
              <span className="swatch swatch-marker" aria-hidden="true" />
              公開日
            </li>
          )}
        </ul>
        {series === null ? (
          <p className="hint">データソースが設定されていません。</p>
        ) : (
          <TrendChart
            label={ARTICLE_METRICS.find((option) => option.id === chosen)?.label ?? ""}
            dates={currentDates}
            values={series.current}
            previous={series.previous.length === series.current.length ? series.previous : null}
            previousDates={previousDates.length === currentDates.length ? previousDates : null}
            format={chosen === "position" ? formatPosition : chosen === "clicks" || chosen === "sessions" ? format : formatAxis}
            invert={chosen === "position"}
            tone={tone}
            memos={insights.memos}
            markers={article.published_on === null ? [] : [{ date: article.published_on, label: "公開" }]}
            height={240}
          />
        )}
      </section>
      {search !== null && (
        <section className="panel" aria-labelledby="article-queries">
          <div className="panel-head">
            <div>
              <h2 className="panel-title" id="article-queries">
                この記事に来た検索クエリ
              </h2>
              <p className="panel-caption">クリックの多い順</p>
            </div>
          </div>
          {search.queries.length === 0 ? (
            <p className="hint">この期間のクエリはありません。</p>
          ) : (
            <table className="rank">
              <thead>
                <tr>
                  <th scope="col">クエリ</th>
                  <th scope="col" className="num">
                    クリック
                  </th>
                  <th scope="col" className="num hide-sm">
                    表示
                  </th>
                  <th scope="col" className="num hide-sm">
                    CTR
                  </th>
                  <th scope="col" className="num">
                    順位
                  </th>
                </tr>
              </thead>
              <tbody>
                {search.queries.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">
                      <BarRow label={row.key} value={row.clicks} max={max} tone="search" />
                    </th>
                    <td className="num">
                      <span className="cell-main">{formatCount(row.clicks)}</span>
                      <Delta change={muted(changeOf(row.clicks, row.previous_clicks), beforePublish)} />
                    </td>
                    <td className="num hide-sm">{formatCount(row.impressions)}</td>
                    <td className="num hide-sm">{row.ctr === null ? "—" : formatPercent(row.ctr)}</td>
                    <td className="num">{row.position === null ? "—" : formatPosition(row.position)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </>
  );
}

// A change shown without the color of better or worse.
function muted(change: Change | null, mute: boolean): Change | null {
  return change === null || !mute ? change : { ...change, good: null };
}

function articleSeries(insights: InsightsResponse, metric: ArticleMetric) {
  const n = insights.period.days;
  if (metric === "sessions") {
    if (insights.sessions === null) return null;
    const values = insights.sessions.daily.map((day) => day.sessions);
    return { current: values.slice(values.length - n), previous: values.slice(0, values.length - n) };
  }
  if (insights.search === null) return null;
  const values = insights.search.daily.map((day) => (metric === "position" ? day.position : day[metric]));
  return { current: values.slice(values.length - n), previous: values.slice(0, values.length - n) };
}

function articleTotals(insights: InsightsResponse, metric: ArticleMetric) {
  if (metric === "sessions") {
    return {
      current: insights.sessions?.totals.sessions ?? null,
      previous: insights.sessions?.previous_totals.sessions ?? null,
    };
  }
  return {
    current: insights.search?.totals[metric] ?? null,
    previous: insights.search?.previous_totals[metric] ?? null,
  };
}

function LinkedMemos({ client, article }: { client: ApiClient; article: Article }) {
  const query = { article_id: article.id, limit: MEMOS_PAGE };
  const [state, reload] = useView(
    () => loadMemoPage(client, article.site_id, query),
    `article-memos:${article.id}:${article.updated_at}`,
  );
  switch (state.kind) {
    case "loading":
      return (
        <p className="hint" role="status">
          読み込み中…
        </p>
      );
    case "redirecting":
      return <p className="hint">ログイン画面へ移動しています…</p>;
    case "notFound":
      return <p role="alert">サイトが見つかりません。削除された可能性があります</p>;
    case "error":
      return (
        <div className="actions">
          <p role="alert">{state.message}</p>
          <button type="button" onClick={reload}>
            再読み込み
          </button>
        </div>
      );
    case "ready":
      return (
        <MemoPages
          client={client}
          siteId={article.site_id}
          query={query}
          first={state.data}
          emptyMessage="この記事のメモはまだありません。"
          compact
        />
      );
  }
}

function EditArticleForm({
  client,
  article,
  onUpdated,
  onGone,
}: {
  client: ApiClient;
  article: Article;
  onUpdated: () => void;
  onGone: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState(() => articleFormValues(article));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await updateArticle(client, article.id, articleRequest(values));
    if (handleItemResult(result, setSending, setFailure)) onUpdated();
    else if (result.kind === "notFound") onGone();
  }

  return (
    <form className="form" aria-label="記事の編集" onSubmit={(event) => void onSubmit(event)}>
      <ArticleFields values={values} onChange={setValues} disabled={sending} />
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={sending}>
          保存
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

function DeleteArticle({ client, article, onGone }: { client: ApiClient; article: Article; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onDelete() {
    setSending(true);
    setFailure(null);
    const result = await deleteArticle(client, article.id);
    switch (result.kind) {
      case "ok":
        setFlash("記事を削除しました");
        navigate(`/sites/${article.site_id}/articles`);
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

  return (
    <div className="danger-inline">
      {!open ? (
        <button type="button" className="button-danger-outline" onClick={() => setOpen(true)}>
          記事を削除
        </button>
      ) : (
        <div className="confirm" role="group" aria-label="記事を削除">
          <p>この記事を削除します。ひも付くメモは残り、この記事とのひも付けだけが外れます。元に戻せません。</p>
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
      )}
    </div>
  );
}
