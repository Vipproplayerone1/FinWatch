# FinWatch — Hướng dẫn demo chi tiết

Tài liệu này hướng dẫn cách demo **toàn bộ** các tính năng của hệ thống FinWatch — pipeline giám sát giao dịch tài chính thời gian thực dựa trên kiến trúc `PostgreSQL → Debezium → Kafka → ClickHouse → Grafana / Web UI`.

> **Lưu ý môi trường:** Tất cả lệnh trong code block giữ nguyên tiếng Anh để copy-paste an toàn. Người dùng đang chạy trên **Windows 11 + PowerShell**, vì vậy phải dùng `curl.exe` (binary thật) thay vì `curl` (alias của `Invoke-WebRequest`). Trong PowerShell, thay `&&` bằng `; if ($?) { ... }`. Trong Git Bash, có thể dùng `&&` bình thường.

---

## 0. Yêu cầu chuẩn bị (chạy 1 lần)

| Thành phần | Phiên bản tối thiểu | Cách kiểm tra |
|---|---|---|
| Docker Desktop | 4.x (Compose v2) | `docker --version` & `docker compose version` |
| Miniconda env | `graduate_env` (Python 3.11) | `conda env list` |
| Python deps | xem `finwatch/scripts/requirements.txt` | `pip list` trong env |
| Ổ đĩa trống | ≥ 5 GB | volumes Docker (postgres, kafka, clickhouse) |
| Cổng trống | 3000, 3002, 5432, 8083, 8123, 9000, 9090, 29092 | `netstat -ano \| findstr ":3002"` |

### Kích hoạt môi trường Python

```powershell
conda activate C:\ProgramData\miniconda3\envs\graduate_env
python --version       # Python 3.11.x
```

Nếu env chưa tồn tại:

```powershell
conda create -p C:\ProgramData\miniconda3\envs\graduate_env python=3.11 -y
conda activate C:\ProgramData\miniconda3\envs\graduate_env
pip install -r finwatch/scripts/requirements.txt
```

---

## 1. Khởi động toàn bộ stack

Tất cả lệnh chạy trong thư mục `finwatch/`.

```bash
cd D:/Major/Graduate_Project/finwatch
docker compose up -d
```

Stack gồm **9 service**: postgres, zookeeper, kafka, debezium, clickhouse, prometheus, grafana, web, **fraud-worker**.

Đợi ~60 giây để các healthcheck pass, sau đó đăng ký Debezium connector (idempotent):

```bash
python scripts/wait_for_services.py
```

### Kiểm tra trạng thái

```bash
docker compose ps
```

Kết quả kỳ vọng (tất cả `Up` + service quan trọng là `healthy`):

```
NAME                  STATUS                    PORTS
finwatch-postgres     Up X minutes (healthy)    0.0.0.0:5432->5432/tcp
finwatch-zookeeper    Up X minutes              2181/tcp
finwatch-kafka        Up X minutes (healthy)    0.0.0.0:29092->29092/tcp
finwatch-debezium     Up X minutes (healthy)    0.0.0.0:8083->8083/tcp
finwatch-clickhouse   Up X minutes (healthy)    0.0.0.0:8123, 0.0.0.0:9000
finwatch-prometheus   Up X minutes              0.0.0.0:9090->9090/tcp
finwatch-grafana      Up X minutes              0.0.0.0:3000->3000/tcp
finwatch-web          Up X minutes              0.0.0.0:3002->3000/tcp
finwatch-fraud-worker Up X minutes
```

> **`fraud-worker`** là service mới: chạy `scripts/fraud_alert_worker.py --interval 30` liên tục, gọi 6 anomaly query trong `clickhouse/queries/anomaly_*.sql` mỗi 30 giây và ghi case mới vào bảng Postgres `fraud_alerts` (dedup 1h theo cặp `(account_id, rule_code)`). Case sau đó replicate qua CDC trở lại ClickHouse như một bảng thứ tư.

---

## 2. Bảng endpoint nhanh (mở 6 tab trình duyệt)

| Tab | URL | Mục đích trong demo |
|---|---|---|
| 1 | http://localhost:3002 | **Web UI chính** — Dashboard, live stream, fraud alerts |
| 2 | http://localhost:3002/architecture | Sơ đồ kiến trúc động, hiển thị event flow giữa 4 node |
| 3 | http://localhost:3002/trace | Insert vào Postgres rồi trace event qua từng chặng |
| 4 | http://localhost:3002/fraud | 6 luật phát hiện fraud (R1–R6) — biểu đồ realtime |
| 5 | http://localhost:3002/accounts | **Danh bạ tài khoản** — tìm kiếm, balance, status, số alert mở trong 24h |
| 6 | http://localhost:3002/accounts/[id] | **Trang chi tiết account** — Suspend / Reactivate, txn gần nhất, alert history |
| 7 | http://localhost:3002/alerts | **Hàng đợi fraud cases** từ bảng `fraud_alerts` với lọc rule + severity |
| 8 | http://localhost:3002/kafka | Kafka topic browser, partition/offset/consumer lag |
| 9 | http://localhost:3000 (admin/admin) | Grafana — Pipeline Health dashboard |

Endpoint phụ:

| Service | URL | Kiểm tra nhanh |
|---|---|---|
| ClickHouse HTTP | http://localhost:8123/ping | `Ok.` |
| Debezium Connect | http://localhost:8083/connectors | JSON list |
| Prometheus | http://localhost:9090/-/ready | `Prometheus Server is Ready.` |

---

## 3. Verification checklist (chạy sau khi `docker compose up -d`)

Mục tiêu: chứng minh từng chặng pipeline hoạt động trước khi vào demo chính.

### 3.1 PostgreSQL — schema + WAL

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "\dt"
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SHOW wal_level;"
```

Kỳ vọng:
- 3 bảng: `accounts`, `merchants`, `transactions`
- `wal_level = logical` (bắt buộc để CDC chạy)

### 3.2 Kafka topics

```bash
docker exec finwatch-kafka kafka-topics --bootstrap-server kafka:9092 --list
```

Kỳ vọng có các topic do Debezium tạo:

```
finwatch.public.accounts
finwatch.public.merchants
finwatch.public.transactions
finwatch.public.fraud_alerts
_finwatch_connect_configs
_finwatch_connect_offsets
_finwatch_connect_status
__debezium-heartbeat.finwatch
__consumer_offsets
```

> **`finwatch.public.fraud_alerts`** là topic thứ tư, do bảng `fraud_alerts` (case log) được thêm vào publication `finwatch_pub` ở `postgres/init/02_fraud_workflow.sql` và `table.include.list` của connector.

### 3.3 Debezium connector

```bash
curl.exe -s http://localhost:8083/connectors/finwatch-connector/status
```

Kỳ vọng: `"state":"RUNNING"` cho cả `connector` và `tasks[0]`.

### 3.4 ClickHouse — snapshot đã đổ về

```bash
docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.merchants FINAL WHERE cdc_op != 'd'"
docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.accounts FINAL WHERE cdc_op != 'd'"
docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.transactions FINAL WHERE cdc_op != 'd'"
```

Kỳ vọng (sau snapshot lần đầu):
- `merchants` = 12
- `accounts` = 10
- `transactions` ≥ 50 (seed data ban đầu)
- `fraud_alerts` = 0 (rỗng cho đến khi worker chạy lần đầu)

Kiểm tra thêm bảng case log mới:

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "\d fraud_alerts"
docker exec finwatch-clickhouse clickhouse-client -q "SHOW CREATE TABLE finwatch.fraud_alerts"
```

Bảng phải có cột `id, account_id, rule_code, severity, txn_count, total_amount, evidence (JSONB), status, notes, created_at, resolved_at` cùng index dedup `(account_id, rule_code, created_at)`.

> **Quy tắc luôn áp dụng:** mọi câu SELECT phân tích trên 3 bảng đích trong ClickHouse phải có `FINAL` + `cdc_op != 'd'` (xem `CLAUDE.md` §11.5).

### 3.5 End-to-end smoke test

Insert 1 giao dịch vào Postgres, đợi ~10 giây, đọc trong ClickHouse:

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
INSERT INTO transactions (account_id, merchant_id, amount, currency, type, status, description)
SELECT a.id, m.id, 150000.00, 'VND', 'purchase', 'completed', 'demo smoke test'
FROM accounts a, merchants m
WHERE a.email='nguyenvana@email.com' AND m.name='VinMart'
LIMIT 1;"
```

Sau ~10s:

```bash
docker exec finwatch-clickhouse clickhouse-client -q "
SELECT id, amount, type, description
FROM finwatch.transactions FINAL
WHERE description='demo smoke test' AND cdc_op != 'd'"
```

Kỳ vọng: trả về đúng 1 dòng. Đây là bằng chứng pipeline E2E (PG → Debezium → Kafka → ClickHouse) hoạt động.

### 3.6 Closed-loop test — lock account làm txn tiếp theo bị từ chối

Đây là bằng chứng lớp **fraud-workflow** đã được áp dụng ở cả 3 đường insert (API, generator, simulator). Lấy ID tài khoản, gọi API lock, thử insert, gọi API unlock, thử lại:

```powershell
$ACC = (docker exec finwatch-postgres psql -U finwatch -d finwatch -tAc "SELECT id FROM accounts WHERE email='nguyenvana@email.com'").Trim()
$body = "{`"account_id`":`"$ACC`",`"merchant`":`"VinMart`",`"amount`":100000,`"type`":`"purchase`"}"

# Lock
curl.exe -s -X POST "http://localhost:3002/api/accounts/$ACC/lock"
# Insert thử khi đang lock: kỳ vọng { accepted: false, reason: "suspended" }
curl.exe -s -X POST http://localhost:3002/api/insert-transaction -H "Content-Type: application/json" -d $body
# Unlock
curl.exe -s -X POST "http://localhost:3002/api/accounts/$ACC/unlock"
# Insert lại khi đã active: kỳ vọng { accepted: true, new_balance: <prev - 100000> }
curl.exe -s -X POST http://localhost:3002/api/insert-transaction -H "Content-Type: application/json" -d $body
```

Nếu hai response đầu đúng (`reason: "suspended"`) và hai response cuối đúng (`accepted: true` + balance giảm đúng 100,000) thì **balance ledger** + **lock/unlock workflow** đã hoạt động.

### 3.7 Fraud worker — sinh case từ ClickHouse → Postgres

Tiêm fraud rồi chạy worker 1 lần, kiểm tra case xuất hiện trong cả PG và CH:

```bash
python scripts/simulate_fraud.py --scenario card-cloning      # VELOCITY firing
python scripts/fraud_alert_worker.py --once                   # 1 lần tick
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT rule_code, severity, count(*) FROM fraud_alerts GROUP BY 1, 2"
```

Kỳ vọng: ít nhất 1 dòng `VELOCITY | high | 1`. Đợi ~10 giây cho CDC, sau đó:

```bash
docker exec finwatch-clickhouse clickhouse-client -q "SELECT rule_code, count() FROM finwatch.fraud_alerts FINAL WHERE cdc_op != 'd' GROUP BY 1"
```

Phải có cùng số dòng — bằng chứng case đã chảy qua Debezium → Kafka → ClickHouse và sẵn sàng phục vụ UI.

---

## 4. Kịch bản demo chính (gợi ý 10 phút)

### Bước 1 — Sinh tải nền (background)

Mở **một terminal riêng**, chạy synthetic load để dashboard có dữ liệu chạy động:

```bash
cd D:/Major/Graduate_Project/finwatch
python scripts/generate_transactions.py --count 2000 --tps 200
```

- `--count 2000` = tổng 2000 giao dịch
- `--tps 200` = nhịp ~200 giao dịch/giây
- Thời gian chạy: ~10s

Có thể chạy nhiều lần liên tiếp để TPS spike trong UI.

### Bước 2 — Show Dashboard chính (http://localhost:3002)

Người xem sẽ thấy:

1. **Animated architecture flow** ở trên cùng: các "hạt" sáng chạy từ Postgres → Debezium → Kafka → ClickHouse → Web mỗi khi có event.
2. **Health KPIs**: TPS hiện tại, p95 latency, total today.
3. **TPS sparkline**: nhịp giao dịch theo giây.
4. **Live transaction stream**: danh sách giao dịch mới nhất, kèm tên account, merchant, category, mức rủi ro (low/medium/high).
5. **Fraud alert feed**: cảnh báo theo từng luật (sẽ rỗng nếu chưa chạy `simulate_fraud.py`).

### Bước 3 — Inject 3 kịch bản fraud thật

```bash
python scripts/simulate_fraud.py --pattern all
```

3 kịch bản được tiêm:

| Pattern | Câu chuyện | Luật bị kích hoạt |
|---|---|---|
| `card-cloning` | Kẻ tấn công clone thẻ qua skimmer, đốt số dư bằng **15 micro-purchase** trong vài giây | **VELOCITY** (R1) |
| `wire-fraud` | Business Email Compromise: giả CFO chuyển **250,000,000 VND** một lần | **LARGE_AMT** (R3) |
| `fx-laundering` | Layering: chia tiền qua **5 loại tiền tệ** (VND, USD, EUR, JPY, THB) trong 10 phút | **MULTI_CCY** (R5) |

Có thể tách lẻ với `--pattern velocity | large-amount | multi-currency`.

Đợi ~5 giây, refresh tab Dashboard (http://localhost:3002) — Fraud alert feed sẽ có ngay các dòng `VELOCITY`, `LARGE_AMT`, `MULTI_CCY`, `HIGH_RISK`, `ZSCORE`.

### Bước 4 — Trace 1 giao dịch qua từng chặng (http://localhost:3002/trace)

1. Trang `/trace` cho phép insert giao dịch trực tiếp qua API `/api/insert-transaction`.
2. Sau khi insert, UI hiển thị "đường đi" qua 4 chặng: PG insert → Debezium emit → Kafka offset → ClickHouse arrival, kèm timestamp từng chặng.
3. Đây là tính năng "showcase" giải thích trực quan cách CDC hoạt động.

### Bước 5 — Fraud rules deep-dive (http://localhost:3002/fraud)

Trang `/fraud` hiển thị **6 luật** (R1–R6) song song:

| Rule | Tên | Mô tả ngắn |
|---|---|---|
| R1 | VELOCITY | > 10 txn hoặc > 50M VND trong 5 phút trên cùng account |
| R2 | ZSCORE | Số tiền lệch ≥ 3σ so với trung bình account trong 30 ngày |
| R3 | LARGE_AMT | Single txn > 100M VND |
| R4 | HIGH_RISK | ≥ 3 txn tới merchant `risk_level='high'` trong 1 giờ |
| R5 | MULTI_CCY | > 2 currency riêng biệt trong 10 phút |
| R6 | FAILURE_SPIKE | > 5 txn `status='failed'` trong 10 phút |

Mỗi luật có biểu đồ time-series riêng (lấy qua API `/api/fraud/history?rule=R1&minutes=30`).

### Bước 5.5 — Closed loop trên UI (http://localhost:3002/accounts/[id])

Đây là phần "wow" của bản demo mới — chứng minh hệ thống hoạt động như một fraud-ops thực, không chỉ là pipeline showcase.

1. Mở http://localhost:3002/accounts — danh bạ tài khoản. Tìm `Nguyen` → thấy account có cột `Open alerts (24h)` ≥ 1 (sau khi đã chạy simulate_fraud).
2. Click **View →**. Trang chi tiết hiện: tên, email, **balance** lớn, **status badge** `active` (xanh) hoặc `suspended` (đỏ); cạnh đó là 2 panel **Recent transactions** và **Alert history**.
3. Click nút đỏ **Suspend** → confirm. Status badge chuyển sang `suspended`. Trong 1 giây cả 3 đường insert (generator/simulator/API) đều sẽ ghi txn `status='failed'` cho account này.
4. Để chứng minh: mở terminal mới, chạy `python scripts/generate_transactions.py --count 10 --tps 5`. SWR trên `/accounts/[id]` refresh mỗi 5s — các dòng `failed` (đỏ) với description `rejected: account suspended` đổ xuống bảng Recent transactions.
5. Click **Reactivate** (xanh) → status quay về `active`. Txn tiếp theo sẽ lại được `completed` (debit balance đúng số tiền).

### Bước 5.6 — Alerts queue (http://localhost:3002/alerts)

1. Click **Alerts** trên NavBar. Bảng hiện toàn bộ case từ `fraud_alerts FINAL` — mỗi case có `time | account (link) | rule | severity | txn_count | total_amount | status`.
2. Click các filter chip phía trên: lọc theo `VELOCITY`, `LARGE_AMT`, ... hoặc theo severity `critical`, `high`, `medium`, `low`. URL có ?rule=...&severity=... nên link share được.
3. Click vào tên account trong bảng — nhảy thẳng sang `/accounts/[id]` của tài khoản đó (tích hợp giữa 2 trang).

> **Khác biệt với Alert feed ở Dashboard:** feed ở Dashboard tính alert theo realtime từ `transactions FINAL` (transient). Trang `/alerts` đọc từ `fraud_alerts FINAL` — case **persistent** mà analyst đã/đang xử lý. Hai bảng phục vụ hai nhu cầu khác nhau.

### Bước 6 — Kafka browser nội bộ (http://localhost:3002/kafka)

Trang `/kafka` thay thế công cụ `kafka-ui` bên ngoài, cho phép:
- Liệt kê topic (partition, replication factor, retention)
- Inspect message theo offset
- Xem consumer-lag

Dùng để chứng minh "Kafka thực sự có data chảy qua" cho người xem không quen tool ngoài.

### Bước 7 — Grafana Pipeline Health (http://localhost:3000)

- Login: `admin / admin` (lần đầu sẽ hỏi đổi password, có thể skip)
- Mở dashboard **Pipeline Health** (đã được provision tự động).
- Hiển thị: volume theo phút, top merchants, ingestion lag (PG→CH), TPS theo type.

---

## 5. Anomaly detection — chạy raw SQL

Sau khi `simulate_fraud.py` chạy, có thể chạy 3 query SQL gốc bằng `clickhouse-client`:

```bash
docker exec -i finwatch-clickhouse clickhouse-client --multiquery < clickhouse/queries/anomaly_velocity_check.sql
docker exec -i finwatch-clickhouse clickhouse-client --multiquery < clickhouse/queries/anomaly_zscore.sql
docker exec -i finwatch-clickhouse clickhouse-client --multiquery < clickhouse/queries/anomaly_threshold.sql
```

Hoặc inline (dùng cho slide demo):

```bash
docker exec finwatch-clickhouse clickhouse-client -q "
SELECT account_id, count() AS txn_count, sum(toFloat64(amount)) AS total_amount
FROM finwatch.transactions FINAL
WHERE created_at >= now() - INTERVAL 10 MINUTE AND cdc_op != 'd'
GROUP BY account_id
HAVING txn_count > 10 OR total_amount > 50000000
ORDER BY txn_count DESC
FORMAT PrettyCompact"
```

Kỳ vọng (sau khi chạy `simulate_fraud.py --pattern all`):

```
   ┌─account_id───────────────────────────┬─txn_count─┬─total_amount─┐
1. │ f501a28d-d9d9-4cdf-ba7b-f62c6941c583 │        20 │  60267404.33 │
2. │ 094cf49c-b584-4d5f-b1db-e9687fb985ed │         1 │    250000000 │
   └──────────────────────────────────────┴───────────┴──────────────┘
```

---

## 6. Benchmarks (đo hiệu năng — phục vụ Chương 5 thesis)

### 6.1 End-to-end latency (PG insert → CH visible)

```bash
python scripts/benchmark_latency.py --samples 20
```

Kết quả thực đo tham khảo (stack mới chạy 1 giờ, máy phát triển):

```
Results (20/20 successful):
   Min:    574 ms
   Max:    2107 ms
   Avg:    1052 ms
   Median: 1079 ms
   P95:    2107 ms
   Target 5000ms: 20/20 (100%)
```

> Có được mức ~1s nhờ profile `clickhouse/users.d/streaming.xml` (`stream_flush_interval_ms=500`). Mặc định ClickHouse là ~7.5s.

### 6.2 Throughput tại đầu PostgreSQL

```bash
python scripts/benchmark_throughput.py --total 5000
```

Kết quả thực đo tham khảo:

```
Result: 5000 transactions in 2.8s = 1767 TPS
```

Target trong thesis: **> 1000 TPS** ở phía insert PG.

---

## 7. Test suite (pytest)

Toàn bộ pipeline có test tự động (sức khoẻ, tính toàn vẹn, anomaly, schema evolution). Chạy:

```bash
cd D:/Major/Graduate_Project/finwatch
python -m pytest -v
```

Kỳ vọng:

```
22 passed, 1 deselected in ~25s
```

(1 test bị `deselect` là `test_stress.py` — chỉ chạy khi truyền `-m slow`.)

Để chạy cả test slow:

```bash
python -m pytest -v -m "slow or not slow"
```

---

## 8. Thu thập "evidence" cho báo cáo

Lệnh dưới đây sẽ tạo một thư mục `evidence/<timestamp>/` chứa: connector status, topic list, snapshot counts, output 3 anomaly query, dashboard query, kết quả latency + throughput, bằng chứng dedup.

```bash
python scripts/collect_evidence.py
```

Output mẫu (thư mục mới sẽ xuất hiện trong `finwatch/evidence/2026-05-21_HHMMSS/`):

```
connector_status.json
kafka_topics.txt
snapshot_counts.txt
anomaly_anomaly_velocity_check.txt
anomaly_anomaly_zscore.txt
anomaly_anomaly_threshold.txt
dashboard_dashboard_queries.txt
latency.txt
throughput.txt
dedup_evidence.txt
SUMMARY.md
```

`SUMMARY.md` tự sinh, kèm số liệu — copy thẳng vào Chương 5.

---

## 9. Kịch bản demo rút gọn (5 phút)

| Phút | Hành động | Thấy gì |
|---|---|---|
| 0–1 | `docker compose ps` + mở http://localhost:3002 | Stack `Up` (9 service kể cả fraud-worker), dashboard live |
| 1–2 | `python scripts/generate_transactions.py --count 2000 --tps 200` | TPS sparkline nhảy lên ~200 |
| 2–3 | `python scripts/simulate_fraud.py --pattern all` + `python scripts/fraud_alert_worker.py --once` | Fraud alerts firing + case lưu vào `fraud_alerts` |
| 3–4 | Mở /accounts → click View → Suspend; chạy generator 10 txn | Txn tiếp theo của account này = `failed: rejected: account suspended` |
| 4–5 | Mở /alerts → filter VELOCITY/critical + Grafana dashboard | Hàng đợi case hiển thị + Grafana hoạt động |

---

## 10. Cleanup & reset

### Tắt stack (giữ data)

```bash
docker compose down
```

### Reset hoàn toàn (xoá toàn bộ volume — postgres data, kafka offsets, CH dữ liệu)

```bash
docker compose down -v
docker compose up -d
python scripts/wait_for_services.py
```

### Chỉ reset Kafka offsets / ClickHouse (giữ Postgres)

Xem `finwatch/docs/runbook.md` mục "Recovery cheatsheet".

---

## 11. Troubleshooting nhanh

| Triệu chứng | Nguyên nhân hay gặp | Cách xử lý |
|---|---|---|
| Connector status không `RUNNING` | Postgres chưa healthy lúc Debezium start | `curl.exe -X POST http://localhost:8083/connectors/finwatch-connector/restart` |
| Web UI 502 / không load | `web` container chưa build xong | `docker compose logs web --tail 100` |
| `curl` treo, hiện `Uri:` prompt | PowerShell alias `curl` = `Invoke-WebRequest` | Đổi sang `curl.exe` |
| ClickHouse trống dù connector RUNNING | Kafka engine table chưa consume | `docker exec finwatch-clickhouse clickhouse-client -q "SELECT * FROM system.kafka_consumers"` |
| Replication slot phình | Connector bị xoá nhưng slot còn | `SELECT pg_drop_replication_slot('finwatch_slot');` |
| Anomaly query trả về rỗng | Chưa có dữ liệu trong 5–10 phút gần đây | Chạy `simulate_fraud.py` trước |
| Port 3000 / 3002 / 5432 bị chiếm | App khác đang chạy | Sửa `.env` (không sửa `.env.example`) |

Trường hợp khẩn:

```bash
docker compose logs --tail 200 <service>          # đọc log
docker compose restart <service>                  # restart 1 service
docker compose down -v && docker compose up -d    # nuke + làm lại
```

---

## 12. Checklist trước khi present

- [ ] `docker compose ps` — 9 service đều `Up`, các service quan trọng `healthy`, kể cả `fraud-worker`
- [ ] `curl.exe -s http://localhost:8083/connectors/finwatch-connector/status` — `RUNNING`
- [ ] `curl.exe -s http://localhost:8123/ping` — `Ok.`
- [ ] http://localhost:3002 — Dashboard load, không lỗi 5xx
- [ ] http://localhost:3002/accounts — danh bạ load, search hoạt động
- [ ] http://localhost:3002/alerts — hàng đợi case load (rỗng được, nhưng không lỗi)
- [ ] http://localhost:3000 — Grafana login được
- [ ] `python -m pytest -v` — 22 passed
- [ ] Đã chạy 1 lần `simulate_fraud.py --scenario card-cloning` + `fraud_alert_worker.py --once` → ít nhất 1 dòng trong `fraud_alerts`
- [ ] Closed loop UI: lock account → insert thử → response `accepted:false reason:suspended`; unlock → response `accepted:true new_balance:...`
- [ ] `python scripts/collect_evidence.py` — đã có folder evidence mới nhất

Khi cả 8 dòng đều ✅, hệ thống đã sẵn sàng demo.
