# Campaign Performance Export API

Внешний API для выгрузки агрегированной статистики по кампаниям (trial → upsell → first subscription) из Subengine. Только чтение, метод `GET`.

## 1. Получение API-ключа

1. Откройте в приложении страницу **Integrations** (доступна по `http://localhost:8080` или на HTTPS-домене — на голом HTTP по IP создание ключа не работает в старых версиях, в текущей работает везде).
2. Введите имя ключа и нажмите **Create key**.
3. Скопируйте ключ из зелёного блока **сразу же**: он показывается один раз. В базе хранится только SHA-256-хэш — восстановить ключ после перезагрузки страницы невозможно.
4. Скомпрометированный ключ отзывайте кнопкой **Revoke** и создавайте новый.

Формат ключа: `subengine_live_<43 символа base64url>`.

## 2. Endpoint

```
GET https://wsjbpkderyhdefukppvb.supabase.co/functions/v1/export-campaign-performance
```

Авторизация — заголовок:

```
Authorization: Bearer subengine_live_xxxxx
```

Ключ действует только на данные того аккаунта, в котором он создан, и только на scope `campaign_performance:read`.

## 3. Параметры запроса (query string)

Все параметры необязательны. Без параметров возвращается вся история.

| Параметр | Формат | Описание |
|---|---|---|
| `date_from` | `YYYY-MM-DD` | Начало периода, включительно |
| `date_to` | `YYYY-MM-DD` | Конец периода, включительно |
| `campaign_path` | строка | Точное совпадение пути воронки, регистр и ведущие `/` игнорируются (`soulmate-reading`) |
| `media_buyer` | `Ivan` \| `Artem A` \| `Artem D` \| `Unknown` | Фильтр по байеру (пробел в значении кодируйте: `Artem%20A`) |
| `campaign_id` | строка | Точное совпадение ID кампании |

Семантика периода: пользователь попадает в выгрузку, если дата его **первого успешного trial** входит в диапазон. Все последующие транзакции этого пользователя (upsell, first_subscription, refund) учитываются в метриках независимо от их даты.

## 4. Формат ответа

```json
{
  "data": [
    {
      "campaign_id": "120245324528670659",
      "campaign_path": "soulmate-reading",
      "funnel": "soulmate",
      "date_from": "2026-05-01",
      "date_to": "2026-05-08",
      "trial_users": 469,
      "upsell_users": 55,
      "upsell_cr": 0.1173,
      "first_sub_users": 145,
      "trial_to_first_sub_cr": 0.3092,
      "refund_users": 31,
      "net_revenue": 5234.5,
      "spend": 1800,
      "cac": 3.84,
      "roas": 2.91
    }
  ],
  "meta": {
    "date_from": "2026-05-01",
    "date_to": "2026-05-08",
    "rows": 1,
    "traffic_rows": 42,
    "transactions_loaded": 5123,
    "import_batches_loaded": 7,
    "latest_batch_rows": 812,
    "rows_outside_latest_batch": 4311,
    "generated_at": "2026-06-12T12:00:00.000Z"
  }
}
```

Все метрики вычисляются **на сервере** из склада транзакций и последнего сохранённого снимка Facebook-трафика на момент запроса. Классификация (trial / upsell / first_subscription) пересчитывается по полной истории пользователя внутри Edge Function — нажимать «Refresh local analytics cache from DB» в приложении для корректности API не требуется.

API всегда читает **весь** склад транзакций по всем загруженным CSV-частям (`auth_user_id = владелец ключа`, `deleted_at is null`), без фильтра по последнему `import_batch_id`. Поля `meta` это подтверждают:

| Поле `meta` | Описание |
|---|---|
| `transactions_loaded` | Сколько строк склада загружено и учтено в ответе (по всем батчам) |
| `import_batches_loaded` | Число различных `import_batch_id` среди загруженных строк |
| `latest_batch_rows` | Строк из последнего импорт-батча |
| `rows_outside_latest_batch` | Строк из предыдущих батчей (`> 0` означает, что используется не только последний CSV) |

Одна строка `data` = одна комбинация `(campaign_id, campaign_path, funnel)`. Сортировка: по `trial_users` по убыванию, затем по `campaign_id`.

| Поле | Описание |
|---|---|
| `campaign_id` | ID рекламной кампании из атрибуции trial-транзакции; `"Unknown"`, если не определён |
| `campaign_path` | Путь воронки |
| `funnel` | Название воронки |
| `date_from` / `date_to` | Эхо параметров запроса (`null`, если фильтр не передан) |
| `trial_users` | Уникальные пользователи с успешным trial в периоде |
| `upsell_users` | Из них — с успешным upsell |
| `upsell_cr` | `upsell_users / trial_users`, до 4 знаков |
| `first_sub_users` | Из них — с успешной первой подпиской |
| `trial_to_first_sub_cr` | `first_sub_users / trial_users`, до 4 знаков |
| `refund_users` | Пользователи хотя бы с одним рефандом |
| `net_revenue` | Чистая выручка группы (gross успешных продаж − рефанды/чарджбэки), USD |
| `spend` | Расходы на трафик из снимка Facebook за период; `null`, если данных нет или путь делят несколько кампаний |
| `cac` | `spend / trial_users`; `null`, если `spend` недоступен |
| `roas` | `net_revenue / spend`; `null`, если `spend` недоступен или равен 0 |

`meta.traffic_rows` — число строк трафика, прочитанных из последнего снимка Facebook (0, если снимок не сохранён).

## 5. Ошибки

| Код | Тело | Причина |
|---|---|---|
| `401` | `{"error":"Invalid API key."}` | Ключ отсутствует, не существует, отозван или без нужного scope |
| `405` | `{"error":"Method not allowed."}` | Любой метод кроме `GET`/`OPTIONS` |
| `500` | `{"error":"Export failed."}` | Внутренняя ошибка; детали — в Export Logs на странице Integrations |

Каждый запрос логируется (время, ключ, статус, число строк) — журнал виден в блоке **Export Logs**.

## 6. Примеры

### curl

```bash
curl -G "https://wsjbpkderyhdefukppvb.supabase.co/functions/v1/export-campaign-performance" \
  -H "Authorization: Bearer subengine_live_xxxxx" \
  --data-urlencode "date_from=2026-05-01" \
  --data-urlencode "date_to=2026-05-08" \
  --data-urlencode "media_buyer=Ivan"
```

### Python

```python
import requests

resp = requests.get(
    "https://wsjbpkderyhdefukppvb.supabase.co/functions/v1/export-campaign-performance",
    headers={"Authorization": "Bearer subengine_live_xxxxx"},
    params={"date_from": "2026-05-01", "date_to": "2026-05-08"},
    timeout=60,
)
resp.raise_for_status()
for row in resp.json()["data"]:
    print(row["campaign_id"], row["trial_users"], row["trial_to_first_sub_cr"])
```

### JavaScript / Node

```js
const url = new URL("https://wsjbpkderyhdefukppvb.supabase.co/functions/v1/export-campaign-performance");
url.searchParams.set("date_from", "2026-05-01");
url.searchParams.set("date_to", "2026-05-08");

const resp = await fetch(url, {
  headers: { Authorization: `Bearer ${process.env.SUBENGINE_API_KEY}` },
});
if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
const { data } = await resp.json();
```

### Google Sheets (Apps Script)

```js
function importCampaignPerformance() {
  const resp = UrlFetchApp.fetch(
    "https://wsjbpkderyhdefukppvb.supabase.co/functions/v1/export-campaign-performance?date_from=2026-05-01",
    { headers: { Authorization: "Bearer subengine_live_xxxxx" } },
  );
  const rows = JSON.parse(resp.getContentText()).data;
  const sheet = SpreadsheetApp.getActiveSheet();
  const header = ["campaign_id", "campaign_path", "funnel", "trial_users", "upsell_users", "upsell_cr", "first_sub_users", "trial_to_first_sub_cr", "refund_users"];
  sheet.clearContents();
  sheet.appendRow(header);
  rows.forEach((row) => sheet.appendRow(header.map((key) => row[key])));
}
```

## 7. Рекомендации

- Храните ключ в секретах (env-переменная, secret manager), не коммитьте в код.
- Ключ передаётся только по HTTPS — endpoint не принимает plain-HTTP.
- Для регулярных выгрузок достаточно одного запроса в нужный период; ответ формируется по живым данным склада транзакций на момент запроса.
