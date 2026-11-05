# APIリファレンス

ログイン、ユーザー管理、サイト、データの取り込み、MCP（OAuth、ツール）、データの扱いの仕様をまとめます。導入と設定の手順は[README](../README.md)と[設定](settings.md)を参照してください。

## ログイン

ログインとセッションの仕組みは[Pinglune](https://github.com/i2bskn/pinglune)と同じです。ログイン方式は`AUTH_MODE`で選びます（[設定](settings.md#ログイン方式)）。

| エンドポイント | 内容 |
| --- | --- |
| `GET /auth/login` | ログイン画面 |
| `POST /auth/login` | パスワードでログインする（`AUTH_MODE=password`） |
| `GET /auth/setup`、`POST /auth/setup` | 初期設定。ユーザーがいないときだけ使え、登録した人がadminになる（`AUTH_MODE=password`） |
| `GET /auth/oidc/callback` | OIDCのコールバック（`AUTH_MODE=oidc`） |
| `POST /auth/refresh` | セッションの更新 |
| `POST /auth/logout` | ログアウト |

## ユーザー管理

| エンドポイント | 内容 | ロール |
| --- | --- | --- |
| `GET /api/v1/me` | ログイン中のユーザー | すべて |
| `POST /api/v1/me/password` | 自分のパスワードの変更（`AUTH_MODE=password`） | すべて |
| `GET /api/v1/users` | ユーザーの一覧 | admin |
| `POST /api/v1/users` | ユーザーの追加（`AUTH_MODE=password`） | admin |
| `POST /api/v1/users/:id/password` | パスワードの再設定（`AUTH_MODE=password`） | admin |
| `POST /api/v1/users/:id/revoke-sessions` | セッションの失効 | admin |
| `PATCH /api/v1/users/:id` | ロールの変更。本文は`{ "role" }` | admin |
| `DELETE /api/v1/users/:id` | ユーザーの削除 | admin |

- ロールは`admin`か`member`です。adminだけが使えるのはユーザー管理だけで、ほかのAPIとMCPにロールの差はありません。
- memberがadminのAPIを呼ぶと403 `forbidden`です。
- 最後のadminのロールの変更と削除は409 `last_admin`、自分自身の削除は400 `cannot_delete_self`です。

## サイト

| エンドポイント | 内容 | 成功 |
| --- | --- | --- |
| `GET /api/v1/sites` | サイトの一覧（`name`の昇順、同じ名前は`id`の昇順） | 200 `{ "sites": Site[] }` |
| `POST /api/v1/sites` | サイトの登録。本文は`{ "name", "url", "gsc_property"?, "ga4_property_id"? }` | 201 `Site` |
| `GET /api/v1/sites/:id` | サイト1件 | 200 `Site` |
| `PATCH /api/v1/sites/:id` | サイトの変更。本文は`name`、`url`、`gsc_property`、`ga4_property_id`のうち変える項目だけ | 200 `Site` |
| `DELETE /api/v1/sites/:id` | サイトの削除。取り込み済みのデータも削除する | 204 |

- ログインしたユーザーなら、ロールに関係なくすべて使えます。全ユーザーが同じサイトを見ます。
- サイトは100件まで登録できます。
- サイトは登録したユーザーと結び付けません。ユーザーを削除してもサイトは残ります。
- `gsc_property`か`ga4_property_id`を変えると、そのデータソースの取り込み済みデータは集計に使われなくなり、削除されます（[取り込みの仕組み](#取り込みの仕組み)）。サイトを削除すると、取り込み済みのデータも削除されます。

`Site`の形は次のとおりです。時刻はUNIX時間のミリ秒です。

```json
{
  "id": "site_01JC9Z8Q4R6T2V7W3X5Y1A0B2C",
  "name": "ブログ",
  "url": "https://example.com",
  "gsc_property": "sc-domain:example.com",
  "ga4_property_id": "123456789",
  "created_at": 1767225600000,
  "updated_at": 1767225600000
}
```

### 入力の検証

検証は次の順に行い、最初に見つかったエラーを返します：未知の項目 →（`PATCH`のみ）空のオブジェクト → `name` → `url` → `gsc_property` → `ga4_property_id`。

| 項目 | 規則 | 保存する値 |
| --- | --- | --- |
| `name` | 文字列。前後の空白を除いて1〜100文字（コードポイント数）、制御文字を含まない | 前後の空白を除いた値 |
| `url` | 文字列。前後の空白を除いて2048文字以下。スキームが`https`か`http`で、ユーザー名・パスワードを含まない | オリジン（ホストは小文字、既定のポートは省く）。パス・クエリ・フラグメントは保存しない |
| `gsc_property` | `null`、空文字、`sc-domain:`＋ドメイン（接頭辞の大文字小文字は問わない。253文字以下）、または`https`か`http`のURLプレフィックス（パスが`/`で終わり、クエリ・フラグメント・ユーザー名・パスワードを含まない。2048文字以下） | `null`と空文字は`null`。ドメインは小文字にする。URLプレフィックスは正規化したURL（例：`https://example.com`は`https://example.com/`） |
| `ga4_property_id` | `null`、空文字、または1〜20桁の数字 | `null`と空文字は`null` |

`http://example.com`と`https://example.com`は別のオリジンなので、別のサイトとして登録できます。

### エラー

| ステータス | コード | 条件 |
| --- | --- | --- |
| 400 | `invalid_body` | 本文がJSONのオブジェクトでない |
| 400 | `unknown_field` | 未知の項目がある |
| 400 | `invalid_request` | `PATCH`の本文が空のオブジェクト |
| 400 | `invalid_name` | `name`が規則に合わない |
| 400 | `invalid_url` | `url`が規則に合わない |
| 400 | `invalid_gsc_property` | `gsc_property`が規則に合わない |
| 400 | `invalid_ga4_property` | `ga4_property_id`が規則に合わない |
| 401 | `unauthorized` | ログインしていない |
| 404 | `not_found` | サイトが見つからない（`DELETE`も同じ） |
| 409 | `url_conflict` | 同じ`url`のサイトが登録済み（登録・変更とも） |
| 409 | `limit_exceeded` | サイトが100件ある状態での登録。`url`が重複していてもこのエラーになる |

## データの取り込み

| エンドポイント | 内容 | 成功 |
| --- | --- | --- |
| `GET /api/v1/google` | サービスアカウントの設定 | 200 `GoogleStatus` |
| `POST /api/v1/sites/:id/sync` | 期間を指定した取り込みの依頼。本文は`{ "start_date", "end_date" }` | 202 `{ "queued", "days" }` |
| `GET /api/v1/sites/:id/sync` | 取り込みの状況 | 200 `SyncStatus` |

ログインしたユーザーなら、ロールに関係なくすべて使えます。

### `GET /api/v1/google`

```json
{ "configured": true, "client_email": "querune@project.iam.gserviceaccount.com", "error": null }
```

鍵が未設定なら`{ "configured": false, "client_email": null, "error": null }`、設定されているが読み取れない（JSONでない、`client_email`・`private_key`がない、鍵の形式が正しくない）なら`{ "configured": false, "client_email": null, "error": "invalid" }`です。鍵そのものは返しません。

### `POST /api/v1/sites/:id/sync`

`start_date`と`end_date`（`YYYY-MM-DD`、両端を含む）の各日を、サイトにプロパティがあるデータセット（Search Consoleなら`gsc_pages`と`gsc_queries`、GA4なら`ga4_landing_pages`）ごとに取り込みます。取得済みの日も取り込み直します。Search ConsoleのデータセットはUTCの今日から16か月より前の日を含めません（Search Consoleの保存期間外のため）。応答の`queued`は依頼したメッセージ数（日×データセット）、`days`は依頼した日の数です。待ち・実行中の日は依頼し直しません。

検証は次の順に行い、最初に見つかったエラーを返します。

| ステータス | コード | 条件 |
| --- | --- | --- |
| 400 | `invalid_body` | 本文がJSONのオブジェクトでない |
| 400 | `unknown_field` | 未知の項目がある |
| 400 | `invalid_date` | `start_date`か`end_date`がない、または`YYYY-MM-DD`の実在する日付でない |
| 400 | `invalid_range` | 開始日が終了日より後、終了日がUTCの今日より後、または期間が90日を超える |
| 404 | `not_found` | サイトが見つからない |
| 409 | `not_configured` | サイトにSearch ConsoleのプロパティもGA4のプロパティIDもない |
| 409 | `google_not_configured` | `GOOGLE_SERVICE_ACCOUNT_KEY`が未設定か読み取れない |
| 503 | `temporarily_unavailable` | キューに送れなかった。送れなかった日は`enqueue_failed`で失敗として記録される |

### `GET /api/v1/sites/:id/sync`

```json
{
  "site_id": "site_01JC9Z8Q4R6T2V7W3X5Y1A0B2C",
  "datasets": [
    {
      "dataset": "gsc_pages",
      "configured": true,
      "property": "sc-domain:example.com",
      "latest_date": "2026-11-03",
      "provisional_from": "2026-11-01",
      "last_succeeded_at": 1793000000000,
      "available_days": 120,
      "truncated_days": 0,
      "queued": 0,
      "running": 0,
      "failed": 1,
      "recent_failures": [
        { "date": "2026-10-30", "error_code": "permission_denied", "error_message": "...", "finished_at": 1793000000000 }
      ]
    }
  ]
}
```

- `datasets`は常に`gsc_pages`、`gsc_queries`、`ga4_landing_pages`の3件です。`configured`は対応するプロパティがあるか、`property`は今のプロパティです。プロパティがなければ、ほかの値は`null`・0・空の配列です。
- 数えるのは今のプロパティの日だけです。「取得済みの日」は一度でも取り込みに成功した日で、取り直しの待ち・実行中・失敗の間も取得済みのままです。
- `latest_date`は取得済みの最新の日、`provisional_from`は取得済みで速報値の最も古い日、`last_succeeded_at`は最後に成功した時刻（UNIX時間のミリ秒）、`available_days`は取得済みの日数、`truncated_days`は行数の上限で打ち切った日数です。
- `queued`・`running`・`failed`は、その状態の日数です。`recent_failures`は失敗した日を新しい順に最大10件返します。

失敗の`error_code`は次のとおりです。

| コード | 内容 |
| --- | --- |
| `google_not_configured` | サービスアカウントの鍵が設定されていない |
| `credentials_invalid` | 鍵が読み取れないか、Googleが鍵を受け付けなかった |
| `invalid_request` | Google APIが400を返した |
| `permission_denied` | サービスアカウントにプロパティの閲覧権限がない（403） |
| `property_not_found` | プロパティが見つからない（404） |
| `invalid_response` | Google APIの応答を読み取れなかった |
| `retry_exhausted` | 一時的な失敗（401・429・5xx・通信エラー・D1の上限など）が再試行の上限まで続いた |
| `enqueue_failed` | 取り込みをキューに送れなかった |

### 取り込みの仕組み

- 取り込みは、1メッセージで1データセット×1日×2,000行までを処理します。2,000行を超える日は、続きのメッセージで次の2,000行を取り込みます。同じ日の取り込みは同じIDを持ち、取り込み直しが始まると古い取り込みのメッセージは捨てられます。
- 1日・1データセットあたり50,000行までを取り込みます（Search Console APIで取れる上限）。それを超える日は打ち切り、打ち切った日として記録します。
- 毎日18:00 UTCに、全サイトの直近7日（昨日まで）と、直近30日のうち速報値・失敗・止まった取り込みの日を取り込み直します。それより前の日を取り直すには、管理画面かAPIで期間を指定して取り込みます。
- Search Consoleは、応答のメタデータで未確定とされた日と、太平洋時間で3日前以降の日を速報値として記録します。GA4は、プロパティのタイムゾーンで2日前以降の日を速報値として記録します。速報値の日は、確定するまで毎日取り込み直します。
- 速報値の日はページを取る間に値が変わるため、ページの境界で行が抜けたり重複したりすることがあります（Search Consoleは並び順を指定できないため）。重複は同じ行への上書きで吸収し、抜けは翌日以降の取り直しで補います。
- 一時的な失敗（Google APIの401・429・5xx、通信エラー、D1の失敗）は、60秒から倍々に最大1時間の間隔で5回まで再試行します。上限に達すると`retry_exhausted`として記録します。D1の1日の上限に当たった日もこうなり、直近30日の日は翌日以降の毎日の取り込みが、それより前の日は手動の取り込みで取り直します。
- 取り直し中や取り直しに失敗した日も、前回成功した時点のデータは残り、集計に使われます。
- プロパティを変更すると、そのデータソースの取り込みの状況を消し、古いプロパティの行は集計に使われなくなります。行は削除の予約として、キューで5,000行ずつ削除します。サイトを削除した場合も同じです。削除のメッセージが届かなかった場合は、毎日の処理が送り直します。元のプロパティに戻して取り込み直した日の行は削除しません。

## MCP

### 認証

`/mcp`はOAuthで認可するMCPサーバーです。MCP認可仕様に沿ったOAuth 2.1の認可サーバーをQuerune自身が持ち、DCR、CIMD、PKCE（S256）、保護リソースメタデータ、認可サーバーメタデータ、RFC 9207のissパラメータに対応します。クライアント、grant、トークンはKVに保存します。CIMDには互換フラグ`global_fetch_strictly_public`が必要です。

| エンドポイント | 内容 |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp` | 保護リソースメタデータ。`resource`は`<origin>/mcp`、`authorization_servers`は`<origin>` |
| `GET /.well-known/oauth-authorization-server` | 認可サーバーメタデータ |
| `POST /oauth/register` | 動的クライアント登録（DCR） |
| `GET /authorize` | 認可要求。ログインと同意の画面を表示します |
| `POST /oauth/token` | トークンの発行と更新 |

- スコープは`mcp`の1つです。
- アクセストークンの有効期間は12時間、リフレッシュトークンは30日です（`AUTH_MODE=oidc`では24時間）。
- ユーザーの削除、パスワード変更、セッションの失効では、そのユーザーのgrantをすべて取り消します。
- パスワード変更とセッションの失効では、その時刻までに許可したトークンを`/mcp`で拒否します。grantの一覧の反映が遅れて取り消しから漏れたgrantにも効きます。
- 同じクライアント・同じリダイレクトURIで許可し直すと、そのクライアントの以前のgrantは取り消されます。
- 接続したユーザーは、全サイトのデータと記録を読めます。サイトごとに読める範囲を絞る機能はありません。

### ツール

| ツール | 引数 | 返す内容 |
| --- | --- | --- |
| `list_sites` | なし | `{ "sites": [{ "id", "name", "url", "gsc_property", "ga4_property_id" }] }`（`name`の昇順、同じ名前は`id`の昇順） |
| `get_sync_status` | `site_id` | `GET /api/v1/sites/:id/sync`と同じ`SyncStatus` |
| `query_search_performance` | `site_id`、`start_date`、`end_date`（必須）、`group_by`（`page`・`query`・`page_query`・`date`、既定`page`）、`page`（完全一致）、`query_contains`（部分一致。`group_by`が`query`・`page_query`のときだけ）、`compare_start_date`・`compare_end_date`、`order_by`（`clicks`・`impressions`、既定`clicks`）、`limit`（1〜100、既定20） | Search Consoleの集計。`rows`、`totals`、`coverage`、`notes` |
| `query_landing_sessions` | `site_id`、`start_date`、`end_date`（必須）、`group_by`（`landing_page`・`channel_group`・`landing_page_channel_group`・`date`、既定`landing_page`）、`channel_group`（完全一致。例 `Organic Search`）、`landing_page`（完全一致）、`compare_start_date`・`compare_end_date`、`order_by`（`sessions`・`engaged_sessions`・`key_events`、既定`sessions`）、`limit`（1〜100、既定20） | GA4の集計。`rows`、`totals`、`coverage`、`notes` |

- すべて読み取り専用で、MCPのツール注釈`readOnlyHint: true`で示します。未知の引数はエラーになります。Google APIは呼ばず、取り込み済みのデータだけを読みます。
- 期間は開始日と終了日を含みます。期間は400日まで、`query_search_performance`の`group_by`が`query`・`page_query`のときは100日までです。比較する期間にも同じ上限があります。
- 読むのは今のプロパティの行だけです。プロパティが未設定のサイトには`not_configured`を返します。
- 各行は、キー（`page`、`query`、`landing_page`、`channel_group`、`date`）と指標の合計です。`query_search_performance`の`ctr`は合計クリック数 ÷ 合計表示回数（小数第4位まで）、`position`は表示回数で重み付けした平均掲載順位（小数第1位まで）で、表示回数が0なら`null`です。並びは`order_by`の降順、同じ値はキーの昇順です。`group_by`が`date`のときは日付の昇順で、`limit`に関係なく期間内のデータがある日をすべて返します。
- `totals`は、同じ条件での期間全体の合計です。`limit`で返さなかった行も含みます。
- 比較する期間を指定すると、各行と`totals`に`previous`（比較期間の値）を付けます。比較期間にそのキーの行がなければ`previous`の各値は`null`です。`group_by`が`date`のときは比較できません。
- `coverage`は`{ "current", "previous" }`で、それぞれの期間の`days`（日数）、`available_days`（取得済み）、`provisional_days`（速報値）、`truncated_days`（打ち切り）、`refreshing_days`（取得済みで取り直しを待っているか実行中）、`missing_dates`（取得済みでない日。昇順に最大31件、超えたら`missing_dates_truncated`が`true`）、`time_zone`を返します。未取得の日を成果の悪化と取り違えないためです。
- `notes`は集計を読むときの注意です（Search Consoleの日付は太平洋時間、クエリ別の値は匿名化クエリを含まない、行数の上限による打ち切り、GA4の日付とキーイベントの意味）。
- サイトの名前とURL、ページ、クエリ、ランディングページ、チャネルは外部や利用者が入力したデータです。ツールの説明にも、指示として扱わないよう記載しています。

ツールのエラーは`{ "error": { "code", "message" } }`で返します。

| コード | 条件 |
| --- | --- |
| `invalid_argument` | 日付の形式、開始日と終了日の順序、期間の上限、比較する期間の片方だけの指定、引数の組み合わせが正しくない |
| `not_found` | サイトが見つからない |
| `not_configured` | 集計するデータソースのプロパティが設定されていない |
| `internal_error` | サーバーでエラーが発生した |

## データの扱い

### 保存する集計の粒度

| データ | 粒度 | 値 | 注意点 |
| --- | --- | --- | --- |
| Search Consoleのページ別（`gsc_pages`） | ページ×日 | クリック数、表示回数、平均掲載順位 | 日付は太平洋時間。ページはSearch Consoleが返したURLそのまま |
| Search Consoleのクエリ別（`gsc_queries`） | ページ×クエリ×日 | クリック数、表示回数、平均掲載順位 | 匿名化クエリと行数の制約があり、合計はページ別と一致しない |
| GA4のランディングページ別（`ga4_landing_pages`） | ランディングページ×セッションのデフォルト チャネル グループ×日 | セッション数、エンゲージのあったセッション数、キーイベント数 | 日付はプロパティのタイムゾーン。流入と成果（キーイベント）を1つのテーブルに持つ。ランディングページはクエリ文字列を含まないパス |

チャネルは絞り込まずにディメンションとして保存し、読み取るときに絞り込みます。行ごとに、取り込んだときのプロパティを持ちます。GA4はData APIの集計結果を保存します。生のイベントは保存しません。

### 指標の計算

- CTRは、期間の合計クリック数 ÷ 合計表示回数で計算します。日ごとのCTRを平均しません。表示回数が0のときは値なしとして扱います。
- 割合や平均掲載順位を単純に平均しません。分母と重みを保持し、元の集計の定義に沿って計算します。
- Search Consoleのクエリ行の合計を、ページ全体の値として扱いません。
- 欠損と未取得を0に置き換えません。全件を取得したか、一部だけかを区別します。
- ページの成果を、そのページの各クエリ行に複製して合計しません。クエリ別の成果は、これらの集計からは求められません。
- Search Consoleのクリック数とGA4のセッション数は別の指標として扱います。Search Consoleの日付は太平洋時間、GA4はプロパティのタイムゾーンで区切られるため、同じ日付でも厳密には対応しません。

### 来歴

日・データセットごとに、取り込んだプロパティ、最後に成功した時刻、確定・速報値、行数、行数の上限で打ち切ったか、タイムゾーンを記録します（[取り込みの仕組み](#取り込みの仕組み)）。遅れて更新される直近の日は取り直し、同じ日を取り直しても重複しないように保存します。
