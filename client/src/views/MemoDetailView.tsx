import { type FormEvent, useState } from "react";
import type { ArticleSummary, Memo } from "../../../src/api/types";
import { deleteMemo, updateMemo } from "../actions";
import { setFlash } from "../flash";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { type ApiClient, loadMemoDetail, useView } from "../load";
import { memoFormValues, memoRequest } from "../records";
import { navigate } from "../router";
import { SiteBreadcrumb, Tags, handleItemResult } from "./ArticlesView";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { MemoFields } from "./MemosView";
import { UNKNOWN_RESULT_MESSAGE } from "./SitesView";

const GONE_MESSAGE = "メモが見つかりません。削除された可能性があります";

// One memo: its details, the edit form and the deletion.
export function MemoDetailView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadMemoDetail(client, id), `memo:${id}`);
  const [notice, setNotice] = useState<string | null>(null);
  useDocumentTitle(viewTitle(state, (data) => data.memo.title));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={GONE_MESSAGE} onReload={reload} />;
  }
  const { memo, site, articles } = state.data;

  return (
    <main className="main">
      <SiteBreadcrumb site={site} section="memos" />
      <header className="page-head">
        <h1>{memo.title}</h1>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <dl className="details">
        <dt>本文</dt>
        <dd>{memo.content === "" ? "なし" : <span className="text-body">{memo.content}</span>}</dd>
        <dt>タグ</dt>
        <dd>{memo.tags.length === 0 ? "なし" : <Tags tags={memo.tags} />}</dd>
        <dt>関連する記事</dt>
        <dd>
          {memo.articles.length === 0 ? (
            "なし"
          ) : (
            <ul className="plain-list">
              {memo.articles.map((article) => (
                <li key={article.id}>
                  <Link to={`/articles/${article.id}`}>{article.title}</Link>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      <p className="hint">
        登録 <time dateTime={new Date(memo.created_at).toISOString()}>{formatDateTime(memo.created_at)}</time>・更新{" "}
        <time dateTime={new Date(memo.updated_at).toISOString()}>{formatDateTime(memo.updated_at)}</time>
      </p>
      <EditMemoForm
        // Keyed by the saved values, so that the form shows them again after a reload.
        key={memo.updated_at}
        client={client}
        memo={memo}
        articles={articles}
        onUpdated={() => {
          setNotice("メモを更新しました");
          reload();
        }}
        onGone={reload}
      />
      <DeleteMemo client={client} memo={memo} onGone={reload} />
    </main>
  );
}

function EditMemoForm({
  client,
  memo,
  articles,
  onUpdated,
  onGone,
}: {
  client: ApiClient;
  memo: Memo;
  articles: ArticleSummary[];
  onUpdated: () => void;
  onGone: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState(() => memoFormValues(memo));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await updateMemo(client, memo.id, memoRequest(values));
    if (handleItemResult(result, setSending, setFailure)) {
      onUpdated();
    } else if (result.kind === "notFound") {
      onGone();
    }
  }

  return (
    <>
      <h2>編集</h2>
      <form className="folder-form" aria-label="メモの編集" onSubmit={(event) => void onSubmit(event)}>
        <MemoFields values={values} onChange={setValues} articles={articles} disabled={sending} />
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
function DeleteMemo({ client, memo, onGone }: { client: ApiClient; memo: Memo; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onDelete() {
    setSending(true);
    setFailure(null);
    const result = await deleteMemo(client, memo.id);
    switch (result.kind) {
      case "ok":
        setFlash("メモを削除しました");
        navigate(`/sites/${memo.site_id}/memos`);
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
            メモを削除
          </button>
        </div>
      ) : (
        <div className="folder-form" role="group" aria-label="メモを削除">
          <p>{memo.title} を削除します。元に戻せません。</p>
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
