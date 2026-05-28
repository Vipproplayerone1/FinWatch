# FinWatch — Hướng dẫn demo bằng UI (không cần terminal)

Tài liệu này hướng dẫn cách demo **toàn bộ** pipeline FinWatch chỉ bằng giao diện web tại **http://localhost:3002**. Mọi bước đều click bằng chuột — không cần mở PowerShell, không cần `docker exec`, không cần chạy script Python. Tất cả 6 luật fraud (VELOCITY, LARGE_AMT, MULTI_CCY, ZSCORE, HIGH_RISK, FAIL_SPIKE) được điều khiển từ trong UI.

**Phiên bản này thêm 2 trang mới: `/accounts` (danh bạ + lock/unlock) và `/alerts` (hàng đợi case)**, biến demo từ "pipeline showcase" thành "fraud-ops console" — analyst có thể click một nút để khoá account và thấy toàn bộ pipeline phản ứng trong ~1 giây.

> **Tiền đề duy nhất:** stack đã chạy (`docker compose up -d` đã được làm 1 lần). Sau đó toàn bộ demo dưới đây chỉ cần trình duyệt.

> **Khuyến nghị mạnh:** trước buổi demo, chạy **1 lệnh duy nhất** để hệ thống "no-warmup". Chọn 1 trong 2 chế độ:
>
> **Cho live defense (clean state — `/alerts` rỗng, click để xem alert sinh ra live):**
>
> ```powershell
> python finwatch\scripts\prepare_demo_full.py --start --for-defense
> ```
>
> Trong ~27 giây script sẽ: boot stack + register Debezium connector, verify snapshot, **seed 30 ngày baseline cho z-score**, drive 1500 txn live load **loại high-risk merchant** (không phát sinh false positive), **bỏ qua** inject 6 kịch bản fraud, **bỏ qua** tick worker, pre-warm UI + API. Khi mở `/fraud` cả 6 card đều `count=0`, `/alerts` rỗng — bạn click scenario buttons LIVE trong demo và hội đồng thấy alert đi từ 0 lên 1 real time.
>
> **Cho tour mode (mọi widget đã có data sẵn, demo dạng dạo cảnh):**
>
> ```powershell
> python finwatch\scripts\prepare_demo_full.py
> ```
>
> Bản tour sẽ **bắn cả 6 kịch bản fraud** (R1-R6 đều có count > 0 ngay khi mở `/fraud`) + tick worker để `/alerts` có sẵn case. Phù hợp cho buổi giới thiệu, không phù hợp cho live defense vì hội đồng không xem được transition "0 → 1".
>
> Xem chi tiết ở `scripts/prepare_demo_full.py`.

---

## 0. Mở 8 tab trình duyệt (1 lần duy nhất)

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

---

## 0.5. Chuẩn bị clean state cho buổi defense

Cho live defense, prepare stack ở trạng thái **không có alert nào sẵn** để khi mở `/alerts` panel rỗng → click scenario → alert hiện ra live (~1 s).

```powershell
python finwatch\scripts\prepare_demo_full.py --start --for-defense
```

Cờ `--for-defense` làm:

- Boot stack + đợi healthcheck (stages 1–5)
- Seed 30 ngày baseline cho ZSCORE history (stage 6)
- Drive normal load nhưng **loại high-risk merchant** → không phát sinh HIGH_RISK / ZSCORE / VELOCITY false positive
- **Skip** inject 6 kịch bản fraud (stage 8)
- **Skip** tick fraud_alert_worker (stage 10) → `fraud_alerts` trống
- Skip per-rule count>0 verification — clean state là kỳ vọng

Kết quả: dashboard render, TPS chart có data, `/alerts` rỗng, 6 fraud rule cards đều `count=0`. Click scenario buttons LIVE trong demo → hội đồng thấy alert đi từ 0 lên 1 real time.

Verify trước khi bắt đầu demo:

```powershell
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT count(*) FROM fraud_alerts"
# expect: 0
```

---

## 1. Tab "Dashboard" (http://localhost:3002) — màn hình chính

### 1.1 Cấu trúc trang

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

### 1.2 Sinh tải nền — chỉ 1 click

Ở khối **Demo controls**, tìm nút màu xanh accent ở phía dưới:

> **`Drive normal load (200 txns)`**

Click 1 lần. Trong ~3–5 giây:
- Nút đổi sang `Driving load…`
- Dòng status hiển thị: `OK · 200 txns in 2.1s ≈ 95 TPS · TPS chart should rise within ~2 s`
- **TPS sparkline** ở giữa trang nhảy lên một spike.
- **Live transaction stream** (góc dưới-trái) bắt đầu có dòng `drive-load #1`, `drive-load #2`, ... đổ về.
- Trong **Pipeline Flow panel** ở trên cùng, các "hạt" nhấp nháy chạy từ PG → CH.

Có thể click lại nút này nhiều lần để spike lên cao hơn.

### 1.3 Tiêm 6 fraud scenarios — chỉ 1 click mỗi cái

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

> **Nếu đã chạy `prepare_demo_full.py`** ở mục 8.1 thì cả 6 luật đã firing sẵn — chỉ cần mở Alert feed là thấy 6 loại alert. Click button trong lúc demo vẫn ích lợi để khán giả thấy số count tăng realtime.

---

### 1.4 Quy ước hiển thị panel Pipeline Flow

Panel **Pipeline Flow** ở trên cùng Dashboard hiển thị **4 node** (PostgreSQL, Debezium, Kafka, ClickHouse) nối với nhau bằng các đường, và mỗi giao dịch là một **hạt sáng** chạy dọc đường nối.

> *Color = transaction type · size = amount · pulsing red glow = fraud-flagged (amount > 100M VND).*

| Yếu tố | Ý nghĩa |
|---|---|
| Màu hạt | Loại txn: purchase / transfer / withdrawal / deposit / refund |
| Kích thước hạt | Số tiền — txn lớn thì hạt to |
| Quầng đỏ pulsing | Tiền > 100M VND (cờ fraud rõ ràng) |
| Số ở mỗi node | EPM (events per minute) đếm realtime |

**Kịch bản show nhanh:** click `wire-fraud` (250M VND) trong khối Demo controls — trong vòng ~1 giây sẽ thấy một hạt **to + quầng đỏ pulsing** đi từ PG sang CH ngay trong cùng tab Dashboard. Click `Drive normal load (200 txns)` để thấy hàng chục hạt nhỏ chạy song song.

---

## 2. Tab "Insert & trace" (http://localhost:3002/demo) — tự tay drive pipeline

Đây là tính năng "showcase" lớn nhất — cho phép người demo **insert 1 giao dịch tay** rồi xem nó đi qua từng chặng có time-stamp.

### 3.1 Layout

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
│  - [Insert & Trace]     │   │  ✓ Debezium captured  X ms │   │
│                         │   │  ✓ Kafka available    X ms │   │
│                         │   │  ✓ ClickHouse visible X ms │   │
│                         │   └────────────────────────────┘   │
├─────────────────────────┴────────────────────────────────────┤
│  Per-hop trace (auto-mounts sau khi CH visible)              │
│  → mở rộng tracer với 4 stages có timestamp ISO + raw JSON   │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Kịch bản A — insert thường

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

### 3.3 Kịch bản B — insert fraud (high-risk merchant)

1. Mở dropdown **Merchant** — sẽ thấy một số merchant có hậu tố ` · HIGH RISK` (do `risk_level=high` trong PG).
2. Chọn merchant `CryptoExchange ABC · HIGH RISK` (hoặc bất kỳ entry có `HIGH RISK`).
3. Đổi **Amount** sang `120000000` (120 triệu VND — quá ngưỡng LARGE_AMT 100M).
4. Đổi **Type** sang `transfer`.
5. Click **`Insert & Trace`**.
6. Sau ~1 giây giao dịch hiện trên CH. Mở tab **Dashboard** — panel **Pipeline Flow** ở trên cùng sẽ thấy hạt to có quầng đỏ pulse, và Alert feed bên dưới có thêm dòng `LARGE_AMT high … Single txn 120M VND`.

### 3.4 Kịch bản C — preset fraud (3 click)

Khối **Try sample fraud patterns** ở trên cùng có sẵn 3 nút preset (mầu rose):

- **`Velocity (card-cloning)`** — 15 rapid micro-purchases
- **`Large amount (wire-fraud)`** — 250M VND single transfer
- **`Multi-currency (FX)`** — 5 currencies trong 10 phút

Click 3 nút này để inject fraud nhanh mà không cần điền form. Toast bên dưới sẽ hiện: `VELOCITY fired · 15 rows in 2.3s`.

---

## 4. Tab "Trace" (http://localhost:3002/trace) — tra cứu giao dịch bất kỳ

Trang này tách riêng tracer nguyên bản, dùng để **trace lại** một giao dịch đã insert trước đó (kể cả trong quá khứ).

### 4.1 Cấu trúc

| Khối | Nội dung |
|---|---|
| **Sidebar trái** | Ô tìm UUID + nút `Trace`, bên dưới là list "Recent 20" txn đang chảy |
| **Pane phải** | Hiển thị tracer 4 stages cho txn đang chọn |

### 4.2 Demo

1. Bên sidebar, list **Recent 20** tự refresh mỗi 2 giây — click vào bất kỳ dòng nào để show full trace bên phải.
2. Hoặc nếu đã có UUID (ví dụ từ tab **Insert & trace** đã copy), paste vào ô search → click nút **`Trace`**.
3. Pane phải hiện:
   - Header: UUID + nút **`copy`** + amount + type + status
   - **Total end-to-end** badge to: VD `1.05 s` (xanh nếu <1s, vàng <3s, đỏ ≥3s)
   - 4 stage cards với timestamp ISO và epoch ms
   - Latency badge giữa từng stage
   - Section **Raw metadata** thu/mở được

### 4.3 Mẹo trình bày

Sau khi insert một giao dịch ở tab `/demo`, copy UUID, sang `/trace` paste vào — khán giả thấy được tracer chuyên dụng (có sidebar list realtime) khác với tracer "inline" ở `/demo`.

---

## 5. Tab "Fraud rules" (http://localhost:3002/fraud) — 6 luật song song

Trang `/fraud` là **bằng chứng định lượng** rằng các luật anomaly thực sự đang chạy. 6 thẻ R1–R6 hiển thị song song:

| Card | Rule shortName | Ngưỡng (in trên card) |
|---|---|---|
| **R1** (rose) | VELOCITY | >10 txn hoặc >50M VND / 5 min |
| **R2** (violet) | ZSCORE | |z| ≥ 3 vs baseline 30 ngày |
| **R3** (orange) | LARGE_AMT | Single txn > 100M VND |
| **R4** (pink) | HIGH_RISK | ≥3 txn tới merchant high-risk / 1h |
| **R5** (amber) | MULTI_CCY | >2 currencies trong 10 min |
| **R6** (red) | FAIL_SPIKE | >5 failed status / 10 min |

### 5.1 Trên mỗi card có

- **Count number lớn**: số rows đang flag (tween animation khi đổi)
- **Sparkline 30 phút gần nhất**
- **Bảng rows flag** (truncated UUID còn 8 ký tự)
- **Source file** dẫn về `clickhouse/queries/anomaly_*.sql`
- **SQL** hiển thị (toggle xem)

### 5.2 Kịch bản show

1. Trước khi đến trang này, ở tab Dashboard click cả 6 scenario buttons.
2. Mở `/fraud`. Cả 6 card sáng lên với count >0 trong vòng 10s (refresh interval).
3. Chỉ vào R3 (LARGE_AMT) — số `1` hoặc `2` (do `wire-fraud` inject 1 row >100M).
4. Chỉ vào R5 (MULTI_CCY) — `1` (account ABC có 5 currencies).
5. R6 (FAIL_SPIKE) — `1` sau khi click `card-testing` (6 failed).

Đây là cách demo **không cần SQL** mà vẫn show được luật firing.

---

## 5.5. Tab "Accounts" (http://localhost:3002/accounts) — danh bạ + closed loop

Tab này là phần lớn nhất của bản update — biến demo từ "xem pipeline" thành "vận hành hệ thống fraud-ops" thực sự.

### 5.5.1 Trang danh bạ `/accounts`

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

### 5.5.2 Trang chi tiết `/accounts/[id]`

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

### 5.5.3 Kịch bản closed-loop — đây là phần "wow"

Đây là bằng chứng FinWatch hoạt động như fraud-ops thực, không chỉ là CDC showcase:

1. Bên tab **Dashboard**, click `card-cloning` button (15 micro-purchases tới account ngẫu nhiên). Đợi worker tick (~30s) — hoặc sang tab Alerts (5.6) và refresh.
2. Quay lại tab **Accounts**, search account vừa bị tấn công (search bằng tên người Việt — `Do Van I`, `Vo Thi F`, ... — số `Open alerts (24h)` của một account sẽ = 1).
3. Click **View →**. Trang chi tiết hiện `VELOCITY high 15` trong Alert history.
4. Click nút **Suspend** (đỏ) → dialog confirm → OK.
5. Status badge chuyển sang `suspended` (đỏ) trong 1 giây. Trong cùng thời gian, **toàn bộ 3 đường insert** (generator/simulator/API) đều sẽ ghi txn `status='failed'` cho account này.
6. Để chứng minh, ở tab Dashboard click lại `card-cloning` — trong vòng vài giây trang chi tiết sẽ thêm 15 dòng `failed` (đỏ) với description `rejected: account suspended` vào panel **Recent transactions**.
7. Click **Reactivate** (xanh) → status quay về `active` → txn tiếp theo lại được `completed` (balance bị debit đúng số tiền).

> **Điểm cần nhấn mạnh:** không phải DB trigger — **ledger được áp dụng ở tầng application** (`/api/insert-transaction`, `scripts/generate_transactions.py`, `scripts/simulate_fraud.py`). Nhờ vậy simulator (insert trực tiếp vào PG bỏ qua API) vẫn tuân thủ cùng quy tắc — đây là invariant của bản thiết kế.

### 5.5.4 Bonus — balance ledger

Trong cùng kịch bản trên, để ý cột **Balance** trên trang danh bạ `/accounts`:

- Mỗi lần `Drive normal load` hoặc `card-cloning` chạy thành công → balance giảm xuống (purchase/withdrawal/transfer là debit).
- Khi insufficient funds (số dư < amount), txn lưu thành `status='failed'` với description `insufficient funds` — balance KHÔNG bị trừ.
- Sau `wire-fraud` (250M VND single transfer), nhiều account có balance < 250M sẽ tạo ra txn failed `insufficient funds` — nhưng luật `LARGE_AMT` vẫn flag vì rule filter theo amount, không theo status.

---

## 5.6. Tab "Alerts" (http://localhost:3002/alerts) — hàng đợi case persistent

Khác biệt căn bản với Alert feed ở Dashboard:

| | Alert feed (Dashboard) | /alerts queue |
|---|---|---|
| Nguồn | `transactions FINAL` (tính realtime) | `fraud_alerts FINAL` (case lưu trữ) |
| Tính chất | Transient — biến mất khi window trượt | Persistent — case còn mãi đến khi analyst close |
| Mục đích | Cảnh báo nhanh khi anomaly xuất hiện | Workflow xử lý case (assign / close fraud / close clean) |

### 5.6.1 Cấu trúc trang

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

### 5.6.2 Filter chip

- Click chip rule → URL có `?rule=VELOCITY` → bảng chỉ hiện case VELOCITY.
- Click chip severity → URL có `?severity=critical` → chỉ hiện case critical.
- Có thể kết hợp (`?rule=LARGE_AMT&severity=critical`) → cảnh báo nghiêm trọng cần xử lý ngay.
- Click lần nữa vào chip đang chọn → bỏ filter.

### 5.6.3 Tích hợp với /accounts

Cột **Account** trong bảng là link clickable → nhảy thẳng sang `/accounts/[id]` của tài khoản đó.

Workflow demo điển hình: ở `/alerts` lọc `critical` → thấy account `X` → click → trang chi tiết → click `Suspend`. Toàn bộ chu trình detect → action → reject trong 4 click.

---

## 6. Tab "Kafka" (http://localhost:3002/kafka) — Kafka topic browser tích hợp

Trang này thay thế công cụ `kafka-ui` bên ngoài.

### 6.1 Layout

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

### 6.2 3 tab trong main pane

#### Tab **Messages**
- Mặc định hiển thị các message gần nhất của topic đang chọn.
- Tick checkbox **`Live tail (1 s)`** ở góc trên phải → message mới đổ về realtime.
- Mỗi row: partition, offset, timestamp, key (UUID), value (JSON envelope sau khi qua SMT `ExtractNewRecordState`).

#### Tab **Consumers**
- Hiện consumer group đang đọc topic (ClickHouse Kafka engine, Debezium nội bộ).
- Mỗi partition: `current offset`, `log end`, `lag`.
- Lag = 0 hoặc rất nhỏ → bằng chứng "ClickHouse consume kịp thời".

#### Tab **Metadata**
- Partitions: 1
- Replication factor: 1
- Bảng configs (cleanup.policy=delete, compression.type=producer, ...) — đánh dấu `default` hay `override`.

### 6.3 Kịch bản show "Kafka thực sự có data chảy qua"

1. Bên tab Dashboard, click `Drive normal load (200 txns)`.
2. Sang tab **Kafka**. Click topic `finwatch.public.transactions`. Tab Messages, bật **Live tail**.
3. Trong vài giây sẽ thấy danh sách message tăng nhanh (mỗi row là 1 transaction insert).
4. Chuyển sang tab **Consumers** — lag của ClickHouse consumer luôn ~0–5, không tăng → CH consume real-time.

---

## 7. Kịch bản demo 10 phút (recommended)

> **Pre-condition:** đã chạy `python scripts\prepare_demo_full.py` ở mục 8.1 → toàn bộ 6 luật đã firing sẵn, 22/22 endpoint warm. Nếu chưa, đường thủ công ở 8.2 vẫn dùng được nhưng cần thêm ~2 phút khởi động.

| Phút | Tab | Hành động |
|---|---|---|
| 0–1 | Dashboard | Giới thiệu các widget. Click `Drive normal load (200 txns)`. Quan sát TPS spike + Live stream chạy. |
| 1–2 | Dashboard · Pipeline Flow | Vẫn ở tab Dashboard, quan sát panel **Pipeline Flow** trên cùng: hạt sáng chạy giữa các node, số EPM ở mỗi node nhảy. |
| 2–3 | Dashboard | Click 3 nút: `card-cloning`, `wire-fraud`, `fx-laundering`. Sau ~5s refresh Alert feed — 6 alert types xuất hiện. |
| 3–4 | Insert & trace | Demo Kịch bản B (insert 120M VND vào CryptoExchange ABC). Cho khán giả thấy 4 stage timeline + total latency ~1s. |
| 4–5 | Trace | Paste UUID vừa insert vào ô search → show tracer chuyên dụng + Raw metadata JSON. |
| 5–6 | Fraud rules | Show 6 card R1–R6 với count >0. Hover SQL toggle để show câu query thực sự. |
| 6–8 | **Accounts → Account detail** | **Phần "wow":** search account vừa bị card-cloning → View → Suspend → bên tab Dashboard click `card-cloning` lại → quay về tab account detail thấy 15 dòng `failed: rejected: account suspended` đỏ rực. Reactivate, hiển thị balance + status quay về `active`. |
| 8–9 | **Alerts** | Filter `critical` → một dòng → click account → trang chi tiết → click Suspend. Workflow 4 click hoàn chỉnh. |
| 9–10 | Kafka | Topic `finwatch.public.transactions` + `finwatch.public.fraud_alerts` + Live tail. Bằng chứng case log cũng chảy qua CDC như bảng nghiệp vụ. |

---

## 8. Checklist trước khi demo

Trước buổi demo 5 phút:

### 8.1 Đường tắt — 1 lệnh (khuyến nghị)

**Cho live defense (clean state):**

```powershell
python finwatch\scripts\prepare_demo_full.py --start --for-defense
```

Đợi ~27s. Khi banner cuối in `READY FOR LIVE DEFENSE DEMO (clean state)` + `HTTP probes 22/22`, hệ thống đã sẵn sàng. Mở http://localhost:3002 là demo được ngay — `/alerts` rỗng, 6 fraud cards `count=0`, click scenario buttons live để hội đồng thấy alert sinh ra.

**Cho tour mode (mọi widget có data sẵn):**

```powershell
python finwatch\scripts\prepare_demo_full.py
```

Đợi ~27s. Khi banner in `READY for COMPREHENSIVE DEMO` + `HTTP probes 22/22` + `Fraud rules firing 6/6`, hệ thống đã sẵn sàng. Phù hợp cho giới thiệu, không phù hợp cho live defense vì `/alerts` đã có case.

Flag hữu ích:
- `--start` → cũng chạy `docker compose up -d` trước
- `--for-defense` → clean state cho live defense (no fraud inject + tick + exclude high-risk merchants)
- `--no-baseline` → bỏ qua bước seed 30 ngày (nhanh hơn ~5s, nhưng R2 ZSCORE sẽ ít dữ liệu nền)
- `--evidence` → kèm chạy `collect_evidence.py` (tạo bundle cho thesis Chương 5)

### 8.2 Đường thủ công — 3 click UI

Nếu không muốn chạy script:

- [ ] Mở http://localhost:3002 → góc trên phải có chấm xanh emerald `live · polling every 1 s` (KHÔNG có banner đỏ).
- [ ] Khối **Health KPIs** ở góc trên phải hiển thị: `tps_now` ≥ 0, `total_today` > 0, `avg_latency_ms` không bị NaN.
- [ ] Click 1 lần `Drive normal load (200 txns)` — status hiện `OK · 200 txns in X.Xs ≈ Y TPS` trong 5 giây.
- [ ] (Tuỳ chọn) Click cả 6 fraud scenario buttons trên Demo controls để Alert feed có data trước.

Nếu cả 3 dòng trên ✅, hệ thống đã sẵn sàng demo qua UI. Đường tắt 8.1 đã làm tự động tất cả các bước này + thêm baseline + prewarm.

---

## 9. Troubleshooting (UI level)

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

---

## 10. Toàn bộ API endpoint được dùng (tham khảo cho thesis)

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

Sau khi hoàn thành tour này (8 phút), người xem đã thấy được:
- Pipeline E2E (PG → Debezium → Kafka → CH) hoạt động realtime, latency ~1 giây.
- 6 luật fraud detection thực sự chạy trên dữ liệu live.
- 3 cách inject fraud (button preset, form custom, raw load) — tất cả đều không rời UI.
- Bằng chứng quan sát được ở từng chặng (Pipeline Flow particles trên Dashboard, Per-hop trace, Kafka browser).
