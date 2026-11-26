---
title: 環境変数
description: Queruneで設定できる環境変数と、値が正しくないときの動作。
---

環境変数は、Cloudflareのダッシュボード（Workersの「Settings」→「Variables and Secrets」）か`wrangler secret put`で設定します。`wrangler.jsonc`には書きません。再デプロイで設定が上書きされないようにするためです。

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `JWT_SECRET` | 必須 | ログインのセッションに使う秘密の値。32文字以上。`openssl rand -hex 32`で生成します。変更すると全員がログアウトします |
| `AUTH_MODE` | 任意 | ログイン方式。`password`（既定）か`oidc` |
| `APP_ORIGIN` | `oidc`で必須 | QueruneのURLのオリジン（例：`https://querune.example.com`）。`password`では、設定するとパスキーで多要素認証できます |
| `OIDC_ISSUER` | `oidc`で必須 | IdPのissuerそのもの。`/.well-known/`を含むURL（discoveryのURL）は設定エラーです |
| `OIDC_CLIENT_ID` | `oidc`で必須 | IdPに登録したクライアントのID |
| `OIDC_CLIENT_SECRET` | `oidc`で必須 | IdPに登録したクライアントのシークレット |
| `INITIAL_ADMIN_EMAIL` | `oidc`で最初の1人に必須 | 最初のadminのメールアドレス。ユーザーが0人のときだけ、このメールアドレスでログインした人をadminにします。[OIDCでログインする](/querune/admin/oidc/)を参照 |
| `OIDC_REQUIRE_EMAIL_VERIFIED` | 任意 | `false`にすると、IdPが`email_verified`を送らない場合もログインを許可します。[OIDCでログインする](/querune/admin/oidc/)を参照 |
| `OIDC_REQUIRE_GOOGLE_HD` | 任意 | `true`にすると、初めてのログインでGoogleの`hd`を確かめます。Gmailは対象外です。IdPのログイン方法がGoogleだけの場合に使います。[OIDCでログインする](/querune/admin/oidc/#googleのhdの確認oidc_require_google_hd)を参照 |
| `PASSWORD_MFA_POLICY` | 任意 | 多要素認証を必須にする範囲。`optional`（既定）・`admins`・`all`のどれか（`AUTH_MODE=password`）。[多要素認証](/querune/admin/mfa/)を参照 |
| `PASSWORD_MFA_KEY` | 任意 | 認証アプリ（TOTP）の秘密を暗号化する鍵。設定すると認証アプリで多要素認証できます（`AUTH_MODE=password`）。[多要素認証](/querune/admin/mfa/)を参照 |
| `PASSWORD_HASH_ALGORITHM` | 任意 | パスワードのハッシュの方式。`scrypt`（既定）か`pbkdf2`。`AUTH_MODE`に関係なく、それ以外の値は設定エラーです。[パスワードのハッシュ](/querune/admin/password/#パスワードのハッシュpassword_hash_algorithm)を参照 |
| `PASSWORD_PBKDF2_ITERATIONS` | 任意 | `pbkdf2`のときのハッシュの回数。10000〜100000の整数（既定は100000）で、`"50000"`のように文字列で設定します。`scrypt`のときも確かめられ、範囲外は設定エラーです。[パスワードのハッシュ](/querune/admin/password/#パスワードのハッシュpassword_hash_algorithm)を参照 |
| `SESSION_MAX_AGE_HOURS` | 任意 | ログインからセッションが切れるまでの時間。既定は`password`で`720`（30日）、`oidc`で`24`です。[セッションの長さ](/querune/admin/sessions/)を参照 |
| `SESSION_IDLE_TIMEOUT_HOURS` | 任意 | 最後のアクセスからセッションが切れるまでの時間。既定はなしです。[セッションの長さ](/querune/admin/sessions/)を参照 |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | 任意 | Search ConsoleとGA4の取り込みに必要。Googleのサービスアカウントの鍵（JSON）をそのまま設定します。[Search ConsoleとGA4をつなぐ](/querune/getting-started/google/)を参照 |

## 設定エラーになったとき

環境変数の値が正しくない（設定エラーの）間は、次のようになります。値を直すと元に戻ります。

- すべてのリクエストが500になります。ログに`invalid configuration`と変数の名前が出ます。
- 定期（cron）の取り込みは何もせずに終わります。
- キューに入った取り込みは処理されず、値が直るまで再試行を続けます。

`OIDC_REQUIRE_GOOGLE_HD`は例外です（[OIDCでログインする](/querune/admin/oidc/#googleのhdの確認oidc_require_google_hd)を参照）。
