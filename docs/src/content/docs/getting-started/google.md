---
title: Search ConsoleとGA4をつなぐ
description: 1つのGoogleのサービスアカウントで、全サイトのSearch ConsoleとGA4のデータを読み取れるようにします。
---

Queruneは、1つのGoogleのサービスアカウントで全サイトのSearch ConsoleとGA4のデータを読み取ります。

1. [Google Cloudのコンソール](https://console.cloud.google.com/)でプロジェクトを作ります（既存のプロジェクトでも構いません）。
2. 「APIとサービス」で、Google Search Console APIとGoogle Analytics Data APIを有効にします。
3. 「IAMと管理」→「サービスアカウント」でサービスアカウントを作り、「鍵」→「鍵を追加」→「新しい鍵を作成」でJSONの鍵を作ってダウンロードします。サービスアカウントにプロジェクトのロールは要りません。
4. 鍵のJSONを、`wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY`（JSONを貼り付けます）か、Cloudflareのダッシュボードの「Variables and Secrets」で、秘密（Secret）として`GOOGLE_SERVICE_ACCOUNT_KEY`に保存します。
5. Search Consoleで、プロパティの「設定」→「ユーザーと権限」にサービスアカウントのメールアドレス（鍵の`client_email`）を追加します。権限は「制限付き」で構いません。
6. GA4で、プロパティの「管理」→「プロパティのアクセス管理」にサービスアカウントのメールアドレスを「閲覧者」として追加します。
7. Queruneの管理画面でサイトにSearch ConsoleのプロパティとGA4のプロパティIDを設定し、サイトの画面の「データの取り込み」で期間を選んで取り込みます。

- 鍵はリポジトリや`.dev.vars.example`に置かないでください。鍵があれば、サービスアカウントに許可したすべてのプロパティのデータを読めます。
- サイトの画面の「データの取り込み」に、設定したサービスアカウントのメールアドレスが表示されます。鍵が未設定か読み取れない場合も、ここに表示されます。
- 鍵を作り直したときは、`GOOGLE_SERVICE_ACCOUNT_KEY`を新しい鍵に置き換えてから、Google Cloudで古い鍵を削除してください。
- 取り込みの仕組みと上限は[データの取り込み](/querune/reference/sync/#取り込みの仕組み)を参照してください。
