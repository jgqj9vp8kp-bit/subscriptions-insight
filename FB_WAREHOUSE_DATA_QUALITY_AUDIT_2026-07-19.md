# Facebook Warehouse Data Quality Audit

- Дата аудита: 2026-07-19
- Режим: только чтение
- Scope: Facebook sync history, warehouse coverage, recoverability и влияние на reconciliation
- Не выполнялось: изменение allocation, Cohort membership, First-touch attribution, mapping, commit, push или deploy

## Executive summary

1. В legacy Postgres warehouse подтверждён жёсткий gap Campaign metrics за `2026-05-08..2026-06-14`: **0 Campaign rows во все 38 дней**. В authoritative first-trial cohorts в этот период есть **390 Facebook-candidate users**, **15 Campaign ID** и **106 Campaign×date keys**.
2. Единственный успешный legacy import window — `2026-06-15..2026-07-15`: 231 Campaign row, 231 Campaign ID, 18 ad accounts. Но только 48/231 строк являются однодневными; 183/231 — агрегаты за 2–31 день. Поэтому присутствие интервала не доказывает наличие корректной daily Campaign metric.
3. `act_2486811861722169` присутствует во всех трёх успешных legacy sync: 20 Campaign, первая дата `2026-06-15`, последняя `2026-07-15`, interval-presence 31/31 дней. До `2026-06-15` данных этого аккаунта в существующих warehouse-артефактах нет.
4. В raw payload, snapshot, import tables, staging/temp/archive tables отсутствующие периоды не найдены. Значит, gap нельзя восстановить **из уже сохранённых внутренних данных**. Возможность повторно получить его из Capsuled/Meta остаётся открытой и требует отдельного source backfill/probe.
5. Без mapping восстановление `2026-05-08..2026-06-14` даст:
   - **0 Campaign ID** с переходом identity-level `PROBABLE → CONFIRMED`, потому что все 15 ID уже подтверждены точным присутствием в более позднем FB warehouse;
   - до **15 Campaign ID / 106 Campaign×date** с переходом date-level `campaign_unmatched/no_fb_campaign → metric available`, если source действительно вернёт эти метрики;
   - до **390 authoritative users** с появившимся Campaign/date-кандидатом для allocation. Финальное число нельзя честно вычислить без самих `fb_purchases`, timezone/currency validation и проверки over-allocation.
6. Сначала нужно восстановить и проверить warehouse, затем заново измерить reconciliation, и только после этого решать остаточный mapping gap. Иначе mapping будет маскировать отсутствие фактов.

## 1. История Facebook sync

Все timestamps ниже — UTC. `duration_ms` используется как источник длительности: во всех четырёх legacy sync `finished_at` оказался раньше DB-generated `created_at` на 228–936 ms, потому что `finished_at` вычисляется перед insert, а `created_at` задаётся default `now()` при insert.

### Legacy `capsuled_facebook_syncs` — полная сохранённая история

| Created at | Sync ID | Window | Level | Ad accounts | Campaign | Rows imported | Status | Duration | Error |
|---|---|---:|---|---:|---:|---:|---|---:|---|
| 2026-07-05 12:17:17.946 | `430f4611-3f17-4bb3-ba01-40444ff450f1` | 2026-06-05..2026-07-05 | campaign | 0 | 0 | 0 | failed | 4,296 ms | 3 attempts; HTML `DOCTYPE` returned instead of JSON |
| 2026-07-15 10:29:13.991 | `26393a5d-5367-4ad3-b074-2b0d8bb85811` | 2026-06-15..2026-07-15 | campaign | 18 | 231 | 231 | success | 4,612 ms | — |
| 2026-07-15 10:35:40.894 | `7a9ce843-8835-4fd7-8ee1-5630e55ff389` | 2026-06-15..2026-07-15 | campaign | 18 | 231 | 231 | success | 2,801 ms | — |
| 2026-07-15 10:55:57.714 | `a3621b78-bd8a-4d99-8bf7-b4eaecf18340` | 2026-06-15..2026-07-15 | campaign | 18 | 231 | 231 | success | 2,025 ms | — |

У трёх успешных sync совпадает полный набор 231 ключа `Campaign ID + dateFrom + dateTo`; значения могли restate между импортами. Нормализованная таблица хранит только последнюю версию каждого `import_key`, потому что последующие sync делают upsert.

### Active ClickHouse pipeline — доказуемые write-sync events

| Started at | Sync/execution ID | Window | Levels | Ad accounts | Campaign | Source rows | Warehouse writes | Status | Duration | Errors |
|---|---|---|---|---:|---:|---:|---:|---|---:|---|
| 2026-07-15 13:34:27.645 | state row created | не сохранён | не сохранены | n/a | n/a | n/a | n/a | state initialized | n/a | n/a |
| 2026-07-18 16:40:56.362 | `d8bd1aac-90ce-4e7a-8bb3-36bce3136058` | payload=`incremental`; resolved window не сохранён | не сохранены | n/a | n/a | n/a | n/a | HTTP 200 | 8,778 ms | response body не сохранён |
| 2026-07-18 18:12:58.568 | `5f6a02bc-21f1-4b6b-be3d-a6c9c2795f40` | payload=`incremental`; resolved window не сохранён | не сохранены | n/a | n/a | n/a | n/a | HTTP 200 | 6,119 ms | response body не сохранён |
| 2026-07-19 14:01:26.505 | `fact_facebook_stats_sync` latest state | 2026-07-17..2026-07-19 | account, campaign, adset, ad, day | n/a | n/a | 412 | 4 inserted, 408 updated | completed | 5,845 ms | none |

Последний ClickHouse sync дополнительно подтверждает: 3 active days, 13 API requests, 0 skipped rows, 0 merged rows, 4,377 total warehouse rows и одинаковый Spend `3,040.21` на всех пяти levels.

**History gap:** active ClickHouse pipeline не имеет append-only sync history. Он upsert-ит одну строку `clickhouse_transaction_sync_state` по `(auth_user_id, sync_name)`, поэтому предыдущие windows, row/account/campaign counts и response diagnostics перезаписываются. Edge logs позволяют доказать сам факт части запусков, HTTP status и duration, но не восстановить response body. Поэтому перечислить все historical ClickHouse sync с требуемыми полями из текущей observability невозможно.

### Timeline

```text
2026-07-05 12:17  legacy failed, requested 06-05..07-05, 0 rows
2026-07-15 10:29  legacy success, 06-15..07-15, 231 Campaign rows
2026-07-15 10:35  legacy success, same 231 keys
2026-07-15 10:55  legacy success, same 231 keys
2026-07-15 13:34  active ClickHouse state first created; run details later overwritten
2026-07-18 16:40  active incremental sync, HTTP 200
2026-07-18 18:12  active incremental sync, HTTP 200
2026-07-19 14:01  active incremental sync, 07-17..07-19, completed
```

## 2. Coverage by Date

### Confirmed hard gap

За каждый день ниже одновременно выполнены два условия:

- в authoritative cohort input есть Facebook-candidate activity;
- в сохранённом legacy warehouse нет ни одной Campaign metric, чей `[date_from, date_to]` покрывает день.

Coverage: **0/38 days = 0%**.

```text
2026-05-08
2026-05-09
2026-05-10
2026-05-11
2026-05-12
2026-05-13
2026-05-14
2026-05-15
2026-05-16
2026-05-17
2026-05-18
2026-05-19
2026-05-20
2026-05-21
2026-05-22
2026-05-23
2026-05-24
2026-05-25
2026-05-26
2026-05-27
2026-05-28
2026-05-29
2026-05-30
2026-05-31
2026-06-01
2026-06-02
2026-06-03
2026-06-04
2026-06-05
2026-06-06
2026-06-07
2026-06-08
2026-06-09
2026-06-10
2026-06-11
2026-06-12
2026-06-13
2026-06-14
```

В этом gap находятся 390 users, 15 Campaign ID и 106 Campaign×date keys. По дням Facebook-candidate activity растёт от 1 Campaign в начале периода до 10–12 Campaign в последние дни; warehouse rows остаются равны нулю во все 38 дней.

### Imported interval window

В `2026-06-15..2026-07-15` хотя бы один Campaign interval пересекает каждый из 31 дней: nominal interval-presence **31/31 = 100%**. Это не daily coverage:

| Row grain | Campaign rows | Share |
|---|---:|---:|
| `date_from = date_to` | 48 | 20.78% |
| Multi-day interval | 183 | 79.22% |
| Total | 231 | 100% |

Median interval — 3 дня, minimum — 1, maximum — 31. Multi-day Spend/Purchases нельзя корректно разложить по отдельным дням без повторной выгрузки source data.

## 3. Coverage by Ad Account

Таблица ниже оценивает interval-presence внутри единственного успешного legacy request window `2026-06-15..2026-07-15`. «Пропуск» означает, что ни один Campaign interval аккаунта не покрывает день; это может быть как отсутствием активности, так и data gap. Без day-level source truth эти две причины неразличимы. Для всех аккаунтов также отсутствует подтверждённый warehouse coverage за `2026-05-08..2026-06-14`.

| Ad account | Buyer | First | Last | Campaign | Successful sync | Days / 31 | Coverage | Periods without a covering row |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `act_1022611373489730` | Artem D | 2026-06-17 | 2026-07-15 | 26 | 3 | 29 | 93.55% | 06-15..06-16 |
| `act_1213836067369994` | Ivan | 2026-06-15 | 2026-07-15 | 3 | 3 | 31 | 100% | — |
| `act_1319500666378118` | Artem D | 2026-06-24 | 2026-07-15 | 9 | 3 | 22 | 70.97% | 06-15..06-23 |
| `act_1322614903374888` | Artem D | 2026-06-17 | 2026-06-30 | 14 | 3 | 13 | 41.94% | 06-15..06-16; 06-24; 07-01..07-15 |
| `act_1362634572405907` | Artem A | 2026-07-05 | 2026-07-15 | 7 | 3 | 11 | 35.48% | 06-15..07-04 |
| `act_1458333576328741` | Artem D | 2026-06-15 | 2026-06-15 | 1 | 3 | 1 | 3.23% | 06-16..07-15 |
| `act_1466758267997367` | Artem A | 2026-07-01 | 2026-07-09 | 1 | 3 | 9 | 29.03% | 06-15..06-30; 07-10..07-15 |
| `act_1539098907564327` | Artem D | 2026-06-15 | 2026-06-19 | 12 | 3 | 5 | 16.13% | 06-20..07-15 |
| `act_2065053647441893` | Artem D | 2026-06-17 | 2026-06-30 | 11 | 3 | 14 | 45.16% | 06-15..06-16; 07-01..07-15 |
| `act_2217799391958345` | Artem D | 2026-06-15 | 2026-06-21 | 9 | 3 | 7 | 22.58% | 06-22..07-15 |
| `act_2219260308911764` | Artem D | 2026-06-20 | 2026-06-30 | 13 | 3 | 11 | 35.48% | 06-15..06-19; 07-01..07-15 |
| `act_2380314362464727` | Ivan | 2026-06-15 | 2026-07-08 | 20 | 3 | 24 | 77.42% | 07-09..07-15 |
| **`act_2486811861722169`** | **Ivan** | **2026-06-15** | **2026-07-15** | **20** | **3** | **31** | **100%** | **—** |
| `act_2532900983806472` | Ivan | 2026-06-15 | 2026-07-15 | 31 | 3 | 31 | 100% | — |
| `act_26889553160729180` | Artem A | 2026-06-26 | 2026-07-15 | 6 | 3 | 15 | 48.39% | 06-15..06-25; 06-27..06-29; 07-04..07-05 |
| `act_27055079814172581` | Artem A | 2026-06-23 | 2026-07-15 | 16 | 3 | 16 | 51.61% | 06-15..06-22; 06-27..07-03 |
| `act_3002733866590136` | Ivan | 2026-06-15 | 2026-07-15 | 17 | 3 | 20 | 64.52% | 06-17..06-23; 07-01..07-04 |
| `act_4116087011963752` | Ivan | 2026-06-15 | 2026-07-15 | 15 | 3 | 18 | 58.06% | 06-30..07-12 |

## 4. Coverage by Campaign, Buyer and Funnel

### Campaign

| Measure | Result |
|---|---:|
| Stored Campaign rows / unique Campaign ID | 231 / 231 |
| Single-day Campaign rows | 48 (20.78%) |
| Multi-day Campaign rows | 183 (79.22%) |
| Cohort FB-candidate Campaign in 06-15..07-15 | 158 |
| Campaign with at least one exact date match | 151 / 158 (95.57%) |
| Campaign×date matches | 712 / 731 (97.40%) |
| User-weighted exact-date matches | 2,367 / 2,402 (98.54%) |
| Gap 05-08..06-14 | 0 / 106 Campaign×date (0%) |

### Buyer

Buyer coverage — union of Campaign intervals in `2026-06-15..2026-07-15`; это activity/interval-presence, не доказательство daily completeness.

| Buyer | Accounts | Campaign | Rows | Covered days / 31 | Coverage |
|---|---:|---:|---:|---:|---:|
| Artem A | 4 | 30 | 30 | 20 | 64.52% |
| Artem D | 8 | 95 | 95 | 31 | 100% |
| Ivan | 6 | 106 | 106 | 31 | 100% |

### Funnel

Exact matching only: authoritative Campaign ID + cohort date against stored Campaign interval. Aliases/mapping исключены.

| Period | Funnel | All users | FB-candidate users | FB Campaign | Matched users | Matched Campaign | User coverage |
|---|---|---:|---:|---:|---:|---:|---:|
| 05-08..06-14 | past_life | 235 | 50 | 1 | 0 | 0 | 0% |
| 05-08..06-14 | soulmate | 1,864 | 340 | 14 | 0 | 0 | 0% |
| 05-08..06-14 | unknown | 168 | 0 | 0 | 0 | 0 | n/a |
| 06-15..07-15 | past_life | 54 | 53 | 10 | 48 | 8 | 90.57% |
| 06-15..07-15 | soulmate | 2,814 | 2,339 | 142 | 2,309 | 137 | 98.72% |
| 06-15..07-15 | unknown | 248 | 10 | 6 | 10 | 6 | 100% |

## 5. Recoverability

| Candidate source | Found | Can restore 05-08..06-14? | Evidence |
|---|---|---|---|
| `capsuled_facebook_syncs.raw_payload` | 3 successful payloads + 1 failed/null | No | Все успешные payload ограничены 06-15..07-15; failed run сохранил 0 rows |
| `capsuled_facebook_stats.raw_payload` | 231 latest normalized rows | No | Upsert хранит latest copy тех же 231 interval keys |
| `data_snapshots/facebook_traffic` | 1 snapshot, 231 metrics | No | Latest-only snapshot того же sync; `date_to` дополнительно теряется при преобразовании в `date` |
| Staging/raw/archive/temp FB tables | Не найдены | No | В production schema нет дополнительных FB tables/routines |
| `import_batches` / `import_batch_files` | 53/53 | No | Все batches имеют source `palmer_csv`, не Facebook |
| ClickHouse sync state | 1 latest state row | No | History перезаписывается upsert-ом |
| Edge invocation logs | Частичная история вызовов | No | Нет response payload и Campaign metrics |
| External Capsuled/Meta source | Не проверялся write/backfill-запросом | Возможно | Текущий код поддерживает full lookback 540 дней и daily entity fetch, но availability старых source metrics надо подтвердить отдельно |

Вывод: данные `2026-05-08..2026-06-14` **потеряны для восстановления из текущих warehouse-артефактов**. Утверждать, что они потеряны в Meta/Capsuled окончательно, нельзя без отдельного read-only source probe или изолированного backfill в staging.

## 6. Window semantics

Есть три разных понятия даты:

1. `capsuled_facebook_syncs.date_from/date_to` — **inclusive границы request/sync window**. Они берутся из request parameters и записываются один раз на sync.
2. `capsuled_facebook_stats.date_from/date_to` — **границы activity interval конкретной entity**, возвращённые Capsuled. Доказательство: при одном request `06-15..07-15` строки имеют разные span от 1 до 31 дня; 48 rows — один день, 183 — несколько дней.
3. Active ClickHouse `fact_facebook_stats.stat_date` — **Meta reporting/activity day**, не snapshot date. Он берётся из `row.date || row.dateFrom`; entity levels намеренно запрашиваются по одному дню.

`created_at`, `finished_at`, `last_import_at`, `source_updated_at` и `dataFreshness.lastImportAt` — sync/freshness timestamps. Они не являются днём активности. `fbStatsTo` — граница freshness источника, а не Campaign activity row.

Следствие: legacy multi-day `date_from/date_to` нельзя трактовать как ежедневные snapshots и нельзя размножать один interval total на каждый день. Для reconciliation корректный grain — `Campaign ID + Meta reporting date`.

## 7. Reconciliation simulation без mapping

Модель использует неизменённый authoritative first successful trial на 7,776 users. Facebook candidate определяется только явным `facebook/fb/meta/instagram/ig` source или точным Campaign ID, реально присутствующим в FB warehouse. Existing alias mapping не использован.

### Gap `2026-05-08..2026-06-14`

| Metric | Before recovery | If complete warehouse is restored |
|---|---:|---:|
| Campaign IDs in affected cohort scope | 15 | 15 |
| Campaign IDs already known exactly in later FB data | 15 | 15 |
| Identity-level `PROBABLE → CONFIRMED` | — | **0** |
| Campaign×date keys with metric | 0 / 106 | up to 106 / 106 |
| Campaign IDs with at least one restored missing-period metric | 0 / 15 | up to 15 / 15 |
| Authoritative users with date-level candidate | 0 / 390 | up to 390 / 390 |

Почему это диапазон, а не обещанный финальный результат: наличие Campaign/date metric ещё не гарантирует `fully_allocated`. Нужны фактические `fb_purchases`, подтверждённая Meta timezone, единая currency/account semantics и отсутствие over-allocation. Поэтому корректный forecast — **0 identity-level transitions; до 15 date-level Campaign recoveries**.

Затронутые Campaign ID:

| Campaign ID | Users | Active cohort dates | Known later in FB warehouse |
|---|---:|---:|---|
| `120245850733300040` | 222 | 38 | yes |
| `6984573798360` | 50 | 16 | yes |
| `120246583512210073` | 26 | 9 | yes |
| `120248371748160659` | 23 | 9 | yes |
| `120248880985650659` | 13 | 6 | yes |
| `120248380723540541` | 8 | 5 | yes |
| `120248942538250659` | 8 | 5 | yes |
| `120247836803950675` | 7 | 2 | yes |
| `120247836327660675` | 6 | 3 | yes |
| `120245661211440780` | 5 | 3 | yes |
| `120245664121290780` | 5 | 2 | yes |
| `120252240833530321` | 5 | 2 | yes |
| `6953705994977` | 5 | 2 | yes |
| `120247836775230675` | 4 | 2 | yes |
| `120245661211420780` | 3 | 2 | yes |

## 8. Recommendations

### 1. Можно ли восстановить warehouse?

Из внутренних таблиц — **нет**: подходящих raw/staging/archive данных за gap не существует. Из внешнего source — **возможно**: pipeline уже имеет безопасную daily-grain стратегию и 540-day full lookback. Это надо проверить отдельным source probe и затем controlled backfill с DQ validation.

### 2. Что делать первым?

Сначала warehouse:

1. Read-only source availability probe для `2026-05-08..2026-06-14` на `day` и `campaign` levels.
2. Backfill в изолированную version/staging area, не затрагивая active allocation.
3. Проверки `day spend == campaign/adset/ad/account spend`, `merged_rows_detected = 0`, row cap/pagination, account/currency/timezone consistency.
4. Coverage gate: expected active days, Campaign×date completeness и отдельный контроль `act_2486811861722169`.
5. Только после переключения validated warehouse version — повторный reconciliation exact-ID-only.
6. Mapping исследовать лишь для остатка, который не объясняется отсутствующими facts.

### 3. Как изменится reconciliation?

В gap появится до 106 Campaign×date metrics для 15 Campaign и 390 users. Strict `PROBABLE → CONFIRMED` по Campaign identity останется 0, потому что IDs уже подтверждены. Практический эффект будет в уменьшении `campaign_unmatched/no_fb_campaign` и появлении возможности вычислить allocation по этим датам; точный новый allocation gap возможен только после получения `fb_purchases`.

## Audit limitations and evidence

- Live production Postgres читался в read-only transaction.
- Active ClickHouse data не изменялись; доступная state row показывает только последний run.
- Edge logs использовались только для реконструкции invocation timeline. Формат и доступ к логам соответствуют официальным Supabase Management API / Logs guidance: [Supabase Management API logs](https://supabase.com/docs/guides/integrations/supabase-for-platforms), [Supabase Logs](https://supabase.com/docs/guides/telemetry/logs).
- Основные code evidence:
  - legacy schema и sync history fields: `supabase/migrations/202607030001_create_capsuled_facebook_stats.sql`;
  - legacy raw payload/upsert/snapshot behavior: `supabase/functions/capsuled-facebook-sync/index.ts`;
  - active daily-grain sync и state upsert: `supabase/functions/_shared/clickhouse/facebookStats.ts`;
  - Campaign ID + Meta reporting date semantics: `FB_COHORT_AUTHORITATIVE_AUDIT.md`.

Никакие production данные или правила классификации в ходе аудита не менялись.
