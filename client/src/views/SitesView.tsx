import type { Site } from "../../../src/api/types";
import type { SiteResult } from "../actions";

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
      <div className="field-row">
        <label className="field">
          <span className="field-label">名前</span>
          <input
            type="text"
            value={values.name}
            onChange={(event) => onChange({ ...values, name: event.target.value })}
            autoComplete="off"
            required
            maxLength={SITE_NAME_MAX_LENGTH}
            placeholder="例: cyfr.dev"
            disabled={disabled}
          />
          <span className="field-hint">{SITE_NAME_MAX_LENGTH}&nbsp;文字以内</span>
        </label>
        <label className="field">
          <span className="field-label">URL</span>
          <input
            type="url"
            value={values.url}
            onChange={(event) => onChange({ ...values, url: event.target.value })}
            autoComplete="off"
            required
            placeholder="https://example.com"
            disabled={disabled}
          />
          <span className="field-hint">パス以降は保存されません</span>
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">
            Search Console のプロパティ<span className="optional">任意</span>
          </span>
          <input
            type="text"
            value={values.gscProperty}
            onChange={(event) => onChange({ ...values, gscProperty: event.target.value })}
            autoComplete="off"
            placeholder="sc-domain:example.com"
            disabled={disabled}
          />
          <span className="field-hint">
            ドメインは sc-domain:example.com、<span className="nowrap">URL プレフィックス</span>は https://example.com/
          </span>
        </label>
        <label className="field">
          <span className="field-label">
            GA4 のプロパティ ID<span className="optional">任意</span>
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={values.ga4PropertyId}
            onChange={(event) => onChange({ ...values, ga4PropertyId: event.target.value })}
            autoComplete="off"
            placeholder="123456789"
            disabled={disabled}
          />
          <span className="field-hint">数字のみ（GA4 の管理 → プロパティの詳細）</span>
        </label>
      </div>
    </>
  );
}
