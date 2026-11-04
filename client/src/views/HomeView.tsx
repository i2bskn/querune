import { Link } from "../Link";
import { type ApiClient, loadSites, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";

// The overview: the registered sites, and the URL that AI apps connect to over MCP.
export function HomeView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadSites(client), "overview");
  useDocumentTitle(viewTitle(state, () => "概要"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  const count = state.data.length;
  const mcpUrl = `${location.origin}/mcp`;

  return (
    <main className="main">
      <header className="page-head">
        <h1>概要</h1>
        <p className="lead">登録したサイトの情報を、MCP でつないだ AI との会話から読み取れます。</p>
      </header>

      {count === 0 ? (
        <p className="notice">
          サイトを登録してください。<Link to="/sites">サイトの画面へ</Link>
        </p>
      ) : (
        <ul className="stats" aria-label="現在の状態">
          <li className="stat">
            <Link to="/sites" className="stat-link">
              <span className="stat-label">サイト</span>
              <span className="stat-value">
                {count}
                <span className="stat-unit"> 件</span>
              </span>
              <span className="stat-note">サイトの画面で確かめられます</span>
            </Link>
          </li>
        </ul>
      )}

      <h2>AI から接続する</h2>
      <dl className="details">
        <dt>MCP の URL</dt>
        <dd>
          <code>{mcpUrl}</code>
        </dd>
      </dl>
      <p className="hint">AI アプリにこの URL を MCP サーバーとして追加し、表示される画面で接続を許可してください。</p>
    </main>
  );
}
