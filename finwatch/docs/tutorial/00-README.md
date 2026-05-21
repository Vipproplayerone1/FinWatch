# FinWatch Tutorial — Learn the Full Pipeline

Welcome. This tutorial teaches you how FinWatch works by walking you through every stage of the pipeline, one chapter at a time. Each chapter mixes **theory** (what this piece is, why it exists, how it works under the hood) with **hands-on commands** you run against the real system.

By the end of this tutorial you will be able to:

- Explain how a row of data travels from a Postgres INSERT all the way to a Grafana dashboard
- Read and modify every configuration file in the project and know what each setting does
- Start, stop, and verify each stage of the pipeline independently
- Diagnose common failures at any stage

---

## The pipeline you will learn

```
 ┌───────────────┐     ┌────────────┐     ┌──────────┐     ┌────────────────────┐     ┌──────────────┐
 │  PostgreSQL   │ WAL │  Debezium  │Kafka│  Kafka   │ MV  │     ClickHouse     │ SQL │   Grafana    │
 │  (OLTP)       │────▶│  Connector │────▶│  Broker  │────▶│  (OLAP analytics)  │────▶│  dashboards  │
 │  transactions │     │  (CDC)     │     │  topics  │     │  ReplacingMergeTr. │     │              │
 └───────────────┘     └────────────┘     └──────────┘     └────────────────────┘     └──────────────┘
   Chapter 02 / 03        Chapter 04        Chapter 05          Chapter 06              Chapter 08
                                    ▲
                                    │
                            Chapter 07 ties it all together end-to-end
```

Each box is a stage. Each stage has its own data format, its own failure modes, and its own commands. You'll learn them one at a time.

---

## Chapter index

| # | Chapter | What you learn |
|---|---|---|
| 00 | [README](00-README.md) | This file — how to use the tutorial |
| 01 | [Overview and setup](01-overview-and-setup.md) | The big picture, Conda env, Docker Compose basics, bringing the stack up |
| 02 | [PostgreSQL: the OLTP source](02-postgres-oltp.md) | OLTP, ACID, MVCC, the FinWatch schema, `psql` basics |
| 03 | [WAL and logical replication](03-wal-and-logical-replication.md) | Write-Ahead Log, `pgoutput`, publications, replication slots, LSN |
| 04 | [Debezium and CDC](04-debezium-cdc.md) | Change Data Capture, Kafka Connect, the connector config, SMTs |
| 05 | [Kafka: the streaming backbone](05-kafka-streaming.md) | Topics, partitions, offsets, consumer groups, live CDC events |
| 06 | [ClickHouse: real-time analytics](06-clickhouse-analytics.md) | OLAP vs OLTP, columnar storage, Kafka Engine, Materialized Views, ReplacingMergeTree |
| 07 | [End-to-end verification](07-end-to-end-verification.md) | Trace one row through all stages, measure latency, test UPDATE and DELETE |
| 08 | [Dashboards: Grafana](08-dashboards-grafana.md) | Build your first real-time panel — auto-provisioned dashboards and how the queries map to ClickHouse |

---

## How each chapter is structured

Every chapter follows the same shape. Once you see it once, the rest will feel familiar:

1. **Why this matters** — one paragraph motivating the concept in FinWatch's context
2. **Theory** — the concepts, with diagrams where useful
3. **How it's used in FinWatch** — a line-by-line walkthrough of the real config file that implements this stage
4. **Hands-on** — numbered steps with exact commands and the output you should see
5. **Checkpoints** — 2–3 small exercises to verify you understand
6. **Troubleshooting** — things that commonly go wrong, and how to diagnose them

---

## Prerequisites

You should be comfortable with:

- Basic SQL (`SELECT`, `INSERT`, `WHERE`, `JOIN`)
- Using a terminal — `cd`, `ls`, piping, environment variables
- Docker basics — what a container is, what `docker ps` shows
- Python basics — you can read a script and understand `import`, functions, `pip install`

You do **not** need prior experience with:

- Kafka, Debezium, ClickHouse, or Grafana
- Change Data Capture as a concept
- OLAP databases
- Prometheus or JVM tuning

Everything you need to know about these is introduced in the chapters that use them.

---

## Required tools on your machine

Before chapter 01, make sure you have:

| Tool | Why | How to check |
|---|---|---|
| **Docker Desktop** | Runs every service in the pipeline | `docker --version` returns a version |
| **Docker Compose** | Brings the whole stack up | `docker compose version` returns a version |
| **Conda (Miniconda)** | Python environment for scripts | `conda --version` returns a version |
| **Git** | Optional, for tracking your own changes | `git --version` |
| A web browser | To view Grafana and the FinWatch web UI (Kafka browser, fraud rules, insert & trace, etc.) | Any modern browser |

If any of these is missing, install it before continuing. The project's root `claude.md` has the exact commands for setting up the Conda environment.

---

## How to work through this tutorial

There are three good ways to use this tutorial, depending on your goal:

### Mode 1: Learn from scratch (recommended)

Read every chapter in order, running every command yourself against the real stack. This takes 6–10 hours total. You'll understand every piece of the system.

### Mode 2: Deep-dive on one stage

If you already know the pipeline roughly but want to understand (say) ClickHouse Materialized Views, jump straight to chapter 06. Each chapter is self-contained enough that you can read it on its own — just note which earlier chapter it links back to for context.

### Mode 3: Reference while debugging

When something breaks, find the relevant chapter, skip to the **Troubleshooting** section, and use it as a cheat sheet. The commands there are the exact ones you'd run to diagnose problems in production.

---

## Keeping the stack running between chapters

This tutorial assumes you'll have the Docker stack up while reading. You don't need to keep everything running all the time — each chapter says explicitly which services it needs. For most of the tutorial, this subset is enough:

```bash
conda activate C:\ProgramData\miniconda3\envs\graduate_env
cd D:/Major/Graduate_Project/finwatch
docker compose up -d postgres zookeeper kafka debezium clickhouse
```

Chapter 08 (dashboards) additionally needs `grafana`.

To shut everything down without losing data:

```bash
docker compose down
```

To shut everything down **and wipe all volumes** (accounts, merchants, transactions, Kafka offsets — everything):

```bash
docker compose down -v
```

Use `-v` sparingly. It's the clean-slate reset.

---

## A note on paths

This project lives at `D:\Major\Graduate_Project\finwatch`. All relative paths in the tutorial are relative to that directory. When a chapter says "open `postgres/init/01_init_schema.sql`", it means `D:\Major\Graduate_Project\finwatch\postgres\init\01_init_schema.sql`.

Commands use bash syntax (forward slashes). If you're in PowerShell or CMD, adapt accordingly — or use Git Bash, which ships with Docker Desktop on Windows.

---

## Where to go next

Open **[chapter 01 — Overview and setup](01-overview-and-setup.md)** and start there. See you on the other side.
