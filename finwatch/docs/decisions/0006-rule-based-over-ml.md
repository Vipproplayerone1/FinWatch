# ADR-0006: Rule-based detection over ML

- **Status:** Accepted (with ML as documented future work)
- **Date:** 2026-04

## Context

The fraud-detection layer could use either explicit SQL rules (one query per pattern) or a trained ML model (gradient boosting, isolation forest, autoencoder, …). The thesis had to pick one as the primary approach within the available scope.

## Decision

Rule-based, SQL-only. Six rules in `finwatch/clickhouse/queries/anomaly_*.sql` covering velocity, z-score, large-amount, high-risk merchant, multi-currency, and failure-spike patterns.

ML is documented as future work (see L2.1 in `finwatch/docs/limitations.md`), not abandoned. The architecture explicitly supports an ML overlay.

## Consequences

**Positive:**
- **Explainability.** An analyst opening a case in `/alerts` sees exactly which threshold was crossed. There is no "the model decided" — the SQL is the explanation. For Vietnamese banking-compliance contexts, this is the *required* mode; an SBV inspector cannot accept a black-box model output as a SAR justification.
- **No labelled training data needed.** The thesis has only synthetic data; labelling that data for a supervised classifier would be tautological (we'd be training the model to recognise the same patterns we synthesized).
- **Threshold sweeps are cheap.** Tuning `100M VND` to `120M VND` is a constant change, not a retraining run.
- **Easy to evaluate.** `finwatch/scripts/evaluate_rules.py` produces a confusion matrix per rule against labelled synthetic data, reproducible with `--seed`. No model checkpoints, no GPU.

**Negative:**
- **Recall ceiling.** Rule-based detection caps at the patterns we thought to write. Novel fraud techniques (e.g. a previously-unseen layering structure) will not be caught.
- **Threshold drift.** Production environments evolve, and the thresholds shipped here would need periodic re-tuning. The architecture supports it; the thesis demo does not implement it.
- **Brittle to coordinated attacks.** A sophisticated attacker who knows the rules can craft a campaign that stays just below each threshold (an evasion pattern documented in each rule's header).

## ML overlay design (future work)

If ML is added later, the architecture supports it without changes to the OLTP path:

1. A second consumer service reads the same Kafka topic (`finwatch.public.transactions`).
2. It computes features (rolling stats per account, time-of-day, merchant risk score, …) using a feature store backed by ClickHouse.
3. It scores each transaction with a pre-trained model and writes the score to `fraud_alerts.ml_score` (column to be added).
4. The `/alerts` page surfaces both rule-based and ML-based scores; the analyst sees the union.
5. The ML score is a *re-ranker*, not a primary signal — every flagged case still has a rule explanation.

This design preserves explainability (rules are still the analyst-facing reason) while improving recall.

## Alternatives considered

- **ML-primary** (rejected): explainability gap is too large for thesis-grade compliance; also requires labelled training data the thesis does not have.
- **Hybrid where ML augments rules at the threshold-tuning stage**: viable but introduces complexity (the ML output influences the rule threshold) that doesn't fit the explicit-rules narrative.
- **Probabilistic rules** (e.g. Bayesian-network alarms): philosophically attractive but tooling support is limited; not within thesis time budget.

## References

- "Interpretable Machine Learning" (Molnar, 2022) — discussion of the explainability trade-off in regulated domains.
- `finwatch/docs/limitations.md` L2.1 — ML future-work statement.
