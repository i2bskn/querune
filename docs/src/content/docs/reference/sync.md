---
title: データの取り込み
description: Search ConsoleとGA4の取り込みを依頼するAPI、取り込みの状況、取り込みの仕組み。
---

| エンドポイント | 内容 | 成功 |
| --- | --- | --- |
| `GET /api/v1/google` | サービスアカウントの設定 | 200 `GoogleStatus` |
| `POST /api/v1/sites/:id/sync` | 期間を指定した取り込みの依頼。本文は`{ "start_date", "end_date" }` | 202 `{ "queued", "days" }` |
| `GET /api/v1/sites/:id/sync` | 取り込みの状況 | 200 `SyncStatus` |

ログインしたユーザーなら、ロールに関係なくすべて使えます。

## `GET /api/v1/google`

```json
{ "configured": true, "client_email": "querune@project.iam.gserviceaccount.com", "error": null }
```

鍵が未設定なら`{ "configured": false, "client_email": null, "error": null }`、設定されているが読み取れない（JSONでない、`client_email`・`private_key`がない、鍵の形式が正しくない）なら`{ "configured": false, "client_email": null, "error": "invalid" }`です。鍵そのものは返しません。

## `POST /api/v1/sites/:id/sync`

`start_date`と`end_date`（`YYYY-MM-DD`、両端を含む）の各日を、サイトにプロパティがあるデータセット（Search Consoleなら`gsc_pages`と`gsc_queries`、GA4なら`ga4_landing_pages`と`ga4_pages`）ごとに取り込みます。取得済みの日も取り込み直します。Search ConsoleのデータセットはUTCの今日から16か月より前の日を含めません（Search Consoleの保存期間外のため）。応答の`queued`は依頼したメッセージ数（日×データセット）、`days`は依頼した日の数です。待ち・実行中の日は依頼し直しません。手動の取り込みでは、Googleが0行を返した日も0行として保存します（毎日の取り込みでは前回のデータを残します。[取り込みの仕組み](#取り込みの仕組み)）。

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

## `GET /api/v1/sites/:id/sync`

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
      ],
      "time_zone": "America/Los_Angeles",
      "time_zone_known": true,
      "expected_latest_date": "2026-11-03",
      "state_basis": "api",
      "refresh_days": 7,
      "recent_days": [
        { "date": "2026-10-21", "state": "final", "updating": false, "row_count": 152, "fetched_at": 1793000000000, "error_code": null }
      ],
      "final_through": "2026-10-31"
    }
  ],
  "final_through": "2026-10-31"
}
```

- `datasets`は常に`gsc_pages`・`gsc_queries`・`ga4_landing_pages`・`ga4_pages`の4件です。`configured`は対応するプロパティがあるか、`property`は今のプロパティです。プロパティがなければ、ほかの値は`null`・0・空の配列です。
- 数えるのは今のプロパティの日だけです。「取得済みの日」は一度でも取り込みに成功した日で、取り直しの待ち・実行中・失敗の間も取得済みのままです。
- `latest_date`は取得済みの最新の日、`provisional_from`は取得済みで速報値の最も古い日、`last_succeeded_at`は最後に成功した時刻（UNIX時間のミリ秒）、`available_days`は取得済みの日数、`truncated_days`は行数の上限で打ち切った日数です。
- `queued`・`running`・`failed`は、その状態の日数です。`recent_failures`は失敗した日を新しい順に最大10件返します。
- `time_zone`は日付の基準のタイムゾーンです。Search Consoleは`America/Los_Angeles`、GA4は最後に成功した取り込みで記録したプロパティのタイムゾーンです。GA4でまだ記録がなければ`null`で、`time_zone_known`が`false`になります。
- `expected_latest_date`は取り込み済みであるはずの最新の日で、`time_zone`での昨日です。GA4のタイムゾーンが未確定の間は、どのタイムゾーンでも過ぎた日になるよう`Etc/GMT+12`での昨日を使います。
- `state_basis`は確定・速報値の判定根拠です。`api`（Search Console）はAPIが未確定とした日を速報値にします。行のない日だけは経過日数で推定します。`elapsed_days`（GA4）は経過日数による推定で、APIの保証ではありません。`refresh_days`は毎日取り直す直近の日数です。
- `recent_days`は`expected_latest_date`から遡る14日の状態を古い順に返します。`state`は`final`（確定）・`provisional`（速報値）・`pending`（成功したことがなく待ち・実行中）・`failed`（成功したことがなく失敗）・`missing`（未取得）のいずれかです。`final`と`provisional`は最後に成功した取り込みの判定です。`updating`は取得済みの日を取り直している間`true`です。`row_count`と`fetched_at`は最後に成功した取り込みの行数と時刻、`error_code`は最後の取り込みが失敗した日のコードです（取得済みの日の取り直しの失敗も含む）。
- `final_through`は`recent_days`で確定が途切れずに続く最後の日です。すべて確定なら`expected_latest_date`で、最も古い日が確定でなければ`null`です。直近14日だけで決めるため、それより前の日が確定していることは保証しません。
- サイト全体の`final_through`は、設定済みのデータセット（`ga4_pages`を含む）の値の最小です。どれかが`null`なら`null`です。`ga4_pages`を追加した直後は直近の日が未取得のため、[過去の日の取り込み](/querune/reference/data/#過去の日の取り込み)を行うまでサイト全体の`final_through`が`null`になることがあります。各値はそれぞれのデータセットの日付（Search Consoleは太平洋時間、GA4はプロパティのタイムゾーン）で、最小は日付の文字列として比べます。

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
| `empty_response` | 前回は行があった日にGoogleが0行を返した。前回のデータを残している。0行が正しければ、その日を手動で取り込む |

## 取り込みの仕組み

- 取り込みは、1メッセージで1データセット×1日×2,000行までを処理します。2,000行を超える日は、続きのメッセージで次の2,000行を取り込みます。同じ日の取り込みは同じIDを持ち、取り込み直しが始まると古い取り込みのメッセージは捨てられます。
- 1日・1データセットあたり50,000行までを取り込みます（Search Console APIで取れる上限）。それを超える日は打ち切り、打ち切った日として記録します。
- 取り込みの日付はデータセットのタイムゾーンで決めます。Search Consoleは太平洋時間、GA4はプロパティのタイムゾーンです（最初の取り込みまでは`Etc/GMT+12`）。各データセットで、そのタイムゾーンの昨日までを取り込みます。
- 毎日18:00 UTCに、全サイトの直近の日を確定・速報値にかかわらず取り込み直します。直近の日はSearch Consoleが7日、GA4（`ga4_landing_pages`・`ga4_pages`とも）が10日です（GA4は最大7日遅れて届くデータと最大48時間の処理があるため）。あわせて直近30日のうち速報値・失敗・止まった取り込みの日を取り込み直し、削除のメッセージを送り直します。
- 毎日6:00 UTCに、直近5日のうち確定していない日（未取得・速報値・失敗）を取り込みます。時刻を12時間おきにすることで、どのタイムゾーンの昨日も1日に2回取り込みます。日本時間では15:00と3:00です。
- それより前の日を取り直すには、管理画面かAPIで期間を指定して取り込みます。待ち・実行中の日は取り直しの対象にしないため、同じ日の取り込みが並行することはありません。
- Search Consoleは日付でもグループ化して取り込み、応答のメタデータ（`first_incomplete_date`）で未完成とされた日を速報値として記録します。行があり未完成とされなかった日は、新しい日でも確定です。行のない日はAPIで判定できないため、太平洋時間で3日前以降を速報値と推定します。2ページ目以降の応答にメタデータが返るかはAPIの仕様に明記がないため、前のページで未完成とされた日はその判定を引き継ぎます。
- GA4は確定を返さないため、プロパティのタイムゾーンで4日前以降の日を速報値と推定します。応答にタイムゾーンがなければUTCで判定し、タイムゾーンは記録しません。GA4のタイムゾーンは、2つのGA4データセットのうち最後に成功した取り込みの記録を使います。
- GA4の応答のメタデータで`subjectToThresholding`か`dataLossFromOtherRow`が`true`のページがあった日は、しきい値か(other)行の影響を受けた日として記録します（2ページ目以降にも引き継ぎます）。
- 取り直しは行を上書きし、取り直しで返らなかった行を削除します。値の更新や行の消滅が反映され、行は重複しません。
- 前回は行があった日にGoogleが0行を返した場合、毎日の取り込みでは前回のデータを残して`empty_response`として失敗にします。失敗の日は翌日以降の取り込みが取り直します。0行が正しい場合は、管理画面かAPIでその日を手動で取り込むと0行として保存します。
- 速報値の日はページを取る間に値が変わるため、ページの境界で行が抜けたり重複したりすることがあります（Search Consoleは並び順を指定できないため）。重複は同じ行への上書きで吸収し、抜けは翌日以降の取り直しで補います。
- 一時的な失敗（Google APIの401・429・5xx、通信エラー、D1の失敗）は、60秒から倍々に最大1時間の間隔で5回まで再試行します。上限に達すると`retry_exhausted`として記録します。D1の1日の上限に当たった日もこうなり、直近30日の日は翌日以降の毎日の取り込みが、それより前の日は手動の取り込みで取り直します。
- 取り直し中や取り直しに失敗した日も、前回成功した時点のデータは残り、集計に使われます。
- プロパティを変更すると、そのデータソースの取り込みの状況を消し、古いプロパティの行は集計に使われなくなります。行は削除の予約として、キューで5,000行ずつ削除します。サイトを削除した場合も同じです。削除のメッセージが届かなかった場合は、毎日の処理が送り直します。元のプロパティに戻して取り込み直した日の行は削除しません。
