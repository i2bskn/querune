---
title: セッションの長さ
description: ログインのセッションが切れるまでの時間をSESSION_MAX_AGE_HOURSとSESSION_IDLE_TIMEOUT_HOURSで変えます。
---

ログインのセッションの長さは`SESSION_MAX_AGE_HOURS`と`SESSION_IDLE_TIMEOUT_HOURS`で変えられます。どちらも時間単位の1〜9600の整数で、`"168"`のように文字列で設定します。それ以外の値を設定すると、すべてのリクエストが500になります（[設定エラーになったとき](/querune/admin/configuration/#設定エラーになったとき)）。

- `SESSION_MAX_AGE_HOURS`はログインした時点から数えます。アクセスを続けても延長されません。変更は次のログインから反映されます。
- `SESSION_IDLE_TIMEOUT_HOURS`を設定すると、アクセスがないままその時間が経ったセッションも切れます。アクセスするたびに`SESSION_MAX_AGE_HOURS`の範囲で延長されます。変更は既存のセッションにもすぐ反映されます。
- 延長されるのは、アクセストークン（15分）が切れた後のアクセスです。そのため実際に許される無操作の時間は、`SESSION_IDLE_TIMEOUT_HOURS`より最大15分短くなります。
- MCPのトークンには影響しません。

たとえば「7日以内にアクセスすれば延長し、最長30日でログインし直す」なら、`SESSION_IDLE_TIMEOUT_HOURS`を`168`、`SESSION_MAX_AGE_HOURS`を`720`にします。
