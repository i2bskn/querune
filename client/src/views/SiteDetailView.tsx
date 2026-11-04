import { type FormEvent, useState } from "react";
import type { Site } from "../../../src/api/types";
import { deleteSite, updateSite } from "../actions";
import { setFlash } from "../flash";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { type ApiClient, loadSiteDetail, useView } from "../load";
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
          <p>{site.name} を削除します。元に戻せません。</p>
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
