---
title: OIDCでログインする
description: IdPのアカウントでログインする方式（AUTH_MODE=oidc）と、Cloudflare Access for SaaSでGoogleを使う場合の設定。
---

## ログインできる人

IdPのアカウントでログインします。ログインできるのは、adminが管理画面のユーザー管理で追加した人だけです。IdPでログインできることやドメインに所属していることだけでは、ユーザーは作られません。

- 最初のadminは`INITIAL_ADMIN_EMAIL`で決めます。ユーザーが1人もいないときだけ、このメールアドレスでログインした人がadminとして作られます。ユーザーが1人以上いれば、この設定は使われません。
- `INITIAL_ADMIN_EMAIL`を設定しないと、ユーザーがいない状態では誰もログインできません。形式が正しくないと、すべてのリクエストが500になります（[設定エラーになったとき](/querune/admin/configuration/#設定エラーになったとき)）。
- 2人目以降は、adminがユーザー管理でメールアドレスとロールを指定して追加します。追加した人が初めてログインしたときに、IdPのアカウントと結び付きます。結び付いた後はIdPのアカウントで本人を確かめるので、IdP側でメールアドレスを変えてもログインできます。
- 追加してまだログインしていない人は、一覧に「招待中」と表示されます。
- ログインさせたくない人は削除します。削除するとセッションとMCPの接続も切れます。もう一度使えるようにするには、ユーザーを追加し直します。
- `OIDC_REQUIRE_EMAIL_VERIFIED=false`は、IdPが`email_verified`を送らず、かつIdPのすべてのログイン方法がメールアドレスを確認している場合にだけ設定してください。未確認のメールアドレスでログインできる方法があると、追加済みでまだログインしていない人や`INITIAL_ADMIN_EMAIL`になりすまして結び付けられるためです。`email_verified`が送られた場合は、この設定に関係なく`true`である必要があります。`OIDC_ISSUER`を変えたときは、この設定も見直してください。IdPが`email_verified`を送れるように設定できる場合は、そちらを優先します（Cloudflare Accessは下記を参照）。
- IdPには、リダイレクトURIとして`<APP_ORIGIN>/auth/oidc/callback`を登録します。

## Cloudflare Access for SaaSでGoogleを使う場合

Cloudflare Access for SaaSは、Googleの`email_verified`と`hd`を既定ではIDトークンに入れません。AccessのアプリのOIDCクレームに、次の2つを追加します。

| 名前 | スコープ | IdPクレーム | 必須 |
| --- | --- | --- | --- |
| `email_verified` | `profile` | `verified_email` | オン |
| `hd` | `profile` | `hd` | オフ |

- それぞれ新しいクレームとして追加します。既存のクレームの下にある「IdPごとの値」は、そのクレームの値をIdPごとに上書きする設定です。そこに`hd`を入れると`email_verified`が`hd`の値になり、誰もログインできなくなります。
- `hd`は必須にしません。Gmailのアカウントには`hd`がないので、必須にするとAccessでログインに失敗します。
- `email_verified`を追加すれば、`OIDC_REQUIRE_EMAIL_VERIFIED`は既定（`true`が必要）のままで使えます。
- `hd`を追加したうえで、`OIDC_REQUIRE_GOOGLE_HD`を`true`にします（下記）。

## Googleの`hd`の確認（`OIDC_REQUIRE_GOOGLE_HD`）

IdPのログイン方法がGoogleだけの場合（Cloudflare Access for SaaSでGoogleだけを選んだ場合など）に、`OIDC_REQUIRE_GOOGLE_HD`を`true`にします。Googleがメールアドレスの今の持ち主を保証できるのは、Gmailと、IDトークンに`hd`が入るGoogle Workspaceのアカウントだけです。会社のメールアドレスで作った個人のGoogleアカウントには`hd`がありません。

- 有効にすると、`@gmail.com`以外のメールアドレスでは、IDトークンの`hd`が空でない文字列のときだけログインを許可します。`hd`の値は確かめないので、協力先のWorkspaceのアカウントもログインできます。
- 確かめるのは、追加した人の初めてのログインと、`INITIAL_ADMIN_EMAIL`で最初のadminを作るときです。条件を満たさないと、ユーザーと結び付けず、「このアカウントではログインできません」と表示します。
- すでにIdPのアカウントと結び付いた人は確かめ直しません。有効にする前に結び付いた人もログインし続けられます。まだログインしていない人は、有効にした後の初めてのログインで確かめます。
- 有効にする前に、IdPがIDトークンに`hd`を入れるようにします。Cloudflare Accessでは、上記のとおりアプリのOIDCクレームに`hd`を追加します。`hd`が届かないと、Gmail以外の人は初めてのログインができません。拒否されたときは、ログに`oidc login rejected`（`reason: "google_hd_missing"`）が出ます。
- `INITIAL_ADMIN_EMAIL`が`hd`のないアカウント（Gmailでも、Workspaceでもないもの）だと、最初のadminを作れません。その場合は無効にしてadminを作ってから、有効にします。
- IdPは確かめません。Google以外のログイン方法があるIdPで有効にすると、Gmail以外の人がログインできないか、確認の意味がなくなります。
- 値は`true`か`false`（既定）です。それ以外の値では、初めてのログインと最初のadminの作成だけが403で拒否され、ほかの機能は動き続けます。ログに`invalid configuration`と`OIDC_REQUIRE_GOOGLE_HD`が出ます。
