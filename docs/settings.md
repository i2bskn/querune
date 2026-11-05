# 設定

Queruneの環境変数、ログイン方式、Search ConsoleとGA4の接続をまとめます。

## 環境変数

環境変数は、Cloudflareのダッシュボード（Workersの「Settings」→「Variables and Secrets」）か`wrangler secret put`で設定します。`wrangler.jsonc`には書きません。再デプロイで設定が上書きされないようにするためです。

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `JWT_SECRET` | 必須 | ログインのセッションに使う秘密の値。32文字以上。`openssl rand -hex 32`で生成します。変更すると全員がログアウトします |
| `AUTH_MODE` | 任意 | ログイン方式。`password`（既定）か`oidc` |
| `APP_ORIGIN` | `oidc`で必須 | QueruneのURLのオリジン（例：`https://querune.example.com`） |
| `OIDC_ISSUER` | `oidc`で必須 | IdPのissuer |
| `OIDC_CLIENT_ID` | `oidc`で必須 | IdPに登録したクライアントのID |
| `OIDC_CLIENT_SECRET` | `oidc`で必須 | IdPに登録したクライアントのシークレット |
| `ALLOWED_EMAILS` | `oidc`で実質必須 | ログインを許可するメールアドレス。下記を参照 |
| `OIDC_REQUIRE_EMAIL_VERIFIED` | 任意 | `false`にすると、IdPが`email_verified`を送らない場合もログインを許可します。下記を参照 |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | 任意 | Search ConsoleとGA4の取り込みに必要。Googleのサービスアカウントの鍵（JSON）をそのまま設定します。下記を参照 |

## ログイン方式

### パスワード（`AUTH_MODE=password`）

既定のログイン方式です。デプロイしてURLを開くと初期設定画面になり、最初に登録した人がadminになります。2人目以降は、adminが管理画面のユーザー管理で追加します。

### OIDC（`AUTH_MODE=oidc`）

IdPのアカウントでログインします。初めてログインした人がadminになり、2人目以降はmemberになります。ユーザーはメールアドレスで既存のアカウントと結び付けます。

- `ALLOWED_EMAILS`が空なら、誰もログインできません。`*`はすべての人を許可します（IdP側でログインできる人を絞っている場合に使います）。それ以外は、カンマ区切りのメールアドレス（完全一致）かドメイン（完全一致。サブドメインは一致しません）です。
- `OIDC_REQUIRE_EMAIL_VERIFIED=false`は、IdPが`email_verified`を送らず、かつIdPのすべてのログイン方法がメールアドレスを確認している場合にだけ設定してください。未確認のメールアドレスでログインできると、同じメールアドレスの既存アカウントを乗っ取れるためです。`email_verified`が送られた場合は、この設定に関係なく`true`である必要があります。`OIDC_ISSUER`を変えたときは、この設定も見直してください。
- IdPには、リダイレクトURIとして`<APP_ORIGIN>/auth/oidc/callback`を登録します。

## ロール

| ロール | できること |
| --- | --- |
| admin | すべての操作と、ユーザー管理（追加、パスワードの再設定、セッションの失効、ロールの変更、削除） |
| member | ユーザー管理以外のすべての操作 |

全ユーザーが同じサイトの情報を見ます。サイトごと・ユーザーごとに見られる範囲を分ける機能はありません。最後のadminのロールは変更できず、削除もできません。自分自身は削除できません。

## Search Console と GA4 の接続

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
- 取り込みの仕組みと上限は[APIリファレンス](api.md#取り込みの仕組み)を参照してください。
