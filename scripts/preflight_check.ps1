# ==============================================================================
# FinWatch — Pre-flight check script (run 15-20 minutes before the demo)
# Purpose: verify the whole stack is ready before presenting to the committee.
# How to run: open PowerShell, cd into Graduate_Project, then:
#   powershell -ExecutionPolicy Bypass -File scripts\preflight_check.ps1
# ==============================================================================

$ErrorActionPreference = "Continue"
$pass = 0
$fail = 0
$warn = 0

function Step($name, $block) {
    Write-Host ""
    Write-Host "=== $name ===" -ForegroundColor Cyan
    try {
        & $block
    } catch {
        Write-Host "  [ERROR] $_" -ForegroundColor Red
        $script:fail++
    }
}

function Ok($msg)   { Write-Host "  [OK]   $msg" -ForegroundColor Green; $script:pass++ }
function Bad($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red;   $script:fail++ }
function Warn2($m)  { Write-Host "  [WARN] $m" -ForegroundColor Yellow;  $script:warn++ }

# 1. Docker daemon
Step "1. Docker daemon" {
    $v = docker version --format '{{.Server.Version}}' 2>$null
    if ($LASTEXITCODE -eq 0) { Ok "Docker Engine $v is running" } else { Bad "Docker Desktop is not started" }
}

# 2. Compose status — all 8 services must be Up
Step "2. Docker Compose services" {
    Push-Location finwatch
    $ps = docker compose ps --format json 2>$null | ConvertFrom-Json
    Pop-Location
    $expected = @("postgres","zookeeper","kafka","debezium","clickhouse","grafana","prometheus","web")
    foreach ($svc in $expected) {
        $found = $ps | Where-Object { $_.Service -eq $svc }
        if ($found -and $found.State -eq "running") { Ok "$svc : running ($($found.Status))" }
        elseif ($found) { Bad "$svc : $($found.State) - $($found.Status)" }
        else { Bad "$svc : container not found" }
    }
}

# 3. PostgreSQL — schema + logical WAL
Step "3. PostgreSQL (schema + WAL)" {
    $wal = docker exec finwatch-postgres psql -U finwatch -d finwatch -tAc "SHOW wal_level;" 2>$null
    if ($wal -eq "logical") { Ok "wal_level = logical" } else { Bad "wal_level = '$wal' (must be 'logical')" }

    $tables = docker exec finwatch-postgres psql -U finwatch -d finwatch -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public';" 2>$null
    if ([int]$tables -ge 3) { Ok "$tables tables in schema public (accounts, merchants, transactions)" }
    else { Bad "Only $tables tables found - schema may not be initialized" }

    $pub = docker exec finwatch-postgres psql -U finwatch -d finwatch -tAc "SELECT pubname FROM pg_publication WHERE pubname='finwatch_pub';" 2>$null
    if ($pub -eq "finwatch_pub") { Ok "publication finwatch_pub exists" } else { Bad "publication finwatch_pub is missing" }

    $slot = docker exec finwatch-postgres psql -U finwatch -d finwatch -tAc "SELECT slot_name FROM pg_replication_slots WHERE slot_name='finwatch_slot';" 2>$null
    if ($slot -eq "finwatch_slot") { Ok "replication slot finwatch_slot is active" } else { Warn2 "Slot missing - Debezium will create it on register" }
}

# 4. Debezium connector
Step "4. Debezium connector" {
    try {
        $status = Invoke-RestMethod -Uri "http://localhost:8083/connectors/finwatch-connector/status" -TimeoutSec 5
        if ($status.connector.state -eq "RUNNING") { Ok "connector.state = RUNNING" } else { Bad "connector.state = $($status.connector.state)" }
        $taskState = $status.tasks[0].state
        if ($taskState -eq "RUNNING") { Ok "tasks[0].state = RUNNING" } else { Bad "tasks[0].state = $taskState" }
    } catch {
        Bad "Cannot reach http://localhost:8083 - run: python scripts\wait_for_services.py"
    }
}

# 5. Kafka topics
Step "5. Kafka topics (created by Debezium)" {
    $topics = docker exec finwatch-kafka kafka-topics --bootstrap-server kafka:9092 --list 2>$null
    foreach ($t in @("finwatch.public.accounts","finwatch.public.merchants","finwatch.public.transactions")) {
        if ($topics -match [regex]::Escape($t)) { Ok "topic $t exists" } else { Bad "topic $t is missing" }
    }
}

# 6. ClickHouse — ping + snapshot
Step "6. ClickHouse" {
    try {
        $ping = Invoke-RestMethod -Uri "http://localhost:8123/ping" -TimeoutSec 5
        if ($ping -match "Ok") { Ok "HTTP /ping = Ok." } else { Bad "Ping returned: $ping" }
    } catch { Bad "Cannot reach ClickHouse HTTP 8123" }

    $merchants = docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.merchants FINAL WHERE cdc_op != 'd'" 2>$null
    if ([int]$merchants -ge 12) { Ok "merchants: $merchants rows (snapshot OK)" } else { Bad "merchants only has $merchants rows - snapshot did not run" }

    $accounts = docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.accounts FINAL WHERE cdc_op != 'd'" 2>$null
    if ([int]$accounts -ge 10) { Ok "accounts: $accounts rows" } else { Bad "accounts only has $accounts rows" }
}

# 7. End-to-end smoke test (insert 1 record in PG, read in CH)
Step "7. End-to-end smoke test (PG insert -> CH read)" {
    $marker = "preflight-$(Get-Date -UFormat %s)"
    $sql = @"
INSERT INTO transactions (account_id, merchant_id, amount, currency, type, status, description)
SELECT a.id, m.id, 99999.00, 'VND', 'purchase', 'completed', '$marker'
FROM accounts a, merchants m WHERE a.email='nguyenvana@email.com' AND m.name='VinMart' LIMIT 1;
"@
    docker exec finwatch-postgres psql -U finwatch -d finwatch -c $sql 2>&1 | Out-Null
    Write-Host "  -> inserted marker '$marker', waiting 8s..." -ForegroundColor Gray
    Start-Sleep -Seconds 8

    $found = docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.transactions FINAL WHERE description='$marker' AND cdc_op != 'd'" 2>$null
    if ([int]$found -eq 1) { Ok "End-to-end OK (PG -> Kafka -> CH < 8s)" } else { Bad "Marker did not appear in CH after 8s - check Debezium logs" }
}

# 8. Grafana & Prometheus
Step "8. Grafana / Prometheus" {
    try { $g = Invoke-RestMethod -Uri "http://localhost:3000/api/health" -TimeoutSec 5; Ok "Grafana: $($g.database) / version $($g.version)" }
    catch { Warn2 "Grafana 3000 not responding - may still be starting up" }

    try { $p = Invoke-WebRequest -Uri "http://localhost:9090/-/ready" -TimeoutSec 5; if ($p.StatusCode -eq 200) { Ok "Prometheus ready" } }
    catch { Warn2 "Prometheus 9090 not ready yet" }
}

# 9. FinWatch UI (internal Kafka browser lives at /kafka)
Step "9. FinWatch UI (http://localhost:3002)" {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:3002/api/health/summary" -TimeoutSec 5
        if ($r.StatusCode -eq 200) { Ok "UI /api/health/summary = 200" } else { Bad "UI returned $($r.StatusCode)" }
    } catch { Bad "Cannot reach http://localhost:3002 - check 'docker compose logs web'" }

    try {
        $r = Invoke-WebRequest -Uri "http://localhost:3002/api/kafka/topics" -TimeoutSec 5
        if ($r.StatusCode -eq 200) { Ok "Kafka browser /api/kafka/topics = 200" } else { Bad "kafka browser returned $($r.StatusCode)" }
    } catch { Bad "Internal Kafka browser unreachable" }
}

# Summary
Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "PRE-FLIGHT SUMMARY" -ForegroundColor Cyan
Write-Host "  PASS : $pass" -ForegroundColor Green
Write-Host "  WARN : $warn" -ForegroundColor Yellow
Write-Host "  FAIL : $fail" -ForegroundColor Red
Write-Host "================================================" -ForegroundColor Cyan

if ($fail -eq 0) {
    Write-Host "STACK READY FOR DEMO!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "FAILURES PRESENT - run 'docker compose logs <service>' to diagnose" -ForegroundColor Red
    exit 1
}
