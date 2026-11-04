# 開発

Queruneを開発する場合の、技術スタック・ローカル開発・デプロイの仕組みをまとめます。利用者向けの導入手順は[README](../README.md)と[設定](settings.md)を参照してください。

## 技術スタック

Cloudflare Workers + Hono + D1（drizzle-orm）で動き、MCPのOAuthの状態はKVに置きます。言語はTypeScript、パッケージ管理はpnpm、テストは`@cloudflare/vitest-plugin`、Web画面はReact + Viteです。

ログイン、ユーザー管理、MCPのOAuth認可サーバー（`@cloudflare/workers-oauth-provider`、`@modelcontextprotocol/sdk`）は[Pinglune](https://github.com/i2bskn/pinglune)から移植した土台です。

## ローカルで開発する

Node.jsとpnpmが必要です。

```sh
pnpm install
cp .dev.vars.example .dev.vars   # JWT_SECRET を設定する
pnpm db:migrate:local
pnpm dev
```

`pnpm dev`はWeb画面（`client/`）をビルドしてから`wrangler dev`を起動します。

CookieにSecure属性と`__Host-`接頭辞を使うので、`http://localhost`ではSafariでログインできません。ChromeかFirefoxを使ってください。

| コマンド | 内容 |
| --- | --- |
| `pnpm test` | テスト |
| `pnpm typecheck` | 型チェック（サーバーとWeb画面） |
| `pnpm build:client` | Web画面を`dist/client`にビルドする |
| `pnpm db:generate` | スキーマからマイグレーションを作る |
| `pnpm db:migrate:local` | ローカルのD1にマイグレーションを適用する |

## デプロイの仕組み

Deploy to CloudflareボタンもWorkers Buildsも、デプロイには`pnpm run deploy`（`scripts/deploy.mjs`）を使います。スクリプトは`wrangler.jsonc`のD1の設定を読み、次の順に実行します。

1. D1データベースが既にあるかを確かめます。
2. `LOCATION_HINT`が設定されていれば、まだないD1をその場所に作ります。作れなかった場合は、別の場所に作られないようにデプロイを止めます。
3. D1のマイグレーション（`drizzle/migrations`）を本番に適用します。
4. `wrangler deploy`を実行します。新しいコードが動く前にテーブルができているよう、マイグレーションの後にしています。

`LOCATION_HINT`を設定していない初回のデプロイでD1がまだないときは、3と4を入れ替えて`wrangler deploy`を先に実行します。D1やKVを自動で作るのは`wrangler deploy`で、`wrangler d1 migrations apply`は既存のD1を探すだけだからです。

手元から`pnpm run deploy`を実行する場合、Cloudflareのアカウントが複数あると、wranglerがアカウントを選べずに失敗します。`CLOUDFLARE_ACCOUNT_ID`にデプロイ先のアカウントIDを指定してください。

Deploy to Cloudflareボタンは、`.dev.vars.example`でコメントアウトしていないキーをシークレットとして入力させます。`JWT_SECRET`以外はコメントアウトしておきます。
