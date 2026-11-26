---
title: 開発環境
description: Queruneの技術スタック、ローカルでの開発、データセットとテーブル。
---

## 技術スタック

Cloudflare Workers + Hono + D1（drizzle-orm）で動き、MCPのOAuthの状態はKVに置きます。Search ConsoleとGA4の取り込みと、取り込んだデータの削除はQueues（`querune-sync`、DLQは`querune-sync-dlq`）で少しずつ処理し、毎日の取り込みはCron Triggers（18:00 UTCと6:00 UTC）で始めます。サイトマップからの記事の自動登録も同じキューで処理し、18:00 UTCのCron Triggerで始めます。言語はTypeScript、パッケージ管理はpnpm、テストは`@cloudflare/vitest-plugin`、Web画面はReact + Viteです。

ログイン、ユーザー管理、MCPのOAuth認可サーバー（`@cloudflare/workers-oauth-provider`、`@modelcontextprotocol/sdk`）は[`@i2bskn/workers-app-core`](https://docs.i2bskn.com/workers-app-core/)を使っています（`src/core.ts`）。

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

## データセットとテーブル

| データセット | テーブル | 取り込む内容 |
| --- | --- | --- |
| `gsc_pages` | `gsc_page_daily` | Search Consoleのページ×日 |
| `gsc_queries` | `gsc_query_daily` | Search Consoleのページ×クエリ×日 |
| `ga4_landing_pages` | `ga4_landing_daily` | GA4のランディングページ×チャネル×日のセッション |
| `ga4_pages` | `ga4_page_daily` | GA4のホスト名×ページのパス×日の表示回数とエンゲージメント時間 |

日・データセットごとの取り込みの状態は`sync_days`に、削除の予約は`pending_purges`に持ちます。どちらも`dataset`をCHECK制約で上の4つに限っているため、データセットを足すとdrizzle-kitが両テーブルを作り直すマイグレーションを生成します。この2つは外部キーで参照されていないため、作り直しで行は失われません。`0005`では新しい列`last_thresholded`を古いテーブルからコピーする行をdrizzle-kitが生成したため、手で取り除いています。
