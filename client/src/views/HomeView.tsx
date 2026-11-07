import { type FormEvent, useState } from "react";
import type { OverviewSeries, Site } from "../../../src/api/types";
import { createSite } from "../actions";
import { CopyIcon, PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadOverview, useView } from "../load";
import { changeOf, formatCount } from "../numbers";
import { setCurrentSite, sitesChanged } from "../siteContext";
import { navigate } from "../router";
import { type ChartTone, Sparkline } from "./charts";
import { ViewStatus, useDocumentTitle, useFlashNotice, viewTitle } from "./common";
import { Delta } from "./metrics";
import { EMPTY_SITE_FORM, SiteFields, type SiteFormValues, handleSiteResult, siteRequest } from "./SitesView";

// Every site with its last 28 days, the form to add a site, and the URL that AI apps connect to.
export function HomeView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadOverview(client), "overview");
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useFlashNotice(setNotice);
  useDocumentTitle(viewTitle(state, () => "すべてのサイト"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  const { sites, overview } = state.data;
  const bySite = new Map(overview.sites.map((entry) => [entry.site_id, entry]));

  return (
    <main className="page">
      <header className="page-head">
        <div className="page-head-text">
          <h1>すべてのサイト</h1>
          <p className="lead">
            直近 {overview.period.days} 日（{overview.period.start.replaceAll("-", "/")}〜{overview.period.end.replaceAll("-", "/")}）のクリックとセッション。カードを開くと推移とメモを並べて見られます。
          </p>
        </div>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {sites.length === 0 ? (
        <section className="onboarding">
          <h2>最初のサイトを登録する</h2>
          <p>サイトの URL と Search Console・GA4 のプロパティを登録すると、毎日の実績を取り込めます。</p>
          <CreateSiteForm client={client} onClose={null} />
        </section>
      ) : (
        <>
          <ul className="site-grid">
            {sites.map((site) => {
              const entry = bySite.get(site.id);
              return (
                <li key={site.id}>
                  <SiteCard site={site} clicks={entry?.clicks ?? null} sessions={entry?.sessions ?? null} />
                </li>
              );
            })}
            {!adding && (
              <li>
                <button type="button" className="site-card site-card-add" onClick={() => setAdding(true)}>
                  <PlusIcon />
                  サイトを追加
                </button>
              </li>
            )}
          </ul>
          {adding && <CreateSiteForm client={client} onClose={() => setAdding(false)} />}
        </>
      )}
      <ConnectAi />
    </main>
  );
}

function SiteCard({ site, clicks, sessions }: { site: Site; clicks: OverviewSeries | null; sessions: OverviewSeries | null }) {
  return (
    <Link to={`/sites/${site.id}`} className="site-card">
      <span className="site-card-head">
        <span className="site-card-name">{site.name}</span>
        {site.name !== site.url.replace(/^https?:\/\//, "") && (
          <span className="site-card-url">{site.url.replace(/^https?:\/\//, "")}</span>
        )}
      </span>
      <span className="site-card-metrics">
        <CardMetric label="クリック" series={clicks} tone="search" missing="Search Console 未設定" />
        <CardMetric label="セッション" series={sessions} tone="sessions" missing="GA4 未設定" />
      </span>
    </Link>
  );
}

function CardMetric({
  label,
  series,
  tone,
  missing,
}: {
  label: string;
  series: OverviewSeries | null;
  tone: ChartTone;
  missing: string;
}) {
  if (series === null) {
    return (
      <span className="card-metric card-metric-empty">
        <span className="card-metric-label">{label}</span>
        <span className="card-metric-missing">{missing}</span>
      </span>
    );
  }
  return (
    <span className="card-metric">
      <span className="card-metric-label">{label}</span>
      <span className="card-metric-value">
        {formatCount(series.total)}
        <Delta change={changeOf(series.total, series.previous_total)} />
      </span>
      <Sparkline values={series.daily} tone={tone} />
    </span>
  );
}

// onClose is null when the form is the only way forward (no site yet).
function CreateSiteForm({ client, onClose }: { client: ApiClient; onClose: (() => void) | null }) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState<SiteFormValues>(EMPTY_SITE_FORM);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await createSite(client, siteRequest(values));
    if (handleSiteResult(result, setSending, setFailure) && result.kind === "ok") {
      sitesChanged();
      setCurrentSite(result.site.id);
      navigate(`/sites/${result.site.id}/data`);
    }
  }

  return (
    <form className="panel form editor" aria-label="サイトを追加" onSubmit={(event) => void onSubmit(event)}>
      <h2 className="panel-title">サイトを追加</h2>
      <SiteFields values={values} onChange={setValues} disabled={sending} />
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={sending}>
          登録して取り込みへ
        </button>
        {onClose !== null && (
          <button type="button" onClick={onClose} disabled={sending}>
            やめる
          </button>
        )}
      </div>
      {failure !== null && (
        <p className="form-error" role="alert">
          {failure}
        </p>
      )}
    </form>
  );
}

// The URL of the MCP server, with a button to copy it.
function ConnectAi() {
  const url = `${location.origin}/mcp`;
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel connect" aria-labelledby="connect-title">
      <div>
        <h2 className="panel-title" id="connect-title">
          AI とつなぐ
        </h2>
        <p className="hint">
          AI アプリ（Claude・ChatGPT など）にこの URL を MCP サーバーとして追加します。表示される画面で接続を許可すると、AI
          が実績とメモを読み、メモと記事を書き込めます。
        </p>
      </div>
      <div className="copy-field">
        <code>{url}</code>
        <button
          type="button"
          className="icon-button"
          aria-label="URL をコピー"
          title="URL をコピー"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          <CopyIcon />
        </button>
        <span className="copy-status" role="status">
          {copied ? "コピーしました" : ""}
        </span>
      </div>
    </section>
  );
}
