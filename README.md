# Querune

Queruneは、SEOを長く続けるための調査・記録・振り返りの手間を減らし、AIとの会話で次の行動を決められるようにするツールです。Search ConsoleとGoogle Analytics 4（GA4）のデータを取得して保存し、MCPを通じてAIから利用できるようにします。Cloudflare Workersで動き、Deploy to Cloudflareボタンで自分のCloudflareアカウントにデプロイできます。

- 同期: Search ConsoleとGA4の集計データを日次で取得し、データの鮮度・欠損・同期状態と一緒に保存します。
- 記事とメモ: サイトの記事の台帳（タイトル・URL・公開日・タグ・備考）と、メモを残します。メモはタイトル・本文・タグ・記事との関連付けだけを持つ、調査・計測の変更・競合の観察・記事のアイデアなど、サイトについて残しておきたいことを書く場所です。日付や種類は持たず、必要なら本文やタグで表します。分類は利用者が決める自由なタグで行います。「前回何を考え、何を変え、次に何をするか」を次の振り返りへ引き継ぐためです。
- MCP: OAuthで接続し、実績と記事・メモをAIから読み取れます。記事とメモはAIからも登録・編集できます（削除は管理画面だけ）。集計と指標の計算はサーバーで行い、AIは説明と検討を受け持ちます。
- 管理画面: 取り込んだ実績の推移・上位のクエリとページ・流入チャネルを、メモを書いた日の印と並べて見られます。メモは本文にMarkdownが使え、タイトルと本文から検索できます。記事・メモ・サイト・ユーザーの管理もここで行います。記事はサイトマップから選んでまとめて登録でき、タイトルと公開日はページから読み取ります。

## デプロイする

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/i2bskn/querune)

セットアップ画面では`JWT_SECRET`を入力します。`openssl rand -hex 32`で生成した値を使ってください。D1データベースの場所のヒントには、使う人に近い地域（日本ならAsia-Pacific (APAC)）を選びます。

表示されたURLを開くと初期設定画面になり、**最初に登録した人がadminになります**。URLを知った他人に先に登録されないように、デプロイしたらすぐ登録してください。

## ドキュメント

使い方と設定は https://docs.i2bskn.com/querune/ にまとめています。

- [デプロイする](https://docs.i2bskn.com/querune/getting-started/deploy/)
- [Search ConsoleとGA4をつなぐ](https://docs.i2bskn.com/querune/getting-started/google/)
- [AIとつなぐ](https://docs.i2bskn.com/querune/getting-started/ai/)
- [環境変数](https://docs.i2bskn.com/querune/admin/configuration/)
- [APIリファレンス](https://docs.i2bskn.com/querune/reference/auth/)
- [開発環境](https://docs.i2bskn.com/querune/development/local/)

ドキュメントのソースは[`docs/`](docs/)にあります。

## ライセンス

[Apache License 2.0](LICENSE)
