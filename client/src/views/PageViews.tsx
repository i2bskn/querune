import { useState } from "react";
import type { InsightsResponse, PageViewRow } from "../../../src/api/types";
import { Link } from "../Link";
import { type Change, changeOf, formatCount, formatSeconds } from "../numbers";
import { BarRow, TrendChart } from "./charts";
import { Delta, KpiButton } from "./metrics";

type PageViews = NonNullable<InsightsResponse["page_views"]>;

type PageViewMetric = "views" | "average";

const LABELS: Record<PageViewMetric, string> = {
  views: "表示回数",
  average: "平均時間/表示1回",
};

// The value of a day: null on the days not imported.
function dailyValue(day: PageViews["daily"][number], metric: PageViewMetric): number | null {
  if (day.views === null) return null;
  if (metric === "views") return day.views;
  return day.views === 0 || day.engagement_seconds === null ? null : day.engagement_seconds / day.views;
}

// The host name of the site URL, or null.
function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// The views of pages (GA4): every view, not only the first page of a visit. For a site, siteUrl is its URL and the
// most viewed pages are listed; for an article, siteUrl is null. muteChange shows the changes without the color of
// better or worse.
export function PageViewsPanel({
  insights,
  siteId,
  siteUrl,
  muteChange = false,
}: {
  insights: InsightsResponse;
  siteId: string;
  siteUrl: string | null;
  muteChange?: boolean;
}) {
  const [metric, setMetric] = useState<PageViewMetric>("views");
  const pageViews = insights.page_views;
  if (pageViews === null) return null;
  const n = insights.period.days;
  const dates = pageViews.daily.map((day) => day.date);
  const currentDates = dates.slice(dates.length - n);
  const previousDates = dates.slice(0, dates.length - n);
  const seriesOf = (id: PageViewMetric) => {
    const values = pageViews.daily.map((day) => dailyValue(day, id));
    return { current: values.slice(values.length - n), previous: values.slice(0, values.length - n) };
  };
  // The change is shown only when no day of either period is missing: a missing day is not 0 views.
  const comparable = pageViews.coverage.missing_days === 0 && pageViews.previous_coverage.missing_days === 0;
  const change = (current: number | null, previous: number | null): Change | null => {
    if (!comparable) return null;
    const result = changeOf(current, previous);
    return result === null || !muteChange ? result : { ...result, good: null };
  };
  const totals = {
    views: { current: pageViews.totals.views, previous: pageViews.previous_totals.views },
    average: {
      current: pageViews.totals.avg_engagement_seconds_per_view,
      previous: pageViews.previous_totals.avg_engagement_seconds_per_view,
    },
  };
  const format = (id: PageViewMetric) => (id === "views" ? formatCount : formatSeconds);
  const series = seriesOf(metric);
  const coverage = pageViews.coverage;
  const thresholded = coverage.thresholded_days > 0 || pageViews.previous_coverage.thresholded_days > 0;

  return (
    <>
      <section className="panel chart-panel" aria-labelledby="page-views-title">
        <div className="panel-head">
          <div>
            <h2 className="panel-title" id="page-views-title">
              ページの表示回数（GA4）
            </h2>
            <p className="panel-caption">
              訪問の途中で読まれた分も含む表示回数です。ランディングページのセッション数とは別の指標です
            </p>
          </div>
        </div>
        <ul className="freshness" aria-label="表示回数のデータの状態">
          <li className={coverage.missing_days > 0 ? "freshness-warn" : undefined}>
            <span className="freshness-source">GA4 表示回数</span>
            <span>
              {coverage.available_days}/{coverage.days} 日
            </span>
            {coverage.provisional_days > 0 && <span>直近 {coverage.provisional_days} 日は速報値</span>}
            {coverage.missing_days > 0 && (
              <Link to={`/sites/${siteId}/data`} className="freshness-link">
                欠損 {coverage.missing_days} 日
              </Link>
            )}
          </li>
        </ul>
        <div className="kpi-grid" role="group" aria-label="表示する指標" style={{ "--kpi-count": 2 } as React.CSSProperties}>
          {(["views", "average"] as const).map((id) => {
            const values = seriesOf(id);
            const total = totals[id];
            return (
              <KpiButton
                key={id}
                label={LABELS[id]}
                value={total.current === null ? "—" : format(id)(total.current)}
                change={change(total.current, total.previous)}
                values={values.current}
                previous={values.previous}
                tone="sessions"
                selected={id === metric}
                onSelect={() => setMetric(id)}
              />
            );
          })}
        </div>
        {!comparable && (
          <p className="hint">この期間か前の期間に未取得の日があるため、前の期間との比較は出していません。</p>
        )}
        {thresholded && (
          <p className="hint">GA4 のしきい値・(other) 行の影響で一部の行が含まれていない可能性があります。</p>
        )}
        <TrendChart
          label={LABELS[metric]}
          dates={currentDates}
          values={series.current}
          previous={series.previous.length === series.current.length ? series.previous : null}
          previousDates={previousDates.length === currentDates.length ? previousDates : null}
          format={metric === "views" ? formatCount : formatSeconds}
          tone="sessions"
          memos={insights.memos}
          height={240}
        />
        <p className="hint">
          GA4（プロパティのタイムゾーンの日付）。平均エンゲージメント時間は合計の時間を表示回数で割った値で、GA4 の画面のユーザーあたりの値とは違います。
        </p>
      </section>
      {siteUrl !== null && (
        <PageViewTable rows={pageViews.pages} siteHost={hostOf(siteUrl)} comparable={comparable} />
      )}
    </>
  );
}

function PageViewTable({
  rows,
  siteHost,
  comparable,
}: {
  rows: PageViewRow[];
  siteHost: string | null;
  comparable: boolean;
}) {
  const max = Math.max(0, ...rows.map((row) => row.views));
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">よく読まれたページ</h2>
          <p className="panel-caption">GA4 の表示回数の多い順・訪問の途中で読まれた分も含みます</p>
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
                表示回数
              </th>
              <th scope="col" className="num num-wide">
                平均時間
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const otherHost = row.host_name !== siteHost;
              return (
                <tr key={`${row.host_name}\n${row.page_path}`}>
                  <th scope="row">
                    <BarRow
                      label={
                        <>
                          <span className="mono">{row.page_path}</span>
                          {otherHost && <span className="bar-host">{row.host_name}</span>}
                        </>
                      }
                      value={row.views}
                      max={max}
                      tone="sessions"
                      title={`${row.host_name}${row.page_path}`}
                    />
                  </th>
                  <td className="num">
                    <span className="cell-main">{formatCount(row.views)}</span>
                    {comparable && <Delta change={changeOf(row.views, row.previous_views)} />}
                  </td>
                  <td className="num">
                    {row.avg_engagement_seconds_per_view === null ? "—" : formatSeconds(row.avg_engagement_seconds_per_view)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
