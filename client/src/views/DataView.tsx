import { type FormEvent, useEffect, useState } from "react";
import type { DatasetSyncStatus, GoogleStatus, RecentDay, Site } from "../../../src/api/types";
import { requestSync } from "../actions";
import { CopyIcon, ExternalIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadSiteDetail, loadSyncPanel, useView } from "../load";
import { formatDate } from "../numbers";
import { formatDateTime } from "../format";
import { setCurrentSite } from "../siteContext";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { UNKNOWN_RESULT_MESSAGE } from "./SitesView";

const GONE_MESSAGE = "サイトが見つかりません。削除された可能性があります";

const DATASET_LABELS: Record<DatasetSyncStatus["dataset"], { source: string; detail: string }> = {
  gsc_pages: { source: "Search Console", detail: "ページ別" },
  gsc_queries: { source: "Search Console", detail: "クエリ別" },
  ga4_landing_pages: { source: "GA4", detail: "ランディングページ × チャネル" },
};

const DAY_STATE_LABELS: Record<RecentDay["state"], string> = {
  final: "確定",
  provisional: "速報値",
  pending: "取得待ち",
  failed: "失敗",
  missing: "未取得",
};

// A day imported successfully before whose last import failed.
function retryFailed(day: RecentDay): boolean {
  return (day.state === "final" || day.state === "provisional") && day.error_code !== null;
}

function dayLabel(day: RecentDay): string {
  let label = `${formatDate(day.date)} ${DAY_STATE_LABELS[day.state]}`;
  if (day.updating) label += "（取り直し中）";
  if (retryFailed(day)) label += "（取り直しに失敗）";
  return label;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A date in UTC as YYYY-MM-DD, days before today.
function utcDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

// The import of a site: the service account to add to the properties, the state of each dataset and the form to
// import a period.
export function DataView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadSiteDetail(client, id), `site:${id}`);
  useDocumentTitle(viewTitle(state, (site) => `データの取り込み - ${site.name}`));
  useEffect(() => {
    if (state.kind === "ready") setCurrentSite(state.data.id);
  }, [state]);
  if (state.kind !== "ready") return <ViewStatus state={state} notFoundMessage={GONE_MESSAGE} onReload={reload} />;
  const site = state.data;
  return (
    <main className="page">
      <header className="page-head">
        <div className="page-head-text">
          <p className="eyebrow">{site.name}</p>
          <h1>データの取り込み</h1>
          <p className="lead">
            Search Console と GA4 の集計を毎日 6:00 と 18:00（UTC・日本時間 15:00 と 3:00）に取り込みます。過去の期間や欠けた日はここから取り込めます。
          </p>
        </div>
      </header>
      <SyncPanel client={client} site={site} onGone={reload} />
    </main>
  );
}

function SyncPanel({ client, site, onGone }: { client: ApiClient; site: Site; onGone: () => void }) {
  const [state, reload] = useView(() => loadSyncPanel(client, site.id), `sync:${site.id}:${site.updated_at}`);
  const [notice, setNotice] = useState<string | null>(null);
  if (state.kind === "loading") {
    return (
      <p className="status" role="status">
        読み込み中…
      </p>
    );
  }
  if (state.kind === "redirecting") return <p className="status">ログイン画面へ移動しています…</p>;
  if (state.kind === "notFound") return <p role="alert">{GONE_MESSAGE}</p>;
  if (state.kind === "error") {
    return (
      <div className="actions">
        <p role="alert">{state.message}</p>
        <button type="button" onClick={reload}>
          再読み込み
        </button>
      </div>
    );
  }
  const { google, status } = state.data;
  return (
    <>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="grid-data">
        <SyncForm
          client={client}
          site={site}
          disabled={!google.configured}
          disabledReason={
            google.configured
              ? null
              : "サービスアカウントの鍵を設定すると取り込めます。手順は「サービスアカウント」を見てください。"
          }
          onRequested={(message) => {
            setNotice(message);
            reload();
          }}
          onGone={onGone}
        />
        <ServiceAccount google={google} />
      </div>
      <h2 className="section-title">取り込みの状態</h2>
      <ul className="dataset-grid">
        {status.datasets.map((dataset) => (
          <li key={dataset.dataset}>
            <DatasetCard status={dataset} siteId={site.id} />
          </li>
        ))}
      </ul>
    </>
  );
}

function ServiceAccount({ google }: { google: GoogleStatus }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel" aria-labelledby="service-account">
      <h2 className="panel-title" id="service-account">
        サービスアカウント
      </h2>
      {google.configured && google.client_email !== null ? (
        <>
          <p className="hint">
            このメールアドレスを、Search Console のプロパティのユーザー（制限付きで可）と、GA4 のプロパティのアクセス管理（閲覧者）に追加してください。
          </p>
          <div className="copy-field">
            <code>{google.client_email}</code>
            <button
              type="button"
              className="icon-button"
              aria-label="メールアドレスをコピー"
              title="メールアドレスをコピー"
              onClick={() => {
                const email = google.client_email ?? "";
                void navigator.clipboard?.writeText(email).then(() => {
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
        </>
      ) : (
        <>
          <p className="hint">
            {google.error === "invalid"
              ? "保存されている鍵を読み取れません。鍵（JSON）を作り直して保存し直してください。"
              : "取り込みには Google のサービスアカウントの鍵が必要です。"}
          </p>
          <ol className="steps">
            <li>Google Cloud で Search Console API と Google Analytics Data API を有効にする</li>
            <li>サービスアカウントを作り、鍵（JSON）を作成する</li>
            <li>
              鍵を Workers の Secret <code>GOOGLE_SERVICE_ACCOUNT_KEY</code> に保存する
            </li>
          </ol>
          <a
            href="https://github.com/i2bskn/querune/blob/main/docs/settings.md#search-console-と-ga4-の接続"
            target="_blank"
            rel="noopener noreferrer"
            className="external-link"
          >
            設定の手順を読む
            <ExternalIcon />
          </a>
        </>
      )}
    </section>
  );
}

function DatasetCard({ status, siteId }: { status: DatasetSyncStatus; siteId: string }) {
  const label = DATASET_LABELS[status.dataset];
  if (!status.configured) {
    return (
      <section className="panel dataset dataset-off" aria-label={`${label.source} ${label.detail}`}>
        <p className="dataset-source">{label.source}</p>
        <h3 className="dataset-name">{label.detail}</h3>
        <p className="hint">
          プロパティが設定されていません。<Link to={`/sites/${siteId}/settings`}>サイトの設定</Link>で登録できます。
        </p>
      </section>
    );
  }
  const busy = status.queued + status.running;
  const state = status.failed > 0 ? "warn" : busy > 0 ? "busy" : "ok";
  return (
    <section className={`panel dataset dataset-${state}`} aria-label={`${label.source} ${label.detail}`}>
      <p className="dataset-source">{label.source}</p>
      <h3 className="dataset-name">{label.detail}</h3>
      <p className="dataset-property mono">{status.property}</p>
      <dl className="dataset-stats">
        <div>
          <dt>取り込み済み</dt>
          <dd>
            {status.available_days}
            <small>日</small>
          </dd>
        </div>
        <div>
          <dt>最新の日</dt>
          <dd>
            {status.latest_date === null ? "—" : formatDate(status.latest_date)}
            {status.expected_latest_date !== null &&
              (status.latest_date === null || status.latest_date < status.expected_latest_date) && (
                <span className="dataset-expected">想定 {formatDate(status.expected_latest_date)}</span>
              )}
          </dd>
        </div>
        <div>
          <dt>待ち・実行中</dt>
          <dd>
            {busy}
            <small>日</small>
          </dd>
        </div>
        <div>
          <dt>失敗</dt>
          <dd className={status.failed > 0 ? "text-warn" : undefined}>
            {status.failed}
            <small>日</small>
          </dd>
        </div>
      </dl>
      <RecentDays status={status} />
      <p className="hint">
        {status.provisional_from !== null && <>{formatDate(status.provisional_from)} 以降は速報値です。</>}
        {status.last_succeeded_at !== null && (
          <>
            最後の取り込み{" "}
            <time dateTime={new Date(status.last_succeeded_at).toISOString()}>{formatDateTime(status.last_succeeded_at)}</time>
          </>
        )}
      </p>
      {status.truncated_days > 0 && (
        <p className="hint">{status.truncated_days} 日は行数の上限で一部だけを取り込みました。</p>
      )}
      {status.recent_failures.length > 0 && (
        <details className="failures">
          <summary>最近の失敗（{status.recent_failures.length} 件）</summary>
          <ul>
            {status.recent_failures.map((failure) => (
              <li key={failure.date}>
                <span className="mono">{failure.date}</span> {failure.error_message ?? failure.error_code}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// The state of each of the recent days, and how final days are decided.
function RecentDays({ status }: { status: DatasetSyncStatus }) {
  const days = status.recent_days;
  const first = days[0];
  const last = days.at(-1);
  const basis =
    status.state_basis === "api"
      ? `Search Console の API が未確定とした日を速報値にしています（行のない日は日数で推定）。直近 ${status.refresh_days} 日は毎日取り直します。`
      : `GA4 の API は確定を返さないため、経過日数で確定とみなしています（推定）。直近 ${status.refresh_days} 日は毎日取り直します。`;
  return (
    <div className="recent-days">
      {first !== undefined && last !== undefined && (
        <>
          <p className="recent-days-title">直近 {days.length} 日</p>
          <ol className="day-strip">
            {days.map((day) => (
              <li
                key={day.date}
                className={`day day-${day.state}${day.updating ? " day-updating" : ""}${retryFailed(day) ? " day-retry-failed" : ""}`}
                title={dayLabel(day)}
              >
                <span className="sr-only">{dayLabel(day)}</span>
              </li>
            ))}
          </ol>
          <p className="day-strip-range mono" aria-hidden="true">
            <span>{formatDate(first.date)}</span>
            <span>{formatDate(last.date)}</span>
          </p>
          <ul className="day-legend">
            {(Object.keys(DAY_STATE_LABELS) as RecentDay["state"][]).map((state) => (
              <li key={state}>
                <span className={`day day-${state}`} aria-hidden="true" />
                {DAY_STATE_LABELS[state]}
              </li>
            ))}
            <li>
              <span className="day day-final day-updating" aria-hidden="true" />
              取り直し中
            </li>
            <li>
              <span className="day day-final day-retry-failed" aria-hidden="true" />
              取り直しに失敗
            </li>
          </ul>
        </>
      )}
      <p className="hint">
        {basis}
        {status.time_zone !== null ? (
          <>日付は {status.time_zone} の日付です。</>
        ) : (
          status.state_basis === "elapsed_days" && <>タイムゾーン未確定（最初の取り込みで決まります）。</>
        )}
      </p>
    </div>
  );
}

const PRESETS = [
  { label: "7日", days: 7 },
  { label: "28日", days: 28 },
  { label: "90日", days: 90 },
];

function SyncForm({
  client,
  site,
  disabled,
  disabledReason,
  onRequested,
  onGone,
}: {
  client: ApiClient;
  site: Site;
  disabled: boolean;
  disabledReason: string | null;
  onRequested: (message: string) => void;
  onGone: () => void;
}) {
  const [startDate, setStartDate] = useState(() => utcDate(28));
  const [endDate, setEndDate] = useState(() => utcDate(1));
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await requestSync(client, site.id, { start_date: startDate, end_date: endDate });
    switch (result.kind) {
      case "ok":
        setSending(false);
        onRequested(`${result.result.days} 日分（${result.result.queued} 件）の取り込みを依頼しました。数分で反映されます。`);
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
    <form className="panel form" aria-labelledby="sync-title" onSubmit={(event) => void onSubmit(event)}>
      <h2 className="panel-title" id="sync-title">
        期間を選んで取り込む
      </h2>
      {disabledReason !== null && <p className="notice notice-warn">{disabledReason}</p>}
      <div className="segmented" role="group" aria-label="よく使う期間">
        {PRESETS.map((preset) => (
          <button
            key={preset.days}
            type="button"
            disabled={sending || disabled}
            aria-pressed={startDate === utcDate(preset.days) && endDate === utcDate(1)}
            onClick={() => {
              setStartDate(utcDate(preset.days));
              setEndDate(utcDate(1));
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="field-row">
        <label>
          開始日
          <input
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            required
            disabled={sending || disabled}
          />
        </label>
        <label>
          終了日
          <input
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            required
            disabled={sending || disabled}
          />
        </label>
      </div>
      <p className="hint">
        日付は Search Console では太平洋時間、GA4 ではプロパティのタイムゾーンの日付です。日本時間より 1 日遅れることがあります。一度に 90 日まで取り込め、取り込み済みの日は取り直します。
      </p>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={sending || disabled}>
          取り込む
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
