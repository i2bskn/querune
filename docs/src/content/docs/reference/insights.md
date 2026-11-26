---
title: 実績の集計
description: 管理画面の実績とサイトの一覧に使う集計のAPI。
---

## `GET /api/v1/sites/:id/insights`

管理画面の実績に使う集計です。取り込んだ今のプロパティの行だけを集計します。

| クエリ | 内容 |
| --- | --- |
| `days` | 期間の日数（1〜180、既定28） |
| `end` | 期間の最後の日（`YYYY-MM-DD`、今日以前）。省略すると取り込み済みの最新の日 |
| `article_id` | 指定するとその記事のURLのページだけを集計し、メモはその記事にひも付くものだけを返す（GA4のセッションはURLのパス・ページの表示回数はURLのホスト名とパスで照合する） |

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
    "coverage": { "days": 28, "available_days": 28, "provisional_days": 3, "missing_days": 0, "pending_days": 0, "upcoming_days": 0, "truncated_days": 0, "time_zone": "America/Los_Angeles" }
  },
  "sessions": {
    "property": "123456789",
    "daily": [{ "date": "2026-09-12", "sessions": 151, "engaged_sessions": 80, "key_events": 1 }],
    "totals": { "sessions": 5696, "engaged_sessions": 2811, "engagement_rate": 0.4935, "key_events": 31 },
    "previous_totals": { "sessions": 4571, "engaged_sessions": 2153, "engagement_rate": 0.471, "key_events": 27 },
    "channels": [{ "key": "Organic Search", "sessions": 3713, "engaged_sessions": 1900, "engagement_rate": 0.5117, "key_events": 20, "previous_sessions": 2990 }],
    "landing_pages": [],
    "coverage": { "days": 28, "available_days": 28, "provisional_days": 3, "missing_days": 0, "pending_days": 0, "upcoming_days": 0, "truncated_days": 0, "time_zone": "Asia/Tokyo" }
  },
  "page_views": {
    "property": "123456789",
    "daily": [{ "date": "2026-09-12", "views": 412, "engagement_seconds": 10320.5, "state": "final" }],
    "totals": { "views": 12840, "engagement_seconds": 321004.2, "avg_engagement_seconds_per_view": 25 },
    "previous_totals": { "views": 10211, "engagement_seconds": 250180.9, "avg_engagement_seconds_per_view": 24.5 },
    "pages": [{ "host_name": "example.com", "page_path": "/a", "views": 2210, "engagement_seconds": 70720.4, "avg_engagement_seconds_per_view": 32, "previous_views": 1980 }],
    "coverage": { "days": 28, "available_days": 28, "provisional_days": 3, "missing_days": 0, "pending_days": 0, "upcoming_days": 0, "truncated_days": 0, "time_zone": "Asia/Tokyo", "thresholded_days": 0 },
    "previous_coverage": { "days": 28, "available_days": 28, "provisional_days": 0, "missing_days": 0, "pending_days": 0, "upcoming_days": 0, "truncated_days": 0, "time_zone": "Asia/Tokyo", "thresholded_days": 0 }
  },
  "memos": [{ "id": "memo_01JC9Z8Q4R6T2V7W3X5Y1A0B2C", "title": "タイトルを変更", "tags": ["改善"], "created_at": 1793000000000 }]
}
```

- `daily`は前の期間の最初の日から期間の最後の日まで1日1件です。前の期間は期間の直前の同じ日数です。
- `search`・`sessions`の`daily`は行のある日はその合計です。行がなく取得済みの日は0です。ただし打ち切り（`last_truncated`）かGA4のしきい値・(other)行（`last_thresholded`）の対象になった日は0にせず`null`です。取得済みでない日も`null`です。0の日の`ctr`・`position`・`engagement_rate`は分母が0なので`null`です。
- `ctr`はクリック÷表示回数、`position`は表示回数で重み付けした平均掲載順位、`engagement_rate`はエンゲージのあったセッション÷セッションです。分母が0なら`null`です。
- `pages`・`queries`はクリックの多い順、`channels`・`landing_pages`はセッションの多い順に10件までです。`previous_*`は前の期間に行がなければ`null`です。
- `search`はSearch Consoleのプロパティがないか記事にURLがなければ`null`、`sessions`はGA4のプロパティがないか記事にURLがなければ`null`です。
- `page_views`はGA4のページの表示回数です（[ページの表示回数](/querune/reference/data/#ページの表示回数ga4_pages)）。GA4のプロパティがないか記事にURLがなければ`null`です。
  - `daily`の`state`はその日の取り込みの状態（`final`・`provisional`・`pending`・`failed`・`missing`。`GET /api/v1/sites/:id/sync`の`recent_days`と同じ判定）です。取得済み（`final`・`provisional`）の日は合計で、行がなければ0です。取得済みでない日は`null`です。
  - `totals`・`previous_totals`は取得済みの日の合計です。期間に取得済みの日が1日もなければ各値が`null`です。一部の日だけ取得済みなら、その日の合計を返します。欠けた日数は`coverage`の`missing_days`で示します。
  - `pages`はサイト全体のときだけ表示回数の多い順に10件までで、記事のときは空です。`previous_views`は前の期間に取得済みの日が1日もなければ`null`、あれば数値（行がなければ0）です。
  - `coverage`・`previous_coverage`はそれぞれの期間の取り込みの状況です。`missing_days`は取得済みでない日数で、そのうち取り込みを待っているか実行中の日数が`pending_days`です。`upcoming_days`は集計前の日数です（下記）。`thresholded_days`はGA4のしきい値か(other)行の影響を受けた取得済みの日数です。
  - `engagement_seconds`と`avg_engagement_seconds_per_view`は小数第1位まで、`views`は整数です。
  - 画面は、両方の期間で`missing_days`が0のときだけ前の期間との比較を出します。
- `search`・`sessions`の`coverage`にも`pending_days`と`upcoming_days`があります。画面は`pending_days`を「取得待ち」として出します。
- `upcoming_days`は集計前の日数です。取得済みでなく今のプロパティの取り込みの記録もない日のうち、データセットの期待される最新日（そのタイムゾーンの昨日）以降の日を数えます。定期の取り込みがまだその日を取りに来ていないだけなので、画面は「集計前」として出します。`missing_days`の内数で、`pending_days`とは重なりません。
- 画面は`missing_days`から`pending_days`と`upcoming_days`を引いた日数を「欠損」として出します。
- 既定の期間の最後の日（`end`の省略時）は、`gsc_pages`・`gsc_queries`・`ga4_landing_pages`の取得済みの最新の日です。`ga4_pages`は含めません。
- `memos`は期間の前後1日を含めて作成されたメモを新しい順に100件までです。画面はブラウザの日付で各日に並べます。
- クエリが正しくなければ400 `invalid_query`、サイトか記事（別のサイトの記事を含む）がなければ404 `not_found`です。

## `GET /api/v1/sites/insights`

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
