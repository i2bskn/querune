---
title: デプロイの仕組み
description: Deploy to CloudflareボタンとWorkers Buildsが実行するデプロイの手順と、カスタムドメイン。
---

Deploy to CloudflareボタンもWorkers Buildsも、デプロイには`pnpm run deploy`（[@i2bskn/workers-deploy](https://github.com/i2bskn/workers-deploy)の`workers-deploy`コマンド）を使います。コマンドは`wrangler.jsonc`のD1の設定を読み、次の順に実行します。

1. D1データベースが既にあるかを確かめます。
2. `LOCATION_HINT`が設定されていれば、まだないD1をその場所に作ります。作れなかった場合は、別の場所に作られないようにデプロイを止めます。
3. D1のマイグレーション（`drizzle/migrations`）を本番に適用します。
4. `wrangler deploy`を実行します。新しいコードが動く前にテーブルができているよう、マイグレーションの後にしています。

`LOCATION_HINT`を設定していない初回のデプロイでD1がまだないときは、3と4を入れ替えて`wrangler deploy`を先に実行します。D1やKVを自動で作るのは`wrangler deploy`で、`wrangler d1 migrations apply`は既存のD1を探すだけだからです。

手元から`pnpm run deploy`を実行する場合、Cloudflareのアカウントが複数あると、wranglerがアカウントを選べずに失敗します。`CLOUDFLARE_ACCOUNT_ID`にデプロイ先のアカウントIDを指定してください。

Deploy to Cloudflareボタンは、`.dev.vars.example`でコメントアウトしていないキーをシークレットとして入力させます。`JWT_SECRET`以外はコメントアウトしておきます（`GOOGLE_SERVICE_ACCOUNT_KEY`は任意なので、デプロイ後に設定します）。

キューは、`wrangler.jsonc`にproducerのバインディングがあれば`wrangler deploy`が作ります。consumerだけのキューは作られないため、DLQにもコードでは使わないproducerのバインディング（`SYNC_DLQ`）を置いています。

## カスタムドメインとworkers.dev

`wrangler.jsonc`に`workers_dev`を書いていないため、`wrangler deploy`はルートやカスタムドメインの指定がなければworkers.devのURLを有効にします。ダッシュボードで無効にしても、次のデプロイで有効に戻ります。`workers_dev: false`を書くと、カスタムドメインを持たない利用者（Deploy to Cloudflareボタンでの初回デプロイを含む）がアクセスできるURLがなくなるため、設定ファイルには書きません。

カスタムドメインで使う場合は、Workers Buildsのビルド変数`CUSTOM_DOMAINS`にホスト名を指定します（複数ならカンマかスペースで区切ります）。ホスト名以外（`https://`付きなど）を指定するとデプロイはエラーで止まります。コマンドはそれを`wrangler deploy --domains`に渡し、wranglerはカスタムドメインを割り当ててworkers.devのURLを無効にします。wranglerはWorkerのカスタムドメインを指定したものだけに置き換えるため、ダッシュボードで追加したものも含めてすべて指定してください。
