import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ImportArticleResult, ReadSitemapResponse, Site } from "../../../src/api/types";
import { importArticles, readSitemap } from "../actions";
import { CONNECTION_ERROR, type ApiClient } from "../load";
import { formatCount, formatDate, shortUrl } from "../numbers";
import { SITE_GONE_MESSAGE } from "./ArticlesView";

// The URLs sent to the server at a time (its limit).
const IMPORT_CHUNK = 10;
// The rows drawn at once; more are narrowed down with the filter.
const MAX_ROWS = 500;

// A request that got no response may have registered some of the URLs, so the list is checked after closing.
const IMPORT_UNKNOWN_MESSAGE = "サーバーに接続できませんでした。登録されたかどうかは閉じたあとの記事の一覧で確かめてください";

type Phase = "load" | "choose" | "importing" | "done";

type Progress = { done: number; total: number };

// Imports articles from the sitemap of a site: read the sitemap, choose the URLs, send them 10 at a time, and show the
// results. onClose gets whether anything was sent, so that the caller reloads the list only then: a request that
// failed or got no response may still have registered articles.
export function SitemapImport({
  client,
  site,
  onClose,
}: {
  client: ApiClient;
  site: Site;
  onClose: (sent: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("load");
  const [sitemapUrl, setSitemapUrl] = useState(`${site.url}/sitemap.xml`);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sitemap, setSitemap] = useState<ReadSitemapResponse | null>(null);
  const [filter, setFilter] = useState("");
  const [showRegistered, setShowRegistered] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // The articles the site can still register: the value of the sitemap, less those created since.
  const [remaining, setRemaining] = useState(0);
  const [progress, setProgress] = useState<Progress>({ done: 0, total: 0 });
  const [stopping, setStopping] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // By URL, in the order they were first sent; a retry replaces the result of its URL.
  const [results, setResults] = useState<ReadonlyMap<string, ImportArticleResult>>(new Map());
  const sent = useRef(false);
  const stopRequested = useRef(false);
  const unmounted = useRef(false);

  // Leaving the screen stops the import before its next request. Set again on mount for the double mount of
  // StrictMode.
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  async function onLoad(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setLoadError(null);
    const value = sitemapUrl.trim();
    const result = await readSitemap(client, site.id, { sitemap_url: value === "" ? null : value });
    if (unmounted.current) return;
    switch (result.kind) {
      case "ok":
        setLoading(false);
        setSitemap(result.sitemap);
        setRemaining(result.sitemap.remaining);
        setSelected(new Set());
        setFilter("");
        setShowRegistered(false);
        setPhase("choose");
        return;
      case "notFound":
        setLoading(false);
        setLoadError(SITE_GONE_MESSAGE);
        return;
      case "error":
        setLoading(false);
        setLoadError(result.message);
        return;
      case "unknown":
        setLoading(false);
        setLoadError(CONNECTION_ERROR);
        return;
      case "redirecting":
        return;
    }
  }

  async function runImport(urls: string[]) {
    stopRequested.current = false;
    setStopping(false);
    setRunError(null);
    setProgress({ done: 0, total: urls.length });
    setPhase("importing");
    for (let start = 0; start < urls.length; start += IMPORT_CHUNK) {
      if (stopRequested.current || unmounted.current) break;
      const chunk = urls.slice(start, start + IMPORT_CHUNK);
      sent.current = true;
      const result = await importArticles(client, site.id, { urls: chunk });
      if (unmounted.current || result.kind === "redirecting") return;
      if (result.kind !== "ok") {
        setRunError(
          result.kind === "notFound"
            ? SITE_GONE_MESSAGE
            : result.kind === "unknown"
              ? IMPORT_UNKNOWN_MESSAGE
              : result.message,
        );
        break;
      }
      const created = result.results.filter((item) => item.status === "created").length;
      setResults((previous) => {
        const next = new Map(previous);
        for (const item of result.results) next.set(item.url, item);
        return next;
      });
      setRemaining((previous) => Math.max(0, previous - created));
      setProgress({ done: start + chunk.length, total: urls.length });
    }
    setPhase("done");
  }

  function stop() {
    stopRequested.current = true;
    setStopping(true);
  }

  if (phase === "load" || sitemap === null) {
    return (
      <form
        className="panel form sitemap-import"
        aria-label="サイトマップから取り込む"
        onSubmit={(event) => void onLoad(event)}
      >
        <h2 className="panel-title">サイトマップから取り込む</h2>
        <p className="hint">サイトマップの URL を読み、選んだページのタイトルと公開日を記事に登録します。</p>
        <p className="hint">登録済みで公開日が空の記事は、選ぶと公開日だけを補います。</p>
        <p className="hint">
          毎日の自動登録の対象は新しく載ったページだけです。以前から載っているページや削除した記事はここから取り込んでください。
        </p>
        <label className="field">
          <span className="field-label">サイトマップの URL</span>
          <input
            type="url"
            value={sitemapUrl}
            onChange={(event) => setSitemapUrl(event.target.value)}
            autoComplete="off"
            placeholder={`${site.url}/sitemap.xml`}
            disabled={loading}
          />
        </label>
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={loading}>
            {loading ? "読み込み中…" : "読み込む"}
          </button>
          <button type="button" onClick={() => onClose(sent.current)} disabled={loading}>
            閉じる
          </button>
        </div>
        {loadError !== null && (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        )}
      </form>
    );
  }

  if (phase === "choose") {
    return (
      <ChooseUrls
        site={site}
        sitemap={sitemap}
        filter={filter}
        onFilterChange={setFilter}
        showRegistered={showRegistered}
        onShowRegisteredChange={setShowRegistered}
        selected={selected}
        onSelectedChange={setSelected}
        remaining={remaining}
        onImport={() => void runImport(sitemap.urls.filter((item) => selected.has(item.url)).map((item) => item.url))}
        onBack={() => {
          setLoadError(null);
          setPhase("load");
        }}
      />
    );
  }

  if (phase === "importing") {
    return (
      <section className="panel form sitemap-import" aria-label="サイトマップから取り込む">
        <h2 className="panel-title">取り込み中</h2>
        <progress className="sitemap-progress" max={progress.total} value={progress.done} aria-label="取り込みの進捗" />
        <p className="hint" role="status">
          {formatCount(progress.done)} / {formatCount(progress.total)} 件
        </p>
        <div className="form-actions">
          <button type="button" onClick={stop} disabled={stopping}>
            {stopping ? "中止しています…" : "中止"}
          </button>
        </div>
      </section>
    );
  }

  const all = [...results.values()];
  const failed = all.filter((item): item is Extract<ImportArticleResult, { status: "failed" }> => item.status === "failed");
  const createdCount = all.filter((item) => item.status === "created").length;
  const datedCount = all.filter((item) => item.status === "dated").length;
  const existsCount = all.filter((item) => item.status === "exists").length;
  const unsent = progress.total - progress.done;
  // Only the URLs without an article take room; the registered ones only get their date.
  const registered = new Set(sitemap.urls.filter((item) => item.registered).map((item) => item.url));
  const retryOverLimit = failed.filter((item) => !registered.has(item.url)).length > remaining;
  return (
    <section className="panel form sitemap-import" aria-label="サイトマップから取り込む">
      <h2 className="panel-title">取り込みの結果</h2>
      <p className="sitemap-summary" role="status">
        登録 {formatCount(createdCount)} 件・公開日を補った記事 {formatCount(datedCount)} 件・登録済み{" "}
        {formatCount(existsCount)} 件・失敗 {formatCount(failed.length)} 件
      </p>
      {runError !== null && (
        <p className="form-error" role="alert">
          {runError}
        </p>
      )}
      {unsent > 0 && <p className="hint">取り込みを終えていない URL が {formatCount(unsent)} 件あります。</p>}
      {failed.length > 0 && (
        <details className="failures">
          <summary>失敗した URL と理由</summary>
          <ul>
            {failed.map((item) => (
              <li key={item.url}>
                <span className="mono">{shortUrl(item.url, site.url)}</span>: {item.error}
              </li>
            ))}
          </ul>
        </details>
      )}
      {failed.length > 0 && retryOverLimit && (
        <p className="notice notice-warn">記事はあと {formatCount(remaining)} 件まで登録できます</p>
      )}
      <div className="form-actions">
        {failed.length > 0 && (
          <button
            type="button"
            className="button-primary"
            disabled={retryOverLimit}
            onClick={() => void runImport(failed.map((item) => item.url))}
          >
            失敗した {formatCount(failed.length)} 件をもう一度取り込む
          </button>
        )}
        <button type="button" onClick={() => onClose(sent.current)}>
          閉じる
        </button>
      </div>
    </section>
  );
}

// The path and query of a URL of the site, lowercased, for the filter.
function filterKey(url: string, origin: string): string {
  return shortUrl(url, origin).toLowerCase();
}

function ChooseUrls({
  site,
  sitemap,
  filter,
  onFilterChange,
  showRegistered,
  onShowRegisteredChange,
  selected,
  onSelectedChange,
  remaining,
  onImport,
  onBack,
}: {
  site: Site;
  sitemap: ReadSitemapResponse;
  filter: string;
  onFilterChange: (filter: string) => void;
  showRegistered: boolean;
  onShowRegisteredChange: (show: boolean) => void;
  selected: ReadonlySet<string>;
  onSelectedChange: (selected: ReadonlySet<string>) => void;
  remaining: number;
  onImport: () => void;
  onBack: () => void;
}) {
  const rows = useMemo(
    () =>
      sitemap.urls.map((item) => ({
        ...item,
        label: shortUrl(item.url, site.url),
        key: filterKey(item.url, site.url),
        // A registered article is chosen only to fill its missing published date.
        selectable: !item.registered || item.undated,
      })),
    [sitemap, site.url],
  );
  const needle = filter.trim().toLowerCase();
  const matched = rows.filter((row) => (showRegistered || row.selectable) && (needle === "" || row.key.includes(needle)));
  const drawn = matched.slice(0, MAX_ROWS);
  const unregistered = sitemap.urls.filter((item) => !item.registered).length;
  const undated = sitemap.urls.filter((item) => item.undated).length;
  // Only the URLs without an article take room.
  const newSelected = rows.filter((row) => !row.registered && selected.has(row.url)).length;
  const overLimit = newSelected > remaining;
  const skipped: string[] = [];
  if (sitemap.skipped_sitemaps > 0) skipped.push(`読めなかったサイトマップ ${formatCount(sitemap.skipped_sitemaps)} 件`);
  if (sitemap.skipped_urls > 0) skipped.push(`対象外の URL ${formatCount(sitemap.skipped_urls)} 件`);

  function toggle(url: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(url);
    else next.delete(url);
    onSelectedChange(next);
  }

  function selectMatched() {
    const next = new Set(selected);
    for (const row of matched) if (row.selectable) next.add(row.url);
    onSelectedChange(next);
  }

  return (
    <section className="panel form sitemap-import" aria-label="サイトマップから取り込む">
      <h2 className="panel-title">取り込む URL を選ぶ</h2>
      <div className="sitemap-summary">
        <p>
          {formatCount(sitemap.urls.length)} 件の URL のうち、未登録は {formatCount(unregistered)} 件
        </p>
        {undated > 0 && <p className="hint">公開日が空の登録済みの記事が {formatCount(undated)} 件あります</p>}
        {sitemap.truncated && <p className="hint">先頭の 5000 件だけを表示しています</p>}
        {skipped.length > 0 && <p className="hint">{skipped.join("・")}を除きました</p>}
      </div>
      <div className="sitemap-tools">
        <label className="field">
          <span className="field-label">URL で絞り込む</span>
          <input
            type="search"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            autoComplete="off"
            placeholder="/posts/ など"
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={showRegistered}
            onChange={(event) => onShowRegisteredChange(event.target.checked)}
          />
          登録済みも表示
        </label>
      </div>
      <div className="form-actions">
        <button type="button" onClick={selectMatched} disabled={matched.every((row) => !row.selectable)}>
          絞り込んだ結果をすべて選ぶ
        </button>
        <button type="button" onClick={() => onSelectedChange(new Set())} disabled={selected.size === 0}>
          選択を外す
        </button>
      </div>
      {drawn.length === 0 ? (
        <p className="hint">該当する URL はありません。</p>
      ) : (
        <ul className="sitemap-list" aria-label="サイトマップの URL">
          {drawn.map((row) => (
            <li key={row.url}>
              <label className="sitemap-row">
                <input
                  type="checkbox"
                  checked={row.selectable && selected.has(row.url)}
                  disabled={!row.selectable}
                  onChange={(event) => toggle(row.url, event.target.checked)}
                />
                <span className="sitemap-url mono" title={row.url}>
                  {row.label}
                </span>
                {row.registered && <span className="tag">{row.undated ? "公開日なし" : "登録済み"}</span>}
                {row.lastmod !== null && <span className="sitemap-date">{formatDate(row.lastmod)}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
      {matched.length > drawn.length && (
        <p className="hint">ほかに {formatCount(matched.length - drawn.length)} 件あります。URL で絞り込んでください</p>
      )}
      {overLimit && <p className="notice notice-warn">記事はあと {formatCount(remaining)} 件まで登録できます</p>}
      <div className="form-actions">
        <button type="button" className="button-primary" disabled={selected.size === 0 || overLimit} onClick={onImport}>
          選んだ {formatCount(selected.size)} 件を取り込む
        </button>
        <button type="button" onClick={onBack}>
          戻る
        </button>
      </div>
    </section>
  );
}
