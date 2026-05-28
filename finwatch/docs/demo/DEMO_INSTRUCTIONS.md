# FinWatch — Hướng dẫn demo (general · CLI + UI)

Tài liệu này là **kịch bản demo chính thức** cho buổi bảo vệ luận văn — đi theo narrative "Closed-loop fraud monitoring" trong ~22 phút. Khác với bản UI-only ở `DEMO_INSTRUCTIONS_UI.md`, bản này **mỗi Act đều có cả UI action và CLI alternative** (curl / psql / docker exec / python script) — phục vụ cả khi hội đồng muốn xem evidence ở tầng terminal, và phục vụ lab walkthrough cho bản thân (verify pipeline ở tầng SQL trước khi defense).

> **Lưu ý môi trường:** Tất cả lệnh trong code block giữ nguyên tiếng Anh để copy-paste an toàn. Người dùng đang chạy trên **Windows 11 + PowerShell**, vì vậy phải dùng `curl.exe` (binary thật) thay vì `curl` (alias của `Invoke-WebRequest`). Trong PowerShell, thay `&&` bằng `; if ($?) { ... }`. Trong Git Bash, có thể dùng `&&` bình thường.

> **TL;DR cho ngày defense:**
> 1. T-2 giờ: `python finwatch\scripts\prepare_demo_full.py --start --for-defense`
> 2. Mở 7 tab UI (mục 2.3) + 1 terminal PowerShell sẵn sàng
> 3. Verify `/alerts` empty + per-rule count=0
> 4. Khi vào phòng: Act 1 (Vấn đề) → Act 6 (Limitations + Q&A)

Mục lục nhanh:

1. Đối tượng tài liệu
2. Chuẩn bị trước demo
3. KỊCH BẢN CHUẨN — 6 Acts (~22 phút)
4. Biến thể theo thời lượng
5. Điều KHÔNG NÊN làm
6. Recovery — khi demo có sự cố
7. FAQ phòng vệ (10 câu)
8. Phụ lục — Verification chi tiết, benchmarks, evidence collection (reference)

---

## 1. Đối tượng tài liệu

- **Người dùng chính:** chính bạn, có thể cần show evidence ở cả tầng UI và tầng SQL trong buổi defense.
- **Mục tiêu:** dẫn hội đồng đi từ **vấn đề** → **detection** → **action** → **metrics** → **limitations** trong 22 phút. Khi hội đồng yêu cầu evidence cụ thể (SQL, log Postgres, Kafka offset), bản này có sẵn lệnh để chạy ngay.
- **Tiền đề:** stack đã chạy + đã chạy `prepare_demo_full.py --for-defense` (mục 2.2).

---

## 2. Chuẩn bị trước demo

### 2.1 Checklist 3 mốc thời gian

**T-7 ngày**

- [ ] Tập demo theo kịch bản 6-Act ít nhất 3 lần, đo thời gian từng Act.
- [ ] Chụp screenshot mỗi panel chính làm backup (Dashboard, /demo Propagation Status, /accounts/[id], /alerts, /fraud) + screenshot output `benchmark_latency.py`.
- [ ] In file này ra giấy A4.
- [ ] *(Tuỳ chọn)* Soạn `finwatch\docs\limitations.md` + `finwatch\docs\decisions\` (ADRs) để Act 5 + Act 6 có file để mở. Nếu chưa, dùng bản inline ở Act 6.
- [ ] Chạy `python scripts/collect_evidence.py` để có bundle evidence cho Chương 5 thesis.

**T-1 ngày**

- [ ] Cold reboot máy demo.
- [ ] `docker compose down -v && docker compose up -d` (reset volume sạch).
- [ ] Chạy lệnh ở mục 2.2.
- [ ] Verify (mục 2.4) — clean state đầy đủ.
- [ ] Test Act 3.2 end-to-end: click `Velocity (card-cloning)` ở Dashboard → đợi ~5–10s → 1 case mới ở `/alerts`. Ghi latency thực tế lên giấy.
- [ ] Chạy `python -m pytest -v` — kỳ vọng 22 passed.

**T-2 giờ**

- [ ] Re-run lệnh 2.2 (đã có baseline rồi → ~10–27s).
- [ ] Đóng Slack/Discord/Spotify/Telegram.
- [ ] Browser zoom 110–125%.
- [ ] Mở 7 tab UI (mục 2.3) + 1 terminal PowerShell với `conda activate C:\ProgramData\miniconda3\envs\graduate_env` sẵn.
- [ ] Verify lần cuối (mục 2.4).

### 2.2 Lệnh chuẩn bị (chỉ 1 lệnh)

```powershell
conda activate C:\ProgramData\miniconda3\envs\graduate_env
python finwatch\scripts\prepare_demo_full.py --start --for-defense
```

Lệnh này:

- Boot full 9 service (postgres, zookeeper, kafka, debezium, clickhouse, prometheus, grafana, web, fraud-worker)
- Register Debezium connector + verify ClickHouse snapshot
- Seed 30-ngày baseline cho ZSCORE history
- Drive ~1500 txn load nhưng **loại high-risk merchant** → không phát sinh HIGH_RISK / ZSCORE / VELOCITY false positive
- **KHÔNG** inject fraud (việc của demo live)
- **KHÔNG** tick fraud-worker (cùng lý do)
- Pre-warm UI pages + API endpoints
- **Kết quả:** stack sẵn sàng, `/alerts` hoàn toàn trống, mọi rule card `count=0`

Khi banner hiện `FinWatch is READY FOR LIVE DEFENSE DEMO (clean state)` → vào phòng được.

> Nếu cần "tour mode" (lab demo / open-house, mọi widget có data sẵn): chạy `python finwatch\scripts\prepare_demo_full.py --start` (KHÔNG kèm `--for-defense`). Mode này tự fire 6 scenario + tick worker, nhưng KHÔNG dùng cho defense vì mất transition "0 → 1".

### 2.3 7 tab UI + terminal PowerShell

| # | URL | Đặt tên | Dùng ở Act |
|---|---|---|---|
| 1 | http://localhost:3002/ | **Dashboard** | Act 1, Act 3 |
| 2 | http://localhost:3002/demo | **Insert & Trace** | Act 2, Act 4.3 |
| 3 | http://localhost:3002/alerts | **Alert queue** | Act 3, Act 4 |
| 4 | http://localhost:3002/accounts | **Accounts** | Act 4 |
| 5 | http://localhost:3000 | **Grafana** (admin/admin) | Act 5 |
| 6 | http://localhost:3002/fraud | **Fraud rules** (6 cards) | Act 3 backup |
| 7 | http://localhost:3002/kafka | **Kafka** (backup) | Act 2 backup |

Cộng với **1 terminal PowerShell** đã `conda activate` xong và `cd D:/Major/Graduate_Project/finwatch/` — sẵn sàng chạy `docker exec`, `python scripts/...`, `curl.exe` khi cần.

### 2.4 Verify trạng thái trước demo

```powershell
# 1. fraud_alerts trống — clean state
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT count(*) FROM fraud_alerts"
# expect: 0

# 2. baseline đã seed
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT count(*) FROM transactions WHERE description LIKE 'baseline%'"
# expect: vài trăm

# 3. Debezium connector RUNNING
curl.exe -s http://localhost:8083/connectors/finwatch-connector/status | python -m json.tool

# 4. ClickHouse snapshot landed
docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.transactions FINAL WHERE cdc_op != 'd'"
# expect: hàng trăm trở lên
```

Nếu một trong các điều kiện trên fail → re-run lệnh 2.2.

---

## 3. KỊCH BẢN CHUẨN — "Closed-loop fraud monitoring" (~22 phút)

### Act 1 — Vấn đề (2 phút)

**Tab:** Dashboard (http://localhost:3002/)

**Mở đầu:** chỉ tay vào subtitle *"Real-Time Transaction Monitoring · PostgreSQL → Debezium → Kafka → ClickHouse"* trên cùng Dashboard.

**Lời thoại:**

> "Ngân hàng cần phát hiện gian lận trong **giây**, không phải **phút**. Batch ETL truyền thống quét dữ liệu mỗi đêm — kẻ tấn công đã rút hết tiền trước khi báo cáo chạy xong. Em xây hệ thống FinWatch dùng Change Data Capture để stream mọi giao dịch từ Postgres OLTP qua Kafka đến ClickHouse trong **dưới 1 giây** — đủ nhanh để rule-based detection chặn được hành vi gian lận **ngay trong khoảnh khắc** nó diễn ra."

**Show:** Pipeline Flow particles chạy với traffic nền (1500 txn baseline đã được drive bởi `prepare_demo_full.py`).

**CLI evidence** (nếu hội đồng hỏi "pipeline có thật chạy không?"):

```powershell
# Show wal_level=logical là invariant cho CDC
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SHOW wal_level"
# expect: logical

# Topic Kafka có sẵn
docker exec finwatch-kafka kafka-topics --bootstrap-server kafka:9092 --list | Select-String "finwatch.public"
# expect: 4 topic finwatch.public.accounts/merchants/transactions/fraud_alerts
```

---

### Act 2 — Pipeline có chạy được không? (3 phút)

**Tab:** /demo (Insert & Trace)

**UI Action:**

1. Account / Merchant default, Amount = `150000`, Currency = `VND`, Type = `purchase`, Status = `completed`.
2. Description = `Defense Act 2 — pipeline E2E proof`.
3. Bấm **`Insert & Trace`**.

**Show:** Propagation Status panel 3 row:

- **PostgreSQL commit** — ~30–60 ms (API round-trip + balance check + INSERT)
- **CDC propagation** — ~0.5–1s (Debezium → Kafka → ClickHouse · WAL to row)
- **ClickHouse visible** — ~700–1300 ms (end-to-end · row queryable via FINAL)

**Lời thoại:**

> "30 milli-giây là API roundtrip — bao gồm `SELECT ... FOR UPDATE` balance check, INSERT và commit. **1 giây** là end-to-end từ commit Postgres đến ClickHouse query được. Đây là sub-second em đề cập ở Act 1 — đo thật."

**CLI alternative** (cho hội đồng muốn xem raw):

```powershell
# Insert thẳng qua psql, sau đó verify ở CH
docker exec finwatch-postgres psql -U finwatch -d finwatch -c @'
INSERT INTO transactions (account_id, merchant_id, amount, currency, type, status, description)
SELECT a.id, m.id, 150000.00, 'VND', 'purchase', 'completed', 'defense-cli'
FROM accounts a, merchants m
WHERE a.email='nguyenvana@email.com' AND m.name='VinMart'
LIMIT 1
'@

# Đợi ~2s, đọc trong ClickHouse
Start-Sleep -Seconds 2
docker exec finwatch-clickhouse clickhouse-client -q "SELECT id, amount, type, description FROM finwatch.transactions FINAL WHERE description='defense-cli' AND cdc_op != 'd'"
# expect: 1 dòng
```

**Bonus** (nếu còn thời gian): mở tab Dashboard, chỉ Pipeline Flow particles — hạt vừa chạy qua là txn vừa insert.

---

### Act 3 — Detection layer (5 phút) — **ACT WOW NHẤT**

**Tab:** Dashboard + /alerts

#### Action 3.1 — Normal load không gây alert (1.5 phút)

**UI:**

1. Sang `/alerts`, confirm bảng **trống**.
2. Về Dashboard, click `Drive normal load (200 txns)`.
3. Show TPS sparkline spike + Pipeline Flow particles.
4. Đợi ~25s. Sang `/alerts` → **vẫn trống**.

**CLI alternative:**

```powershell
python finwatch\scripts\generate_transactions.py --count 200 --tps 200 --exclude-high-risk
# Đợi ~3s rồi check
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT count(*) FROM fraud_alerts"
# expect: vẫn 0
```

**Lời thoại:**

> "200 giao dịch hợp lệ vừa chảy qua hệ thống — purchase nhỏ tới merchant non-high-risk, không alert nào fire. Đây là invariant detection layer: rule không phản ứng với traffic bình thường."

#### Action 3.2 — Velocity scenario (1.5 phút)

**UI:**

1. Về Dashboard, click `Velocity (card-cloning)`.
2. Sang `/alerts`, đợi ~5–15s, refresh nếu cần.
3. Show: 1 case mới `VELOCITY · high · 15 txns · 60.3M VND in 5 min`.

**CLI alternative:**

```powershell
python finwatch\scripts\simulate_fraud.py --scenario card-cloning
python finwatch\scripts\fraud_alert_worker.py --once
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT rule_code, severity, txn_count, total_amount FROM fraud_alerts ORDER BY created_at DESC LIMIT 5"
# expect: 1 dòng VELOCITY
```

**Lời thoại:**

> "15 giao dịch micro-purchase trong 5 giây — quá ngưỡng VELOCITY (`>10 txn` hoặc `>50M VND` trong 5 phút). Worker phát hiện, tạo case mới trong PG `fraud_alerts`, CDC đẩy lên CH, `/alerts` page hiển thị trong ~5–10 giây. Đây là **closed loop detection**."

#### Action 3.3 — Wire-fraud scenario (1 phút)

**UI:** Dashboard click `Large amount (wire-fraud)`. Sang `/alerts` thấy case `LARGE_AMT · high` (hoặc `critical`).

**CLI alternative:**

```powershell
python finwatch\scripts\simulate_fraud.py --scenario wire-fraud
python finwatch\scripts\fraud_alert_worker.py --once
```

**Note:** Một giao dịch có thể trigger nhiều rule khi pattern bất thường nổi bật (ví dụ LARGE_AMT + ZSCORE).

#### Action 3.4 — *(tuỳ chọn)* Multi-currency (1 phút)

**UI:** Dashboard click `Multi-currency (FX)` → `/alerts` xuất hiện case `MULTI_CCY`.

**CLI alternative:**

```powershell
python finwatch\scripts\simulate_fraud.py --scenario fx-laundering
python finwatch\scripts\fraud_alert_worker.py --once
```

> Áp lực thời gian ≤22 phút → bỏ Action 3.4.

---

### Act 4 — Workflow nghiệp vụ (5 phút) — **ACT "BANK THẬT"**

**Tab:** /alerts → /accounts/[id] → /demo

#### Action 4.1 — Drill down từ alert vào account (1 phút)

**UI:** Trong `/alerts`, click tên account của case VELOCITY → nhảy sang `/accounts/[id]`. Show: balance, status badge `active`, Recent transactions, Alert history.

**Lời thoại:**

> "Analyst nhìn vào account bị flag để điều tra. Đây là 15 txn VELOCITY vừa diễn ra — pattern rõ ràng của card cloning."

#### Action 4.2 — Suspend account (1 phút)

**UI:**

1. Bấm `Suspend` (đỏ, góc phải header).
2. Confirm → OK.
3. Status badge → `suspended` (đỏ) trong 1 giây.

**CLI alternative (lock qua API):**

```powershell
$ACC = (docker exec finwatch-postgres psql -U finwatch -d finwatch -tAc "SELECT id FROM accounts WHERE email='nguyenvana@email.com'").Trim()
curl.exe -s -X POST "http://localhost:3002/api/accounts/$ACC/lock"
# response: { "ok": true, "status": "suspended" }
```

**Lời thoại:**

> "Em vừa khoá account ở UI. Đây không phải DB trigger — em áp dụng **ledger ở tầng application** (`/api/insert-transaction`, `scripts/generate_transactions.py`, `scripts/simulate_fraud.py`). Simulator/generator bỏ qua API vẫn tuân thủ cùng quy tắc — invariant của thiết kế."

#### Action 4.3 — Verify closed loop (2 phút)

**UI:**

1. Mở `/demo`.
2. Chọn lại account vừa suspend trong dropdown Account.
3. Amount = 150000, type = purchase, status = completed.
4. Bấm `Insert & Trace`.
5. Toast đỏ: **`Rejected (account suspended) · row XXXXXXXX… still flows to CDC`**.

**CLI alternative:**

```powershell
$body = "{`"account_id`":`"$ACC`",`"merchant`":`"VinMart`",`"amount`":150000,`"type`":`"purchase`"}"
curl.exe -s -X POST http://localhost:3002/api/insert-transaction -H "Content-Type: application/json" -d $body
# response: { "accepted": false, "reason": "suspended", "id": "..." }
```

Hoặc chạy generator (cũng bị reject):

```powershell
python finwatch\scripts\generate_transactions.py --count 10 --tps 5
# Xong, check failed rows cho account
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT count(*) FROM transactions WHERE account_id='$ACC' AND status='failed' AND description='rejected: account suspended'"
# expect: > 0
```

**Lời thoại:**

> "Đây là **closed loop nghiệp vụ**. Detection phát hiện hành vi → analyst khoá → ledger từ chối giao dịch tiếp theo **trong cùng pipeline**. Row bị reject vẫn được lưu (audit value), nhưng balance không trừ và status = `failed` với reason `rejected: account suspended`."

#### Action 4.4 — *(tuỳ chọn)* Reactivate để show toggle (1 phút)

**UI:** Về `/accounts/[id]`, bấm `Reactivate` (xanh). Status về `active`. Insert lại ở `/demo` → toast xanh, balance trừ đúng.

**CLI alternative:**

```powershell
curl.exe -s -X POST "http://localhost:3002/api/accounts/$ACC/unlock"
# response: { "ok": true, "status": "active" }
```

> *Lưu ý:* "Close as fraud" trên `/alerts` (đóng case với reason) hiện chưa có trong build — **future work**. Suspend account ở `/accounts/[id]` là cách đóng loop chính.

---

### Act 5 — Defensibility / metrics (4 phút)

**Tab:** Grafana → *(tuỳ chọn)* evaluation report / ADRs / terminal benchmarks

#### Action 5.1 — Grafana Pipeline Health (2 phút)

**UI:** http://localhost:3000 → dashboard **`FinWatch — Pipeline Health`** → panel "End-to-end latency" (~1s p50) + "Transactions per second" (sustained ~1000–1500 TPS).

**Lời thoại:**

> "Latency p50 ~1s — đáp ứng target thesis **< 5s**. Throughput ~1500 TPS trên 1 Docker host — đủ cho ngân hàng tier 2."

**CLI re-run** (nếu hội đồng muốn xem live benchmark):

```powershell
python finwatch\scripts\benchmark_latency.py --samples 50
# Đợi ~2 phút. Output:
# Results (50/50 successful):
#    Min:    574 ms
#    Avg:    1052 ms
#    P95:    2107 ms
#    Target 5000ms: 50/50 (100%)
```

#### Action 5.2 — *(tuỳ chọn)* Evaluation report (1 phút)

Nếu đã generate (qua `thesis-defensible.md` prompt hoặc thủ công):

```powershell
ls finwatch\evaluation\report_*.md | Sort-Object LastWriteTime -Descending | Select-Object -First 1
# Mở file mới nhất trong VS Code
```

Show: confusion matrix per rule + F1 scores. Nếu chưa có → bỏ Action này, trả lời FAQ 7.4 nếu hỏi.

#### Action 5.3 — *(tuỳ chọn)* ADRs (1 phút)

Nếu folder `finwatch\docs\decisions\` đã có:

```powershell
ls finwatch\docs\decisions\
# Expected: 0001-cdc-over-dual-write.md, 0002-clickhouse-vs-druid.md, ...
```

Mở `0001-*.md` đọc nhanh Context + Decision (~5 dòng). Nếu chưa có → trả lời FAQ 7.1 / 7.2 inline.

---

### Act 6 — Limitations + Q&A (3 phút)

**Tab:** Dashboard (giữ tab 1) hoặc VS Code mở `finwatch\docs\limitations.md` (nếu đã có).

**Action:** Đọc 3 limitation chính. Nếu chưa có file thì đọc inline:

1. **Synthetic data — chưa kiểm chứng trên dữ liệu ngân hàng thực.** Baseline + fraud scenarios đều synthetic (`generate_transactions.py` + `simulate_fraud.py`). Threshold của 6 rule tune từ pattern em design — chưa A/B test trên production.
2. **Rule-based detection, chưa có ML scorer.** Chọn rule-based vì explainability + không có labeled training data. Future work: overlay ML scorer (isolation forest / gradient boosting) làm second opinion cho high-severity case.
3. **Chưa có SAR/OFAC compliance — out of thesis scope.** Có audit trail cơ bản (`fraud_alerts.evidence` JSONB), nhưng chưa structuring detection / watchlist screening / SAR threshold reporting. Thêm các rule này dễ — viết SQL như 6 rule hiện tại — nhưng compliance workflow đầy đủ là thesis riêng.

**Lời thoại:**

> "Em chủ động nêu giới hạn để hội đồng thấy em hiểu phạm vi thesis. Synthetic data + rule-based + compliance là 3 hướng future work. Em có path rõ ràng để mature từng phần."

**Kết:** *"Em đã hoàn thành phần demo. Hội đồng có câu hỏi nào ạ?"*

---

## 4. Biến thể theo thời lượng

| Slot | Cắt gì | Giữ gì |
|---|---|---|
| **5 phút smoke** | Bỏ Act 1, 5, 6 | Act 2 (Insert & Trace) + Act 3.2 (Velocity) |
| **15 phút compressed** | Bỏ Act 1, Act 5 chỉ Grafana | Act 2, 3, 4 đầy đủ + Act 6 ngắn |
| **22 phút chuẩn (default)** | Đầy đủ | Đầy đủ |
| **30 phút mở rộng** | Đầy đủ + show /kafka + scenario thứ 4 + 2 ADRs đầy đủ + benchmark CLI live | Đầy đủ + deep dive |

---

## 5. Điều KHÔNG NÊN làm trong defense

| Tránh | Lý do |
|---|---|
| Bắt đầu bằng "Hôm nay em demo CDC pipeline" | Bắt đầu phải là **vấn đề**, không phải tool |
| Tour qua tất cả 6 scenarios | Lặp lại nhàm. Show 2–3 đại diện đủ |
| Mở terminal chạy SQL trong demo (trừ khi hội đồng yêu cầu) | Mất audience. CLI alternative ở mỗi Act là backup, không phải mặc định |
| Mở Grafana đầu tiên | Grafana là ops dashboard, không phải product story |
| Live edit code | Risk cao, không giá trị thêm |
| Quên nhắc limitations | Bị hỏi giảm điểm. **Chủ động nêu = control narrative** |
| Chạy `prepare_demo_full.py` KHÔNG có `--for-defense` | Auto-fire fraud + tick worker → `/alerts` đã có alert → mất narrative live |

---

## 6. Recovery — khi demo có sự cố

| Triệu chứng | Cách xử ngay tại defense |
|---|---|
| Particles không bay sau khi insert | F5 Dashboard. Vẫn không → `docker compose ps` xem service nào down |
| `/alerts` không update | Worker dedup chặn (1h theo account+rule_code) — chuyển scenario khác |
| Pipeline Flow load chậm | `docker compose restart web` (~10s) — nói tiếp narrative giấu downtime |
| Toàn bộ stack đứng | Bật backup screenshot. *"Stack production-grade cần thời gian phục hồi, em show evidence chạy thử"* |
| Hội đồng chen ngang | Trả lời, rồi *"Em quay lại flow demo ạ"* |
| Connector FAILED | `curl.exe -X POST http://localhost:8083/connectors/finwatch-connector/restart` |
| ClickHouse trống dù connector RUNNING | `docker exec finwatch-clickhouse clickhouse-client -q "SELECT * FROM system.kafka_consumers"` để debug |
| Replication slot phình | `SELECT pg_drop_replication_slot('finwatch_slot');` rồi re-register connector |

---

## 7. FAQ phòng vệ — chuẩn bị sẵn

### 7.1. Tại sao CDC mà không dual-write?

- App không cần biết về analytics → tách concern
- WAL ghi nhận mọi thay đổi, không bỏ sót (dual-write có window crash giữa commit + publish)
- Replay được khi consumer down: Debezium giữ offset trong replication slot
- Trade-off: thêm 1 service (Debezium) + cần `wal_level=logical`

### 7.2. Tại sao ClickHouse mà không TimescaleDB / Druid / Snowflake?

- Open-source, columnar, sub-second analytical query trên tỉ rows
- Kafka engine native — table đọc thẳng từ topic, không cần connector phụ
- Snowflake quá đắt; TimescaleDB tốt time-series nhưng kém wide-aggregation; Druid setup phức tạp + RAM-hungry

### 7.3. Latency end-to-end bao nhiêu?

- p50 ~1.0s, p95 ~2.1s (đo bằng `benchmark_latency.py --samples 20+`)
- Đã tune `stream_flush_interval_ms` từ 7500ms default xuống 500ms (`clickhouse/users.d/streaming.xml`)
- Trade-off: flush nhanh = CPU cao, batch nhỏ = storage tăng nhẹ
- Target thesis < 5s — vượt xa

### 7.4. False positive rate?

- Synthetic data → không quote precision/recall như con số kết luận
- Threshold mỗi rule có trong UI + `clickhouse/queries/anomaly_*.sql` — là **dial** dễ tune
- Future work: 30 ngày unlabeled production data, semi-supervise gắn nhãn, A/B test threshold

### 7.5. Scale thế nào? Nếu 10,000 TPS?

- Hiện sustained ~1500 TPS / 1 Docker host (8 CPU, 16 GB RAM)
- Kafka horizontal: thêm partition `transactions` + scale broker
- ClickHouse horizontal: shard theo `account_id` hash + replica fail-over
- PG là bottleneck cuối — cần read replicas + PgBouncer
- Detection layer cần stateful sharding (mỗi worker 1 subset accounts)

### 7.6. Nếu Kafka down thì sao?

- Debezium giữ replication slot trong PG → WAL không recycle
- Kafka khôi phục → Debezium resume từ offset cuối cùng commit
- Downtime → alert delay tương ứng
- Production cần thêm DLQ cho poison message + alert trên slot size

### 7.7. Nếu phải dùng ML thì sao?

- Hiện rule-based vì explainability + không có labeled training data
- ML overlay: isolation forest trên feature từ CH (velocity, hour-of-day, merchant risk)
- Trade-off: ML mất explainability — cần SHAP / rule extraction
- Architecture support sẵn: thêm `ml_score` vào `fraud_alerts`, worker thứ 2 consume cùng topic

### 7.8. SAR / OFAC compliance?

- Out of thesis scope — Act 6 limitations
- `fraud_alerts` đã có evidence JSONB / status / notes
- SAR thresholds dễ thêm như rule mới (structuring detection)
- OFAC cần 1 service riêng (sanctions list refresh + name matching)

### 7.9. Tại sao JSON mà không Avro?

- Schema evolution hiếm trong scope thesis
- JSON debug dễ — `docker exec kafka kafka-console-consumer` đọc thẳng
- Trade-off: contract không enforced compile-time
- Production tier 1: dùng Avro + Schema Registry hợp lý (ghi chú CLAUDE.md §8)

### 7.10. Hệ thống production-ready không?

- Không hoàn toàn — limitations Act 6
- Cần thêm: TLS/mTLS, OAuth proxy trước Grafana/UI, PITR backup PG, multi-region replication, Prometheus + Alertmanager + PagerDuty
- Hiện là PoC chứng minh architecture works, path rõ ràng để mature
- Code English-only, CI ready, observability Prometheus scrape — vài tuần sprint là production-near

---

## 8. Phụ lục — Verification chi tiết, benchmarks, evidence collection (reference)

Phần dưới đây giữ nguyên content cũ của bản tài liệu — verification checklist, anomaly query, benchmark, pytest, evidence collection. Dùng cho lab walkthrough hoặc khi rehearse từng Act mới và cần verify pipeline ở tầng SQL.

### 8.0 Yêu cầu chuẩn bị (chạy 1 lần — reference)

| Thành phần | Phiên bản tối thiểu | Cách kiểm tra |
|---|---|---|
| Docker Desktop | 4.x (Compose v2) | `docker --version` & `docker compose version` |
| Miniconda env | `graduate_env` (Python 3.11) | `conda env list` |
| Python deps | xem `finwatch/scripts/requirements.txt` | `pip list` trong env |
| Ổ đĩa trống | ≥ 5 GB | volumes Docker (postgres, kafka, clickhouse) |
| Cổng trống | 3000, 3002, 5432, 8083, 8123, 9000, 9090, 29092 | `netstat -ano \| findstr ":3002"` |

#### Kích hoạt môi trường Python

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

### 8.1 Khởi động toàn bộ stack (manual, không qua `prepare_demo_full.py`)

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

#### Kiểm tra trạng thái

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

> **`fraud-worker`** chạy `scripts/fraud_alert_worker.py --interval 30` liên tục, gọi 6 anomaly query mỗi 30 giây và ghi case mới vào PG `fraud_alerts` (dedup 1h theo `(account_id, rule_code)`). Case sau đó replicate qua CDC trở lại ClickHouse.

### 8.2 Bảng endpoint nhanh

| Tab | URL | Mục đích |
|---|---|---|
| 1 | http://localhost:3002 | Dashboard với Pipeline Flow particle live, live stream, fraud alerts |
| 2 | http://localhost:3002/demo | Insert & trace — drive pipeline tay |
| 3 | http://localhost:3002/trace | Tracer chuyên dụng với sidebar recent 20 |
| 4 | http://localhost:3002/fraud | 6 luật phát hiện fraud (R1–R6) |
| 5 | http://localhost:3002/accounts | Danh bạ account — tìm, balance, status, open alerts |
| 6 | http://localhost:3002/accounts/[id] | Trang chi tiết — Suspend/Reactivate, txn, alert history |
| 7 | http://localhost:3002/alerts | Hàng đợi case từ `fraud_alerts` với filter rule + severity |
| 8 | http://localhost:3002/kafka | Kafka topic browser |
| 9 | http://localhost:3000 (admin/admin) | Grafana — Pipeline Health dashboard |

Endpoint phụ:

| Service | URL | Check |
|---|---|---|
| ClickHouse HTTP | http://localhost:8123/ping | `Ok.` |
| Debezium Connect | http://localhost:8083/connectors | JSON list |
| Prometheus | http://localhost:9090/-/ready | `Prometheus Server is Ready.` |

### 8.3 Verification checklist (manual — `prepare_demo_full.py` đã làm thay)

#### 8.3.1 PostgreSQL — schema + WAL

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "\dt"
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SHOW wal_level;"
```

Kỳ vọng:
- 4 bảng: `accounts`, `merchants`, `transactions`, `fraud_alerts`
- `wal_level = logical` (bắt buộc để CDC chạy)

#### 8.3.2 Kafka topics

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

#### 8.3.3 Debezium connector

```bash
curl.exe -s http://localhost:8083/connectors/finwatch-connector/status
```

Kỳ vọng: `"state":"RUNNING"` cho cả `connector` và `tasks[0]`.

#### 8.3.4 ClickHouse — snapshot đã đổ về

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

Kiểm tra thêm bảng case log:

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "\d fraud_alerts"
docker exec finwatch-clickhouse clickhouse-client -q "SHOW CREATE TABLE finwatch.fraud_alerts"
```

Bảng phải có cột `id, account_id, rule_code, severity, txn_count, total_amount, evidence (JSONB), status, notes, created_at, resolved_at` cùng index dedup `(account_id, rule_code, created_at)`.

> **Quy tắc luôn áp dụng:** mọi câu SELECT phân tích trên 3 bảng đích trong ClickHouse phải có `FINAL` + `cdc_op != 'd'` (CLAUDE.md §11.5).

#### 8.3.5 End-to-end smoke test

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

Kỳ vọng: trả về đúng 1 dòng.

#### 8.3.6 Closed-loop test — lock account làm txn tiếp theo bị từ chối

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

#### 8.3.7 Fraud worker — sinh case từ ClickHouse → Postgres

```bash
python scripts/simulate_fraud.py --scenario card-cloning      # VELOCITY firing
python scripts/fraud_alert_worker.py --once                   # 1 lần tick
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT rule_code, severity, count(*) FROM fraud_alerts GROUP BY 1, 2"
```

Kỳ vọng: ít nhất 1 dòng `VELOCITY | high | 1`. Đợi ~10 giây cho CDC, sau đó:

```bash
docker exec finwatch-clickhouse clickhouse-client -q "SELECT rule_code, count() FROM finwatch.fraud_alerts FINAL WHERE cdc_op != 'd' GROUP BY 1"
```

Phải có cùng số dòng — bằng chứng case đã chảy qua Debezium → Kafka → ClickHouse.

### 8.4 Anomaly detection — chạy raw SQL

Sau khi `simulate_fraud.py` chạy, có thể chạy 3 query SQL gốc:

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

Kỳ vọng (sau `simulate_fraud.py --pattern all`):

```
   ┌─account_id───────────────────────────┬─txn_count─┬─total_amount─┐
1. │ f501a28d-d9d9-4cdf-ba7b-f62c6941c583 │        20 │  60267404.33 │
2. │ 094cf49c-b584-4d5f-b1db-e9687fb985ed │         1 │    250000000 │
   └──────────────────────────────────────┴───────────┴──────────────┘
```

### 8.5 Benchmarks (phục vụ Chương 5 thesis)

#### End-to-end latency (PG insert → CH visible)

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

#### Throughput tại đầu PostgreSQL

```bash
python scripts/benchmark_throughput.py --total 5000
```

Kết quả thực đo tham khảo:

```
Result: 5000 transactions in 2.8s = 1767 TPS
```

Target trong thesis: **> 1000 TPS** ở phía insert PG.

### 8.6 Test suite (pytest)

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

### 8.7 Thu thập "evidence" cho báo cáo

Lệnh dưới đây tạo `evidence/<timestamp>/` chứa connector status, topic list, snapshot counts, output 3 anomaly query, dashboard query, kết quả latency + throughput, bằng chứng dedup.

```bash
python scripts/collect_evidence.py
```

Output mẫu:

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

### 8.8 Kịch bản demo rút gọn 5 phút (tour mode — reference)

> *Đây là tour 5 phút khi không có defense slot. Defense dùng §3 (6-Act). Pre-condition: chạy `prepare_demo_full.py` tour mode (KHÔNG `--for-defense`).*

| Phút | Hành động | Thấy gì |
|---|---|---|
| 0–1 | `docker compose ps` + mở http://localhost:3002 | Stack `Up` (9 service kể cả fraud-worker), dashboard live |
| 1–2 | `python scripts/generate_transactions.py --count 2000 --tps 200` | TPS sparkline nhảy lên ~200 |
| 2–3 | `python scripts/simulate_fraud.py --pattern all` + `python scripts/fraud_alert_worker.py --once` | Fraud alerts firing + case lưu vào `fraud_alerts` |
| 3–4 | Mở /accounts → click View → Suspend; chạy generator 10 txn | Txn tiếp theo của account này = `failed: rejected: account suspended` |
| 4–5 | Mở /alerts → filter VELOCITY/critical + Grafana dashboard | Hàng đợi case + Grafana hoạt động |

### 8.9 Cleanup & reset

#### Tắt stack (giữ data)

```bash
docker compose down
```

#### Reset hoàn toàn (xoá toàn bộ volume)

```bash
docker compose down -v
docker compose up -d
python scripts/wait_for_services.py
```

#### Chỉ reset Kafka offsets / ClickHouse (giữ Postgres)

Xem `finwatch/docs/runbook.md` mục "Recovery cheatsheet".

### 8.10 Troubleshooting (reference)

| Triệu chứng | Nguyên nhân hay gặp | Cách xử lý |
|---|---|---|
| Connector status không `RUNNING` | Postgres chưa healthy lúc Debezium start | `curl.exe -X POST http://localhost:8083/connectors/finwatch-connector/restart` |
| Web UI 502 / không load | `web` container chưa build xong | `docker compose logs web --tail 100` |
| `curl` treo, hiện `Uri:` prompt | PowerShell alias `curl` = `Invoke-WebRequest` | Đổi sang `curl.exe` |
| ClickHouse trống dù connector RUNNING | Kafka engine table chưa consume | `docker exec finwatch-clickhouse clickhouse-client -q "SELECT * FROM system.kafka_consumers"` |
| Replication slot phình | Connector bị xoá nhưng slot còn | `SELECT pg_drop_replication_slot('finwatch_slot');` |
| Anomaly query trả về rỗng | Chưa có dữ liệu trong 5–10 phút gần đây | Chạy `simulate_fraud.py` trước |
| Port 3000 / 3002 / 5432 bị chiếm | App khác đang chạy | Sửa `.env` (không sửa `.env.example`) |
| `/alerts` đã có rows trước khi click | Chạy `prepare_demo_full.py` không kèm `--for-defense` | Re-run với `--for-defense` |

Trường hợp khẩn:

```bash
docker compose logs --tail 200 <service>          # đọc log
docker compose restart <service>                  # restart 1 service
docker compose down -v && docker compose up -d    # nuke + làm lại
```

### 8.11 Checklist cuối trước khi present (manual)

- [ ] `docker compose ps` — 9 service đều `Up`, các service quan trọng `healthy`, kể cả `fraud-worker`
- [ ] `curl.exe -s http://localhost:8083/connectors/finwatch-connector/status` — `RUNNING`
- [ ] `curl.exe -s http://localhost:8123/ping` — `Ok.`
- [ ] http://localhost:3002 — Dashboard load, không lỗi 5xx
- [ ] http://localhost:3002/accounts — danh bạ load, search hoạt động
- [ ] http://localhost:3002/alerts — hàng đợi case load (rỗng được, nhưng không lỗi)
- [ ] http://localhost:3000 — Grafana login được
- [ ] `python -m pytest -v` — 22 passed
- [ ] Đã chạy 1 lần `simulate_fraud.py --scenario card-cloning` + `fraud_alert_worker.py --once` → ít nhất 1 dòng trong `fraud_alerts` (chỉ áp dụng cho **tour mode**; defense mode KHÔNG làm bước này)
- [ ] Closed loop UI: lock account → insert thử → response `accepted:false reason:suspended`; unlock → response `accepted:true new_balance:...`
- [ ] `python scripts/collect_evidence.py` — đã có folder evidence mới nhất

Khi cả 11 dòng đều ✅, hệ thống đã sẵn sàng demo.
