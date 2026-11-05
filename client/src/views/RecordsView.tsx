import { type FormEvent, useState } from "react";
import type { ArticleSummary, RecordList, RecordListQuery, RecordSummary, Site } from "../../../src/api/types";
import { createRecord } from "../actions";
import { PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadRecordPage, loadRecordsView, useView } from "../load";
import {
  KIND_LABELS,
  MAX_ARTICLES_PER_RECORD,
  RECORD_KINDS,
  RECORD_STATUSES,
  type RecordFormValues,
  STATUS_LABELS,
  TEXT_MAX,
  TITLE_MAX,
  emptyRecordForm,
  isRecordKind,
  isRecordStatus,
  periodText,
  recordRequest,
} from "../records";
import { isValidId, navigate, searchParams } from "../router";
import {
  CREATE_UNKNOWN_MESSAGE,
  SITE_GONE_MESSAGE,
  SiteBreadcrumb,
  TagFilter,
  Tags,
  TagsField,
  handleItemResult,
} from "./ArticlesView";
import { ViewStatus, useDocumentTitle, useFlashNotice, viewTitle } from "./common";

// The filters of the screen, from the query string. Values that are not valid are ignored.
export function recordFilters(path: string): { kind: string | null; status: string | null; tag: string | null } {
  const params = searchParams(path);
  const kind = params.get("kind");
  const status = params.get("status");
  const tag = params.get("tag");
  return {
    kind: isRecordKind(kind) ? kind : null,
    status: isRecordStatus(status) ? status : null,
    tag: tag === null || tag.trim() === "" ? null : tag,
  };
}

function filtersQuery(filters: { kind: string | null; status: string | null; tag: string | null }): RecordListQuery {
  const query: RecordListQuery = {};
  if (filters.kind !== null) query.kind = filters.kind;
  if (filters.status !== null) query.status = filters.status;
  if (filters.tag !== null) query.tag = filters.tag;
  return query;
}

// The records of a site: the list filtered by kind, status and tag, and the form to add a record. ?article=<id> opens
// the form with that article of the site chosen.
export function RecordsView({ client, siteId, path }: { client: ApiClient; siteId: string; path: string }) {
  const filters = recordFilters(path);
  const query = filtersQuery(filters);
  const [state, reload] = useView(
    () => loadRecordsView(client, siteId, query),
    `records:${siteId}:${filters.kind ?? ""}:${filters.status ?? ""}:${filters.tag ?? ""}`,
  );
  const [notice, setNotice] = useState<string | null>(null);
  useFlashNotice(setNotice);
  useDocumentTitle(viewTitle(state, (data) => `記録 - ${data.site.name}`));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={SITE_GONE_MESSAGE} onReload={reload} />;
  }
  const { site, records, tags, articles } = state.data;
  const requested = searchParams(path).get("article");
  const preselected =
    requested !== null && isValidId(requested) && articles.some((article) => article.id === requested) ? requested : null;

  function moveTo(next: { kind: string | null; status: string | null; tag: string | null }) {
    const params = new URLSearchParams(filtersQuery(next) as Record<string, string>).toString();
    navigate(`/sites/${site.id}/records${params === "" ? "" : `?${params}`}`);
  }

  return (
    <main className="main">
      <SiteBreadcrumb site={site} />
      <header className="page-head">
        <h1>記録</h1>
        <p className="lead">施策・レビュー・メモの記録です。日付のない記録が先、続いて日付の新しい順に並びます。</p>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <CreateRecordForm
        // Keyed by the article, so that a link for another article opens the form again.
        key={preselected ?? ""}
        client={client}
        site={site}
        articles={articles}
        preselected={preselected}
      />
      <div className="filters">
        <label className="filter">
          種類
          <select
            value={filters.kind ?? ""}
            onChange={(event) => moveTo({ ...filters, kind: event.target.value === "" ? null : event.target.value })}
          >
            <option value="">すべて</option>
            {RECORD_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          状態
          <select
            value={filters.status ?? ""}
            onChange={(event) => moveTo({ ...filters, status: event.target.value === "" ? null : event.target.value })}
          >
            <option value="">すべて</option>
            {RECORD_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <TagFilter tags={tags} value={filters.tag} onChange={(tag) => moveTo({ ...filters, tag })} />
      </div>
      <RecordPages
        client={client}
        siteId={site.id}
        query={query}
        first={records}
        emptyMessage={
          filters.kind === null && filters.status === null && filters.tag === null
            ? "記録はまだ登録されていません。"
            : "条件に合う記録はありません。"
        }
      />
    </main>
  );
}

// A list of records with "さらに表示" for the next pages.
export function RecordPages({
  client,
  siteId,
  query,
  first,
  emptyMessage,
}: {
  client: ApiClient;
  siteId: string;
  query: RecordListQuery;
  first: RecordList;
  emptyMessage: string;
}) {
  const [more, setMore] = useState<RecordSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(first.next_offset);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function loadMore(offset: number) {
    setLoading(true);
    setFailure(null);
    const page = await loadRecordPage(client, siteId, { ...query, offset: String(offset) });
    setLoading(false);
    if (page.kind === "ready") {
      setMore((records) => [...records, ...page.data.records]);
      setNextOffset(page.data.next_offset);
    } else if (page.kind === "error") {
      setFailure(page.message);
    } else if (page.kind === "notFound") {
      setFailure(SITE_GONE_MESSAGE);
    }
  }

  const records = [...first.records, ...more];
  if (records.length === 0) return <p className="notice">{emptyMessage}</p>;
  return (
    <>
      <ul className="list">
        {records.map((record) => (
          <li key={record.id}>
            <RecordRow record={record} />
          </li>
        ))}
      </ul>
      {nextOffset !== null && (
        <div className="actions">
          <button type="button" onClick={() => void loadMore(nextOffset)} disabled={loading}>
            さらに表示
          </button>
          {failure !== null && <p role="alert">{failure}</p>}
        </div>
      )}
    </>
  );
}

function RecordRow({ record }: { record: RecordSummary }) {
  const period = periodText(record.period_start, record.period_end);
  return (
    <Link to={`/records/${record.id}`} className="site-link">
      <span className="site-head">
        <span className="site-name">{record.title}</span>
        <span className="site-url">
          {KIND_LABELS[record.kind]}・{STATUS_LABELS[record.status]}
        </span>
      </span>
      <span className="site-meta">
        <span>日付: {record.date ?? "未設定"}</span>
        {period !== null && <span>期間: {period}</span>}
        {record.articles.length > 0 && <span>記事: {record.articles.map((article) => article.title).join("、")}</span>}
        <Tags tags={record.tags} />
      </span>
    </Link>
  );
}

function CreateRecordForm({
  client,
  site,
  articles,
  preselected,
}: {
  client: ApiClient;
  site: Site;
  articles: ArticleSummary[];
  preselected: string | null;
}) {
  const initial = () => emptyRecordForm(preselected === null ? [] : [preselected]);
  const [open, setOpen] = useState(preselected !== null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState<RecordFormValues>(initial);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await createRecord(client, site.id, recordRequest(values));
    if (result.kind === "notFound") {
      setSending(false);
      setFailure(SITE_GONE_MESSAGE);
      return;
    }
    if (handleItemResult(result, setSending, setFailure, CREATE_UNKNOWN_MESSAGE) && result.kind === "ok") {
      navigate(`/records/${result.item.id}`);
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
            setValues(initial());
            setFailure(null);
          }}
        >
          <PlusIcon />
          記録を追加
        </button>
      </div>
    );
  }
  return (
    <form className="folder-form" aria-label="記録を追加" onSubmit={(event) => void onSubmit(event)}>
      <RecordFields values={values} onChange={setValues} articles={articles} disabled={sending} />
      <div className="folder-form-actions">
        <button type="submit" disabled={sending}>
          追加
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

// The fields of a record, shared by the add and the edit forms.
export function RecordFields({
  values,
  onChange,
  articles,
  disabled,
}: {
  values: RecordFormValues;
  onChange: (values: RecordFormValues) => void;
  // The articles of the site to choose from.
  articles: ArticleSummary[];
  disabled: boolean;
}) {
  return (
    <>
      <label>
        種類
        <select
          value={values.kind}
          onChange={(event) => {
            const kind = event.target.value;
            if (isRecordKind(kind)) onChange({ ...values, kind });
          }}
          disabled={disabled}
        >
          {RECORD_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      <label>
        状態
        <select
          value={values.status}
          onChange={(event) => {
            const status = event.target.value;
            if (isRecordStatus(status)) onChange({ ...values, status });
          }}
          disabled={disabled}
        >
          {RECORD_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      <label>
        タイトル（{TITLE_MAX}&nbsp;文字以内）
        <input
          type="text"
          value={values.title}
          onChange={(event) => onChange({ ...values, title: event.target.value })}
          autoComplete="off"
          required
          disabled={disabled}
        />
      </label>
      <label>
        日付（省略可。実施した日か予定の日）
        <input
          type="date"
          value={values.date}
          onChange={(event) => onChange({ ...values, date: event.target.value })}
          disabled={disabled}
        />
      </label>
      <label>
        期間の開始日（省略可。終了日と両方を入力します）
        <input
          type="date"
          value={values.periodStart}
          onChange={(event) => onChange({ ...values, periodStart: event.target.value })}
          disabled={disabled}
        />
      </label>
      <label>
        期間の終了日
        <input
          type="date"
          value={values.periodEnd}
          onChange={(event) => onChange({ ...values, periodEnd: event.target.value })}
          disabled={disabled}
        />
      </label>
      <TagsField value={values.tags} onChange={(tags) => onChange({ ...values, tags })} disabled={disabled} />
      <label>
        内容（省略可。{TEXT_MAX}&nbsp;文字以内）
        <textarea
          value={values.content}
          onChange={(event) => onChange({ ...values, content: event.target.value })}
          rows={8}
          disabled={disabled}
        />
      </label>
      <ArticlePicker
        chosen={values.articleIds}
        articles={articles}
        onChange={(articleIds) => onChange({ ...values, articleIds })}
        disabled={disabled}
      />
    </>
  );
}

// The articles of a record: a select to add one, and the chosen ones with a button to remove each.
function ArticlePicker({
  chosen,
  articles,
  onChange,
  disabled,
}: {
  chosen: string[];
  articles: ArticleSummary[];
  onChange: (articleIds: string[]) => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState("");
  const titles = new Map(articles.map((article) => [article.id, article.title]));
  const choices = articles.filter((article) => !chosen.includes(article.id));
  const full = chosen.length >= MAX_ARTICLES_PER_RECORD;

  return (
    <fieldset className="picker" disabled={disabled}>
      <legend>記事（{MAX_ARTICLES_PER_RECORD}&nbsp;件まで）</legend>
      {chosen.length > 0 && (
        <ul className="picker-list">
          {chosen.map((id) => (
            <li key={id}>
              <span>{titles.get(id) ?? "削除された記事"}</span>
              <button type="button" onClick={() => onChange(chosen.filter((other) => other !== id))}>
                外す
              </button>
            </li>
          ))}
        </ul>
      )}
      {articles.length === 0 ? (
        <p className="hint">このサイトには記事がありません。</p>
      ) : (
        <div className="picker-add">
          <select
            aria-label="追加する記事"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            disabled={full || choices.length === 0}
          >
            <option value="">記事を選ぶ</option>
            {choices.map((article) => (
              <option key={article.id} value={article.id}>
                {article.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={full || selected === "" || chosen.includes(selected)}
            onClick={() => {
              onChange([...chosen, selected]);
              setSelected("");
            }}
          >
            追加
          </button>
        </div>
      )}
    </fieldset>
  );
}
