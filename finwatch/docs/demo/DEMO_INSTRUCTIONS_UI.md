# FinWatch — Hướng dẫn demo cho thesis defense

Tài liệu này là **kịch bản demo chính thức** cho buổi bảo vệ luận văn — đi theo narrative "Closed-loop fraud monitoring" trong ~22 phút. Phiên bản này chỉ dùng UI tại http://localhost:3002 (sau khi chạy 1 lệnh chuẩn bị duy nhất ở terminal). Phần phụ lục ở cuối giữ lại walkthrough chi tiết từng tab cho khi bạn muốn show sâu hơn hoặc cho lab tour.

> **TL;DR cho ngày defense:**
> 1. T-2 giờ: `python finwatch\scripts\prepare_demo_full.py --start --for-defense`
> 2. Mở 7 tab (xem mục 2.3 bên dưới)
> 3. Verify `/alerts` empty, mọi rule card `count=0`
> 4. Khi vào phòng: bắt đầu Act 1 (Vấn đề) → kết thúc Act 6 (Limitations + Q&A)

Mục lục nhanh:

1. Đối tượng tài liệu
2. Chuẩn bị trước demo (pre-flight + lệnh + tab order + verify)
3. KỊCH BẢN CHUẨN — 6 Acts (~22 phút)
4. Biến thể theo thời lượng
5. Điều KHÔNG NÊN làm
6. Recovery — khi demo có sự cố
7. FAQ phòng vệ (10 câu)
8. Phụ lục — Walkthrough chi tiết từng tab (reference)

---

## 1. Đối tượng tài liệu

- **Người dùng chính:** chính bạn (sinh viên thực hiện), tay cầm tài liệu in giấy A4 hoặc mở trên màn hình phụ trong buổi defense.
- **Mục tiêu:** dẫn hội đồng đi từ **vấn đề** → **detection** → **action** → **metrics** → **limitations** trong 22 phút, không phải tour qua từng tính năng.
- **Tiền đề:** stack đã chạy + đã chạy `prepare_demo_full.py --for-defense` (mục 2.2).

---

## 2. Chuẩn bị trước demo

### 2.1 Checklist 3 mốc thời gian

**T-7 ngày**

- [ ] Tập demo theo kịch bản 6-Act ít nhất 3 lần, đo thời gian từng Act bằng đồng hồ bấm.
- [ ] Chụp screenshot mỗi panel chính (Dashboard, /demo Propagation Status, /accounts/[id] với Suspend, /alerts queue, /fraud 6 cards) làm backup phòng khi stack đứng.
- [ ] In file này (DEMO_INSTRUCTIONS_UI.md) ra giấy A4.
- [ ] *(Tuỳ chọn)* Soạn `finwatch\docs\limitations.md` và folder `finwatch\docs\decisions\` (ADRs) để Act 5 + Act 6 có file để mở. Nếu chưa, dùng bản inline ở Act 6 bên dưới.

**T-1 ngày**

- [ ] Cold reboot máy demo (clear RAM + đảm bảo no leftover process).
- [ ] `docker compose down -v && docker compose up -d` (reset volume sạch).
- [ ] Chạy lệnh ở mục 2.2.
- [ ] Xác nhận `/alerts` empty, mọi rule card `count=0` ở `/fraud`.
- [ ] Test toàn bộ Act 3.2: click **"Velocity (card-cloning)"** → đợi ~5–10s → alert mới hiện ra trong `/alerts` → ghi lại latency thực tế lên giấy.

**T-2 giờ**

- [ ] Re-run lệnh 2.2 (đã có baseline rồi nên ~10–27s tuỳ máy).
- [ ] Đóng Slack/Discord/Spotify/Telegram để tránh pop-up trong demo.
- [ ] Browser zoom 110–125% (đủ to cho hội đồng đứng xa nhìn được).
- [ ] Mở 7 tab theo thứ tự ở mục 2.3.
- [ ] Verify ở mục 2.4.

### 2.2 Lệnh chuẩn bị (chỉ 1 lệnh)

```powershell
python finwatch\scripts\prepare_demo_full.py --start --for-defense
```

Lệnh này:

- Boot full 9 service (postgres, zookeeper, kafka, debezium, clickhouse, prometheus, grafana, web, fraud-worker)
- Register Debezium connector + verify ClickHouse snapshot
- Seed 30-ngày baseline cho ZSCORE history
- Drive ~1500 txn load nhưng **loại high-risk merchant** → không phát sinh HIGH_RISK / ZSCORE / VELOCITY false positive
- **KHÔNG** inject fraud (đó là việc của demo live)
- **KHÔNG** tick fraud-worker (cùng lý do)
- Pre-warm UI pages + API endpoints
- **Kết quả:** stack sẵn sàng, `/alerts` hoàn toàn trống, mọi rule card `count=0`

Khi banner hiện `FinWatch is READY FOR LIVE DEFENSE DEMO (clean state)` → vào phòng được.

> Nếu vô tình chạy `prepare_demo_full.py` không kèm `--for-defense` thì script sẽ bắn 6 scenario + tick worker → `/alerts` đã có case sẵn → mất transition "0 → 1" trong demo. Re-run với `--for-defense` để clean state. Tour mode (mọi widget có data) chỉ dùng cho lab demo / open-house, KHÔNG cho defense.

### 2.3 7 tab mở sẵn (thứ tự theo Act)

| # | URL | Đặt tên | Dùng ở Act |
|---|---|---|---|
| 1 | http://localhost:3002/ | **Dashboard** | Act 1, Act 3 |
| 2 | http://localhost:3002/demo | **Insert & Trace** | Act 2 |
| 3 | http://localhost:3002/alerts | **Alert queue** | Act 3, Act 4 |
| 4 | http://localhost:3002/accounts | **Accounts** | Act 4 |
| 5 | http://localhost:3000 | **Grafana** (admin/admin) | Act 5 |
| 6 | http://localhost:3002/fraud | **Fraud rules** (6 cards backup) | Act 3 backup |
| 7 | http://localhost:3002/kafka | **Kafka** (backup nếu hội đồng hỏi) | Act 2 backup |

> NavBar trên cùng có link tới mọi trang — có thể chuyển tab bằng click thay vì gõ URL.

### 2.4 Verify trạng thái trước demo

```powershell
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT count(*) FROM fraud_alerts"
# expect: 0
```

```powershell
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT count(*) FROM transactions WHERE description LIKE 'baseline%'"
# expect: vài trăm (baseline seeding 30 ngày đã chạy)
```

Mở `/fraud` → cả 6 card phải đều `count=0`. Mở `/alerts` → "No cases yet" hoặc bảng rỗng. Mở Dashboard → TPS sparkline đã có data nền (từ 1500 txn load), Health KPIs không NaN.

Nếu một trong các điều kiện trên fail → re-run lệnh ở 2.2.

---

## 3. KỊCH BẢN CHUẨN — "Closed-loop fraud monitoring" (~22 phút)

### Act 1 — Vấn đề (2 phút)

**Tab:** Dashboard (http://localhost:3002/)

**Mở đầu:** Đứng cạnh màn hình, tay chỉ vào subtitle phía trên *"Real-Time Transaction Monitoring · PostgreSQL → Debezium → Kafka → ClickHouse"*.

**Lời thoại** (tinh thần, không học thuộc):

> "Ngân hàng cần phát hiện gian lận trong **giây**, không phải **phút**. Batch ETL truyền thống quét dữ liệu mỗi đêm — kẻ tấn công đã rút hết tiền trước khi báo cáo chạy xong. Em xây hệ thống FinWatch dùng Change Data Capture để stream mọi giao dịch từ Postgres OLTP qua Kafka đến ClickHouse trong **dưới 1 giây** — đủ nhanh để rule-based detection chặn được hành vi gian lận **ngay trong khoảnh khắc** nó diễn ra."

**Show:** chỉ tay theo Pipeline Flow particles (panel trên cùng Dashboard) — các "hạt" sáng đang chạy từ PostgreSQL → Debezium → Kafka → ClickHouse với traffic nền (1500 txn baseline đã được drive bởi `prepare_demo_full.py`).

---

### Act 2 — Pipeline có chạy được không? (3 phút)

**Tab:** /demo (Insert & Trace)

**Action:**

1. Để dropdown **Account** và **Merchant** ở giá trị mặc định.
2. Field **Amount** = `150000`, **Currency** = `VND`, **Type** = `purchase`, **Status** = `completed`.
3. Description = `Defense Act 2 — pipeline E2E proof`.
4. Bấm **`Insert & Trace`** (nút xanh accent, full-width).

**Show:** Propagation Status panel bên phải transitions qua 3 row:

- **PostgreSQL commit** — sub: *"API round-trip incl. balance check"* — dot chuyển xám → vàng pulse → xanh emerald với số `XX ms` (thực tế ~30–60 ms)
- **CDC propagation** — sub: *"Debezium → Kafka → ClickHouse · WAL to row"* — pulse vàng ~0.5–1s rồi xanh
- **ClickHouse visible** — sub: *"end-to-end · row queryable via FINAL"* — dot xanh với số `XXX ms` (thực tế ~700–1300 ms)

Toast cuối hiện: `Visible in ClickHouse in XXXX ms`.

**Lời thoại:**

> "30 milli-giây là thời gian API roundtrip — bao gồm `SELECT ... FOR UPDATE` balance check, INSERT và commit. **1 giây** là thời gian end-to-end từ commit Postgres đến ClickHouse query được. Đây là sub-second em đề cập trong Act 1 — đo thật, không phải con số giả định."

**Bonus** (nếu còn thời gian): chuyển sang tab Dashboard, chỉ vào Pipeline Flow panel — một hạt mới vừa đi qua 4 node, đây là transaction vừa insert.

---

### Act 3 — Detection layer (5 phút) — **ACT WOW NHẤT**

**Tab:** Dashboard (http://localhost:3002/) + /alerts (tab 3)

#### Action 3.1 — Normal load không gây alert (1.5 phút)

1. Chuyển sang tab `/alerts`, confirm bảng **trống** (vì `--for-defense`).
2. Quay về Dashboard.
3. Bấm nút **`Drive normal load (200 txns)`** trong khối **Demo controls**.
4. Show: TPS sparkline ở giữa Dashboard nhảy lên một spike. Pipeline Flow particles chạy rộn ràng qua 4 node.
5. Đợi ~25 giây cho load chạy xong (status hiện `OK · 200 txns in X.Xs ≈ Y TPS`).
6. Chuyển sang tab `/alerts` → **vẫn trống**.

**Lời thoại:**

> "200 giao dịch hợp lệ vừa chảy qua hệ thống — purchase nhỏ tới merchant non-high-risk, không alert nào fire. Đây là một invariant quan trọng của detection layer: rule không phản ứng với traffic bình thường. Nếu fire ở đây thì là **false positive** — rule có vấn đề."

#### Action 3.2 — Velocity scenario (1.5 phút)

1. Quay về Dashboard.
2. Bấm nút **`Velocity (card-cloning)`** trong Demo controls — kích bản 15 micro-purchase liên tiếp tới 1 account.
3. Show: 15 hạt sáng bay nhanh qua Pipeline Flow trong ~3 giây.
4. Chuyển sang tab `/alerts`. Đợi ~5–15 giây (worker tick 30s, nhưng bạn vừa chạy thủ công khi click button).
5. Refresh nếu cần — **1 case mới xuất hiện**: `VELOCITY · high · Account [name] · 15 txns · 60.3M VND in 5 min`.

**Lời thoại:**

> "15 giao dịch micro-purchase trong 5 giây — quá ngưỡng VELOCITY của em (`>10 txn` hoặc `>50M VND` trong 5 phút). Worker phát hiện, tạo case mới trong bảng Postgres `fraud_alerts`, CDC đẩy lên ClickHouse, trang `/alerts` hiển thị **trong ~5–10 giây** từ lúc click. Đây chính là **closed loop detection** — không cần manual SQL, không cần admin tool ngoài."

#### Action 3.3 — Wire-fraud scenario (1 phút)

1. Về Dashboard, bấm **`Large amount (wire-fraud)`** — 1 giao dịch 250,000,000 VND.
2. Sang `/alerts`. Trong vòng ~10s xuất hiện thêm case `LARGE_AMT · high` (hoặc `critical` nếu rule severity escalation).
3. Đôi khi cùng account vẫn fire `ZSCORE` hoặc `MULTI_CCY` — chỉ ra: *"Một giao dịch có thể trigger nhiều rule khi pattern bất thường nổi bật"*.

#### Action 3.4 — *(tuỳ chọn)* Multi-currency (1 phút)

- Bấm **`Multi-currency (FX)`** — 5 giao dịch ở 5 currency khác nhau (VND/USD/EUR/JPY/THB).
- Sang `/alerts` → thấy case `MULTI_CCY` — cho khán giả thấy detection cho money laundering pattern.

> Nếu áp lực thời gian (≤22 phút) → bỏ Action 3.4, giữ 3.1 + 3.2 + 3.3 là đủ.

---

### Act 4 — Workflow nghiệp vụ (5 phút) — **ACT "BANK THẬT"**

**Tab:** /alerts → /accounts/[id]

#### Action 4.1 — Drill down từ alert vào account (1 phút)

1. Trong `/alerts`, **click vào tên account** của case VELOCITY (cột Account là link clickable).
2. Browser nhảy sang `/accounts/[id]`.
3. Show: tên account, email, số điện thoại, **balance** (số lớn ở góc phải), **status badge** `active` (màu xanh), 2 panel song song bên dưới (Recent transactions + Alert history · 20 dòng mỗi panel).

**Lời thoại:**

> "Analyst nhìn vào account bị flag để điều tra. Đây là **15 giao dịch VELOCITY** vừa diễn ra trong vài giây — pattern rõ ràng của card cloning. Alert history bên phải hiện đúng case này với rule + severity + count."

#### Action 4.2 — Suspend account (closed-loop trigger) (1 phút)

1. Bấm nút **`Suspend`** màu đỏ ở góc phải header (cạnh status badge).
2. Confirm dialog → OK.
3. **Status badge chuyển sang đỏ `suspended` trong 1 giây.** SWR refresh tự động.

**Lời thoại:**

> "Em vừa khoá account ở UI. Nhưng đây không phải database trigger — em áp dụng ledger ở **tầng application** (`/api/insert-transaction`, `scripts/generate_transactions.py`, `scripts/simulate_fraud.py`). Có nghĩa: simulator hay generator bỏ qua API vẫn tuân thủ cùng quy tắc — đây là **invariant của thiết kế**."

#### Action 4.3 — Verify closed loop (2 phút)

1. Mở tab `/demo` (Insert & Trace).
2. Trong dropdown **Account**, **chọn lại account vừa suspend** (tên đã biết từ Act 3.2).
3. Để các field còn lại default: amount = 150000, type = purchase, status = completed.
4. Bấm **`Insert & Trace`**.
5. Show: toast màu đỏ hiện ngay: **`Rejected (account suspended) · row XXXXXXXX… still flows to CDC`**.
6. Quan sát: Propagation Status panel vẫn chạy đầy đủ 3 row, vì row `status='failed'` vẫn được commit và vẫn chảy qua CDC.

**Lời thoại:**

> "Đây là **closed loop nghiệp vụ**. Detection phát hiện hành vi → analyst quyết định khoá → ledger từ chối giao dịch tiếp theo **trong cùng pipeline**, không cần đổi schema, không cần restart service. Trong fraud ops thật, đây là đúng cách bank xử lý: row bị reject vẫn được lưu (có audit value), nhưng balance không bị trừ và status là `failed` với reason `rejected: account suspended`."

#### Action 4.4 — *(tuỳ chọn)* Reactivate để show toggle (1 phút)

1. Về `/accounts/[id]` của account vừa suspend.
2. Bấm **`Reactivate`** (nút xanh, thay chỗ Suspend khi status=suspended).
3. Status badge chuyển về `active`.
4. Sang `/demo`, insert lại — toast lần này xanh, balance bị trừ đúng số tiền.

> *Lưu ý:* tính năng "Close as fraud" trên `/alerts` (đóng case với reason fraud/clean) hiện chưa có trong build — đây là **future work** (alerts redesign). Trong defense, Suspend account ở `/accounts/[id]` là cách đóng loop chính.

---

### Act 5 — Defensibility / metrics (4 phút)

**Tab:** Grafana (tab 5) → *(tuỳ chọn)* evaluation report

#### Action 5.1 — Grafana Pipeline Health (2 phút)

1. Mở http://localhost:3000 (đã login `admin/admin`).
2. Mở dashboard **`FinWatch — Pipeline Health`**.
3. Chỉ vào panel "End-to-end latency" → ~1s p50 (khớp con số đã đo ở Act 2).
4. Chỉ vào panel "Transactions per second" → sustained ~1000–1500 TPS từ baseline load.

**Lời thoại:**

> "Latency p50 ~1 giây — đáp ứng target thiết kế **< 5 giây** trong thesis Chương 4. Throughput sustained ~1500 TPS trên 1 Docker host (16 GB RAM, 8 CPU) — đủ cho ngân hàng tier 2 trong giờ cao điểm."

#### Action 5.2 — *(tuỳ chọn, nếu đã có)* Evaluation report (1 phút)

1. Nếu đã chạy prompt `thesis-defensible.md` để generate evaluation report, mở `finwatch\evaluation\report_<timestamp>.md` trong VS Code.
2. Show confusion matrix per rule + F1 scores. Chỉ ra: *"VELOCITY F1 = 0.XX, LARGE_AMT F1 = 0.XX..."*.

> Nếu chưa có file này thì **bỏ Action 5.2** và chỉ nói: *"Em chưa chạy formal evaluation trên dataset đầy đủ — synthetic data với labeled fraud chỉ có ở scenario buttons. Đây là future work."*

#### Action 5.3 — *(tuỳ chọn, nếu đã có)* ADRs (1 phút)

1. Nếu đã có folder `finwatch\docs\decisions\`, mở folder trong VS Code, list các file ADR (0001-cdc-over-dual-write.md, 0002-clickhouse-vs-druid.md, ...).
2. Mở `0001-cdc-over-dual-write.md` đọc nhanh phần Context + Decision (~5 dòng).

> Nếu chưa có folder ADR thì **bỏ Action 5.3** và trả lời câu FAQ về architectural decisions (mục 7) nếu hội đồng hỏi.

---

### Act 6 — Limitations + Q&A (3 phút)

**Tab:** Dashboard (giữ tab 1) hoặc VS Code mở `finwatch\docs\limitations.md` (nếu đã có).

**Action:** Tóm tắt 3 limitation chính. Nếu đã có file `limitations.md` thì mở; nếu chưa, đọc bullets bên dưới.

**Limitations cần nêu (inline — copy paste vào limitations.md nếu chưa có):**

1. **Synthetic data — chưa kiểm chứng trên dữ liệu ngân hàng thực.** Toàn bộ baseline + fraud scenarios đều do `generate_transactions.py` + `simulate_fraud.py` sinh ra theo distribution thủ công. Threshold của 6 rule (VELOCITY > 10 txn / 5 min, LARGE_AMT > 100M VND, ...) tune từ pattern em đã design — chưa A/B test trên production data.
2. **Rule-based detection, chưa có ML scorer.** Em chọn rule-based vì explainability + không có labeled training data. Future work: overlay một secondary ML scorer (isolation forest hoặc gradient boosting trên feature engineered từ ClickHouse) làm second opinion cho high-severity case.
3. **Chưa có SAR/OFAC compliance — out of thesis scope.** Hệ thống có audit trail cơ bản (`fraud_alerts` lưu evidence JSONB), nhưng chưa có structuring detection, watchlist screening, SAR threshold reporting. Thêm các rule này dễ — viết SQL như 6 rule hiện tại — nhưng compliance workflow đầy đủ là một thesis riêng.

**Lời thoại:**

> "Em chủ động nêu giới hạn để hội đồng thấy em hiểu phạm vi của thesis. Synthetic data, rule-based detection, và compliance là 3 hướng future work. Em có **path rõ ràng** để mature từng phần — ví dụ ML scorer sẽ dùng ClickHouse feature store, compliance sẽ thêm rule + workflow trên cùng `fraud_alerts` table không cần đổi schema."

**Kết:** *"Em đã hoàn thành phần demo. Hội đồng có câu hỏi nào ạ?"*

---

## 4. Biến thể theo thời lượng

| Slot | Cắt gì | Giữ gì |
|---|---|---|
| **5 phút smoke** | Bỏ Act 1, 5, 6 | Act 2 (Insert & Trace) + Act 3.2 (Velocity) |
| **15 phút compressed** | Bỏ Act 1, gộp Act 5 chỉ Grafana | Act 2, 3, 4 đầy đủ + Act 6 ngắn |
| **22 phút chuẩn (default)** | Đầy đủ | Đầy đủ — cho slot 30 phút có Q&A |
| **30 phút mở rộng** | Đầy đủ + Show `/kafka` (Act 2 extension), thêm scenario thứ 4 ở Act 3, đọc 2 ADRs đầy đủ ở Act 5 | Đầy đủ + deep dive |

---

## 5. Điều KHÔNG NÊN làm trong defense

| Tránh | Lý do |
|---|---|
| Bắt đầu bằng "Hôm nay em demo CDC pipeline" | Bắt đầu phải là **vấn đề**, không phải tool. Hội đồng quan tâm "why" trước "how" |
| Tour qua tất cả 6 scenarios | Lặp lại nhàm. Show 2–3 đại diện đủ — VELOCITY + LARGE_AMT cover hai pattern khác nhau (count-based vs amount-based) |
| Mở terminal chạy SQL trong demo | Mất audience. Chỉ làm khi hội đồng yêu cầu "cho xem query thực sự" |
| Mở Grafana đầu tiên | Grafana là ops dashboard, không phải product story. Để Act 5 |
| Live edit code | Risk cao, không giá trị thêm |
| Quên nhắc limitations | Bị hỏi giảm điểm. **Chủ động nêu = control narrative** |
| Chạy `prepare_demo_full.py` KHÔNG có `--for-defense` | Sẽ auto-fire fraud + tick worker → `/alerts` đã có alert → mất narrative live "0 → 1" |

---

## 6. Recovery — khi demo có sự cố

| Triệu chứng | Cách xử ngay tại defense |
|---|---|
| Particles không bay sau khi insert | F5 Dashboard. Vẫn không → `docker compose ps` xem service nào down |
| `/alerts` không update sau khi click scenario | Worker dedup chặn (1h theo `account_id+rule_code`) — chuyển sang scenario khác (ví dụ đang VELOCITY thì thử LARGE_AMT) |
| Pipeline Flow load chậm hoặc trắng panel | Web container restart: `docker compose restart web` (mất ~10s) — trong lúc đó nói tiếp narrative để giấu downtime |
| Toàn bộ stack đứng | Bật backup screenshot trên laptop phụ. Nói thẳng: *"Stack production-grade cần thời gian phục hồi, em show screenshot của lần chạy thử + log evidence"* — không cố cứu live |
| Hội đồng chen ngang giữa Act | Trả lời câu đó, rồi: *"Em quay lại flow demo ạ, đang ở Act X..."* — giữ thread |
| Toast hiện `Rejected (account suspended)` ở Act 2 (chưa Suspend) | Quên Reactivate account từ test trước. Vào `/accounts/[id]` Reactivate, hoặc dùng account khác |

---

## 7. FAQ phòng vệ — chuẩn bị sẵn

10 câu hội đồng hay hỏi. Trả lời 3–5 bullet ngắn cho mỗi câu.

### 7.1. Tại sao CDC mà không dual-write?

- App không cần biết về analytics → tách concern, dev team OLTP làm việc độc lập với team analytics
- WAL ghi nhận **mọi** thay đổi, không bỏ sót — dual-write có window mà app commit DB nhưng crash trước khi publish event
- Replay được khi consumer down: Debezium giữ offset trong replication slot, restart từ đúng chỗ
- Trade-off: thêm 1 service (Debezium) + cần `wal_level=logical`

### 7.2. Tại sao ClickHouse mà không TimescaleDB / Druid / Snowflake?

- Open-source, columnar, sub-second analytical query trên tỉ rows
- **Kafka engine native** — không cần connector phụ (Kafka Connect Sink, custom consumer); table đọc thẳng từ topic
- Snowflake quá đắt cho thesis ($2/credit, cluster sleeping rules phức tạp)
- TimescaleDB tốt cho time-series nhưng kém hơn ở wide-aggregation queries (sum/group-by hàng triệu rows)
- Druid mạnh tương đương nhưng setup phức tạp + RAM-hungry hơn

### 7.3. Latency end-to-end bao nhiêu?

- p50 ~1.0s, p95 ~2.1s (đo thật từ PG commit đến CH `SELECT ... FINAL` thấy row)
- Đã tune `stream_flush_interval_ms` từ 7500ms default xuống 500ms trong `clickhouse/users.d/streaming.xml`
- Trade-off: flush nhanh hơn = CPU cao hơn, batch nhỏ hơn = compression ratio thấp hơn → storage tăng nhẹ
- Target thesis: < 5s — vượt xa

### 7.4. False positive rate?

- Synthetic data → không phản ánh production thực, cho nên em không quote precision/recall như một con số kết luận
- Threshold cho từng rule có visible trong UI và `clickhouse/queries/anomaly_*.sql` — đều là **dial** dễ tune
- Future work: thu thập 30 ngày unlabeled production data, semi-supervise gắn nhãn (analyst confirm/reject case), A/B test threshold

### 7.5. Scale thế nào? Nếu 10,000 TPS?

- Hiện tại sustained ~1500 TPS trên 1 Docker host (8 CPU, 16 GB RAM)
- Kafka horizontal scale: thêm partition trên topic `transactions` + scale broker
- ClickHouse horizontal: shard theo `account_id` hash, replica để fail-over
- **PG là bottleneck cuối** — cần read replicas + connection pooling (PgBouncer)
- Detection layer (fraud-worker) cần stateful sharding: mỗi worker quản 1 subset accounts

### 7.6. Nếu Kafka down thì sao?

- Debezium giữ replication slot trong PG → WAL không bị recycle, tích lũy chờ
- Kafka khôi phục → Debezium resume từ offset cuối cùng được commit
- Khoảng thời gian gián đoạn: `transactions FINAL` ở CH cũ ~thời gian downtime — alert delay tương ứng
- Production cần thêm: dead-letter queue cho message poison + alerting trên replication slot size

### 7.7. Nếu phải dùng ML thì sao?

- Hiện tại rule-based vì 2 lý do: **explainability** (analyst đọc được "Vì sao alert?") + **không có labeled training data**
- ML có thể overlay làm secondary scorer: isolation forest trên feature từ ClickHouse (txn velocity, hour-of-day, merchant risk), gradient boosting cho high-severity case
- Trade-off: ML mất explainability — cần SHAP hoặc rule extraction layer
- Architecture đã support: thêm column `ml_score` vào `fraud_alerts`, viết worker thứ hai consume cùng topic Kafka, không cần đổi schema chính

### 7.8. SAR / OFAC compliance?

- Out of thesis scope — đã nêu ở Act 6 limitations
- Bảng `fraud_alerts` đã có khung audit trail cơ bản (evidence JSONB, created_at, status, notes)
- SAR thresholds dễ thêm như rule mới — *"structuring detection"* là một SQL aggregation tương tự VELOCITY
- OFAC watchlist screening cần thêm 1 service (sanctions list refresh + name matching) — không thuộc CDC pipeline

### 7.9. Tại sao JSON mà không Avro?

- Schema evolution hiếm trong scope thesis (3 bảng nghiệp vụ + 1 case log, không thêm bớt column)
- JSON đơn giản, debug dễ — `docker exec kafka kafka-console-consumer` đọc được luôn, không cần schema registry
- Trade-off: contract không enforced ở compile-time, runtime errors có thể xảy ra nếu schema đổi không backward-compatible
- Production tier 1: dùng Avro + Schema Registry là hợp lý — em có ghi chú trong CLAUDE.md §8

### 7.10. Hệ thống production-ready không?

- **Không hoàn toàn** — limitations Act 6 nêu rõ
- Cần thêm cho production: TLS/mTLS giữa các service, OAuth proxy trước Grafana/UI, PITR backup cho PG, multi-region replication, monitoring + alerting đầy đủ (Prometheus + Alertmanager + PagerDuty)
- Hiện tại là **proof-of-concept** thesis chứng minh architecture works, có path rõ ràng để mature từng layer
- Code language English-only (CLAUDE.md §11.9), CI ready để thêm tests, observability đã có Prometheus scrape → vài tuần sprint là production-near

---

## 8. Phụ lục — Walkthrough chi tiết từng tab (reference)

Phần dưới đây giữ nguyên walkthrough chi tiết của bản tài liệu cũ. Người đọc chỉ vào đây khi muốn deep dive một tab cụ thể (cho lab tour, open-house demo, hoặc khi rehearse Act mới và cần biết chi tiết một widget). Trong defense 22 phút **không** đi tuần tự phần này.

### 8.0 Mở 8 tab trình duyệt (1 lần duy nhất — reference)

Mở 7 tab theo thứ tự dưới đây — sẽ chuyển qua lại trong lúc demo:

| Tab | URL | Đặt tên tab |
|---|---|---|
| 1 | http://localhost:3002 | **Dashboard** (đã tích hợp Pipeline Flow particle live ở trên cùng) |
| 2 | http://localhost:3002/demo | **Insert & trace** |
| 3 | http://localhost:3002/trace | **Trace** |
| 4 | http://localhost:3002/fraud | **Fraud rules** |
| 5 | http://localhost:3002/accounts | **Accounts** *(mới)* |
| 6 | http://localhost:3002/alerts | **Alerts** *(mới)* |
| 7 | http://localhost:3002/kafka | **Kafka** |

Trong NavBar trên cùng có sẵn 7 link tương ứng — có thể click trực tiếp thay vì gõ URL.

### 8.1 Tab "Dashboard" (http://localhost:3002) — màn hình chính

#### Cấu trúc trang

Từ trên xuống dưới:

```
┌─────────────────────────────────────────────────────────────┐
│ FinWatch · Real-Time Transaction Monitoring                 │
│ "live · polling every 1 s"   (dấu chấm xanh nhấp nháy)      │
├─────────────────────────────────────────────────────────────┤
│  Pipeline Flow panel                   │   Health KPIs      │
│  (PG → Debezium → Kafka → CH animated) │   - TPS now        │
│                                        │   - avg latency    │
│                                        │   - p95 latency    │
│                                        │   - total today    │
├─────────────────────────────────────────────────────────────┤
│  Demo controls — drive the pipeline from here               │
│  [6 fraud scenario buttons] [Drive normal load (200 txns)]  │
├─────────────────────────────────────────────────────────────┤
│  TPS Sparkline (60 giây gần nhất)                           │
├──────────────────────────┬──────────────────────────────────┤
│  Live transaction stream │  Alert feed (6 luật fraud)       │
└──────────────────────────┴──────────────────────────────────┘
```

#### Sinh tải nền — chỉ 1 click

Ở khối **Demo controls**, tìm nút màu xanh accent ở phía dưới:

> **`Drive normal load (200 txns)`**

Click 1 lần. Trong ~3–5 giây:
- Nút đổi sang `Driving load…`
- Dòng status hiển thị: `OK · 200 txns in 2.1s ≈ 95 TPS · TPS chart should rise within ~2 s`
- **TPS sparkline** ở giữa trang nhảy lên một spike.
- **Live transaction stream** (góc dưới-trái) bắt đầu có dòng `drive-load #1`, `drive-load #2`, ... đổ về.
- Trong **Pipeline Flow panel** ở trên cùng, các "hạt" nhấp nháy chạy từ PG → CH.

Có thể click lại nút này nhiều lần để spike lên cao hơn.

#### Tiêm 6 fraud scenarios — chỉ 1 click mỗi cái

Vẫn ở khối **Demo controls**, có 6 nút mầu sắc tương ứng mỗi luật. Phía trên mỗi nút là **rule badge** (chữ in hoa nhỏ), phía dưới là tên kịch bản:

| Nút | Rule | Câu chuyện hiển thị khi hover |
|---|---|---|
| `card-cloning` (đỏ rose) | VELOCITY | Skimmer: 15 micro-purchases liên tiếp |
| `wire-fraud` (cam) | LARGE_AMT | BEC: 1 transfer 250,000,000 VND |
| `fx-laundering` (vàng amber) | MULTI_CCY | Layering: 5 currencies trong 10 phút |
| `account-takeover` (tím violet) | ZSCORE | 20 txn baseline + 1 outlier 350M VND |
| `mule-account` (hồng pink) | HIGH_RISK | 4 routing qua merchant `risk_level=high` |
| `card-testing` (đỏ red) | FAIL_SPIKE | 6 failed + 1 completed |

**Khuyến nghị demo:** click lần lượt 3 nút đầu (`card-cloning`, `wire-fraud`, `fx-laundering`). Sau ~5 giây refresh dashboard — **Alert feed** (góc dưới-phải) sẽ có ngay các dòng:

```
VELOCITY   high   account abc…   20 txns, 60.3M VND in 5 min
LARGE_AMT  high   account def…   Single txn 250M VND
MULTI_CCY  med    account abc…   5 currencies in 10 min: EUR,JPY,USD,THB,VND
HIGH_RISK  high   account abc…   5 txns to high-risk merchant: CryptoExchange ABC
ZSCORE     med    account abc…   2 outliers (>=3σ)
FAIL_SPIKE high   account abc…   6 failed txns in 10 min
```

Có thể click 3 nút còn lại (`account-takeover`, `mule-account`, `card-testing`) để demo nốt 3 luật ZSCORE, HIGH_RISK, FAIL_SPIKE.

> **Nếu đã chạy `prepare_demo_full.py` tour mode** thì cả 6 luật đã firing sẵn — chỉ cần mở Alert feed là thấy 6 loại alert. Click button trong lúc demo vẫn ích lợi để khán giả thấy số count tăng realtime.

#### Quy ước hiển thị panel Pipeline Flow

Panel **Pipeline Flow** ở trên cùng Dashboard hiển thị **4 node** (PostgreSQL, Debezium, Kafka, ClickHouse) nối với nhau bằng các đường, và mỗi giao dịch là một **hạt sáng** chạy dọc đường nối.

> *Color = transaction type · size = amount · pulsing red glow = fraud-flagged (amount > 100M VND).*

| Yếu tố | Ý nghĩa |
|---|---|
| Màu hạt | Loại txn: purchase / transfer / withdrawal / deposit / refund |
| Kích thước hạt | Số tiền — txn lớn thì hạt to |
| Quầng đỏ pulsing | Tiền > 100M VND (cờ fraud rõ ràng) |
| Số ở mỗi node | EPM (events per minute) đếm realtime |

**Kịch bản show nhanh:** click `wire-fraud` (250M VND) trong khối Demo controls — trong vòng ~1 giây sẽ thấy một hạt **to + quầng đỏ pulsing** đi từ PG sang CH ngay trong cùng tab Dashboard. Click `Drive normal load (200 txns)` để thấy hàng chục hạt nhỏ chạy song song.

### 8.2 Tab "Insert & trace" (http://localhost:3002/demo) — tự tay drive pipeline

Đây là tính năng "showcase" lớn nhất — cho phép người demo **insert 1 giao dịch tay** rồi xem nó đi qua từng chặng có time-stamp.

#### Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Try sample fraud patterns                                   │
│  [Velocity (card-cloning)] [Large amount] [Multi-currency]   │
├─────────────────────────┬────────────────────────────────────┤
│  Insert transaction     │   Pipeline flow                    │
│  - Account dropdown     │   (với blue-ring highlight cho     │
│  - Merchant dropdown    │    row vừa insert)                 │
│  - Amount + Currency    │                                    │
│  - Type (radio)         │   ┌────────────────────────────┐   │
│  - Status (radio)       │   │  Propagation status        │   │
│  - Description          │   │  ✓ PostgreSQL commit   X ms│   │
│  - [Insert & Trace]     │   │  ✓ CDC propagation    X ms │   │
│                         │   │  ✓ ClickHouse visible X ms │   │
│                         │   └────────────────────────────┘   │
├─────────────────────────┴────────────────────────────────────┤
│  Per-hop trace (auto-mounts sau khi CH visible)              │
│  → mở rộng tracer với 4 stages có timestamp ISO + raw JSON   │
└──────────────────────────────────────────────────────────────┘
```

#### Kịch bản A — insert thường

1. Để dropdown **Account** và **Merchant** ở giá trị mặc định (UI tự chọn record đầu tiên khi load xong).
2. Field **Amount** đã có sẵn `150000`. Currency = `VND`. Type = `purchase`. Status = `completed`.
3. Description = `Demo from UI` (hoặc gõ message ý nghĩa cho khán giả).
4. Click nút **`Insert & Trace`** (màu xanh accent, full-width).
5. Quan sát:
   - Toast xanh: `Inserted abc12345… — waiting for CDC`
   - Khối **Propagation status** sáng dần: chấm dot đổi từ xám → vàng pulse (active) → xanh emerald (done).
   - Mỗi stage hiện ra số mili-giây.
   - Trong vòng ~1 giây, dòng cuối "ClickHouse visible" sáng xanh + toast cập nhật: `Visible in ClickHouse in 1023 ms`.
6. Phía dưới tự xuất hiện **Per-hop trace** với 4 stages:
   - 1. PostgreSQL commit — timestamp ISO + epoch ms
   - 2. Debezium captured — pgMs + 50 ms (estimated)
   - 3. Kafka available — pgMs + 200 ms (estimated)
   - 4. ClickHouse visible — measured từ `_ingested_at`
   - Giữa mỗi stage có **badge latency** (xanh nếu <1s, vàng <3s, đỏ ≥3s).
   - Total E2E hiển thị to ở góc phải.
7. Có thể click **Raw metadata (toggle)** để show JSON đầy đủ — copy ID dán vào slide.

#### Kịch bản B — insert fraud (high-risk merchant)

1. Mở dropdown **Merchant** — sẽ thấy một số merchant có hậu tố ` · HIGH RISK` (do `risk_level=high` trong PG).
2. Chọn merchant `CryptoExchange ABC · HIGH RISK` (hoặc bất kỳ entry có `HIGH RISK`).
3. Đổi **Amount** sang `120000000` (120 triệu VND — quá ngưỡng LARGE_AMT 100M).
4. Đổi **Type** sang `transfer`.
5. Click **`Insert & Trace`**.
6. Sau ~1 giây giao dịch hiện trên CH. Mở tab **Dashboard** — panel **Pipeline Flow** ở trên cùng sẽ thấy hạt to có quầng đỏ pulse, và Alert feed bên dưới có thêm dòng `LARGE_AMT high … Single txn 120M VND`.

#### Kịch bản C — preset fraud (3 click)

Khối **Try sample fraud patterns** ở trên cùng có sẵn 3 nút preset (mầu rose):

- **`Velocity (card-cloning)`** — 15 rapid micro-purchases
- **`Large amount (wire-fraud)`** — 250M VND single transfer
- **`Multi-currency (FX)`** — 5 currencies trong 10 phút

Click 3 nút này để inject fraud nhanh mà không cần điền form. Toast bên dưới sẽ hiện: `VELOCITY fired · 15 rows in 2.3s`.

### 8.3 Tab "Trace" (http://localhost:3002/trace) — tra cứu giao dịch bất kỳ

Trang này tách riêng tracer nguyên bản, dùng để **trace lại** một giao dịch đã insert trước đó (kể cả trong quá khứ).

#### Cấu trúc

| Khối | Nội dung |
|---|---|
| **Sidebar trái** | Ô tìm UUID + nút `Trace`, bên dưới là list "Recent 20" txn đang chảy |
| **Pane phải** | Hiển thị tracer 4 stages cho txn đang chọn |

#### Demo

1. Bên sidebar, list **Recent 20** tự refresh mỗi 2 giây — click vào bất kỳ dòng nào để show full trace bên phải.
2. Hoặc nếu đã có UUID (ví dụ từ tab **Insert & trace** đã copy), paste vào ô search → click nút **`Trace`**.
3. Pane phải hiện:
   - Header: UUID + nút **`copy`** + amount + type + status
   - **Total end-to-end** badge to: VD `1.05 s` (xanh nếu <1s, vàng <3s, đỏ ≥3s)
   - 4 stage cards với timestamp ISO và epoch ms
   - Latency badge giữa từng stage
   - Section **Raw metadata** thu/mở được

#### Mẹo trình bày

Sau khi insert một giao dịch ở tab `/demo`, copy UUID, sang `/trace` paste vào — khán giả thấy được tracer chuyên dụng (có sidebar list realtime) khác với tracer "inline" ở `/demo`.

### 8.4 Tab "Fraud rules" (http://localhost:3002/fraud) — 6 luật song song

Trang `/fraud` là **bằng chứng định lượng** rằng các luật anomaly thực sự đang chạy. 6 thẻ R1–R6 hiển thị song song:

| Card | Rule shortName | Ngưỡng (in trên card) |
|---|---|---|
| **R1** (rose) | Velocity burst (VELOCITY) | >10 txn hoặc >50M VND / 5 min |
| **R2** (violet) | Z-score statistical (ZSCORE) | |z| ≥ 3 vs baseline 30 ngày |
| **R3** (orange) | Large single amount (LARGE_AMT) | Single txn > 100M VND |
| **R4** (pink) | High-risk merchant (HIGH_RISK) | ≥3 txn tới merchant high-risk / 1h |
| **R5** (amber) | Multi-currency burst (MULTI_CCY) | >2 currencies trong 10 min |
| **R6** (red) | Failure spike (FAIL_SPIKE) | >5 failed status / 10 min |

#### Trên mỗi card có

- **Count number lớn**: số rows đang flag (tween animation khi đổi)
- **Sparkline 30 phút gần nhất**
- **Bảng rows flag** (truncated UUID còn 8 ký tự)
- **Source file** dẫn về `clickhouse/queries/anomaly_*.sql`
- **SQL** hiển thị (toggle xem)

#### Kịch bản show

1. Trước khi đến trang này, ở tab Dashboard click cả 6 scenario buttons.
2. Mở `/fraud`. Cả 6 card sáng lên với count >0 trong vòng 10s (refresh interval).
3. Chỉ vào R3 (LARGE_AMT) — số `1` hoặc `2` (do `wire-fraud` inject 1 row >100M).
4. Chỉ vào R5 (MULTI_CCY) — `1` (account ABC có 5 currencies).
5. R6 (FAIL_SPIKE) — `1` sau khi click `card-testing` (6 failed).

Đây là cách demo **không cần SQL** mà vẫn show được luật firing.

### 8.5 Tab "Accounts" (http://localhost:3002/accounts) — danh bạ + closed loop

Tab này là phần lớn nhất của bản update — biến demo từ "xem pipeline" thành "vận hành hệ thống fraud-ops" thực sự.

#### Trang danh bạ `/accounts`

```
┌──────────────────────────────────────────────────────────────┐
│  Accounts · directory                                        │
│  Search by name or email …  ────────────────  [10 accounts]  │
├──────────────────────────────────────────────────────────────┤
│  Name        Email                Balance    Status  24h    │
│  Nguyen V A  nguyenvana@…    20,882,923 VND  [active]  [1]  →
│  Tran T B    tranthib@…     120,000,000 VND  [active]  [0]  →
│  Le Van C    levanc@…         8,000,000 VND  [active]  [0]  →
│  ...                                                         │
└──────────────────────────────────────────────────────────────┘
```

- **Ô search** (debounce 300 ms): nhập `Nguyen` hoặc một phần email → bảng lọc realtime.
- Cột **Open alerts (24h)** đếm từ `fraud_alerts FINAL` (case mở trong 24h gần nhất). Số > 0 hiện màu vàng cảnh báo.
- Click **View →** ở cuối dòng → sang trang chi tiết.

#### Trang chi tiết `/accounts/[id]`

```
┌──────────────────────────────────────────────────────────────┐
│  ← Accounts                                                  │
│                                                              │
│  Nguyen Van A                              20,882,923 VND    │
│  nguyenvana@email.com · 0901234567         [active] [Suspend]│
│  c6699bb2-7163-487e-9b0e-40f747e063c1                        │
├────────────────────────────┬─────────────────────────────────┤
│  Recent transactions ·20   │  Alert history · 20             │
│  Time   Type  Merchant  …  │  Time   Rule       Sev  Cnt  …  │
│  09:39  purch VinMart …    │  09:39  VELOCITY   high  15     │
│  09:38  purch VinMart …    │  ─                              │
│  …                         │  …                              │
└────────────────────────────┴─────────────────────────────────┘
```

- **Status badge**: `active` (xanh), `suspended` (đỏ), `closed` (xám).
- Nút action thay đổi theo status: `Suspend` (đỏ) khi active, `Reactivate` (xanh) khi suspended, không có nút khi closed.
- **Recent transactions**: dòng `status=failed` hiện màu đỏ — phân biệt rõ ràng txn bị reject vs txn completed.
- **Alert history**: 20 case gần nhất của account này. Mỗi case kèm rule badge + severity badge.
- Cả 3 widget SWR refresh mỗi 5 giây.

#### Kịch bản closed-loop — đây là phần "wow"

Đây là bằng chứng FinWatch hoạt động như fraud-ops thực, không chỉ là CDC showcase:

1. Bên tab **Dashboard**, click `card-cloning` button (15 micro-purchases tới account ngẫu nhiên). Đợi worker tick (~30s) — hoặc sang tab Alerts (8.6) và refresh.
2. Quay lại tab **Accounts**, search account vừa bị tấn công (search bằng tên người Việt — `Do Van I`, `Vo Thi F`, ... — số `Open alerts (24h)` của một account sẽ = 1).
3. Click **View →**. Trang chi tiết hiện `VELOCITY high 15` trong Alert history.
4. Click nút **Suspend** (đỏ) → dialog confirm → OK.
5. Status badge chuyển sang `suspended` (đỏ) trong 1 giây. Trong cùng thời gian, **toàn bộ 3 đường insert** (generator/simulator/API) đều sẽ ghi txn `status='failed'` cho account này.
6. Để chứng minh, ở tab Dashboard click lại `card-cloning` — trong vòng vài giây trang chi tiết sẽ thêm 15 dòng `failed` (đỏ) với description `rejected: account suspended` vào panel **Recent transactions**.
7. Click **Reactivate** (xanh) → status quay về `active` → txn tiếp theo lại được `completed` (balance bị debit đúng số tiền).

> **Điểm cần nhấn mạnh:** không phải DB trigger — **ledger được áp dụng ở tầng application** (`/api/insert-transaction`, `scripts/generate_transactions.py`, `scripts/simulate_fraud.py`). Nhờ vậy simulator (insert trực tiếp vào PG bỏ qua API) vẫn tuân thủ cùng quy tắc — đây là invariant của bản thiết kế.

#### Bonus — balance ledger

Trong cùng kịch bản trên, để ý cột **Balance** trên trang danh bạ `/accounts`:

- Mỗi lần `Drive normal load` hoặc `card-cloning` chạy thành công → balance giảm xuống (purchase/withdrawal/transfer là debit).
- Khi insufficient funds (số dư < amount), txn lưu thành `status='failed'` với description `insufficient funds` — balance KHÔNG bị trừ.
- Sau `wire-fraud` (250M VND single transfer), nhiều account có balance < 250M sẽ tạo ra txn failed `insufficient funds` — nhưng luật `LARGE_AMT` vẫn flag vì rule filter theo amount, không theo status.

### 8.6 Tab "Alerts" (http://localhost:3002/alerts) — hàng đợi case persistent

Khác biệt căn bản với Alert feed ở Dashboard:

| | Alert feed (Dashboard) | /alerts queue |
|---|---|---|
| Nguồn | `transactions FINAL` (tính realtime) | `fraud_alerts FINAL` (case lưu trữ) |
| Tính chất | Transient — biến mất khi window trượt | Persistent — case còn mãi đến khi analyst close |
| Mục đích | Cảnh báo nhanh khi anomaly xuất hiện | Workflow xử lý case (assign / close fraud / close clean) |

#### Cấu trúc trang

```
┌──────────────────────────────────────────────────────────────┐
│  Alert queue · 3 cases                                       │
│                                                              │
│  Rule:     [All] [VELOCITY] [LARGE_AMT] [MULTI_CCY] [ZSCORE] [HIGH_RISK] [FAIL_SPIKE]
│  Severity: [All] [low] [medium] [high] [critical]            │
├──────────────────────────────────────────────────────────────┤
│  Time     Account     Rule      Sev   Cnt  Total       Stat │
│  09:41    Nguyen…→    HIGH_RISK med    4   29M VND     open │
│  09:41    Vo Thi F→   FAIL_SPIKE high   6   —          open │
│  09:39    Do Van I→   VELOCITY  high  15   45M VND     open │
└──────────────────────────────────────────────────────────────┘
```

#### Filter chip

- Click chip rule → URL có `?rule=VELOCITY` → bảng chỉ hiện case VELOCITY.
- Click chip severity → URL có `?severity=critical` → chỉ hiện case critical.
- Có thể kết hợp (`?rule=LARGE_AMT&severity=critical`) → cảnh báo nghiêm trọng cần xử lý ngay.
- Click lần nữa vào chip đang chọn → bỏ filter.

#### Tích hợp với /accounts

Cột **Account** trong bảng là link clickable → nhảy thẳng sang `/accounts/[id]` của tài khoản đó.

Workflow demo điển hình: ở `/alerts` lọc `critical` → thấy account `X` → click → trang chi tiết → click `Suspend`. Toàn bộ chu trình detect → action → reject trong 4 click.

### 8.7 Tab "Kafka" (http://localhost:3002/kafka) — Kafka topic browser tích hợp

Trang này thay thế công cụ `kafka-ui` bên ngoài.

#### Layout

```
┌─────────────────┬──────────────────────────────────────────┐
│  Sidebar topics │  Header: <topic name>   [Tabs]   [Live tail ☐]
│  (3 dòng)       │  ─────────────────────────────────────── │
│                 │  Tab nội dung (Messages / Consumers /    │
│                 │  Metadata)                               │
└─────────────────┴──────────────────────────────────────────┘
```

Sidebar list 4 topic CDC chính:
- `finwatch.public.accounts`
- `finwatch.public.merchants`
- `finwatch.public.transactions`
- `finwatch.public.fraud_alerts` *(mới — case log thông qua CDC)*

(Cộng với topic count + message count bên cạnh tên.)

#### 3 tab trong main pane

##### Tab **Messages**
- Mặc định hiển thị các message gần nhất của topic đang chọn.
- Tick checkbox **`Live tail (1 s)`** ở góc trên phải → message mới đổ về realtime.
- Mỗi row: partition, offset, timestamp, key (UUID), value (JSON envelope sau khi qua SMT `ExtractNewRecordState`).

##### Tab **Consumers**
- Hiện consumer group đang đọc topic (ClickHouse Kafka engine, Debezium nội bộ).
- Mỗi partition: `current offset`, `log end`, `lag`.
- Lag = 0 hoặc rất nhỏ → bằng chứng "ClickHouse consume kịp thời".

##### Tab **Metadata**
- Partitions: 1
- Replication factor: 1
- Bảng configs (cleanup.policy=delete, compression.type=producer, ...) — đánh dấu `default` hay `override`.

#### Kịch bản show "Kafka thực sự có data chảy qua"

1. Bên tab Dashboard, click `Drive normal load (200 txns)`.
2. Sang tab **Kafka**. Click topic `finwatch.public.transactions`. Tab Messages, bật **Live tail**.
3. Trong vài giây sẽ thấy danh sách message tăng nhanh (mỗi row là 1 transaction insert).
4. Chuyển sang tab **Consumers** — lag của ClickHouse consumer luôn ~0–5, không tăng → CH consume real-time.

### 8.8 Kịch bản demo 10 phút (tour mode reference)

> *Đây là kịch bản tour ngắn khi không dùng defense mode. Cho slot 10 phút lab demo / open-house. Defense mode dùng kịch bản 6-Act ở §3.*

> **Pre-condition:** đã chạy `python scripts\prepare_demo_full.py` (tour mode, KHÔNG có `--for-defense`) ở §2.2 → toàn bộ 6 luật đã firing sẵn, 22/22 endpoint warm.

| Phút | Tab | Hành động |
|---|---|---|
| 0–1 | Dashboard | Giới thiệu các widget. Click `Drive normal load (200 txns)`. Quan sát TPS spike + Live stream chạy. |
| 1–2 | Dashboard · Pipeline Flow | Vẫn ở tab Dashboard, quan sát panel **Pipeline Flow** trên cùng: hạt sáng chạy giữa các node, số EPM ở mỗi node nhảy. |
| 2–3 | Dashboard | Click 3 nút: `card-cloning`, `wire-fraud`, `fx-laundering`. Sau ~5s refresh Alert feed — 6 alert types xuất hiện. |
| 3–4 | Insert & trace | Demo Kịch bản B (insert 120M VND vào CryptoExchange ABC). Cho khán giả thấy 3 stage timeline + total latency ~1s. |
| 4–5 | Trace | Paste UUID vừa insert vào ô search → show tracer chuyên dụng + Raw metadata JSON. |
| 5–6 | Fraud rules | Show 6 card R1–R6 với count >0. Hover SQL toggle để show câu query thực sự. |
| 6–8 | **Accounts → Account detail** | **Phần "wow":** search account vừa bị card-cloning → View → Suspend → bên tab Dashboard click `card-cloning` lại → quay về tab account detail thấy 15 dòng `failed: rejected: account suspended` đỏ rực. Reactivate, hiển thị balance + status quay về `active`. |
| 8–9 | **Alerts** | Filter `critical` → một dòng → click account → trang chi tiết → click Suspend. Workflow 4 click hoàn chỉnh. |
| 9–10 | Kafka | Topic `finwatch.public.transactions` + `finwatch.public.fraud_alerts` + Live tail. Bằng chứng case log cũng chảy qua CDC như bảng nghiệp vụ. |

### 8.9 Troubleshooting (UI level — reference)

| Triệu chứng trên UI | Nguyên nhân & cách xử lý |
|---|---|
| Header NavBar 5xx error / trang trắng | Container `finwatch-web` chết. `docker compose logs web --tail 100` để xem stacktrace. |
| Dashboard load nhưng tất cả widget trống | API ClickHouse trả lỗi. Mở DevTools → tab Network → tìm response của `/api/health/summary` (kỳ vọng 200 + JSON). Nếu 500: connector hoặc CH có vấn đề. |
| Click `Drive normal load` → status hiện `Load error: …` | Backend `/api/load/start` không insert được vào PG. Check container `finwatch-postgres` healthy. |
| Bật `Live tail` ở Kafka nhưng không có message mới | Topic không có producer. Cần insert giao dịch hoặc click `Drive normal load` trước. |
| `/trace` show "Transaction not (yet) visible in ClickHouse" mãi không đổi | Connector RUNNING nhưng Kafka engine table không consume. Restart `finwatch-clickhouse`. |
| `/fraud` các card đều show count = 0 | Chưa inject fraud. Quay lại Dashboard, click ít nhất 1 fraud button. (Nếu đang ở defense mode thì đây là trạng thái kỳ vọng.) |
| `/alerts` đã có rows trước khi click button | Đã chạy `prepare_demo_full.py` **không có** `--for-defense`. Chạy lại với `--for-defense` để có clean state. |

**Tip:** mở Chrome DevTools (F12) → tab Network → filter `Fetch/XHR` để debug live. Mọi widget trên UI đều fetch từ `/api/...` mỗi 1–10 giây — nếu một widget treo, response code và body sẽ chỉ ra hỏng ở backend hay DB.

### 8.10 Toàn bộ API endpoint được dùng (tham khảo cho thesis)

Trong khi demo, UI gọi liên tục các endpoint sau (không cần nhớ — chỉ để giải thích nếu khán giả hỏi):

| Widget UI | Endpoint | Refresh |
|---|---|---|
| Health KPIs | `GET /api/health/summary` | 1s |
| TPS Sparkline | `GET /api/health/tps` | 1s |
| Live transaction stream | `GET /api/transactions/live` | 2s |
| Alert feed (Dashboard) | `GET /api/alerts/recent` | 5s |
| Pipeline Flow EPM counters | `GET /api/pipeline-stats` | 1s |
| Demo controls scenario list | `GET /api/scenarios/list` | 1× (on mount) |
| Demo controls scenario button | `POST /api/scenarios/run` (body: `{scenario: "..."}`) | on click |
| Drive load button | `POST /api/load/start` (body: `{count: 200}`) | on click |
| Insert & trace form | `POST /api/insert-transaction` | on click |
| Trace per-hop | `GET /api/transactions/{id}` | 5s |
| Fraud R1–R6 cards | `GET /api/fraud/r1`…`/r6` | 10s |
| Fraud sparkline history | `GET /api/fraud/history?rule=R1&minutes=30` | 30s |
| **Accounts list** | `GET /api/accounts/search?q=...` | 5s |
| **Account detail** | `GET /api/accounts/{id}` | 5s |
| **Account transactions** | `GET /api/accounts/{id}/transactions` | 5s |
| **Account alerts** | `GET /api/accounts/{id}/alerts` | 5s |
| **Suspend button** | `POST /api/accounts/{id}/lock` | on click |
| **Reactivate button** | `POST /api/accounts/{id}/unlock` | on click |
| **Alerts queue** | `GET /api/alerts?rule=...&severity=...` | 5s |
| Kafka sidebar | `GET /api/kafka/topics` | 30s |
| Kafka Messages tab | `GET /api/kafka/messages?topic=...` | 1s (when Live tail) |
| Kafka Consumers tab | `GET /api/kafka/consumers?topic=...` | 5s |
| Kafka Metadata tab | `GET /api/kafka/metadata?topic=...` | 1× |

Mọi gọi đều **read-only** trừ 5 endpoint POST (`/api/scenarios/run`, `/api/load/start`, `/api/insert-transaction`, `/api/accounts/{id}/lock`, `/api/accounts/{id}/unlock`) — đây là nơi UI thay đổi state ở PG.

---

Sau khi hoàn thành 6-Act ở §3 (22 phút), hội đồng đã thấy được:
- Vấn đề + giải pháp (Act 1)
- Pipeline E2E (PG → Debezium → Kafka → CH) hoạt động realtime, latency ~1 giây (Act 2)
- 6 luật fraud detection thực sự chạy trên dữ liệu live, từ trạng thái clean (Act 3)
- Closed-loop workflow nghiệp vụ (Act 4)
- Defensibility (latency + throughput trên Grafana) (Act 5)
- Em hiểu giới hạn của thesis + future work path (Act 6)
