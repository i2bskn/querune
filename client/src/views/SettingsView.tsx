import { type FormEvent, useEffect, useState } from "react";
import type { Site } from "../../../src/api/types";
import { deleteSite, updateSite } from "../actions";
import { setFlash } from "../flash";
import { formatDateTime } from "../format";
import { type ApiClient, loadSiteDetail, useView } from "../load";
import { changesProperty } from "../properties";
import { navigate } from "../router";
import { setCurrentSite, sitesChanged } from "../siteContext";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { SiteFields, UNKNOWN_RESULT_MESSAGE, handleSiteResult, siteFormValues, siteRequest } from "./SitesView";

const GONE_MESSAGE = "サイトが見つかりません。削除された可能性があります";

// The settings of a site and its deletion.
export function SettingsView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadSiteDetail(client, id), `site:${id}`);
  const [notice, setNotice] = useState<string | null>(null);
  useDocumentTitle(viewTitle(state, (site) => `サイトの設定 - ${site.name}`));
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
          <h1>サイトの設定</h1>
          <p className="lead">
            <span className="nowrap">登録 {formatDateTime(site.created_at)}</span>
            <span className="nowrap">・更新 {formatDateTime(site.updated_at)}</span>
          </p>
        </div>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <EditSiteForm
        key={site.updated_at}
        client={client}
        site={site}
        onUpdated={() => {
          setNotice("サイトを更新しました");
          sitesChanged();
          reload();
        }}
        onGone={reload}
      />
      <DeleteSite client={client} site={site} onGone={reload} />
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
    if (handleSiteResult(result, setSending, setFailure)) onUpdated();
    else if (result.kind === "notFound") onGone();
  }

  return (
    <form className="panel form" aria-labelledby="site-settings" onSubmit={(event) => void onSubmit(event)}>
      <h2 className="panel-title" id="site-settings">
        サイトとデータソース
      </h2>
      <SiteFields values={values} onChange={setValues} disabled={sending} />
      {changesProperty(site, values) && (
        <p className="notice notice-warn">
          プロパティを変えると、そのデータソースの取り込み済みデータは集計に使われなくなり、削除されます。
        </p>
      )}
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

// The deletion, confirmed by typing the name of the site.
function DeleteSite({ client, site, onGone }: { client: ApiClient; site: Site; onGone: () => void }) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation !== site.name) return;
    setSending(true);
    setFailure(null);
    const result = await deleteSite(client, site.id);
    switch (result.kind) {
      case "ok":
        setFlash("サイトを削除しました");
        setCurrentSite(null);
        sitesChanged();
        navigate("/");
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
    <form className="panel form danger-zone" aria-labelledby="delete-site" onSubmit={(event) => void onSubmit(event)}>
      <h2 className="panel-title" id="delete-site">
        サイトを削除
      </h2>
      <p>取り込み済みのデータと、記事・メモもすべて削除します。元に戻せません。</p>
      <label className="field">
        <span className="field-label">確認のため「{site.name}」と入力してください</span>
        <input
          type="text"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
          disabled={sending}
        />
      </label>
      <div className="form-actions">
        <button type="submit" className="button-danger" disabled={sending || confirmation !== site.name}>
          削除する
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
