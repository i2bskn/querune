import { type FormEvent, useState } from "react";
import type { DatasetSyncStatus, GoogleStatus, Site } from "../../../src/api/types";
import { deleteSite, requestSync, updateSite } from "../actions";
import { setFlash } from "../flash";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { type ApiClient, loadSiteDetail, loadSyncPanel, useView } from "../load";
import { changesProperty } from "../properties";
import { navigate } from "../router";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { SiteFields, UNKNOWN_RESULT_MESSAGE, handleSiteResult, siteFormValues, siteRequest } from "./SitesView";

const GONE_MESSAGE = "サイトが見つかりません。削除された可能性があります";

// One site: its settings to edit, and its deletion.
export function SiteDetailView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadSiteDetail(client, id), `site:${id}`);
  // The result of the last update, kept across the reload that follows.
  const [notice, setNotice] = useState<string | null>(null);
  useDocumentTitle(viewTitle(state, (site) => site.name));

  if (state.kind === "notFound") return <SiteGone />;
  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={GONE_MESSAGE} onReload={reload} />;
  }
  const site = state.data;

  return (
    <main className="main">
      <p className="breadcrumb">
        <Link to="/sites">サイト</Link>
      </p>
      <header className="page-head">
        <h1>{site.name}</h1>
        <p className="lead site-url">{site.url}</p>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <dl className="details">
        <dt>Search Console</dt>
        <dd>{site.gsc_property ?? "未設定"}</dd>
        <dt>GA4</dt>
        <dd>{site.ga4_property_id ?? "未設定"}</dd>
        <dt>登録</dt>
        <dd>
          <time dateTime={new Date(site.created_at).toISOString()}>{formatDateTime(site.created_at)}</time>
        </dd>
        <dt>更新</dt>
        <dd>
          <time dateTime={new Date(site.updated_at).toISOString()}>{formatDateTime(site.updated_at)}</time>
        </dd>
      </dl>
      <EditSiteForm
        // Keyed by the saved values, so that the form shows them again after a reload.
        key={site.updated_at}
        client={client}
        site={site}
        onUpdated={() => {
          setNotice("サイトを更新しました");
          reload();
        }}
        onGone={reload}
      />
      <SyncSection client={client} site={site} onGone={reload} />
      <DeleteSite client={client} site={site} onGone={reload} />
    </main>
  );
}

function SiteGone() {
  return (
    <main className="main empty-state">
      <h1>{GONE_MESSAGE}</h1>
      <p>
        <Link to="/sites" className="button">
          サイトの一覧へ
        </Link>
      </p>
    </main>
  );
}

function EditSiteForm({
  client,
  site,
  onUpdated,
  onGone,
}: {
  client: ApiClient;
  site: Site;
  onUpdated: () => void;
  // The site is gone: the reload shows the screen for a missing site.
  onGone: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState(() => siteFormValues(site));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await updateSite(client, site.id, siteRequest(values));
    if (handleSiteResult(result, setSending, setFailure)) {
      onUpdated();
    } else if (result.kind === "notFound") {
      onGone();
    }
  }

  return (
    <>
      <h2>設定</h2>
      <form className="folder-form" aria-label="サイトの設定" onSubmit={(event) => void onSubmit(event)}>
        <SiteFields values={values} onChange={setValues} disabled={sending} />
        {changesProperty(site, values) && (
          <p className="hint">プロパティを変えると、そのデータソースの取り込み済みデータは集計に使われなくなり、削除されます</p>
        )}
        <div className="folder-form-actions">
          <button type="submit" disabled={sending}>
            保存
          </button>
        </div>
        {failure !== null && <p role="alert">{failure}</p>}
      </form>
    </>
  );
}

// The deletion, confirmed on the page by typing the name of the site.
function DeleteSite({ client, site, onGone }: { client: ApiClient; site: Site; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Compared as typed, not trimmed.
    if (confirmation !== site.name) return;
    setSending(true);
    setFailure(null);
    const result = await deleteSite(client, site.id);
    switch (result.kind) {
      case "ok":
        setFlash("サイトを削除しました");
        navigate("/sites");
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
        // The move to the login page has started; the buttons stay disabled.
        return;
    }
  }

  return (
    <>
      <h2>削除</h2>
      {!open ? (
        <div className="actions">
          <button
            type="button"
            className="button-danger-outline"
            onClick={() => {
              setOpen(true);
              setConfirmation("");
              setFailure(null);
            }}
          >
            サイトを削除
          </button>
        </div>
      ) : (
        <form className="folder-form" aria-label="サイトを削除" onSubmit={(event) => void onSubmit(event)}>
          <p>{site.name} を削除します。取り込み済みのデータも削除します。元に戻せません。</p>
          <label>
            確認のため、このサイトの名前を入力してください
            <input
              type="text"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              disabled={sending}
            />
          </label>
          <div className="folder-form-actions">
            <button type="submit" className="button-danger" disabled={sending || confirmation !== site.name}>
              削除
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={sending}>
              やめる
            </button>
          </div>
          {failure !== null && <p role="alert">{failure}</p>}
        </form>
      )}
    </>
  );
}

const DATASET_LABELS: Record<DatasetSyncStatus["dataset"], string> = {
  gsc_pages: "Search Console ページ別",
  gsc_queries: "Search Console クエリ別",
  ga4_landing_pages: "GA4 ランディングページ別",
};

const DAY_MS = 24 * 60 * 60 * 1000;

// A date in UTC as YYYY-MM-DD, days before today.
function utcDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

// The import of Search Console and GA4: the service account, the state of each dataset, and the form to import a
// period.
function SyncSection({ client, site, onGone }: { client: ApiClient; site: Site; onGone: () => void }) {
  // Loaded again after the site is saved, since its properties may have changed.
  const [state, reload] = useView(() => loadSyncPanel(client, site.id), `sync:${site.id}:${site.updated_at}`);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <h2>データの取り込み</h2>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {state.kind === "loading" && (
        <p className="hint" role="status">
          読み込み中…
        </p>
      )}
      {state.kind === "redirecting" && <p className="hint">ログイン画面へ移動しています…</p>}
      {state.kind === "notFound" && <p role="alert">{GONE_MESSAGE}</p>}
      {state.kind === "error" && (
        <div className="actions">
          <p role="alert">{state.message}</p>
          <button type="button" onClick={reload}>
            再読み込み
          </button>
        </div>
      )}
      {state.kind === "ready" && (
        <>
          <ServiceAccount google={state.data.google} />
          {state.data.status.datasets.map((dataset) => (
            <DatasetStatus key={dataset.dataset} status={dataset} />
          ))}
          <SyncForm
            client={client}
            site={site}
            disabled={!state.data.google.configured}
            onRequested={(message) => {
              setNotice(message);
              reload();
            }}
            onGone={onGone}
          />
        </>
      )}
    </>
  );
}

function ServiceAccount({ google }: { google: GoogleStatus }) {
  if (google.configured) {
    return (
      <dl className="details">
        <dt>サービスアカウント</dt>
        <dd>
          <code>{google.client_email}</code>
        </dd>
        <dt>権限</dt>
        <dd>
          このメールアドレスを Search Console のプロパティのユーザー（制限付きで可）と、GA4
          のプロパティのアクセス管理（閲覧者）に追加してください
        </dd>
      </dl>
    );
  }
  return (
    <p className="notice" role="status">
      {google.error === "invalid"
        ? "サービスアカウントの鍵（GOOGLE_SERVICE_ACCOUNT_KEY）を確認してください"
        : "サービスアカウントの鍵（GOOGLE_SERVICE_ACCOUNT_KEY）が設定されていません"}
    </p>
  );
}

function DatasetStatus({ status }: { status: DatasetSyncStatus }) {
  const label = DATASET_LABELS[status.dataset];
  if (!status.configured) {
    return (
      <dl className="details">
        <dt>{label}</dt>
        <dd>プロパティが設定されていません</dd>
      </dl>
    );
  }
  return (
    <dl className="details" aria-label={label}>
      <dt>{label}</dt>
      <dd>
        <span className="site-url">{status.property}</span>
      </dd>
      <dt>最新の日</dt>
      <dd>{status.latest_date ?? "なし"}</dd>
      <dt>速報値の開始日</dt>
      <dd>{status.provisional_from ?? "なし"}</dd>
      <dt>取得済みの日数</dt>
      <dd>
        <span className="nowrap">{status.available_days} 日</span>
      </dd>
      <dt>最後に取り込んだ時刻</dt>
      <dd>
        {status.last_succeeded_at === null ? (
          "なし"
        ) : (
          <time dateTime={new Date(status.last_succeeded_at).toISOString()}>{formatDateTime(status.last_succeeded_at)}</time>
        )}
      </dd>
      <dt>待ち・実行中・失敗</dt>
      <dd>
        <span className="nowrap">待ち {status.queued} 日</span>
        <span className="nowrap">実行中 {status.running} 日</span>
        <span className="nowrap">失敗 {status.failed} 日</span>
      </dd>
      {status.truncated_days > 0 && (
        <>
          <dt>打ち切り</dt>
          <dd>
            <span className="nowrap">{status.truncated_days} 日</span>
            （行数の上限で一部だけを取り込みました）
          </dd>
        </>
      )}
      {status.recent_failures.length > 0 && (
        <>
          <dt>最近の失敗</dt>
          <dd>
            <ul className="hint">
              {status.recent_failures.map((failure) => (
                <li key={failure.date}>
                  <span className="nowrap">{failure.date}</span>: {failure.error_message ?? failure.error_code}
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  );
}

function SyncForm({
  client,
  site,
  disabled,
  onRequested,
  onGone,
}: {
  client: ApiClient;
  site: Site;
  disabled: boolean;
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
        onRequested(`${result.result.days} 日分（${result.result.queued} 件）の取り込みを依頼しました`);
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
        // The move to the login page has started; the buttons stay disabled.
        return;
    }
  }

  return (
    <form className="folder-form" aria-label="データの取り込み" onSubmit={(event) => void onSubmit(event)}>
      <p className="hint">日付は UTC で、一度に 90 日まで取り込めます。</p>
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
      <div className="folder-form-actions">
        <button type="submit" disabled={sending || disabled}>
          取り込む
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}
