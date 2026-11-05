import { type FormEvent, useState } from "react";
import type { Article } from "../../../src/api/types";
import { deleteArticle, updateArticle } from "../actions";
import { setFlash } from "../flash";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { type ApiClient, loadArticleDetail, loadRecordPage, useView } from "../load";
import { articleFormValues, articleRequest } from "../records";
import { navigate } from "../router";
import { ArticleDetails, ArticleFields, SiteBreadcrumb, handleItemResult } from "./ArticlesView";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { RecordPages } from "./RecordsView";
import { UNKNOWN_RESULT_MESSAGE } from "./SitesView";

const GONE_MESSAGE = "記事が見つかりません。削除された可能性があります";
// The linked records shown per page.
const RECORDS_PAGE = "50";

// One article: its details, the linked records, the edit form and the deletion.
export function ArticleDetailView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadArticleDetail(client, id), `article:${id}`);
  const [notice, setNotice] = useState<string | null>(null);
  useDocumentTitle(viewTitle(state, (data) => data.article.title));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={GONE_MESSAGE} onReload={reload} />;
  }
  const { article, site } = state.data;

  return (
    <main className="main">
      <SiteBreadcrumb site={site} section="articles" />
      <header className="page-head">
        <h1>{article.title}</h1>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <ArticleDetails article={article} />
      <p className="hint">
        登録 <time dateTime={new Date(article.created_at).toISOString()}>{formatDateTime(article.created_at)}</time>・更新{" "}
        <time dateTime={new Date(article.updated_at).toISOString()}>{formatDateTime(article.updated_at)}</time>
      </p>
      <h2>記録</h2>
      <div className="actions">
        <Link to={`/sites/${site.id}/records?article=${article.id}`} className="button">
          この記事の記録を追加
        </Link>
      </div>
      <LinkedRecords client={client} article={article} />
      <EditArticleForm
        // Keyed by the saved values, so that the form shows them again after a reload.
        key={article.updated_at}
        client={client}
        article={article}
        onUpdated={() => {
          setNotice("記事を更新しました");
          reload();
        }}
        onGone={reload}
      />
      <DeleteArticle client={client} article={article} onGone={reload} />
    </main>
  );
}

function LinkedRecords({ client, article }: { client: ApiClient; article: Article }) {
  const query = { article_id: article.id, limit: RECORDS_PAGE };
  const [state, reload] = useView(
    () => loadRecordPage(client, article.site_id, query),
    `article-records:${article.id}:${article.updated_at}`,
  );
  switch (state.kind) {
    case "loading":
      return (
        <p className="hint" role="status">
          読み込み中…
        </p>
      );
    case "redirecting":
      return <p className="hint">ログイン画面へ移動しています…</p>;
    case "notFound":
      return <p role="alert">サイトが見つかりません。削除された可能性があります</p>;
    case "error":
      return (
        <div className="actions">
          <p role="alert">{state.message}</p>
          <button type="button" onClick={reload}>
            再読み込み
          </button>
        </div>
      );
    case "ready":
      return (
        <RecordPages
          client={client}
          siteId={article.site_id}
          query={query}
          first={state.data}
          emptyMessage="この記事の記録はまだありません。"
        />
      );
  }
}

function EditArticleForm({
  client,
  article,
  onUpdated,
  onGone,
}: {
  client: ApiClient;
  article: Article;
  onUpdated: () => void;
  onGone: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState(() => articleFormValues(article));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await updateArticle(client, article.id, articleRequest(values));
    if (handleItemResult(result, setSending, setFailure)) {
      onUpdated();
    } else if (result.kind === "notFound") {
      onGone();
    }
  }

  return (
    <>
      <h2>編集</h2>
      <form className="folder-form" aria-label="記事の編集" onSubmit={(event) => void onSubmit(event)}>
        <ArticleFields values={values} onChange={setValues} disabled={sending} />
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

// The deletion, confirmed with a second button.
function DeleteArticle({ client, article, onGone }: { client: ApiClient; article: Article; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onDelete() {
    setSending(true);
    setFailure(null);
    const result = await deleteArticle(client, article.id);
    switch (result.kind) {
      case "ok":
        setFlash("記事を削除しました");
        navigate(`/sites/${article.site_id}/articles`);
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
    <>
      <h2>削除</h2>
      {!open ? (
        <div className="actions">
          <button
            type="button"
            className="button-danger-outline"
            onClick={() => {
              setOpen(true);
              setFailure(null);
            }}
          >
            記事を削除
          </button>
        </div>
      ) : (
        <div className="folder-form" role="group" aria-label="記事を削除">
          <p>{article.title} を削除します。ひも付く記録は残り、この記事とのひも付けだけが外れます。元に戻せません。</p>
          <div className="folder-form-actions">
            <button type="button" className="button-danger" onClick={() => void onDelete()} disabled={sending}>
              削除する
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={sending}>
              やめる
            </button>
          </div>
          {failure !== null && <p role="alert">{failure}</p>}
        </div>
      )}
    </>
  );
}
