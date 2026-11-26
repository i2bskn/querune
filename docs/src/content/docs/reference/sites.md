---
title: サイト
description: サイトの登録・変更・削除のAPIと入力の検証。
---

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
- `gsc_property`か`ga4_property_id`を変えると、そのデータソースの取り込み済みデータは集計に使われなくなり、削除されます（[取り込みの仕組み](/querune/reference/sync/#取り込みの仕組み)）。サイトを削除すると、取り込み済みのデータも削除されます。

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

## 入力の検証

検証は次の順に行い、最初に見つかったエラーを返します：未知の項目 →（`PATCH`のみ）空のオブジェクト → `name` → `url` → `gsc_property` → `ga4_property_id`。

| 項目 | 規則 | 保存する値 |
| --- | --- | --- |
| `name` | 文字列。前後の空白を除いて1〜100文字（コードポイント数）、制御文字を含まない | 前後の空白を除いた値 |
| `url` | 文字列。前後の空白を除いて2048文字以下。スキームが`https`か`http`で、ユーザー名・パスワードを含まない | オリジン（ホストは小文字、既定のポートは省く）。パス・クエリ・フラグメントは保存しない |
| `gsc_property` | `null`、空文字、`sc-domain:`＋ドメイン（接頭辞の大文字小文字は問わない。253文字以下）、または`https`か`http`のURLプレフィックス（パスが`/`で終わり、クエリ・フラグメント・ユーザー名・パスワードを含まない。2048文字以下） | `null`と空文字は`null`。ドメインは小文字にする。URLプレフィックスは正規化したURL（例：`https://example.com`は`https://example.com/`） |
| `ga4_property_id` | `null`、空文字、または1〜20桁の数字 | `null`と空文字は`null` |

`http://example.com`と`https://example.com`は別のオリジンなので、別のサイトとして登録できます。

## エラー

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
