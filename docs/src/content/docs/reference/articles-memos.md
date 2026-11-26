---
title: 記事とメモ
description: 記事の台帳とメモのAPI、サイトマップからの取り込み、毎日の自動登録。
---

サイトごとに、記事の台帳とメモを持ちます。台帳にはブログ記事のほか、サービス紹介などの固定ページも登録できます。固定ページのように公開日のないものは`published_on`を`null`にします。メモは、調査・計測の変更・競合の観察・記事のアイデアなど、サイトについて残しておきたいことを書く場所で、タイトル・本文・タグ・記事との関連付けだけを持ちます。日付・期間・種類・状態は持たず、必要なら本文やタグで表します。記事もメモも利用者が決める自由なタグで分類できます。分類の軸、振り返りの周期や期間は決めていません。

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

## サイトマップからの取り込み

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
  "urls": [{ "url": "https://example.com/posts/a", "lastmod": "2026-10-01", "registered": false, "undated": false }],
  "truncated": false,
  "skipped_urls": 0,
  "skipped_sitemaps": 0,
  "remaining": 997
}
```

- `registered`は、同じ`url`の記事が登録済みなら`true`です。`undated`は、その記事に公開日がなければ`true`です。
- `remaining`は、あと登録できる記事の件数です（URLのない記事も数えます）。

`POST /api/v1/sites/:id/articles/import`は、`urls`に指定したページ（1〜10件、サイトと同じorigin）を取得して記事を登録します。

- ページは同時に5本まで取得し、先頭256 KBだけを読みます。同じoriginの中のリダイレクトは2回まで追い、記事の`url`にはリダイレクト後のURLを使います。
- タイトルは`og:title`・`<title>`の順に読みます。どちらもなければURLのパスの最後の区切りを使い、それもなければホスト名にします。200文字を超える分は切ります。
- タイトルの後ろに付いたサイト名は外します。最後の`|`（`｜`）の後ろが40文字以内ならその部分を外し、` - `・` – `・` — `・` · `の後ろは`og:site_name`で始まる場合だけ外します。
- 公開日は`article:published_time`・JSON-LDの`datePublished`・`itemprop="datePublished"`の`<meta>`と`<time>`の順に読みます。どれもなければ、最初の`<article>`の中で最初の`<time datetime>`を使います。サイトマップの`lastmod`は使いません。
- 時刻がUTC（`Z`か`+00:00`）なら日本時間の日付にします（`2026-11-04T20:00:00Z`は`2026-11-05`）。ほかのオフセットの時刻は書かれた日付のままです。
- タグは空、備考は空文字で登録します。
- 登録済みで公開日のない記事は、ページから読んだ公開日だけを設定します（`dated`）。読めなければ`failed`になり、タイトルなどほかの項目は変えません。公開日のある登録済みの記事はページを取得しません。
- `results`はリクエストの順（重複を除いた後）で、`status`は`created`（`article`に`ArticleSummary`）・`dated`（公開日を設定した記事。`article`に`ArticleSummary`）・`exists`（同じURLの記事が登録済み）・`failed`（`error`に理由）のどれかです。
- ページの取得に失敗したURL（HTTPのエラー・応答なし・HTMLでない・UTF-8以外の文字コード・サイトの外へのリダイレクト）は`failed`になり、ほかのURLは続けて登録します。
- 記事の上限に達したら、そのURLと以降の未登録のURLは`failed`になります。

Cloudflare Workersの無料プランでは、大きなサイトマップを読むとCPU時間の上限で失敗することがあります。その場合は子サイトマップのURLを指定してください。

### 毎日の自動登録

サイトマップに新しく載ったページは毎日自動で記事の台帳に登録します。ページの読み方は`POST /api/v1/sites/:id/articles/import`と同じです。

- 毎日18:00 UTCに、各サイトの`<サイトのURL>/sitemap.xml`を読みます。ほかのサイトマップのURLは使いません。
- 初回はそのとき載っているURLを記録するだけで、記事は登録しません。以前から載っているページは手動で取り込んでください。
- 2回目以降は、初めて見たURLだけを登録します。1サイト1日100件までで、超えた分と記事の上限を超える分は記録せずに翌日以降へ回します。
- タグは空・備考は空文字で登録します。既存の記事は変更も削除もしません。公開日のない記事の公開日も補いません。
- 一度見たURLは二度と自動では登録しません。そのため削除した記事は戻りません。戻すときは手動で取り込んでください。
- 同じURLの記事が登録済みのページは、登録せずに記録だけします。リダイレクト先のURLが登録済みの場合も同じです。
- 一時的な失敗（応答なし・タイムアウト・HTTP 410以外のHTTPのエラー・取得数や時間の上限）のページは記録せず、翌日に再試行します。
- 恒久的な失敗（HTTP 410・HTMLでない・UTF-8以外の文字コード・サイトの外へのリダイレクト・リダイレクトが多すぎる）のページは記録し、再試行しません。必要なら手動で取り込んでください。
- サイトマップを読めなかった日は何もせず、翌日に読み直します。
- 初回にサイトマップの一部しか読めなかった日（子サイトマップが11本以上・読めない子がある・5,000件を超える）は何も記録しません。全体を読めた日に初回の記録をします。常に一部しか読めないサイトマップでは自動登録は始まりません。
- サイトのURLを変えると記録を消し、次回を初回として扱います。

## 一覧の並びと絞り込み

- 記事の一覧は、公開日のない記事が先、続いて`published_on`の降順、同じ日は`id`の降順です。
- メモの一覧は、`created_at`の降順（新しく作成した順）、同じ時刻は`id`の降順です。MCPの一覧と記事にひも付くメモも同じ並びです。
- メモの一覧のクエリは`q`（タイトルか本文に含む語。ASCIIの英字は大文字小文字を区別しない。前後の空白を除いて100文字以下で、空なら絞り込まない）、`tag`、`article_id`、`created_after`、`created_before`、`limit`（1〜100、既定50）、`offset`（0〜2000、既定0）です。続きがあれば`next_offset`に次の`offset`を返し、なければ`null`です。
- `created_after`はその時刻以降（その時刻を含む）、`created_before`はその時刻より前（その時刻を含まない）に作成したメモだけにします。値はオフセット付きのRFC 3339の日時です（例 `2026-10-01T00:00:00+09:00`、`2026-10-01T00:00:00Z`）。形式は`YYYY-MM-DDTHH:MM`、続けて省略できる`:SS`と小数秒（1〜3桁）、最後に`Z`か`±HH:MM`です。`T`と`Z`は大文字だけを受け付けます。両方を指定するときは、`created_after`を`created_before`より前にします。
- `tag`はタグの規則で正規化してから完全一致で比べます。`article_id`は形式が正しければ、存在しない記事や別のサイトの記事でも空の一覧を返します。
- 未知のクエリは無視します。値が正しくなければ`invalid_query`です。
- タグの一覧は、使われている件数（記事とメモの合計）の多い順、同じ件数はタグの昇順で、200個までです。それより多ければ`truncated`が`true`です。

## 入力の検証

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

## エラー

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
