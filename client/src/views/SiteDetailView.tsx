import { useEffect } from "react";
import type { InsightsCoverage, InsightsResponse, SearchRow, SessionRow, Site } from "../../../src/api/types";
import { ExternalIcon, PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadDashboard, useView } from "../load";
import {
  type Change,
  changeOf,
  formatAxis,
  formatCount,
  formatDate,
  formatPercent,
  formatPosition,
  formatShortDate,
  localDate,
  shortUrl,
} from "../numbers";
import { navigate, searchParams } from "../router";
import { setCurrentSite } from "../siteContext";
import { BarRow, type ChartTone, ShareBar, TrendChart } from "./charts";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { Delta, KpiButton } from "./metrics";

const GONE_MESSAGE = "サイトが見つかりません。削除された可能性があります";
export const PERIODS = [7, 28, 90] as const;

type MetricId = "clicks" | "impressions" | "ctr" | "position" | "sessions" | "engagement" | "key_events";

type Metric = {
  id: MetricId;
  label: string;
  tone: ChartTone;
  invert?: boolean;
  format: (value: number) => string;
  axis: (value: number) => string;
  change: (current: number | null, previous: number | null) => Change | null;
  note?: string;
};

const METRICS: Record<MetricId, Metric> = {
  clicks: { id: "clicks", label: "クリック", tone: "search", format: formatCount, axis: formatAxis, change: (a, b) => changeOf(a, b) },
  impressions: {
    id: "impressions",
    label: "表示回数",
    tone: "search",
    format: formatCount,
    axis: formatAxis,
    change: (a, b) => changeOf(a, b),
  },
  ctr: {
    id: "ctr",
    label: "CTR",
    tone: "search",
    format: (v) => formatPercent(v),
    axis: (v) => formatPercent(v, 0),
    change: (a, b) => changeOf(a, b, { kind: "points" }),
  },
  position: {
    id: "position",
    label: "平均掲載順位",
    tone: "search",
    invert: true,
    format: formatPosition,
    axis: (v) => String(Math.round(v)),
    change: (a, b) => changeOf(a, b, { kind: "difference", betterWhenLower: true }),
    note: "小さいほど上位",
  },
  sessions: {
    id: "sessions",
    label: "セッション",
    tone: "sessions",
    format: formatCount,
    axis: formatAxis,
    change: (a, b) => changeOf(a, b),
  },
  engagement: {
    id: "engagement",
    label: "エンゲージメント率",
    tone: "sessions",
    format: (v) => formatPercent(v),
    axis: (v) => formatPercent(v, 0),
    change: (a, b) => changeOf(a, b, { kind: "points" }),
  },
  key_events: {
    id: "key_events",
    label: "キーイベント",
    tone: "sessions",
    format: (v) => formatCount(Math.round(v * 10) / 10),
    axis: formatAxis,
    change: (a, b) => changeOf(a, b),
  },
};

const SEARCH_METRICS: MetricId[] = ["clicks", "impressions", "ctr", "position"];
const SESSION_METRICS: MetricId[] = ["sessions", "engagement", "key_events"];

// The days of the dashboard from ?days=, one of PERIODS.
export function periodOf(path: string): number {
  const days = Number(searchParams(path).get("days"));
  return (PERIODS as readonly number[]).includes(days) ? days : 28;
}

type Series = { current: (number | null)[]; previous: (number | null)[] };

function split<T>(daily: T[], periodDays: number): { previous: T[]; current: T[] } {
  return { previous: daily.slice(0, daily.length - periodDays), current: daily.slice(daily.length - periodDays) };
}

function seriesOf(insights: InsightsResponse, id: MetricId): Series | null {
  const days = insights.period.days;
  if (SEARCH_METRICS.includes(id)) {
    if (insights.search === null) return null;
    const value = (day: NonNullable<InsightsResponse["search"]>["daily"][number]) => {
      if (day.clicks === null || day.impressions === null) return null;
      if (id === "clicks") return day.clicks;
      if (id === "impressions") return day.impressions;
      if (id === "ctr") return day.impressions === 0 ? null : day.clicks / day.impressions;
      return day.position;
    };
    const parts = split(insights.search.daily, days);
    return { current: parts.current.map(value), previous: parts.previous.map(value) };
  }
  if (insights.sessions === null) return null;
  const value = (day: NonNullable<InsightsResponse["sessions"]>["daily"][number]) => {
    if (day.sessions === null) return null;
    if (id === "sessions") return day.sessions;
    if (id === "engagement") return day.sessions === 0 ? null : (day.engaged_sessions ?? 0) / day.sessions;
    return day.key_events;
  };
  const parts = split(insights.sessions.daily, days);
  return { current: parts.current.map(value), previous: parts.previous.map(value) };
}

function totalsOf(insights: InsightsResponse, id: MetricId): { current: number | null; previous: number | null } {
  const s = insights.search;
  const g = insights.sessions;
  switch (id) {
    case "clicks":
      return { current: s?.totals.clicks ?? null, previous: s?.previous_totals.clicks ?? null };
    case "impressions":
      return { current: s?.totals.impressions ?? null, previous: s?.previous_totals.impressions ?? null };
    case "ctr":
      return { current: s?.totals.ctr ?? null, previous: s?.previous_totals.ctr ?? null };
    case "position":
      return { current: s?.totals.position ?? null, previous: s?.previous_totals.position ?? null };
    case "sessions":
      return { current: g?.totals.sessions ?? null, previous: g?.previous_totals.sessions ?? null };
    case "engagement":
      return { current: g?.totals.engagement_rate ?? null, previous: g?.previous_totals.engagement_rate ?? null };
    case "key_events":
      return { current: g?.totals.key_events ?? null, previous: g?.previous_totals.key_events ?? null };
  }
}

function hasRows(coverage: InsightsCoverage | undefined): boolean {
  return coverage !== undefined && coverage.available_days > 0;
}

// The performance of a site: the figures of the period against the previous one, the trend with the memos on it,
// and the top queries, pages, channels and landing pages.
export function SiteDetailView({ client, id, path }: { client: ApiClient; id: string; path: string }) {
  const days = periodOf(path);
  const metricParam = searchParams(path).get("metric");
  const [state, reload] = useView(() => loadDashboard(client, id, days), `dashboard:${id}:${days}`);
  useDocumentTitle(viewTitle(state, (data) => `実績 - ${data.site.name}`));
  useEffect(() => {
    if (state.kind === "ready") setCurrentSite(state.data.site.id);
  }, [state]);

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={GONE_MESSAGE} onReload={reload} />;
  }
  const { site, insights } = state.data;
  const available = (Object.keys(METRICS) as MetricId[]).filter((mid) => seriesOf(insights, mid) !== null);
  const selected: MetricId =
    metricParam !== null && available.includes(metricParam as MetricId)
      ? (metricParam as MetricId)
      : (available[0] ?? "clicks");

  function setQuery(next: { days?: number; metric?: MetricId }) {
    const params = new URLSearchParams();
    const d = next.days ?? days;
    if (d !== 28) params.set("days", String(d));
    const m = next.metric ?? selected;
    if (m !== (available[0] ?? "clicks")) params.set("metric", m);
    const query = params.toString();
    navigate(`/sites/${site.id}${query === "" ? "" : `?${query}`}`, { replace: true, keepScroll: true });
  }

  const nothingConfigured = site.gsc_property === null && site.ga4_property_id === null;
  const nothingImported = !hasRows(insights.search?.coverage) && !hasRows(insights.sessions?.coverage);

  return (
    <main className="page page-wide">
      <header className="page-head">
        <div className="page-head-text">
          <p className="eyebrow">
            {site.name !== site.url.replace(/^https?:\/\//, "") && (
              <>
                {site.name}
                <span aria-hidden="true"> · </span>
              </>
            )}
            <a href={site.url} target="_blank" rel="noopener noreferrer">
              {site.url.replace(/^https?:\/\//, "")}
              <ExternalIcon />
            </a>
          </p>
          <h1>実績</h1>
          <p className="lead">
            {formatDate(insights.period.start)}〜{formatDate(insights.period.end)}
            <span className="lead-sub">
              前の期間 {formatShortDate(insights.previous_period.start)}〜{formatShortDate(insights.previous_period.end)} と比較
            </span>
          </p>
        </div>
        <div className="segmented" role="group" aria-label="期間">
          {PERIODS.map((d) => (
            <button key={d} type="button" aria-pressed={d === days} onClick={() => setQuery({ days: d })}>
              {d}日
            </button>
          ))}
        </div>
      </header>

      {nothingConfigured ? (
        <EmptyPanel
          title="データソースが設定されていません"
          body="サイトの設定で、Search Console のプロパティか GA4 のプロパティ ID を登録してください。"
          to={`/sites/${site.id}/settings`}
          action="サイトの設定へ"
        />
      ) : nothingImported ? (
        <EmptyPanel
          title="この期間のデータがまだありません"
          body="データの取り込みで期間を選んで取り込むと、ここに推移が表示されます。以降は毎日自動で取り込まれます。"
          to={`/sites/${site.id}/data`}
          action="データの取り込みへ"
        />
      ) : (
        <>
          <Freshness insights={insights} siteId={site.id} />
          <div className="kpi-groups">
            {[
              { label: "Search Console", tone: "search", ids: available.filter((mid) => SEARCH_METRICS.includes(mid)) },
              { label: "GA4", tone: "sessions", ids: available.filter((mid) => SESSION_METRICS.includes(mid)) },
            ]
              .filter((group) => group.ids.length > 0)
              .map((group) => (
                <section
                  key={group.label}
                  className={`kpi-group kpi-group-${group.tone}`}
                  aria-label={`${group.label} の期間の合計`}
                  style={{ "--kpi-count": group.ids.length } as React.CSSProperties}
                >
                  <h2 className="kpi-group-title">{group.label}</h2>
                  <div className="kpi-grid">
                    {group.ids.map((mid) => {
                      const metric = METRICS[mid];
                      const series = seriesOf(insights, mid);
                      const totals = totalsOf(insights, mid);
                      return (
                        <KpiButton
                          key={mid}
                          label={metric.label}
                          value={totals.current === null ? "—" : metric.format(totals.current)}
                          change={metric.change(totals.current, totals.previous)}
                          values={series?.current ?? []}
                          previous={series?.previous ?? null}
                          tone={metric.tone}
                          invert={metric.invert}
                          selected={mid === selected}
                          onSelect={() => setQuery({ metric: mid })}
                          note={metric.note}
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
          </div>
          <div className="dash-main">
            <MainChart insights={insights} metric={METRICS[selected]} site={site} />
            <PeriodMemos insights={insights} siteId={site.id} />
          </div>
          {insights.search !== null && (
            <>
              <SearchTable
                title="検索クエリ"
                caption="クリックの多い順・匿名化されたクエリは含みません。順位は小さいほど上位で、上位に動くと緑"
                rows={insights.search.queries}
                label={(row) => row.key}
              />
              <SearchTable
                title="ページ"
                caption="Search Console のページ別・クリックの多い順。順位は上位に動くと緑"
                rows={insights.search.pages}
                label={(row) => <span className="mono">{shortUrl(row.key, site.url)}</span>}
              />
            </>
          )}
          {insights.sessions !== null && (
            <>
              <Channels rows={insights.sessions.channels} />
              <SessionTable rows={insights.sessions.landing_pages} />
            </>
          )}
        </>
      )}
    </main>
  );
}

function EmptyPanel({ title, body, to, action }: { title: string; body: string; to: string; action: string }) {
  return (
    <section className="panel empty-panel">
      <h2 className="panel-title">{title}</h2>
      <p>{body}</p>
      <Link to={to} className="button button-primary">
        {action}
      </Link>
    </section>
  );
}

// How complete the figures are: the last day, the provisional days and the missing days of each source.
function Freshness({ insights, siteId }: { insights: InsightsResponse; siteId: string }) {
  const items: { label: string; coverage: InsightsCoverage }[] = [];
  if (insights.search !== null) items.push({ label: "Search Console", coverage: insights.search.coverage });
  if (insights.sessions !== null) items.push({ label: "GA4", coverage: insights.sessions.coverage });
  return (
    <ul className="freshness" aria-label="データの状態">
      {items.map(({ label, coverage }) => {
        const warn = coverage.missing_days > 0;
        return (
          <li key={label} className={warn ? "freshness-warn" : undefined}>
            <span className="freshness-source">{label}</span>
            <span>
              {coverage.available_days}/{coverage.days} 日
            </span>
            {coverage.provisional_days > 0 && <span>直近 {coverage.provisional_days} 日は速報値</span>}
            {warn && (
              <Link to={`/sites/${siteId}/data`} className="freshness-link">
                欠損 {coverage.missing_days} 日
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function MainChart({ insights, metric, site }: { insights: InsightsResponse; metric: Metric; site: Site }) {
  const series = seriesOf(insights, metric.id);
  const dates = (insights.search?.daily ?? insights.sessions?.daily ?? []).map((day) => day.date);
  const { previous: previousDates, current: currentDates } = split(dates, insights.period.days);
  const inPeriod = insights.memos.filter((memo) => {
    const date = localDate(memo.created_at);
    return date >= insights.period.start && date <= insights.period.end;
  });
  if (series === null) return null;
  return (
    <section className="panel chart-panel" aria-labelledby="chart-title">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="chart-title">
            {metric.label}の推移
          </h2>
          <p className="panel-caption">
            {metric.tone === "search" ? "Search Console（太平洋時間の日付）" : "GA4（プロパティのタイムゾーンの日付）"}
          </p>
        </div>
        <ul className="legend" aria-label="凡例">
          <li>
            <span className={`swatch swatch-current swatch-${metric.tone}`} aria-hidden="true" />
            この期間
          </li>
          <li>
            <span className="swatch swatch-previous" aria-hidden="true" />
            前の期間
          </li>
          <li>
            <span className="swatch swatch-memo" aria-hidden="true" />
            <Link to={`/sites/${site.id}/memos`}>メモ {inPeriod.length} 件</Link>
          </li>
        </ul>
      </div>
      <TrendChart
        label={metric.label}
        dates={currentDates}
        values={series.current}
        previous={series.previous.length === series.current.length ? series.previous : null}
        previousDates={previousDates.length === currentDates.length ? previousDates : null}
        format={metric.format}
        invert={metric.invert}
        tone={metric.tone}
        memos={insights.memos}
      />
    </section>
  );
}

function SearchTable({
  title,
  caption,
  rows,
  label,
}: {
  title: string;
  caption: string;
  rows: SearchRow[];
  label: (row: SearchRow) => React.ReactNode;
}) {
  const max = Math.max(0, ...rows.map((row) => row.clicks));
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">{title}</h2>
          <p className="panel-caption">{caption}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="hint">この期間のデータはありません。</p>
      ) : (
        <table className="rank">
          <thead>
            <tr>
              <th scope="col">{title}</th>
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
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  <BarRow label={label(row)} value={row.clicks} max={max} tone="search" title={row.key} />
                </th>
                <td className="num">
                  <span className="cell-main">{formatCount(row.clicks)}</span>
                  <Delta change={changeOf(row.clicks, row.previous_clicks)} />
                </td>
                <td className="num hide-sm">{formatCount(row.impressions)}</td>
                <td className="num hide-sm">{row.ctr === null ? "—" : formatPercent(row.ctr)}</td>
                <td className="num">
                  <span className="cell-main">{row.position === null ? "—" : formatPosition(row.position)}</span>
                  <Delta
                    change={changeOf(row.position, row.previous_position, { kind: "difference", betterWhenLower: true })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const CHANNEL_NAMES: Record<string, string> = {
  "Organic Search": "自然検索",
  Direct: "ノーリファラー",
  Referral: "参照元サイト",
  "Organic Social": "ソーシャル",
  Email: "メール",
  "Paid Search": "有料検索",
  "Organic Video": "動画",
  Unassigned: "未分類",
};

function Channels({ rows }: { rows: SessionRow[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">流入チャネル</h2>
          <p className="panel-caption">GA4 のデフォルト チャネル グループ別のセッション</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="hint">この期間のデータはありません。</p>
      ) : (
        <ShareBar
          parts={rows.map((row) => ({ label: CHANNEL_NAMES[row.key] ?? row.key, value: row.sessions }))}
          format={formatCount}
        />
      )}
    </section>
  );
}

function SessionTable({ rows }: { rows: SessionRow[] }) {
  const max = Math.max(0, ...rows.map((row) => row.sessions));
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">ランディングページ</h2>
          <p className="panel-caption">GA4 のセッションの多い順</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="hint">この期間のデータはありません。</p>
      ) : (
        <table className="rank">
          <thead>
            <tr>
              <th scope="col">ページ</th>
              <th scope="col" className="num">
                セッション
              </th>
              <th scope="col" className="num hide-sm">
                エンゲージ
              </th>
              <th scope="col" className="num num-wide">
                キーイベント
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  <BarRow
                    label={<span className="mono">{row.key}</span>}
                    value={row.sessions}
                    max={max}
                    tone="sessions"
                    title={row.key}
                  />
                </th>
                <td className="num">
                  <span className="cell-main">{formatCount(row.sessions)}</span>
                  <Delta change={changeOf(row.sessions, row.previous_sessions)} />
                </td>
                <td className="num hide-sm">{row.engagement_rate === null ? "—" : formatPercent(row.engagement_rate)}</td>
                <td className="num">{formatCount(row.key_events)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// The memos of the period, oldest first, next to the figures they explain.
function PeriodMemos({ insights, siteId }: { insights: InsightsResponse; siteId: string }) {
  const memos = insights.memos
    .filter((memo) => {
      const date = localDate(memo.created_at);
      return date >= insights.period.start && date <= insights.period.end;
    })
    .slice()
    .sort((a, b) => b.created_at - a.created_at);
  return (
    <section className="panel period-memos" aria-labelledby="period-memos">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="period-memos">
            この期間のメモ
          </h2>
          <p className="panel-caption">グラフの ◆ と同じ日付・新しい順</p>
        </div>
        <Link to={`/sites/${siteId}/memos?new=1`} className="button button-secondary">
          <PlusIcon />
          書く
        </Link>
      </div>
      {memos.length === 0 ? (
        <p className="hint">この期間のメモはありません。施策や気づきを書いておくと推移の上に印が付きます。</p>
      ) : (
        <ol className="timeline">
          {memos.map((memo) => (
            <li key={memo.id}>
              <time dateTime={new Date(memo.created_at).toISOString()} className="timeline-date">
                {formatShortDate(localDate(memo.created_at))}
              </time>
              <Link to={`/memos/${memo.id}`} className="timeline-title">
                {memo.title}
              </Link>
              {memo.tags.length > 0 && (
                <span className="timeline-tags">
                  {memo.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      <Link to={`/sites/${siteId}/memos`} className="panel-foot-link">
        すべてのメモを見る
      </Link>
    </section>
  );
}
