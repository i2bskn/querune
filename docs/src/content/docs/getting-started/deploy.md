---
title: デプロイする
description: Deploy to Cloudflareボタンで自分のCloudflareアカウントにQueruneをデプロイします。
---

## 必要なもの

- Cloudflareのアカウントが必要です。
- Search ConsoleとGA4のデータを取り込む場合は、サービスアカウントを作るためのGoogle Cloudのプロジェクトが必要です。
- `JWT_SECRET`は`openssl rand -hex 32`で生成した値を使ってください。変更すると全員がログアウトします。

WorkersとD1のFreeプランで動く範囲は[Freeプランの目安](/querune/admin/free-plan/)を参照してください。

## Deploy to Cloudflareボタンでデプロイする

1. 次のボタンを押します。

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/i2bskn/querune)

2. セットアップ画面で`JWT_SECRET`を入力し、D1データベースの場所のヒントに、使う人に近い地域（日本ならAsia-Pacific (APAC)）を選びます。
3. 表示されたURLを開くと初期設定画面になり、**最初に登録した人がadminになります**。URLを知った他人に先に登録されないように、デプロイしたらすぐ登録してください。

ボタンを押した後にデプロイで実行される手順は[デプロイの仕組み](/querune/development/deploy/)にまとめています。

## 次にすること

- Search ConsoleとGA4のデータを取り込むには、[Search ConsoleとGA4をつなぐ](/querune/getting-started/google/)に進みます。
- 設定できる環境変数は[環境変数](/querune/admin/configuration/)、ログイン方式は[パスワードでログインする](/querune/admin/password/)と[OIDCでログインする](/querune/admin/oidc/)を参照してください。
