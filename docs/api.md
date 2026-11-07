# APIリファレンス

ログイン、ユーザー管理、サイト、データの取り込み、記事とメモ、MCP（OAuth、ツール）、データの扱いの仕様をまとめます。導入と設定の手順は[README](../README.md)と[設定](settings.md)を参照してください。

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
| `DELETE /api/v1/sites/:id` | サイトの削除。取り込み済みのデータと、記事・メモも削除する | 204 |

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

### `GET /api/v1/sites/:id/insights`

管理画面の実績に使う集計です。取り込んだ今のプロパティの行だけを集計します。

| クエリ | 内容 |
| --- | --- |
| `days` | 期間の日数（1〜180、既定28） |
| `end` | 期間の最後の日（`YYYY-MM-DD`、今日以前）。省略すると取り込み済みの最新の日 |
| `article_id` | 指定するとその記事のURLのページ（GA4はURLのパス）だけを集計し、メモはその記事にひも付くものだけを返す |

```json
{
  "site_id": "site_01JC9Z8Q4R6T2V7W3X5Y1A0B2C",
  "period": { "start": "2026-10-10", "end": "2026-11-06", "days": 28 },
  "previous_period": { "start": "2026-09-12", "end": "2026-10-09" },
  "article": null,
  "search": {
    "property": "sc-domain:example.com",
    "time_zone": "America/Los_Angeles",
    "daily": [{ "date": "2026-09-12", "clicks": 15, "impressions": 588, "position": 7.1 }],
    "totals": { "clicks": 1073, "impressions": 29989, "ctr": 0.0358, "position": 5.6 },
    "previous_totals": { "clicks": 872, "impressions": 24840, "ctr": 0.0351, "position": 6.3 },
    "pages": [{ "key": "https://example.com/a", "clicks": 357, "impressions": 7557, "ctr": 0.0472, "position": 1.8, "previous_clicks": 291, "previous_impressions": 6800, "previous_position": 2.4 }],
    "queries": [],
    "coverage": { "days": 28, "available_days": 28, "provisional_days": 3, "missing_days": 0, "truncated_days": 0, "time_zone": "America/Los_Angeles" }
  },
  "sessions": {
    "property": "123456789",
    "daily": [{ "date": "2026-09-12", "sessions": 151, "engaged_sessions": 80, "key_events": 1 }],
    "totals": { "sessions": 5696, "engaged_sessions": 2811, "engagement_rate": 0.4935, "key_events": 31 },
    "previous_totals": { "sessions": 4571, "engaged_sessions": 2153, "engagement_rate": 0.471, "key_events": 27 },
    "channels": [{ "key": "Organic Search", "sessions": 3713, "engaged_sessions": 1900, "engagement_rate": 0.5117, "key_events": 20, "previous_sessions": 2990 }],
    "landing_pages": [],
    "coverage": { "days": 28, "available_days": 28, "provisional_days": 3, "missing_days": 0, "truncated_days": 0, "time_zone": "Asia/Tokyo" }
  },
  "memos": [{ "id": "memo_01JC9Z8Q4R6T2V7W3X5Y1A0B2C", "title": "タイトルを変更", "tags": ["改善"], "created_at": 1793000000000 }]
}
```

- `daily`は前の期間の最初の日から期間の最後の日まで1日1件で、行のない日の値は`null`です。前の期間は期間の直前の同じ日数です。
- `ctr`はクリック÷表示回数、`position`は表示回数で重み付けした平均掲載順位、`engagement_rate`はエンゲージのあったセッション÷セッションです。分母が0なら`null`です。
- `pages`・`queries`はクリックの多い順、`channels`・`landing_pages`はセッションの多い順に10件までです。`previous_*`は前の期間に行がなければ`null`です。
- `search`はSearch Consoleのプロパティがないか記事にURLがなければ`null`、`sessions`はGA4のプロパティがないか記事にURLがなければ`null`です。
- `memos`は期間の前後1日を含めて作成されたメモを新しい順に100件までです。画面はブラウザの日付で各日に並べます。
- クエリが正しくなければ400 `invalid_query`、サイトか記事（別のサイトの記事を含む）がなければ404 `not_found`です。

### `GET /api/v1/sites/insights`

全サイトの直近28日（UTCで昨日まで）のクリックとセッションを、サイトの一覧に使います。

```json
{
  "period": { "start": "2026-10-10", "end": "2026-11-06", "days": 28 },
  "sites": [
    {
      "site_id": "site_01JC9Z8Q4R6T2V7W3X5Y1A0B2C",
      "clicks": { "daily": [28, 31], "total": 1073, "previous_total": 872 },
      "sessions": null
    }
  ]
}
```

- `daily`は期間の1日1件で、行のない日は0です。プロパティがなければ`clicks`・`sessions`は`null`です。

### 取り込みの仕組み

- 取り込みは、1メッセージで1データセット×1日×2,000行までを処理します。2,000行を超える日は、続きのメッセージで次の2,000行を取り込みます。同じ日の取り込みは同じIDを持ち、取り込み直しが始まると古い取り込みのメッセージは捨てられます。
- 1日・1データセットあたり50,000行までを取り込みます（Search Console APIで取れる上限）。それを超える日は打ち切り、打ち切った日として記録します。
- 毎日18:00 UTCに、全サイトの直近7日（昨日まで）と、直近30日のうち速報値・失敗・止まった取り込みの日を取り込み直します。それより前の日を取り直すには、管理画面かAPIで期間を指定して取り込みます。
- Search Consoleは、応答のメタデータで未確定とされた日と、太平洋時間で3日前以降の日を速報値として記録します。GA4は、プロパティのタイムゾーンで2日前以降の日を速報値として記録します。速報値の日は、確定するまで毎日取り込み直します。
- 速報値の日はページを取る間に値が変わるため、ページの境界で行が抜けたり重複したりすることがあります（Search Consoleは並び順を指定できないため）。重複は同じ行への上書きで吸収し、抜けは翌日以降の取り直しで補います。
- 一時的な失敗（Google APIの401・429・5xx、通信エラー、D1の失敗）は、60秒から倍々に最大1時間の間隔で5回まで再試行します。上限に達すると`retry_exhausted`として記録します。D1の1日の上限に当たった日もこうなり、直近30日の日は翌日以降の毎日の取り込みが、それより前の日は手動の取り込みで取り直します。
- 取り直し中や取り直しに失敗した日も、前回成功した時点のデータは残り、集計に使われます。
- プロパティを変更すると、そのデータソースの取り込みの状況を消し、古いプロパティの行は集計に使われなくなります。行は削除の予約として、キューで5,000行ずつ削除します。サイトを削除した場合も同じです。削除のメッセージが届かなかった場合は、毎日の処理が送り直します。元のプロパティに戻して取り込み直した日の行は削除しません。

## 記事とメモ

サイトごとに、記事の台帳とメモを持ちます。メモは、調査・計測の変更・競合の観察・記事のアイデアなど、サイトについて残しておきたいことを書く場所で、タイトル・本文・タグ・記事との関連付けだけを持ちます。日付・期間・種類・状態は持たず、必要なら本文やタグで表します。記事もメモも利用者が決める自由なタグで分類できます。分類の軸、振り返りの周期や期間は決めていません。

| エンドポイント | 内容 | 成功 |
| --- | --- | --- |
| `GET /api/v1/sites/:id/articles` | サイトの記事の一覧（`note`を含まない）。クエリ`tag`で1つのタグに完全一致する記事だけにできる | 200 `{ "articles": ArticleSummary[] }` |
| `POST /api/v1/sites/:id/articles` | 記事の登録。本文は`{ "title", "url"?, "published_on"?, "tags"?, "note"? }` | 201 `Article` |
| `POST /api/v1/sites/:id/articles/sitemap` | サイトマップを読み、記事の候補のURLを返す。本文は`{ "sitemap_url"? }` | 200 `ReadSitemapResponse` |
| `POST /api/v1/sites/:id/articles/import` | 選んだURLのページを取得し、タイトルと公開日を読んで記事として登録する。本文は`{ "urls" }` | 200 `{ "results": ImportArticleResult[] }` |
| `GET /api/v1/articles/:id` | 記事1件 | 200 `Article` |
| `PATCH /api/v1/articles/:id` | 記事の変更。本文は`title`、`url`、`published_on`、`tags`、`note`のうち変える項目だけ | 200 `Article` |
| `DELETE /api/v1/articles/:id` | 記事の削除。メモは残り、その記事との関連付けだけを外す | 204 |
| `GET /api/v1/sites/:id/memos` | サイトのメモの一覧（`content`の代わりに先頭300文字の`content_preview`を含む） | 200 `{ "memos": (MemoSummary & { "content_preview" })[], "next_offset" }` |
| `POST /api/v1/sites/:id/memos` | メモの登録。本文は`{ "title", "content"?, "tags"?, "article_ids"? }` | 201 `Memo` |
| `GET /api/v1/memos/:id` | メモ1件 | 200 `Memo` |
| `PATCH /api/v1/memos/:id` | メモの変更。本文は登録と同じ項目のうち変える項目だけ | 200 `Memo` |
| `DELETE /api/v1/memos/:id` | メモの削除 | 204 |
| `GET /api/v1/sites/:id/tags` | サイトの記事とメモで使われているタグ | 200 `{ "tags": [{ "tag", "articles", "memos" }], "truncated" }` |

- ログインしたユーザーなら、ロールに関係なくすべて使えます。
- 削除は管理画面（このREST API）からだけ行えます。MCPには削除のツールがありません。
- 変更の履歴は残しません。`PATCH`は、値が保存済みのものと同じでも成功し、`updated_at`を更新します（`article_ids`だけの変更でも更新します）。`id`、`site_id`、`created_at`は変えられません（`unknown_field`）。
- サイトを削除すると、そのサイトの記事・メモ・関連付けも削除されます。
- 1サイトあたり記事は1,000件、メモは2,000件まで登録できます。

`Article`と`Memo`の形は次のとおりです。日付は`YYYY-MM-DD`、時刻はUNIX時間のミリ秒です。記事の`note`は備考です。

```json
{
  "id": "art_01JC9Z8Q4R6T2V7W3X5Y1A0B2C",
  "site_id": "site_01JC9Z8Q4R6T2V7W3X5Y1A0B2C",
  "title": "記事のタイトル",
  "url": "https://example.com/articles/1",
  "published_on": "2026-01-15",
  "tags": ["topic:example"],
  "note": "備考",
  "created_at": 1767225600000,
  "updated_at": 1767225600000
}
```

```json
{
  "id": "memo_01JC9Z8Q4R6T2V7W3X5Y1A0B2C",
  "site_id": "site_01JC9Z8Q4R6T2V7W3X5Y1A0B2C",
  "title": "GA4のタグをGTM経由に変更",
  "tags": ["計測"],
  "content": "本文",
  "articles": [{ "id": "art_01JC9Z8Q4R6T2V7W3X5Y1A0B2C", "title": "記事のタイトル", "url": "https://example.com/articles/1" }],
  "created_at": 1767225600000,
  "updated_at": 1767225600000
}
```

- `ArticleSummary`は`Article`から`note`を除いたもの、`MemoSummary`は`Memo`から`content`を除き、`articles`を`{ "id", "title" }`にしたものです。
- メモの`articles`はタイトルの昇順、同じタイトルは`id`の昇順です。

### サイトマップからの取り込み

サイトマップに載っているURLを、記事の台帳へまとめて登録します。管理画面では記事の画面の「サイトマップから取り込む」から使います。

`POST /api/v1/sites/:id/articles/sitemap`はサイトマップを読みます。

- `sitemap_url`を省略するか`null`・空文字にすると、`<サイトのURL>/sitemap.xml`を読みます。指定するときはサイトと同じoriginのURLにします。
- `urlset`ならその`<url>`を読みます。`sitemapindex`なら先頭から10本までの子サイトマップを順に読み、11本目以降・別のoriginの子・取得に失敗した子・`urlset`でない子は読まずに`skipped_sitemaps`に数えます。
- gzipで圧縮したサイトマップ（`.xml.gz`）も読めます。読むのはUTF-8だけで、子を含めた展開後の合計は5 MBまでです。
- URLはフラグメントを除いて正規化し、サイトマップに書かれた順に返します。重複は最初の1つだけを残します。不正なURLと別のoriginのURLは除き、`skipped_urls`に数えます。5,000件を超えた分は捨てて`truncated`を`true`にします。
- `lastmod`はサイトマップに書かれた日付（`YYYY-MM-DD`）です。時差は変換しません。

```json
{
  "sitemap_url": "https://example.com/sitemap.xml",
  "urls": [{ "url": "https://example.com/posts/a", "lastmod": "2026-10-01", "registered": false }],
  "truncated": false,
  "skipped_urls": 0,
  "skipped_sitemaps": 0,
  "remaining": 997
}
```

- `registered`は、同じ`url`の記事が登録済みなら`true`です。
- `remaining`は、あと登録できる記事の件数です（URLのない記事も数えます）。

`POST /api/v1/sites/:id/articles/import`は、`urls`に指定したページ（1〜10件、サイトと同じorigin）を取得して記事を登録します。

- ページは同時に5本まで取得し、先頭256 KBだけを読みます。同じoriginの中のリダイレクトは2回まで追い、記事の`url`にはリダイレクト後のURLを使います。
- タイトルは`og:title`・`<title>`の順に読みます。どちらもなければURLのパスの最後の区切りを使い、それもなければホスト名にします。200文字を超える分は切ります。
- タイトルの後ろに付いたサイト名は外します。最後の`|`（`｜`）の後ろが40文字以内ならその部分を外し、` - `・` – `・` — `・` · `の後ろは`og:site_name`で始まる場合だけ外します。
- 公開日は`article:published_time`・JSON-LDの`datePublished`・`itemprop="datePublished"`の`<meta>`と`<time>`の順に読みます。サイトマップの`lastmod`は使いません。
- タグは空、備考は空文字で登録します。登録済みの記事は変更しません。
- `results`はリクエストの順（重複を除いた後）で、`status`は`created`（`article`に`ArticleSummary`）・`exists`（同じURLの記事が登録済み）・`failed`（`error`に理由）のどれかです。
- ページの取得に失敗したURL（HTTPのエラー・応答なし・HTMLでない・UTF-8以外の文字コード・サイトの外へのリダイレクト）は`failed`になり、ほかのURLは続けて登録します。
- 記事の上限に達したら、そのURLと以降の未登録のURLは`failed`になります。

Cloudflare Workersの無料プランでは、大きなサイトマップを読むとCPU時間の上限で失敗することがあります。その場合は子サイトマップのURLを指定してください。

### 一覧の並びと絞り込み

- 記事の一覧は、公開日のない記事が先、続いて`published_on`の降順、同じ日は`id`の降順です。
- メモの一覧は、`created_at`の降順（新しく作成した順）、同じ時刻は`id`の降順です。MCPの一覧と記事にひも付くメモも同じ並びです。
- メモの一覧のクエリは`q`（タイトルか本文に含む語。ASCIIの英字は大文字小文字を区別しない。前後の空白を除いて100文字以下で、空なら絞り込まない）、`tag`、`article_id`、`created_after`、`created_before`、`limit`（1〜100、既定50）、`offset`（0〜2000、既定0）です。続きがあれば`next_offset`に次の`offset`を返し、なければ`null`です。
- `created_after`はその時刻以降（その時刻を含む）、`created_before`はその時刻より前（その時刻を含まない）に作成したメモだけにします。値はオフセット付きのRFC 3339の日時です（例 `2026-10-01T00:00:00+09:00`、`2026-10-01T00:00:00Z`）。形式は`YYYY-MM-DDTHH:MM`、続けて省略できる`:SS`と小数秒（1〜3桁）、最後に`Z`か`±HH:MM`です。`T`と`Z`は大文字だけを受け付けます。両方を指定するときは、`created_after`を`created_before`より前にします。
- `tag`はタグの規則で正規化してから完全一致で比べます。`article_id`は形式が正しければ、存在しない記事や別のサイトの記事でも空の一覧を返します。
- 未知のクエリは無視します。値が正しくなければ`invalid_query`です。
- タグの一覧は、使われている件数（記事とメモの合計）の多い順、同じ件数はタグの昇順で、200個までです。それより多ければ`truncated`が`true`です。

### 入力の検証

| 項目 | 規則 | 保存する値 |
| --- | --- | --- |
| `title` | 文字列。前後の空白を除いて1〜200文字（コードポイント数）、制御文字を含まない | 前後の空白を除いた値 |
| `url` | `null`、空文字、または文字列。前後の空白を除いて2048文字以下。スキームが`https`か`http`で、ユーザー名・パスワードを含まない。ホストはサイトのURLと同じでなくてよい | `null`と空文字は`null`。フラグメントを除いた正規化したURL（2048文字以下）。クエリは残す |
| `published_on` | `null`、空文字、または存在する日付の`YYYY-MM-DD` | `null`と空文字は`null` |
| `tags` | 文字列の配列。各タグは前後の空白を除きNFCで正規化して1〜50文字、制御文字と`,`・`、`・`，`を含まない。重複を除いて20個まで | 重複（大文字小文字を区別）を除き、最初の順に並べた配列 |
| `note`（記事の備考）、`content`（メモの本文） | 文字列。改行とタブ以外の制御文字を含まない。改行を`\n`にそろえて10,000文字以下 | 改行を`\n`にそろえた値。前後の空白は除かない |
| `article_ids` | 記事のIDの配列。同じサイトの登録済みの記事で、重複を除いて5件まで。`PATCH`では関連付けの全体を置き換える | |

メモの登録で省略した項目は、`content`が空文字、`tags`と`article_ids`が空の配列です。

メモの登録と同時に別の要求が記事を削除した場合、その記事は関連付けずに登録します。このため、保存した関連付けが`article_ids`より少ないことがあります。応答の`articles`が保存した関連付けです。

### エラー

| ステータス | コード | 条件 |
| --- | --- | --- |
| 400 | `invalid_body` | 本文がJSONのオブジェクトでない |
| 400 | `unknown_field` | 未知の項目がある |
| 400 | `invalid_request` | `PATCH`の本文が空のオブジェクト |
| 400 | `invalid_title`・`invalid_url`・`invalid_date`・`invalid_tags`・`invalid_note`・`invalid_content` | その項目が規則に合わない |
| 400 | `invalid_articles` | `article_ids`に形式の正しくないID、存在しない記事、別のサイトの記事がある、または6件以上ある |
| 400 | `invalid_query` | 一覧のクエリが正しくない |
| 400 | `invalid_sitemap_url` | `sitemap_url`が正しくない、またはサイトと同じoriginでない |
| 400 | `invalid_urls` | `urls`が1〜10件の文字列の配列でない、または不正なURLや別のoriginのURLがある |
| 401 | `unauthorized` | ログインしていない |
| 404 | `not_found` | サイト・記事・メモが見つからない、またはIDの形式が正しくない |
| 409 | `url_conflict` | 同じサイトに同じ`url`の記事がある（登録・変更とも） |
| 409 | `limit_exceeded` | 記事かメモが上限の件数ある状態での登録 |
| 422 | `sitemap_unavailable` | サイトマップを取得できない（HTTPのエラー・応答なし・サイトの外へのリダイレクト・5 MB超過） |
| 422 | `sitemap_unreadable` | サイトマップとして読めない（`urlset`でも`sitemapindex`でもない） |

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
- アクセストークンの有効期間は12時間、リフレッシュトークンは30日です。
- ユーザーの削除、パスワード変更、セッションの失効では、そのユーザーのgrantをすべて取り消します。
- パスワード変更とセッションの失効では、その時刻までに許可したトークンを`/mcp`で拒否します。grantの一覧の反映が遅れて取り消しから漏れたgrantにも効きます。
- 同じクライアント・同じリダイレクトURIで許可し直すと、そのクライアントの以前のgrantは取り消されます。
- 接続したユーザーは、全サイトのデータと記事・メモを読め、記事とメモを登録・編集できます。サイトごとに読める範囲を絞る機能はありません。

### ツール

| ツール | 引数 | 返す内容 |
| --- | --- | --- |
| `list_sites` | なし | `{ "sites": [{ "id", "name", "url", "gsc_property", "ga4_property_id" }] }`（`name`の昇順、同じ名前は`id`の昇順） |
| `get_sync_status` | `site_id` | `GET /api/v1/sites/:id/sync`と同じ`SyncStatus` |
| `query_search_performance` | `site_id`、`start_date`、`end_date`（必須）、`group_by`（`page`・`query`・`page_query`・`date`、既定`page`）、`page`（完全一致）、`query_contains`（部分一致。`group_by`が`query`・`page_query`のときだけ）、`compare_start_date`・`compare_end_date`、`order_by`（`clicks`・`impressions`、既定`clicks`）、`limit`（1〜100、既定20） | Search Consoleの集計。`rows`、`totals`、`coverage`、`notes` |
| `query_landing_sessions` | `site_id`、`start_date`、`end_date`（必須）、`group_by`（`landing_page`・`channel_group`・`landing_page_channel_group`・`date`、既定`landing_page`）、`channel_group`（完全一致。例 `Organic Search`）、`landing_page`（完全一致）、`compare_start_date`・`compare_end_date`、`order_by`（`sessions`・`engaged_sessions`・`key_events`、既定`sessions`）、`limit`（1〜100、既定20） | GA4の集計。`rows`、`totals`、`coverage`、`notes` |
| `list_articles` | `site_id`、`tag`（完全一致）、`published`（`true`は公開日のある記事、`false`はない記事）、`title_contains`（タイトルの部分一致。1〜100文字。ASCIIの大文字小文字を区別しない）、`limit`（1〜200、既定50）、`offset`（既定0） | `{ "site_id", "articles", "next_offset" }`。各記事は`ArticleSummary`に備考の先頭200文字`note_preview`を付けたもの |
| `get_article` | `article_id` | `Article`に、ひも付くメモ`memos`（`MemoSummary`、新しく作成した順に50件まで）、その件数`memos_total`、`search_console_page`（記事のURL）、`ga4_landing_page`（URLのパス）を付けたもの。URLがなければ後の2つは`null` |
| `list_memos` | `site_id`、`tag`、`article_id`、`created_after`、`created_before`（オフセット付きのRFC 3339の日時）、`limit`（1〜100、既定20）、`offset`（既定0） | `{ "site_id", "memos", "next_offset" }`。各メモは`MemoSummary`に本文の先頭300文字`content_preview`を付けたもの |
| `get_memo` | `memo_id` | `Memo` |
| `list_tags` | `site_id` | `GET /api/v1/sites/:id/tags`と同じ |
| `create_article` | `site_id`、`title`（必須）、`url`、`published_on`、`tags`、`note` | 登録した`Article` |
| `update_article` | `article_id`（必須）と、変える項目（`title`、`url`、`published_on`、`tags`、`note`のうち1つ以上） | 変更後の`Article`に、変更前の記事`previous`を付けたもの |
| `create_memo` | `site_id`、`title`（必須）、`content`、`tags`、`article_ids` | 登録した`Memo` |
| `update_memo` | `memo_id`（必須）と、変える項目（`title`、`content`、`tags`、`article_ids`のうち1つ以上） | 変更後の`Memo`に、変更前のメモ`previous`を付けたもの |

- `create_article`・`update_article`・`create_memo`・`update_memo`のほかは読み取り専用で、MCPのツール注釈`readOnlyHint: true`で示します。未知の引数はエラーになります。Google APIは呼ばず、取り込み済みのデータだけを読みます。
- 記事とメモのツールは[記事とメモ](#記事とメモ)のREST APIと同じ検証を行い、同じメッセージを返します。一覧の絞り込みの規則も同じです。削除のツールはありません。
- 変更のツールは指定した項目だけを変え、`tags`・`note`・`content`は値全体を、`article_ids`は関連付けの全体を置き換えます。変更の履歴は残らないため、変更前の値`previous`を返します。誤って上書きしたときは、会話に残った`previous`から戻せます。
- `get_article`の`search_console_page`と`ga4_landing_page`は、`query_search_performance`の`page`と`query_landing_sessions`の`landing_page`に使うための値です。リダイレクト、末尾のスラッシュ、クエリ文字列のために、Search ConsoleのURLやGA4のパスが記事のURLと異なることがあります。
- 期間は開始日と終了日を含みます。期間は400日まで、`query_search_performance`の`group_by`が`query`・`page_query`のときは100日までです。比較する期間にも同じ上限があります。
- 読むのは今のプロパティの行だけです。プロパティが未設定のサイトには`not_configured`を返します。
- 各行は、キー（`page`、`query`、`landing_page`、`channel_group`、`date`）と指標の合計です。`query_search_performance`の`ctr`は合計クリック数 ÷ 合計表示回数（小数第4位まで）、`position`は表示回数で重み付けした平均掲載順位（小数第1位まで）で、表示回数が0なら`null`です。並びは`order_by`の降順、同じ値はキーの昇順です。`group_by`が`date`のときは日付の昇順で、`limit`に関係なく期間内のデータがある日をすべて返します。
- `totals`は、同じ条件での期間全体の合計です。`limit`で返さなかった行も含みます。
- 比較する期間を指定すると、各行と`totals`に`previous`（比較期間の値）を付けます。比較期間にそのキーの行がなければ`previous`の各値は`null`です。`group_by`が`date`のときは比較できません。
- `coverage`は`{ "current", "previous" }`で、それぞれの期間の`days`（日数）、`available_days`（取得済み）、`provisional_days`（速報値）、`truncated_days`（打ち切り）、`refreshing_days`（取得済みで取り直しを待っているか実行中）、`missing_dates`（取得済みでない日。昇順に最大31件、超えたら`missing_dates_truncated`が`true`）、`time_zone`を返します。未取得の日を成果の悪化と取り違えないためです。
- `notes`は集計を読むときの注意です（Search Consoleの日付は太平洋時間、クエリ別の値は匿名化クエリを含まない、行数の上限による打ち切り、GA4の日付とキーイベントの意味）。
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
