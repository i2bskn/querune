---
title: ログインとユーザー管理
description: ログインのエンドポイントと、ユーザー管理のAPI。
---

## ログイン

ログインとセッションの仕組みは[Pinglune](https://github.com/i2bskn/pinglune)と同じです。ログイン方式は`AUTH_MODE`で選びます（[パスワード](/querune/admin/password/)・[OIDC](/querune/admin/oidc/)）。

| エンドポイント | 内容 |
| --- | --- |
| `GET /auth/login` | ログイン画面 |
| `POST /auth/login` | パスワードでログインする（`AUTH_MODE=password`） |
| `GET /auth/setup`、`POST /auth/setup` | 初期設定。ユーザーがいないときだけ使え、登録した人がadminになる（`AUTH_MODE=password`） |
| `GET /auth/invite`、`POST /auth/invite` | 招待リンクを開いた人が自分のパスワードを決める画面。決めるとそのままログインする（`AUTH_MODE=password`） |
| `GET /auth/mfa/manage` | 多要素認証の設定画面。パスワードで確認してから、認証方法の登録・入れ替え・解除に進む（`AUTH_MODE=password`） |
| `/auth/mfa`以下のその他 | パスワードの後の多要素認証の確認と登録の画面（`AUTH_MODE=password`、[多要素認証](/querune/admin/mfa/)） |
| `GET /auth/oidc/callback` | OIDCのコールバック（`AUTH_MODE=oidc`） |
| `POST /auth/refresh` | セッションの更新 |
| `POST /auth/logout` | ログアウト |

## ユーザー管理

| エンドポイント | 内容 | ロール |
| --- | --- | --- |
| `GET /api/v1/me` | ログイン中のユーザー | すべて |
| `POST /api/v1/me/password` | 自分のパスワードの変更（`AUTH_MODE=password`） | すべて |
| `GET /api/v1/users` | ユーザーの一覧 | admin |
| `POST /api/v1/users` | ユーザーの追加。本文は`{ "email", "name"?, "role", "password"? }`。成功は201 `User`に`invitation`を足した形 | admin |
| `POST /api/v1/users/:id/invitation` | 招待リンクの再発行（`AUTH_MODE=password`）。成功は200 `{ "url", "expires_at" }` | admin |
| `POST /api/v1/users/:id/password` | パスワードの再設定（`AUTH_MODE=password`） | admin |
| `POST /api/v1/users/:id/reset-mfa` | 多要素認証のリセット（`AUTH_MODE=password`）。パスワードは残し、セッションとMCPの接続を切る。成功は204 | admin |
| `POST /api/v1/users/:id/revoke-sessions` | セッションの失効 | admin |
| `PATCH /api/v1/users/:id` | ロールの変更。本文は`{ "role" }` | admin |
| `DELETE /api/v1/users/:id` | ユーザーの削除 | admin |

- ロールは`admin`か`member`です。adminだけが使えるのはユーザー管理だけで、ほかのAPIとMCPにロールの差はありません。
- memberがadminのAPIを呼ぶと403 `forbidden`です。
- 最後のadminのロールの変更と削除は409 `last_admin`、自分自身の削除は400 `cannot_delete_self`です。
- `User`の`status`は`active`か`invited`です。`invited`は招待中のユーザーです。`AUTH_MODE=password`ではパスワードを決めていない人、`AUTH_MODE=oidc`ではまだ一度もログインしていない人が該当します。
- `POST /api/v1/users`で`password`を省くと招待になります。`AUTH_MODE=password`では`invitation`に招待リンクの`{ "url", "expires_at" }`（`expires_at`はUNIX時間のミリ秒）が入ります。リンクは発行から7日間有効で、1回だけ使えます。`password`を送ると、その初期パスワードで作ります（12〜256文字）。
- `AUTH_MODE=oidc`では`password`を送りません（送ると400 `invalid_password`）。`invitation`は常に`null`です。追加した人がそのメールアドレスでIdPにログインすると、IdPのアカウントと結び付きます。
- 招待リンクの再発行は、パスワードを決めた人には409 `already_active`です。再発行すると前のリンクは使えなくなります。adminがパスワードを再設定したときも、招待リンクは使えなくなります。
- 多要素認証を設定していない人のリセットは409 `mfa_not_enrolled`、自分自身のリセットは400 `cannot_reset_own_mfa`です。
