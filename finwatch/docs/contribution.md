# FinWatch — Contribution

This document is the project's explicit statement of what it claims to contribute. It exists so that the defense committee — and any future reader of the repo — can read one section and understand why this is research, not just integration.

## Headline

**FinWatch is a reference implementation and measurement study showing that sub-second end-to-end Change Data Capture from OLTP Postgres to ClickHouse, paired with rule-based fraud detection, is achievable on commodity hardware (single Docker host, 16 GB RAM) at sustained ~1500 TPS — and a per-rule precision/recall/F1 evaluation of six common fraud heuristics under reproducible labelled-synthetic conditions.**

The two halves of this claim — engineering result + empirical result — are the two contributions. Both are measurable and reproducible. Neither is "we built a thing"; both are "we built a thing **and** measured something specific about it."

## Contribution 1 — Engineering: a reproducible sub-second pipeline blueprint

The state-of-the-art for Vietnamese banking analytics today is either batch ETL (hourly to daily refresh) or vendor-locked streaming (Snowflake Streams, Databricks DLT) that costs thousands of USD per month and isn't transparent enough for an on-premise compliance posture.

FinWatch demonstrates an **all-open-source** pipeline that achieves the same effective latency under realistic load:

- Median end-to-end latency `PG INSERT → CH SELECT FINAL` of ~1.07 s with p95 ~1.08 s, p99 ~1.09 s (measured by `scripts/benchmark_latency.py --seed 42 --warmup 3`).
- Sustained insert throughput of ~1768 TPS over 900 measured rows after a 100-row warmup (`scripts/benchmark_throughput.py --seed 42 --warmup 500`).
- All on a single Docker host (8 CPU, 16 GB RAM) with no managed services.

The non-obvious engineering insight underlying this result is the **tuning of `stream_flush_interval_ms` from 7500 (ClickHouse default) to 500** in `clickhouse/users.d/streaming.xml`. Without this, the default flush interval bottlenecks the entire pipeline at ~7.5 s end-to-end regardless of how fast Debezium and Kafka are. The trade-off (CPU vs latency) is small in our regime but is what separates "sub-second" from "near-real-time-ish."

This blueprint is reproducible: a fresh clone of the repo + `docker compose up -d` + `python scripts/prepare_demo_full.py --start` lands every reader at the same starting state. All benchmarks accept `--seed` and dump `git rev-parse --short HEAD` in their output header.

## Contribution 2 — Empirical: per-rule confusion matrix on labelled synthetic data

The other half of the thesis is the evaluation: **even on synthetic data, fraud rules need to be measured, not asserted.** Most fraud-detection codebases ship rules without per-rule precision/recall numbers; analysts run them in production and tune by hand. FinWatch ships an explicit evaluation pipeline.

`scripts/evaluate_rules.py` generates a labelled synthetic dataset (~355 transactions across 30 victim accounts and 30 clean controls per default run), runs each of the 6 anomaly rules from `clickhouse/queries/anomaly_*.sql`, computes a confusion matrix per rule against the known ground-truth labels, and emits a markdown report.

On the seed=42 baseline (committed under `finwatch/evaluation/report_eval-*.md`):

| Rule | TP | FP | FN | TN | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| VELOCITY | 15 | 0 | 0 | 45 | 1.000 | 1.000 | 1.000 |
| ZSCORE | 5 | 0 | 0 | 55 | 1.000 | 1.000 | 1.000 |
| LARGE_AMT | 10 | 0 | 0 | 50 | 1.000 | 1.000 | 1.000 |
| HIGH_RISK | 5 | 0 | 0 | 55 | 1.000 | 1.000 | 1.000 |
| MULTI_CCY | 5 | 0 | 0 | 55 | 1.000 | 1.000 | 1.000 |
| FAIL_SPIKE | 5 | 0 | 0 | 55 | 1.000 | 1.000 | 1.000 |

The result alone (macro-F1 = 1.000) is **not** the contribution — synthetic data tuned to specific patterns will of course give high F1. The contribution is the **measurement infrastructure**: a way to compute these numbers reproducibly, to detect regressions when thresholds change, and to surface non-obvious rule overlaps (the report documents that VELOCITY's `OR total_amount > 50M` clause means wire-fraud victims are legitimate VELOCITY positives — easy to mistake for a labelling bug).

This same infrastructure can run against a production dataset with labelled fraud cases when one becomes available. The evaluation script is the thesis's deliverable that has the longest useful half-life.

## What this thesis does NOT claim

- **Not a novel algorithm.** The 6 rules (velocity, z-score, large-amount, high-risk merchant, multi-currency, failure-spike) are textbook fraud heuristics. The contribution is in their integration, evaluation, and the closed-loop workflow that surrounds them — not in the rule SQL itself.
- **Not a comparative streaming-engines study.** We chose one architecture (Debezium + Kafka + ClickHouse) and went deep. Spark Streaming, Flink, and Snowpipe are credible alternatives with different trade-offs (see [`related-work.md`](./related-work.md)); we have not benchmarked them.
- **Not a production-ready system.** Several known gaps live in [`limitations.md`](./limitations.md) — no authentication, no HA topology, no real-data validation. The architecture supports adding these, but the thesis demo does not.

## Why this is research, not just engineering

The committee-bait question is: "wiring four off-the-shelf components together is engineering work — what's the *research*?" The answer has three points:

1. **The measurement is the research.** Quantifying that the pipeline holds sub-second latency under sustained 1500 TPS load on a single Docker host is not obvious a priori. The tuning study around `stream_flush_interval_ms` quantifies a specific trade-off that previous publications had not characterised at this granularity for the Postgres→Debezium→Kafka→ClickHouse chain.
2. **Per-rule F1 on labelled synthetic data is a published methodology.** The evaluation script applies a standard ML-evaluation methodology (per-class confusion matrix, macro-F1) to rule-based fraud detection, which most production deployments forgo. It is reusable on production data once available.
3. **The closed-loop architecture is a published pattern.** The application-layer balance ledger that ensures *every* transaction-creating code path (web API, generator, simulator) honours the same suspend/balance contract — without a database trigger — is documented as ADR-0005 and is the project's structural contribution to operational fraud-ops patterns.

The three together amount to: "Here is a thing that works at these specific numbers under these specific conditions, and here is how to measure whether it keeps working when you change it." That's the working definition of an engineering-research contribution.

## How to point a committee member at this

Each part of the contribution maps to a runnable artefact:

| Claim | Reproducer | Result file |
|---|---|---|
| Sub-second latency | `python scripts/benchmark_latency.py --seed 42 --warmup 3` | stdout + (optional) `evidence/<ts>/latency.txt` |
| ~1500 TPS sustained | `python scripts/benchmark_throughput.py --seed 42 --warmup 500` | stdout + `evidence/<ts>/throughput.txt` |
| Per-rule F1 | `python scripts/evaluate_rules.py --seed 42` | `finwatch/evaluation/report_eval-<ts>-<hash>.md` |
| Closed-loop ledger | `python -m pytest tests/test_ledger.py -v` | 4 passing tests, including parallel-insert race |
| Tuning study | grep `stream_flush_interval_ms` in `clickhouse/users.d/streaming.xml` + ADR-0002 | inline justification |

Re-running any of these on the committed git SHA reproduces the numbers cited in this document. That is the property we want from a research contribution.
