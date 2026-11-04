# APIリファレンス

ログイン、ユーザー管理、サイト、MCP（OAuth、ツール）、データの扱いの仕様をまとめます。導入と設定の手順は[README](../README.md)と[設定](settings.md)を参照してください。

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
| `DELETE /api/v1/sites/:id` | サイトの削除 | 204 |

- ログインしたユーザーなら、ロールに関係なくすべて使えます。全ユーザーが同じサイトを見ます。
- サイトは100件まで登録できます。
- サイトは登録したユーザーと結び付けません。ユーザーを削除してもサイトは残ります。

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

- `list_sites`は読み取り専用で、未知の引数はエラーになります。
- サイトの名前とURLは利用者が入力したデータです。ツールの説明にも、指示として扱わないよう記載しています。

次の操作を提供します。

| 操作 | 用途 | 種類 |
| --- | --- | --- |
| サイト・記事の一覧、記事の詳細 | 対象と公開・更新状況を把握する | 読み取り |
| 検索クエリの一覧、期間の比較 | 検索の変化や次の記事の候補を確認する | 読み取り |
| 施策の履歴、レビュー | 前回の判断とその後を確認する | 読み取り |
| データの更新状況 | 鮮度や同期の失敗を確認する | 読み取り |
| 施策・レビューの記録 | 会話で決めた内容を保存する | 書き込み |

- 応答には、集計の対象期間・条件・データの鮮度を付けます。同期の失敗や未取得を、成果の悪化と取り違えないようにするためです。
- 読み取り専用のツールは、MCPのツール注釈`readOnlyHint: true`で示します。
- 取得したデータ（ページのタイトル、検索クエリなど）に書かれた指示は、データとして扱い、指示として実行しません。ツールの説明にもその旨を記載します。

## データの扱い

### 保存する集計の粒度

| データ | 粒度 | 注意点 |
| --- | --- | --- |
| Search Consoleのページ実績 | ページ・日 | ページ全体のクリック数・表示回数など |
| Search Consoleのクエリ実績 | ページ・クエリ・日 | 匿名化クエリと行数の制約があり、合計はページ全体と一致しない |
| GA4の流入 | ランディングページ・日 | オーガニック検索の条件と、取得時のフィルターを一緒に保存する |
| GA4の成果 | ランディングページ・日と成果の定義 | 流入と別に管理し、集計の条件を記録する |

GA4はData APIの集計結果を保存します。生のイベントは保存しません。

### 指標の計算

- CTRは、期間の合計クリック数 ÷ 合計表示回数で計算します。日ごとのCTRを平均しません。表示回数が0のときは値なしとして扱います。
- 割合や平均掲載順位を単純に平均しません。分母と重みを保持し、元の集計の定義に沿って計算します。
- Search Consoleのクエリ行の合計を、ページ全体の値として扱いません。
- 欠損と未取得を0に置き換えません。全件を取得したか、一部だけかを区別します。
- ページの成果を、そのページの各クエリ行に複製して合計しません。クエリ別の成果は、これらの集計からは求められません。
- Search Consoleのクリック数とGA4のセッション数は別の指標として扱います。Search Consoleの日付は太平洋時間、GA4はプロパティのタイムゾーンで区切られるため、同じ日付でも厳密には対応しません。

### 来歴

集計ごとに、データソースとプロパティ、対象期間、フィルター、タイムゾーン、取得日時、状態（暫定・確定・一部のみ）、欠損を残します。遅れて更新される直近の日は取り直し、同じ期間を取り直しても重複しないように保存します。
