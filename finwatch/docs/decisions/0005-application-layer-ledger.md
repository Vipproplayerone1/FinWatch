# ADR-0005: Balance and lock enforcement at the application layer

- **Status:** Accepted
- **Date:** 2026-05 (introduced when the fraud-workflow milestone added Suspend/Reactivate)

## Context

When the project added the closed-loop fraud workflow (Suspend account → next transaction is rejected by the pipeline), there were two viable places to enforce the balance and lock checks:

1. **Database trigger** — a `BEFORE INSERT` trigger on `transactions` that checks `accounts.balance` and `accounts.status`, rejecting or rewriting the row in-database.
2. **Application code** — every transaction-creating code path checks `accounts` itself, then inserts the appropriate row (completed / failed-rejected / failed-insufficient).

The system has three transaction-creating paths:
- `web/app/api/insert-transaction/route.ts` (the API endpoint, used by the UI)
- `finwatch/scripts/generate_transactions.py` (synthetic load generator)
- `finwatch/scripts/simulate_fraud.py` (fraud scenario simulator)

## Decision

Application-layer enforcement in all three paths. Each path:
1. Opens a transaction with `SELECT id, balance, status FROM accounts WHERE id=$1 FOR UPDATE`.
2. If `status != 'active'` → INSERT with `status='failed'`, `description='rejected: account <status>'`.
3. If `type IN (purchase, transfer, withdrawal)` and `balance < amount` → INSERT with `status='failed'`, `description='insufficient funds'`.
4. Otherwise → INSERT with `status='completed'`, UPDATE `accounts.balance` by `± amount`.
5. Commit the whole sequence atomically.

The Python helper for paths 2 and 3 is `_insert()` in `finwatch/scripts/simulate_fraud.py`. The TS implementation is in `web/app/api/insert-transaction/route.ts`. The script `scripts/generate_transactions.py` has its own copy of the same logic (`insert_with_ledger`).

This invariant is codified in `CLAUDE.md` §11 rule 10.

## Consequences

**Positive:**
- The `simulate_fraud.py` script can hit PostgreSQL directly (it does, for speed) and still obeys the same balance and lock rules as the API path. A trigger-based implementation would only catch the API path because triggers fire on INSERT regardless of source, but a trigger doesn't have access to the *intent* — was this a "completed" insert that we should downgrade, or a "failed" insert that we should leave alone? An attempted card-testing scenario explicitly inserts `status='failed'` rows; a balance-check trigger would have to second-guess that.
- The contract is visible in code that any developer reading the path will see, instead of hidden behind a `\df+` in psql.
- Easy to evolve: changing the rules (e.g. adding a per-merchant whitelist for suspended accounts) is a single function change, not a DDL change requiring downtime.

**Negative:**
- The rules live in **three** code locations and must be kept in sync. If the API gains a new rule but the simulator does not, behaviour diverges. Mitigated by the test suite covering the shared contract (planned in `tests/test_ledger.py` per audit item M4).
- A determined developer can bypass the rules by writing a fourth code path (e.g. `psql` insert during a demo). Discipline matters.

## Alternatives considered

- **Trigger** (rejected): cannot distinguish "intent: completed" from "intent: failed" for scenarios that legitimately need to record failures (card-testing, FAIL_SPIKE rule depends on this).
- **Stored procedure called from all paths** (rejected): adds round-trip overhead and forces every caller to use the procedure; the application code is clearer for thesis review.

## References

- CLAUDE.md §11 rule 10 — the codified invariant.
- `web/app/api/insert-transaction/route.ts` — TS reference implementation.
- `scripts/simulate_fraud.py::_insert` — Python reference implementation, shared with `evaluate_rules.py`.
