import type { User } from "../../src/api/types";
import { BRAND_NAME } from "../../src/brand";
import { createApiClient, createApiFetch, unexpectedResponseMessage } from "./api";
import { loadMe, useView } from "./load";
import { type Route, matchRoute, usePath } from "./router";
import { markLeaving } from "./unload";
import { LoadError, NotFound, useDocumentTitle } from "./views/common";
import { ArticleDetailView } from "./views/ArticleDetailView";
import { ArticlesView } from "./views/ArticlesView";
import { ErrorBoundary } from "./views/ErrorBoundary";
import { HomeView } from "./views/HomeView";
import { AppShell } from "./views/Sidebar";
import { RecordDetailView } from "./views/RecordDetailView";
import { RecordsView } from "./views/RecordsView";
import { SiteDetailView } from "./views/SiteDetailView";
import { SitesView } from "./views/SitesView";
import { UsersView } from "./views/UsersView";

// One client for every screen: the shared refresh and the single move to the login page are per instance.
const client = createApiClient(
  createApiFetch({
    fetch: globalThis.fetch.bind(globalThis),
    redirectToLogin: (url) => {
      markLeaving();
      location.assign(url);
    },
    currentPath: () => location.pathname + location.search,
  }),
);

export function App() {
  // Loaded once; moving between screens does not load it again. Screens load their data after it.
  const [me, reload] = useView(() => loadMe(client), "me");
  const path = usePath();
  const route = matchRoute(path);

  switch (me.kind) {
    case "loading":
      return <p className="status">読み込み中…</p>;
    case "redirecting":
      return <p className="status">ログイン画面へ移動しています…</p>;
    case "error":
      return <LoadError message={me.message} onReload={reload} />;
    case "notFound":
      // loadMe reports a 404 as an error; this case only completes the switch.
      return <LoadError message={unexpectedResponseMessage(404)} onReload={reload} />;
    case "ready":
      return (
        <AppShell user={me.data} route={route} path={path}>
          <div className="layout">
            <div className="layout-screen">
              <ErrorBoundary key={path}>
                <Screen route={route} user={me.data} path={path} />
              </ErrorBoundary>
            </div>
          </div>
        </AppShell>
      );
  }
}

function Screen({ route, user, path }: { route: Route; user: User; path: string }) {
  switch (route.name) {
    case "home":
      return <HomeView client={client} />;
    case "sites":
      return <SitesView client={client} />;
    case "siteDetail":
      return <SiteDetailView client={client} id={route.id} />;
    case "siteArticles":
      return <ArticlesView client={client} siteId={route.id} path={path} />;
    case "siteRecords":
      return <RecordsView client={client} siteId={route.id} path={path} />;
    case "articleDetail":
      return <ArticleDetailView client={client} id={route.id} />;
    case "recordDetail":
      return <RecordDetailView client={client} id={route.id} />;
    case "users":
      return <UsersView client={client} currentUserId={user.id} />;
    case "notFound":
      return <RouteNotFound />;
  }
}

function RouteNotFound() {
  useDocumentTitle(`見つかりません - ${BRAND_NAME}`);
  return <NotFound message="ページが見つかりません" />;
}
