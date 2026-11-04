import { type FormEvent, useState } from "react";
import type { Site } from "../../../src/api/types";
import { type SiteResult, createSite } from "../actions";
import { PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadSites, useView } from "../load";
import { ViewStatus, useDocumentTitle, useFlashNotice, viewTitle } from "./common";

export const UNKNOWN_RESULT_MESSAGE = "サーバーに接続できませんでした。読み込み直して確かめてください";
const SITE_NAME_MAX_LENGTH = 100;

// The values of the form of a site, as typed. The server trims them and treats blank properties as not set.
export type SiteFormValues = { name: string; url: string; gscProperty: string; ga4PropertyId: string };

export const EMPTY_SITE_FORM: SiteFormValues = { name: "", url: "", gscProperty: "", ga4PropertyId: "" };

export function siteFormValues(site: Site): SiteFormValues {
  return {
    name: site.name,
    url: site.url,
    gscProperty: site.gsc_property ?? "",
    ga4PropertyId: site.ga4_property_id ?? "",
  };
}

// The request body for the form values: every item is sent, blank properties as null.
export function siteRequest(values: SiteFormValues) {
  return {
    name: values.name,
    url: values.url,
    gsc_property: values.gscProperty.trim() === "" ? null : values.gscProperty,
    ga4_property_id: values.ga4PropertyId.trim() === "" ? null : values.ga4PropertyId,
  };
}

// The sites, with the form to register one. Every signed-in user sees the same sites.
export function SitesView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadSites(client), "sites");
  // The result of the last operation, kept across the reload that follows; or the message of the screen before
  // (a site deleted on its screen).
  const [notice, setNotice] = useState<string | null>(null);
  useFlashNotice(setNotice);
  useDocumentTitle(viewTitle(state, () => "サイト"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  const sites = state.data;

  return (
    <main className="main">
      <header className="page-head">
        <h1>サイト</h1>
        <p className="lead">
          検索の実績を見るサイトです。Search Console のプロパティと GA4 のプロパティ ID を合わせて登録できます。
        </p>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <CreateSiteForm
        client={client}
        onCreated={() => {
          setNotice("サイトを登録しました");
          reload();
        }}
      />
      {sites.length === 0 ? (
        <p className="notice">サイトはまだ登録されていません。</p>
      ) : (
        <ul className="list sites">
          {sites.map((site) => (
            <li key={site.id}>
              <Link to={`/sites/${site.id}`} className="site-link">
                <span className="site-head">
                  <span className="site-name">{site.name}</span>
                  <span className="site-url">{site.url}</span>
                </span>
                <span className="site-meta">
                  <span>Search Console: {site.gsc_property ?? "未設定"}</span>
                  <span>GA4: {site.ga4_property_id ?? "未設定"}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function CreateSiteForm({ client, onCreated }: { client: ApiClient; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState<SiteFormValues>(EMPTY_SITE_FORM);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await createSite(client, siteRequest(values));
    if (handleSiteResult(result, setSending, setFailure)) {
      setOpen(false);
      onCreated();
    }
  }

  if (!open) {
    return (
      <div className="actions">
        <button
          type="button"
          className="button-primary"
          onClick={() => {
            setOpen(true);
            setValues(EMPTY_SITE_FORM);
            setFailure(null);
          }}
        >
          <PlusIcon />
          サイトを登録
        </button>
      </div>
    );
  }
  return (
    <form className="folder-form" aria-label="サイトを登録" onSubmit={(event) => void onSubmit(event)}>
      <SiteFields values={values} onChange={setValues} disabled={sending} />
      <div className="folder-form-actions">
        <button type="submit" disabled={sending}>
          登録
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

// Settles the state of a form after a request. True when it succeeded; notFound is left to the caller.
export function handleSiteResult(
  result: SiteResult,
  setSending: (sending: boolean) => void,
  setFailure: (failure: string | null) => void,
): boolean {
  switch (result.kind) {
    case "ok":
      setSending(false);
      return true;
    case "notFound":
      setSending(false);
      return false;
    case "error":
      setSending(false);
      setFailure(result.message);
      return false;
    case "unknown":
      setSending(false);
      setFailure(UNKNOWN_RESULT_MESSAGE);
      return false;
    case "redirecting":
      // The move to the login page has started; the buttons stay disabled.
      return false;
  }
}

// The fields of a site, shared by the registration and the edit forms.
export function SiteFields({
  values,
  onChange,
  disabled,
}: {
  values: SiteFormValues;
  onChange: (values: SiteFormValues) => void;
  disabled: boolean;
}) {
  return (
    <>
      <label>
        名前（{SITE_NAME_MAX_LENGTH}&nbsp;文字以内）
        <input
          type="text"
          value={values.name}
          onChange={(event) => onChange({ ...values, name: event.target.value })}
          autoComplete="off"
          required
          maxLength={SITE_NAME_MAX_LENGTH}
          disabled={disabled}
        />
      </label>
      <label>
        URL（https://example.com の形式。パス以降は保存されません）
        <input
          type="url"
          value={values.url}
          onChange={(event) => onChange({ ...values, url: event.target.value })}
          autoComplete="off"
          required
          placeholder="https://example.com"
          disabled={disabled}
        />
      </label>
      <label>
        Search Console のプロパティ（省略可）
        <input
          type="text"
          value={values.gscProperty}
          onChange={(event) => onChange({ ...values, gscProperty: event.target.value })}
          autoComplete="off"
          placeholder="sc-domain:example.com または https://example.com/"
          disabled={disabled}
        />
      </label>
      <label>
        GA4 のプロパティ ID（省略可。数字のみ）
        <input
          type="text"
          inputMode="numeric"
          value={values.ga4PropertyId}
          onChange={(event) => onChange({ ...values, ga4PropertyId: event.target.value })}
          autoComplete="off"
          disabled={disabled}
        />
      </label>
    </>
  );
}
