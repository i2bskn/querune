import { useEffect, useState } from "react";
import type {
  Article,
  ArticleSummary,
  GoogleStatus,
  InsightsOverview,
  InsightsResponse,
  Memo,
  MemoList,
  MemoListQuery,
  Site,
  SyncStatus,
  TagList,
  User,
  UserList,
} from "../../src/api/types";
import { isValidId } from "./router";
import {
  LoginRequiredError,
  type createApiClient,
  responseErrorMessage,
  unexpectedResponseMessage,
} from "./api";

export type ApiClient = ReturnType<typeof createApiClient>;

// The state of a screen that loads its own data.
export type ViewState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  // The API answered 404.
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "redirecting" };

export type Loaded<T> = Exclude<ViewState<T>, { kind: "loading" }>;

export const CONNECTION_ERROR = "サーバーに接続できませんでした";

type Result<T> =
  | { kind: "ok"; value: T }
  | { kind: "notFound"; message: string }
  // status is null when there was no response.
  | { kind: "error"; message: string; status: number | null }
  | { kind: "redirecting" };

type JsonResponse = { ok: boolean; status: number; json(): Promise<unknown> };

// The JSON body of the ok responses of an hc() call.
type OkJson<R> = R extends { ok: true; json(): Promise<infer T> } ? T : never;

// Reads the JSON body of an ok response. null if it is not JSON.
async function readJson(res: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Calls the API and sorts the outcome. Never rejects.
async function request<R extends JsonResponse>(call: () => Promise<R>): Promise<Result<OkJson<R>>> {
  let res: R;
  try {
    res = await call();
  } catch (error) {
    if (error instanceof LoginRequiredError) return { kind: "redirecting" };
    return { kind: "error", message: CONNECTION_ERROR, status: null };
  }
  if (res.status === 404) return { kind: "notFound", message: await responseErrorMessage(res) };
  if (!res.ok) return { kind: "error", message: await responseErrorMessage(res), status: res.status };
  const body = await readJson(res);
  if (body === null) return { kind: "error", message: unexpectedResponseMessage(res.status), status: res.status };
  // res.ok is true here, so the body is one of the ok bodies.
  return { kind: "ok", value: body as OkJson<R> };
}

// Combines the results of the calls of one screen, at least one of which is not ok:
// redirecting > not found > error.
function failure(results: Result<unknown>[]): Loaded<never> {
  if (results.some((r) => r.kind === "redirecting")) return { kind: "redirecting" };
  if (results.some((r) => r.kind === "notFound")) return { kind: "notFound" };
  for (const r of results) {
    if (r.kind === "error") return { kind: "error", message: r.message };
  }
  throw new Error("failure() needs a result that is not ok");
}

export async function loadMe(client: ApiClient): Promise<Loaded<User>> {
  const me = await request(() => client.api.v1.me.$get());
  if (me.kind === "redirecting") return me;
  // There is no "not found" for the signed-in user; show it as an error.
  if (me.kind === "notFound" || me.kind === "error") return { kind: "error", message: me.message };
  return { kind: "ready", data: me.value };
}

export type UsersData = { users: User[]; authMode: UserList["auth_mode"] };

// Admins only. A 403 (a member opened the URL) is shown with the server's message.
export async function loadUsersView(client: ApiClient): Promise<Loaded<UsersData>> {
  const list = await request(() => client.api.v1.users.$get());
  if (list.kind === "redirecting") return list;
  // The list itself is never missing; a 404 here is an unexpected response.
  if (list.kind === "notFound" || list.kind === "error") return { kind: "error", message: list.message };
  return { kind: "ready", data: { users: list.value.users, authMode: list.value.auth_mode } };
}

// Every site, by name.
export async function loadSites(client: ApiClient): Promise<Loaded<Site[]>> {
  const list = await request(() => client.api.v1.sites.$get());
  if (list.kind === "redirecting") return list;
  // The list itself is never missing; a 404 here is an unexpected response.
  if (list.kind === "notFound" || list.kind === "error") return { kind: "error", message: list.message };
  return { kind: "ready", data: list.value.sites };
}

// One site. A deleted site is not found.
export async function loadSiteDetail(client: ApiClient, id: string): Promise<Loaded<Site>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const site = await request(() => client.api.v1.sites[":id"].$get({ param: { id } }));
  if (site.kind !== "ok") return failure([site]);
  return { kind: "ready", data: site.value };
}

export type OverviewData = { sites: Site[]; overview: InsightsOverview };

// Every site with its clicks and sessions of the last 28 days.
export async function loadOverview(client: ApiClient): Promise<Loaded<OverviewData>> {
  const [list, overview] = await Promise.all([
    request(() => client.api.v1.sites.$get()),
    request(() => client.api.v1.sites.insights.$get()),
  ]);
  if (list.kind === "redirecting" || overview.kind === "redirecting") return { kind: "redirecting" };
  if (list.kind !== "ok") return { kind: "error", message: list.message };
  if (overview.kind !== "ok") return { kind: "error", message: overview.message };
  return { kind: "ready", data: { sites: list.value.sites, overview: overview.value } };
}

export type DashboardData = { site: Site; insights: InsightsResponse };

// The figures of a site over days days. A deleted site is not found.
export async function loadDashboard(client: ApiClient, id: string, days: number): Promise<Loaded<DashboardData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const param = { id };
  const [site, insights] = await Promise.all([
    request(() => client.api.v1.sites[":id"].$get({ param })),
    request(() => client.api.v1.sites[":id"].insights.$get({ param, query: { days: String(days) } })),
  ]);
  if (site.kind !== "ok" || insights.kind !== "ok") return failure([site, insights]);
  return { kind: "ready", data: { site: site.value, insights: insights.value } };
}

// The figures of a site over days days ending at end (YYYY-MM-DD).
export async function loadInsightsAround(
  client: ApiClient,
  siteId: string,
  end: string,
  days: number,
): Promise<Loaded<InsightsResponse>> {
  if (!isValidId(siteId)) return { kind: "notFound" };
  const insights = await request(() =>
    client.api.v1.sites[":id"].insights.$get({ param: { id: siteId }, query: { days: String(days), end } }),
  );
  if (insights.kind !== "ok") return failure([insights]);
  return { kind: "ready", data: insights.value };
}

// The figures of one article of a site over days days.
export async function loadArticleInsights(
  client: ApiClient,
  siteId: string,
  articleId: string,
  days: number,
): Promise<Loaded<InsightsResponse>> {
  if (!isValidId(siteId) || !isValidId(articleId)) return { kind: "notFound" };
  const insights = await request(() =>
    client.api.v1.sites[":id"].insights.$get({ param: { id: siteId }, query: { days: String(days), article_id: articleId } }),
  );
  if (insights.kind !== "ok") return failure([insights]);
  return { kind: "ready", data: insights.value };
}

export type SyncPanelData = { google: GoogleStatus; status: SyncStatus };

// The data import of a site: the service account and the import state. A deleted site is not found.
export async function loadSyncPanel(client: ApiClient, id: string): Promise<Loaded<SyncPanelData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const [google, status] = await Promise.all([
    request(() => client.api.v1.google.$get()),
    request(() => client.api.v1.sites[":id"].sync.$get({ param: { id } })),
  ]);
  if (google.kind !== "ok" || status.kind !== "ok") return failure([google, status]);
  return { kind: "ready", data: { google: google.value, status: status.value } };
}

export type ArticlesData = { site: Site; articles: ArticleSummary[]; tags: TagList };

// The articles of a site, filtered by tag when it is not null, with the tags of the site for the filter.
export async function loadArticlesView(client: ApiClient, siteId: string, tag: string | null): Promise<Loaded<ArticlesData>> {
  if (!isValidId(siteId)) return { kind: "notFound" };
  const param = { id: siteId };
  const [site, articles, tags] = await Promise.all([
    request(() => client.api.v1.sites[":id"].$get({ param })),
    request(() => client.api.v1.sites[":id"].articles.$get({ param, query: tag === null ? {} : { tag } })),
    request(() => client.api.v1.sites[":id"].tags.$get({ param })),
  ]);
  if (site.kind !== "ok" || articles.kind !== "ok" || tags.kind !== "ok") return failure([site, articles, tags]);
  return { kind: "ready", data: { site: site.value, articles: articles.value.articles, tags: tags.value } };
}

export type ArticleDetailData = { article: Article; site: Site };

// One article and its site. A deleted article is not found.
export async function loadArticleDetail(client: ApiClient, id: string): Promise<Loaded<ArticleDetailData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const article = await request(() => client.api.v1.articles[":id"].$get({ param: { id } }));
  if (article.kind !== "ok") return failure([article]);
  const siteId = article.value.site_id;
  if (!isValidId(siteId)) return { kind: "error", message: unexpectedResponseMessage(200) };
  const site = await request(() => client.api.v1.sites[":id"].$get({ param: { id: siteId } }));
  if (site.kind !== "ok") return failure([site]);
  return { kind: "ready", data: { article: article.value, site: site.value } };
}

// One page of the memos of a site.
export async function loadMemoPage(client: ApiClient, siteId: string, query: MemoListQuery): Promise<Loaded<MemoList>> {
  if (!isValidId(siteId)) return { kind: "notFound" };
  const page = await request(() => client.api.v1.sites[":id"].memos.$get({ param: { id: siteId }, query }));
  if (page.kind !== "ok") return failure([page]);
  return { kind: "ready", data: page.value };
}

export type MemosData = { site: Site; memos: MemoList; tags: TagList; articles: ArticleSummary[] };

// The first page of the memos of a site with the filters of query, the tags for the filter and the articles for the
// form.
export async function loadMemosView(client: ApiClient, siteId: string, query: MemoListQuery): Promise<Loaded<MemosData>> {
  if (!isValidId(siteId)) return { kind: "notFound" };
  const param = { id: siteId };
  const [site, memos, tags, articles] = await Promise.all([
    request(() => client.api.v1.sites[":id"].$get({ param })),
    request(() => client.api.v1.sites[":id"].memos.$get({ param, query })),
    request(() => client.api.v1.sites[":id"].tags.$get({ param })),
    request(() => client.api.v1.sites[":id"].articles.$get({ param, query: {} })),
  ]);
  if (site.kind !== "ok" || memos.kind !== "ok" || tags.kind !== "ok" || articles.kind !== "ok") {
    return failure([site, memos, tags, articles]);
  }
  return {
    kind: "ready",
    data: { site: site.value, memos: memos.value, tags: tags.value, articles: articles.value.articles },
  };
}

export type MemoDetailData = { memo: Memo; site: Site; articles: ArticleSummary[] };

// One memo, its site and the articles of the site for the form. A deleted memo is not found.
export async function loadMemoDetail(client: ApiClient, id: string): Promise<Loaded<MemoDetailData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const memo = await request(() => client.api.v1.memos[":id"].$get({ param: { id } }));
  if (memo.kind !== "ok") return failure([memo]);
  const siteId = memo.value.site_id;
  if (!isValidId(siteId)) return { kind: "error", message: unexpectedResponseMessage(200) };
  const param = { id: siteId };
  const [site, articles] = await Promise.all([
    request(() => client.api.v1.sites[":id"].$get({ param })),
    request(() => client.api.v1.sites[":id"].articles.$get({ param, query: {} })),
  ]);
  if (site.kind !== "ok" || articles.kind !== "ok") return failure([site, articles]);
  return { kind: "ready", data: { memo: memo.value, site: site.value, articles: articles.value.articles } };
}

// Loads a screen's data while the component is mounted, and again when key changes or reload is called.
// A result that arrives after key has changed is dropped, so a previous screen does not overwrite the state.
export function useView<T>(load: () => Promise<Loaded<T>>, key: string): [ViewState<T>, () => void] {
  const [state, setState] = useState<ViewState<T>>({ kind: "loading" });
  // Incremented by reload to load again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void load().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
    // load is a new function on every render; key identifies what it loads.
  }, [key, attempt]);

  return [state, () => setAttempt((n) => n + 1)];
}
