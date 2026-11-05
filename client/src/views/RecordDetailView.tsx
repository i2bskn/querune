import { type FormEvent, useState } from "react";
import type { ArticleSummary, SiteRecord } from "../../../src/api/types";
import { deleteRecord, updateRecord } from "../actions";
import { setFlash } from "../flash";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { type ApiClient, loadRecordDetail, useView } from "../load";
import { KIND_LABELS, STATUS_LABELS, periodText, recordFormValues, recordRequest } from "../records";
import { navigate } from "../router";
import { SiteBreadcrumb, Tags, handleItemResult } from "./ArticlesView";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { RecordFields } from "./RecordsView";
import { UNKNOWN_RESULT_MESSAGE } from "./SitesView";

const GONE_MESSAGE = "記録が見つかりません。削除された可能性があります";

// One record: its details, the edit form and the deletion.
export function RecordDetailView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadRecordDetail(client, id), `record:${id}`);
  const [notice, setNotice] = useState<string | null>(null);
  useDocumentTitle(viewTitle(state, (data) => data.record.title));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={GONE_MESSAGE} onReload={reload} />;
  }
  const { record, site, articles } = state.data;
  const period = periodText(record.period_start, record.period_end);

  return (
    <main className="main">
      <SiteBreadcrumb site={site} section="records" />
      <header className="page-head">
        <h1>{record.title}</h1>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <dl className="details">
        <dt>種類</dt>
        <dd>{KIND_LABELS[record.kind]}</dd>
        <dt>状態</dt>
        <dd>{STATUS_LABELS[record.status]}</dd>
        <dt>日付</dt>
        <dd>{record.date ?? "未設定"}</dd>
        <dt>期間</dt>
        <dd>{period ?? "未設定"}</dd>
        <dt>タグ</dt>
        <dd>{record.tags.length === 0 ? "なし" : <Tags tags={record.tags} />}</dd>
        <dt>記事</dt>
        <dd>
          {record.articles.length === 0 ? (
            "なし"
          ) : (
            <ul className="plain-list">
              {record.articles.map((article) => (
                <li key={article.id}>
                  <Link to={`/articles/${article.id}`}>{article.title}</Link>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>内容</dt>
        <dd>{record.content === "" ? "なし" : <span className="text-body">{record.content}</span>}</dd>
      </dl>
      <p className="hint">
        登録 <time dateTime={new Date(record.created_at).toISOString()}>{formatDateTime(record.created_at)}</time>・更新{" "}
        <time dateTime={new Date(record.updated_at).toISOString()}>{formatDateTime(record.updated_at)}</time>
      </p>
      <EditRecordForm
        // Keyed by the saved values, so that the form shows them again after a reload.
        key={record.updated_at}
        client={client}
        record={record}
        articles={articles}
        onUpdated={() => {
          setNotice("記録を更新しました");
          reload();
        }}
        onGone={reload}
      />
      <DeleteRecord client={client} record={record} onGone={reload} />
    </main>
  );
}

function EditRecordForm({
  client,
  record,
  articles,
  onUpdated,
  onGone,
}: {
  client: ApiClient;
  record: SiteRecord;
  articles: ArticleSummary[];
  onUpdated: () => void;
  onGone: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState(() => recordFormValues(record));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await updateRecord(client, record.id, recordRequest(values));
    if (handleItemResult(result, setSending, setFailure)) {
      onUpdated();
    } else if (result.kind === "notFound") {
      onGone();
    }
  }

  return (
    <>
      <h2>編集</h2>
      <form className="folder-form" aria-label="記録の編集" onSubmit={(event) => void onSubmit(event)}>
        <RecordFields values={values} onChange={setValues} articles={articles} disabled={sending} />
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
function DeleteRecord({ client, record, onGone }: { client: ApiClient; record: SiteRecord; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onDelete() {
    setSending(true);
    setFailure(null);
    const result = await deleteRecord(client, record.id);
    switch (result.kind) {
      case "ok":
        setFlash("記録を削除しました");
        navigate(`/sites/${record.site_id}/records`);
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
            記録を削除
          </button>
        </div>
      ) : (
        <div className="folder-form" role="group" aria-label="記録を削除">
          <p>{record.title} を削除します。元に戻せません。</p>
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
