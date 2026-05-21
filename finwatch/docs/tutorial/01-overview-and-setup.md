# Chapter 01 — Overview and Setup

## Why this matters

Before you touch any single piece of the pipeline, you need the whole thing sitting in front of you — running, healthy, and reachable. This chapter gets you from a cold laptop to a fully booted FinWatch stack you can poke at. By the end you'll be able to start the system, see every container green, and browse the web UIs that let you watch data move.

The reason we care about this first is simple: every chapter after this assumes the stack is up. If the stack is broken, the commands won't work and you won't learn anything. So we spend one chapter making absolutely sure the foundation is solid.

---

## The big picture

FinWatch solves one problem: **see financial transactions change in near real time**.

A bank or payment app like MoMo stores every transaction in a transactional database (Postgres, MySQL, Oracle). These databases are optimized for *writing* — a million small inserts and updates per day, each one correct and durable. They are **not** optimized for questions like "how many suspicious transactions did we see in the last five minutes?" If you run that kind of analytical query on the transactional database, you slow down real customers trying to pay for coffee.

The traditional fix is to copy data to an analytical database overnight. That introduces a 24-hour delay. In fraud detection, 24 hours is forever.

FinWatch's fix is to copy data to an analytical database **continuously**, with sub-second delay, without putting any load on the transactional database. The way it does that is the architecture you're about to learn.

Here's the whole thing in one picture:

```
  Your application
         │  (INSERT INTO transactions ...)
         ▼
  ┌─────────────────┐
  │   PostgreSQL    │  ← transactional database, OLTP
  │                 │
  │  WAL (Write-    │  ← Postgres writes every change to this log
  │   Ahead Log)    │     for crash recovery
  └────────┬────────┘
           │  streams via logical replication
           ▼
  ┌─────────────────┐
  │    Debezium     │  ← reads the WAL, converts each row change
  │    Connector    │     into a JSON event
  └────────┬────────┘
           │  produces events
           ▼
  ┌─────────────────┐
  │      Kafka      │  ← distributed event log
  │   (topics)      │     finwatch.public.transactions, etc.
  └────────┬────────┘
           │  consumed by
           ▼
  ┌─────────────────┐
  │   ClickHouse    │  ← analytical database, OLAP
  │  Kafka Engine   │     consumes events from Kafka
  │  Materialized   │     transforms them
  │      View       │     writes into
  │  ReplacingMer-  │     a merge-tree table for deduped analytics
  │   geTree table  │
  └────────┬────────┘
           │  queried by
           ▼
  ┌─────────────────┐
  │ Grafana / Meta- │  ← dashboards for operations and business
  │     base        │
  └─────────────────┘
```

Each arrow is a fault boundary. If Kafka goes down, Debezium buffers events locally until Kafka comes back. If ClickHouse goes down, Kafka holds events until ClickHouse catches up. No data is lost — this is called **loose coupling**.

You don't need to memorize this diagram. You just need to know the stages, roughly in order: Postgres → Debezium → Kafka → ClickHouse → dashboards.

---

## The services you'll run

`docker-compose.yml` at `D:/Major/Graduate_Project/finwatch/docker-compose.yml` defines 8 services. Here's what each one does:

| Service | Image | Purpose |
|---|---|---|
| `postgres` | `postgres:15-alpine` | The transactional source database. Stores `accounts`, `merchants`, `transactions`. |
| `zookeeper` | `confluentinc/cp-zookeeper:7.6.0` | Coordinates the Kafka broker (legacy Kafka needs it). |
| `kafka` | `confluentinc/cp-kafka:7.6.0` | The streaming backbone. Holds topics with CDC events. |
| `debezium` | `debezium/connect:2.5` | Kafka Connect worker with Debezium installed. Reads Postgres WAL. |
| `clickhouse` | `clickhouse/clickhouse-server:24.3-alpine` | The analytical database. Consumes from Kafka, stores rows for fast analytics. |
| `prometheus` | `prom/prometheus:v2.50.0` | Metrics collection for monitoring. |
| `grafana` | `grafana/grafana-oss:10.3.3` | Operations dashboards. |
| `web` | `node:20-alpine` (built locally) | FinWatch live demo UI (Next.js) — includes an internal Kafka topic browser at `/kafka`. |

That's a lot. You won't need all of them at once. For most of this tutorial we bring up just the subset we need.

---

## Hands-on: start the stack

### Step 1 — Activate the Conda environment

Every command that uses Python, `pip`, or project scripts **must** run inside the Conda environment. Activate it once per terminal:

```bash
conda activate C:\ProgramData\miniconda3\envs\graduate_env
```

Verify:

```bash
python --version
# Python 3.11.x
```

If Conda says "CommandNotFoundError" or the env doesn't exist, create it:

```bash
conda create -p C:\ProgramData\miniconda3\envs\graduate_env python=3.11 -y
conda activate C:\ProgramData\miniconda3\envs\graduate_env
```

### Step 2 — Make sure Docker is running

```bash
docker info --format "{{.ServerVersion}}"
```

You should see a version number like `28.3.3`. If you see "Cannot connect to the Docker daemon", start Docker Desktop and wait 30 seconds.

### Step 3 — Start the core services

For chapters 02 through 05 we need: Postgres, Zookeeper, Kafka, Debezium. Add the `web` service for visual inspection of topics via the internal Kafka browser at `/kafka` — far easier than `kafka-console-consumer`.

```bash
cd D:/Major/Graduate_Project/finwatch
docker compose up -d postgres zookeeper kafka debezium web
```

The `-d` flag means "detached" — containers run in the background. You can close the terminal and they keep running.

Expected output (order may vary):

```
 Container finwatch-zookeeper   Started
 Container finwatch-postgres    Started
 Container finwatch-kafka       Started
 Container finwatch-debezium    Started
 Container finwatch-web         Started
```

### Step 4 — Wait for them to be healthy

Postgres and Kafka have Docker health checks. Check status:

```bash
docker compose ps --format "table {{.Name}}\t{{.Status}}"
```

You want every service `Up` and, for ones with health checks, `(healthy)`. If Debezium is still `(health: starting)`, wait 30–60 seconds and check again — Debezium takes the longest because it must connect to both Kafka and Postgres before it reports healthy.

### Step 5 — Poke each service to confirm it responds

```bash
# Postgres
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT 1;"
# Expected: a row with "?column? = 1"

# Kafka
docker exec finwatch-kafka kafka-topics --bootstrap-server kafka:9092 --list
# Expected: some topic names (probably finwatch.public.* and _finwatch_connect_*)

# Debezium
curl -s http://localhost:8083/connectors
# Expected: ["finwatch-connector"] or [] if the connector hasn't been registered yet

# FinWatch Kafka browser (internal)
# Open http://localhost:3002/kafka in your browser — you should see the 3 finwatch.public.* topics
# in the sidebar. Click one to inspect messages, consumer lag, and topic config.
```

### Step 6 — Register the Debezium connector if it isn't already

If step 5 returned `[]` (empty array) from the Debezium endpoint, the CDC connector hasn't been registered yet. Register it using the helper script:

```bash
python scripts/wait_for_services.py
```

This script:

1. Waits for Debezium Connect to respond on port 8083
2. Reads `debezium/connectors/finwatch-connector.json`
3. POSTs it to Debezium to create (or update) the connector
4. Checks the connector state

Expected tail of the output:

```
✅ Connector 'finwatch-connector' registered successfully!
📊 Connector state: RUNNING
```

Chapter 04 explains what this script actually does in detail. For now, you just need the connector registered.

### Step 7 — Visual sanity check

Open a browser and visit:

- **FinWatch Kafka browser**: http://localhost:3002/kafka — sidebar lists `finwatch.public.accounts`, `finwatch.public.merchants`, `finwatch.public.transactions`. Click any topic to view recent messages, per-partition consumer lag, and topic configs.
- **Debezium REST**: http://localhost:8083/connectors/finwatch-connector/status — JSON response showing `"state": "RUNNING"`.

If both of these look right, your stack is up and CDC is flowing. You're ready for chapter 02.

---

## Understanding `docker-compose.yml` at a high level

You don't need to read the whole file yet — each chapter will walk you through the service it covers. But it helps to understand the shape. Open `docker-compose.yml` and note:

```yaml
services:
  postgres:   # each service is one container
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: ${POSTGRES_DB}    # variables come from .env
    ports:
      - "5432:5432"                  # host_port:container_port
    volumes:
      - postgres-data:/var/lib/postgresql/data   # named volume for persistence
      - ./postgres/init:/docker-entrypoint-initdb.d  # bind mount for init scripts
    healthcheck:
      test: [...]
    networks:
      - finwatch-net                 # all services share one Docker network
```

Four important patterns to notice:

1. **Environment variables come from `.env`** — passwords, ports, etc. Look in `.env` in the project root to see the values. This keeps secrets out of the compose file.
2. **Named volumes persist data** — `postgres-data:` at the top level declares a named volume. Your transactions survive `docker compose down`. They don't survive `docker compose down -v`.
3. **Bind mounts for config** — lines like `./postgres/init:/docker-entrypoint-initdb.d` tell Docker to mount a folder from your project into the container. That's how the Postgres init SQL script gets run on first boot.
4. **Shared network** — `finwatch-net` is a user-defined Docker network. Every container can reach every other container by service name: `postgres`, `kafka`, `debezium`. That's why `finwatch-connector.json` uses `"database.hostname": "postgres"` instead of an IP.

That's enough to follow the rest of the tutorial. Each later chapter will zoom in on the service it covers.

---

## What `.env` contains

Open `.env` at the project root. Lines you'll reference a lot:

```bash
POSTGRES_DB=finwatch
POSTGRES_USER=finwatch
POSTGRES_PASSWORD=finwatch_secret_2024
POSTGRES_PORT=5432

DEBEZIUM_USER=debezium
DEBEZIUM_PASSWORD=debezium_secret_2024

CLICKHOUSE_DB=finwatch
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=clickhouse_secret_2024
```

These are the credentials. You'll use `finwatch/finwatch_secret_2024` to connect to Postgres as the application user, and `default/clickhouse_secret_2024` for ClickHouse.

**This is a learning project** — in production, never put passwords in `.env` files committed to git. Use Docker secrets, Vault, or a cloud secret manager.

---

## Checkpoints

Answer these to be sure you understood the chapter:

1. What's the difference between OLTP and OLAP, and why does FinWatch use two different databases?
2. Why is `docker compose down -v` dangerous compared to `docker compose down`?
3. If Kafka becomes unreachable for 10 minutes, does FinWatch lose data? Why or why not?

(Answers at the bottom of the chapter.)

---

## Troubleshooting

**Problem:** `docker compose up` fails with "port is already allocated".
**Cause:** Something on your machine is already using 5432, 9092, 8083, 3002, or another port FinWatch needs. Common culprits: a local Postgres install or an old FinWatch container.
**Fix:** Either stop the other service, or change the port in `.env` (e.g., `POSTGRES_PORT=5433`) and restart. Docker only cares about the host-side of `host:container` port mappings; internal communication between containers uses the container-side ports.

---

**Problem:** `docker compose ps` shows Postgres as `unhealthy`.
**Cause:** Usually the init SQL (`postgres/init/01_init_schema.sql`) failed to run. Common reason: a syntax error, or the volume from a prior run has a different schema.
**Fix:**

```bash
docker compose logs postgres | tail -50
```

Read the error. If you want to reset Postgres from scratch:

```bash
docker compose down -v postgres
docker compose up -d postgres
```

Note: `down -v` wipes **all** named volumes, not just Postgres's. If you only want to wipe Postgres's volume, use:

```bash
docker compose stop postgres
docker volume rm finwatch_postgres-data
docker compose up -d postgres
```

---

**Problem:** Debezium shows `(health: starting)` forever.
**Cause:** Debezium can't reach Postgres or Kafka.
**Fix:**

```bash
docker compose logs debezium | tail -30
```

Look for lines like `Could not connect to Postgres` or `Bootstrap broker kafka:9092 disconnected`. Usually the fix is to restart Debezium after Postgres/Kafka finished starting:

```bash
docker compose restart debezium
```

---

## Where to go next

With the stack healthy, you're ready to open up Postgres and understand what it is, why it's the right store for transactions, and how the FinWatch schema is designed.

Next: **[Chapter 02 — PostgreSQL: the OLTP source](02-postgres-oltp.md)**.

---

### Checkpoint answers

1. **OLTP** (Online Transaction Processing) databases are optimized for many small writes — individual transactions must be correct, durable, and fast. **OLAP** (Online Analytical Processing) databases are optimized for large reads over many rows — aggregations, joins, grouping over millions of records. Using one for the other causes problems: running an analytical query on Postgres during peak traffic can slow your customers down; writing individual transactions into ClickHouse is very slow because ClickHouse is columnar. FinWatch uses each for what it's good at, and CDC to move data between them.

2. `docker compose down` stops containers but **keeps named volumes**, so your data persists across restarts. `docker compose down -v` additionally **deletes all named volumes**, so your database contents, Kafka topics, ClickHouse tables, and Grafana dashboards are all wiped. Use `-v` only when you explicitly want a clean slate.

3. **No, FinWatch does not lose data** when Kafka is down. Debezium's Kafka Connect worker buffers events in memory and tracks its position in the Postgres WAL via a replication slot. When Kafka comes back, Debezium resumes from where it left off. This is the point of using Kafka as a buffer: the source and sink don't have to be up at the same time. (There is a catch: if Postgres's WAL fills up because Debezium isn't advancing its slot, Postgres itself can fail — chapter 03 covers this.)
