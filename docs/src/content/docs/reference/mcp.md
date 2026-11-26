---
title: MCP
description: MCPのOAuthによる認可と、AIから使えるツール。
---

## 認証

`/mcp`はOAuthで認可するMCPサーバーです。MCP認可仕様に沿ったOAuth 2.1の認可サーバーをQuerune自身が持ち、DCR、CIMD、PKCE（S256）、保護リソースメタデータ、認可サーバーメタデータ、RFC 9207のissパラメータに対応します。クライアント、grant、トークンはKVに保存します。CIMDには互換フラグ`global_fetch_strictly_public`が必要です。

| エンドポイント | 内容 |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp` | 保護リソースメタデータ。`resource`は`<origin>/mcp`、`authorization_servers`は`<origin>` |
| `GET /.well-known/oauth-authorization-server` | 認可サーバーメタデータ |
| `POST /oauth/register` | 動的クライアント登録（DCR） |
| `GET /authorize` | 認可要求。ログインと同意の画面を表示します |
| `POST /oauth/token` | トークンの発行と更新 |

- スコープは`mcp`の1つです。
- アクセストークンの有効期間は12時間、リフレッシュトークンは30日です。
- ユーザーの削除、パスワード変更、セッションの失効では、そのユーザーのgrantをすべて取り消します。
- パスワード変更とセッションの失効では、その時刻までに許可したトークンを`/mcp`で拒否します。grantの一覧の反映が遅れて取り消しから漏れたgrantにも効きます。
- 同じクライアント・同じリダイレクトURIで許可し直すと、そのクライアントの以前のgrantは取り消されます。
- 接続したユーザーは、全サイトのデータと記事・メモを読め、記事とメモを登録・編集できます。サイトごとに読める範囲を絞る機能はありません。

## ツール

| ツール | 引数 | 返す内容 |
| --- | --- | --- |
| `list_sites` | なし | `{ "sites": [{ "id", "name", "url", "gsc_property", "ga4_property_id" }] }`（`name`の昇順、同じ名前は`id`の昇順） |
| `get_sync_status` | `site_id` | `GET /api/v1/sites/:id/sync`と同じ`SyncStatus` |
| `query_search_performance` | `site_id`、`start_date`、`end_date`（必須）、`group_by`（`page`・`query`・`page_query`・`date`、既定`page`）、`page`（完全一致）、`query_contains`（部分一致。`group_by`が`query`・`page_query`のときだけ）、`compare_start_date`・`compare_end_date`、`order_by`（`clicks`・`impressions`、既定`clicks`）、`limit`（1〜100、既定20） | Search Consoleの集計。`rows`、`totals`、`coverage`、`notes` |
| `query_landing_sessions` | `site_id`、`start_date`、`end_date`（必須）、`group_by`（`landing_page`・`channel_group`・`landing_page_channel_group`・`date`、既定`landing_page`）、`channel_group`（完全一致。例 `Organic Search`）、`landing_page`（完全一致）、`compare_start_date`・`compare_end_date`、`order_by`（`sessions`・`engaged_sessions`・`key_events`、既定`sessions`）、`limit`（1〜100、既定20） | GA4の集計。`rows`、`totals`、`coverage`、`notes` |
| `query_page_views` | `site_id`、`start_date`、`end_date`（必須）、`group_by`（`page`・`host_name`・`date`、既定`page`。`page`はホスト名とパスの組）、`host_name`（完全一致）、`page_path`（そのままの値とデコード版の両方に一致）、`compare_start_date`・`compare_end_date`、`order_by`（`views`・`engagement_seconds`、既定`views`）、`limit`（1〜100、既定20） | GA4のページの表示回数の集計。`rows`、`totals`、`coverage`、`notes` |
| `list_articles` | `site_id`、`tag`（完全一致）、`published`（`true`は公開日のある記事、`false`はない記事）、`title_contains`（タイトルの部分一致。1〜100文字。ASCIIの大文字小文字を区別しない）、`limit`（1〜200、既定50）、`offset`（既定0） | `{ "site_id", "articles", "next_offset" }`。各記事は`ArticleSummary`に備考の先頭200文字`note_preview`を付けたもの |
| `get_article` | `article_id` | `Article`に、ひも付くメモ`memos`（`MemoSummary`、新しく作成した順に50件まで）、その件数`memos_total`、`search_console_page`（記事のURL）、`ga4_landing_page`（URLのパス）、`ga4_page`（`{ "host_name", "page_path" }`。URLのホスト名とpathnameのまま）を付けたもの。URLがなければ後の3つは`null` |
| `list_memos` | `site_id`、`tag`、`article_id`、`created_after`、`created_before`（オフセット付きのRFC 3339の日時）、`limit`（1〜100、既定20）、`offset`（既定0） | `{ "site_id", "memos", "next_offset" }`。各メモは`MemoSummary`に本文の先頭300文字`content_preview`を付けたもの |
| `get_memo` | `memo_id` | `Memo` |
| `list_tags` | `site_id` | `GET /api/v1/sites/:id/tags`と同じ |
| `create_article` | `site_id`、`title`（必須）、`url`、`published_on`、`tags`、`note` | 登録した`Article` |
| `update_article` | `article_id`（必須）と、変える項目（`title`、`url`、`published_on`、`tags`、`note`のうち1つ以上） | 変更後の`Article`に、変更前の記事`previous`を付けたもの |
| `create_memo` | `site_id`、`title`（必須）、`content`、`tags`、`article_ids` | 登録した`Memo` |
| `update_memo` | `memo_id`（必須）と、変える項目（`title`、`content`、`tags`、`article_ids`のうち1つ以上） | 変更後の`Memo`に、変更前のメモ`previous`を付けたもの |

- `create_article`・`update_article`・`create_memo`・`update_memo`のほかは読み取り専用で、MCPのツール注釈`readOnlyHint: true`で示します。未知の引数はエラーになります。Google APIは呼ばず、取り込み済みのデータだけを読みます。
- 記事とメモのツールは[記事とメモ](/querune/reference/articles-memos/)のREST APIと同じ検証を行い、同じメッセージを返します。一覧の絞り込みの規則も同じです。削除のツールはありません。
- 変更のツールは指定した項目だけを変え、`tags`・`note`・`content`は値全体を、`article_ids`は関連付けの全体を置き換えます。変更の履歴は残らないため、変更前の値`previous`を返します。誤って上書きしたときは、会話に残った`previous`から戻せます。
- `get_article`の`search_console_page`と`ga4_landing_page`は、`query_search_performance`の`page`と`query_landing_sessions`の`landing_page`に使うための値です。`ga4_page`は`query_page_views`の`host_name`と`page_path`に使います。`page_path`はデコード版のパスにも一致します。リダイレクト、末尾のスラッシュ、クエリ文字列のために、Search ConsoleのURLやGA4のパスが記事のURLと異なることがあります。
- 期間は開始日と終了日を含みます。期間は400日まで、`query_search_performance`の`group_by`が`query`・`page_query`のときは100日までです。比較する期間にも同じ上限があります。
- 読むのは今のプロパティの行だけです。プロパティが未設定のサイトには`not_configured`を返します。
- 各行は、キー（`page`、`query`、`landing_page`、`channel_group`、`date`）と指標の合計です。`query_search_performance`の`ctr`は合計クリック数 ÷ 合計表示回数（小数第4位まで）、`position`は表示回数で重み付けした平均掲載順位（小数第1位まで）で、表示回数が0なら`null`です。並びは`order_by`の降順、同じ値はキーの昇順です。`group_by`が`date`のときは日付の昇順で、`limit`に関係なく期間内のデータがある日をすべて返します。
- `totals`は、同じ条件での期間全体の合計です。`limit`で返さなかった行も含みます。
- 比較する期間を指定すると、各行と`totals`に`previous`（比較期間の値）を付けます。比較期間にそのキーの行がなければ`previous`の各値は`null`です。`group_by`が`date`のときは比較できません。
- `query_page_views`の`views`・`engagement_seconds`・`avg_engagement_seconds_per_view`は[ページの表示回数](/querune/reference/data/#ページの表示回数ga4_pages)の定義です。期間に取得済みの日が1日もなければ`totals`の各値は`null`です。比較期間に取得済みの日が1日もなければ、各行の`previous`と`totals.previous`は`null`です。取得済みの日はあるのにその行がなければ、`previous`は`{ "views": 0, "engagement_seconds": 0, "avg_engagement_seconds_per_view": null }`です（表示が0回だったため）。`coverage`の両方の期間に`thresholded_days`を付けます。ほかのツールの`coverage`には付けません。
- `coverage`は`{ "current", "previous" }`で、それぞれの期間の`days`（日数）、`available_days`（取得済み）、`provisional_days`（速報値）、`truncated_days`（打ち切り）、`refreshing_days`（取得済みで取り直しを待っているか実行中）、`pending_days`（取得済みでなく、取り込みを待っているか実行中。`missing_dates`の日に含まれる）、`upcoming_days`（取得済みでなく取り込みの記録もない、期待される最新日以降の日。`missing_dates`の日に含まれ、日付は返さないので区別は日数で見る）、`missing_dates`（取得済みでない日。昇順に最大31件、超えたら`missing_dates_truncated`が`true`）、`provisional_dates`（取得済みで速報値の日。昇順に最大31件、超えたら`provisional_dates_truncated`が`true`）、`time_zone`を返します。未取得の日を成果の悪化と取り違えないためです。
- `notes`は集計を読むときの注意です（Search Consoleの日付は太平洋時間、クエリ別の値は匿名化クエリを含まない、行数の上限による打ち切り、GA4の日付とキーイベントの意味）。どちらかの期間に速報値の日があれば今後変わりうること、GA4では確定が経過日数による推定であることも返します。`query_page_views`は、表示回数が入口のセッション数と別の指標であること・平均がGA4の画面のユーザーあたりの値と違うこと・ユーザー数を提供しないことを常に返します。`thresholded_days`が1日以上なら、その影響も返します。どちらかの期間に`pending_days`があれば、取り込みが終わると値が変わることも返します。どちらかの期間に`upcoming_days`があれば、まだ取り込みの時期になっていない日があることも返します。
- 週・月などの期間を比べるときは、`get_sync_status`の`final_through`以前の同じ完了した期間を使うよう、ツールの説明に記載しています。`final_through`は直近14日だけで決まるため、期間全体の完了は`coverage`で確かめます。
- サイトの名前とURL、ページ、クエリ、ランディングページ、チャネル、記事・メモのタイトル・URL・備考・本文・タグは外部や利用者・AIが入力したデータです。ツールの説明にも、指示として扱わないよう記載しています。書き込むツールの説明には、会話で利用者が求めた内容だけを書き込むよう記載しています。

ツールのエラーは`{ "error": { "code", "message" } }`で返します。

| コード | 条件 |
| --- | --- |
| `invalid_argument` | 日付の形式、開始日と終了日の順序、期間の上限、比較する期間の片方だけの指定、引数の組み合わせが正しくない。記事とメモの項目や絞り込みが規則に合わない |
| `not_found` | サイト・記事・メモが見つからない |
| `url_conflict` | 同じサイトに同じURLの記事がある |
| `limit_exceeded` | 記事かメモが上限の件数ある |
| `not_configured` | 集計するデータソースのプロパティが設定されていない |
| `internal_error` | サーバーでエラーが発生した |
