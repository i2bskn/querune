# 開発

Queruneを開発する場合の、技術スタック・ローカル開発・デプロイの仕組みをまとめます。利用者向けの導入手順は[README](../README.md)と[設定](settings.md)を参照してください。

## 技術スタック

Cloudflare Workers + Hono + D1（drizzle-orm）で動き、MCPのOAuthの状態はKVに置きます。Search ConsoleとGA4の取り込みと、取り込んだデータの削除はQueues（`querune-sync`、DLQは`querune-sync-dlq`）で少しずつ処理し、毎日の取り込みはCron Triggers（18:00 UTCと6:00 UTC）で始めます。言語はTypeScript、パッケージ管理はpnpm、テストは`@cloudflare/vitest-plugin`、Web画面はReact + Viteです。

ログイン、ユーザー管理、MCPのOAuth認可サーバー（`@cloudflare/workers-oauth-provider`、`@modelcontextprotocol/sdk`）は[`@i2bskn/workers-app-core`](https://github.com/i2bskn/workers-app-core)を使っています（`src/core.ts`）。

## Freeプランの目安

Freeプランの上限の中で動くように作っていますが、行数の多いサイトや多数のサイトでは上限に当たります。その場合はWorkers Paidプランを使ってください。

- Queuesは1日約10,000オペレーション（1メッセージ約3オペレーション、約3,300メッセージ）です。1メッセージは1データセット×1日×2,000行までを処理します。
- 毎日の取り込みは、サイトあたり18:00 UTCにおよそ24メッセージ（Search Console 2データセット×7日＋GA4 10日）と直近30日の取り直しの日です。6:00 UTCには直近5日のうち確定していない日の数だけ送ります。1日2,000行を超える日は、ページ数だけメッセージが増えます。
- 18:00 UTCの取り込みは直近の日を確定でも毎日取り直すため、その日の行をすべて書き直します。D1の書き込み行数はおおむね（直近の日数×1日の行数）だけ増えます。
- 毎日の取り込みは、GA4のタイムゾーンと取り直す日を探すために`sync_days`を全件読みます。読み取り行数はおおむね`sync_days`の行数の2倍です。
- 1回の手動の取り込みは最大90日で、3データセットなら270メッセージ以上（1日2,000行を超える日はさらに増える）です。
- WorkersのFreeプランは1回の実行のCPU時間が10msで、行数の多い日や多数のサイトでは処理が打ち切られることがあります。
- D1のFreeプランは1日あたり書き込み10万行・読み取り500万行、1データベース500MBです。取り込む行数はおおむね書き込み行数になります。MCPのクエリ別の集計は1回でおおよそ（日数×1日の行数、比較するならその2倍）行を読みます。
- 記事とメモには、1サイトあたり記事1,000件、メモ2,000件、1メモあたり記事5件、備考と本文は1件10,000文字までの上限があります。
- サイトを削除すると、記事・メモ・その関連付けも1回の処理で削除します。D1はインデックスの書き込みも行数に数えるため、上限まで使ったサイトの削除は最大でおよそ48,000行（1日10万行のおよそ半分）を書き込み、その日の取り込みが書き込みの上限で失敗することがあります。その日の上限を使い切っていると削除自体が失敗し、何も削除されません。翌日にやり直してください。
- 記事の備考とメモの本文は、上限まで使うと1サイトあたり最大でおよそ90MB（日本語の場合。1データベース500MBのうち）になります。

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

`articles`と`memos`は`sites`を、`memo_articles`は`articles`と`memos`を`ON DELETE CASCADE`で参照しています。D1はマイグレーションをトランザクションの中で実行し、`PRAGMA foreign_keys=OFF`が効かないため、これらのテーブル（`sites`・`articles`・`memos`）を作り直すマイグレーション（drizzle-kitが列の変更で生成するコピー・`DROP TABLE`・名前の変更）は、参照している行を削除します。生成したマイグレーションに`DROP TABLE`がないか確かめてください。

## デプロイの仕組み

Deploy to CloudflareボタンもWorkers Buildsも、デプロイには`pnpm run deploy`（`scripts/deploy.mjs`）を使います。スクリプトは`wrangler.jsonc`のD1の設定を読み、次の順に実行します。

1. D1データベースが既にあるかを確かめます。
2. `LOCATION_HINT`が設定されていれば、まだないD1をその場所に作ります。作れなかった場合は、別の場所に作られないようにデプロイを止めます。
3. D1のマイグレーション（`drizzle/migrations`）を本番に適用します。
4. `wrangler deploy`を実行します。新しいコードが動く前にテーブルができているよう、マイグレーションの後にしています。

`LOCATION_HINT`を設定していない初回のデプロイでD1がまだないときは、3と4を入れ替えて`wrangler deploy`を先に実行します。D1やKVを自動で作るのは`wrangler deploy`で、`wrangler d1 migrations apply`は既存のD1を探すだけだからです。

手元から`pnpm run deploy`を実行する場合、Cloudflareのアカウントが複数あると、wranglerがアカウントを選べずに失敗します。`CLOUDFLARE_ACCOUNT_ID`にデプロイ先のアカウントIDを指定してください。

Deploy to Cloudflareボタンは、`.dev.vars.example`でコメントアウトしていないキーをシークレットとして入力させます。`JWT_SECRET`以外はコメントアウトしておきます（`GOOGLE_SERVICE_ACCOUNT_KEY`は任意なので、デプロイ後に設定します）。

キューは、`wrangler.jsonc`にproducerのバインディングがあれば`wrangler deploy`が作ります。consumerだけのキューは作られないため、DLQにもコードでは使わないproducerのバインディング（`SYNC_DLQ`）を置いています。
