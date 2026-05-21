# Chapter 02 — PostgreSQL: the OLTP source

## Why this matters

Every byte of data in FinWatch starts as a row in Postgres. Before you can understand how CDC captures changes, you need to understand what's being changed: the transactions table, how it's structured, what rules Postgres enforces on every insert, and how Postgres stays fast and safe while thousands of writes hit it per second. This chapter gives you that foundation.

You'll learn what OLTP means, why Postgres is the right fit, how ACID guarantees make your money-moving code safe, and how the FinWatch schema is designed to balance correctness with speed. By the end you'll be connecting directly to the database with `psql`, reading and writing rows, and understanding every column in the `transactions` table.

---

## Theory

### What OLTP actually means

**OLTP** stands for *Online Transaction Processing*. It describes databases designed for workloads that look like this:

- Many concurrent users or services
- Each operation touches a small number of rows (often one)
- Mix of reads and writes, writes heavily present
- Every write must be correct *right now*, not eventually
- Response time measured in milliseconds

A payment app hits its database like this all day. User A tops up their wallet (one row updated). User B sends money to User C (two rows updated in one atomic step). User D queries their balance (one row read). Thousands of these per second, every single one must be correct.

Contrast with **OLAP** (*Online Analytical Processing*), which looks like:

- Few concurrent users (analysts, dashboards)
- Each query touches millions of rows
- Mostly reads — writes happen in bulk, infrequently
- Response time measured in seconds is often fine

ClickHouse, which you'll meet in chapter 06, is OLAP. Postgres is OLTP. You use both — each for what it's good at — and CDC moves data from one to the other.

### ACID — the four letters that let you build a bank

ACID is the promise Postgres makes to every transaction. Understanding it is understanding why Postgres is trustworthy.

**A — Atomicity.** Either all the changes in a transaction happen, or none of them do. If you `BEGIN; UPDATE accounts SET balance = balance - 100 WHERE id = A; UPDATE accounts SET balance = balance + 100 WHERE id = B; COMMIT;` and the power fails halfway through, Postgres guarantees neither update is applied. You don't lose $100 into the void.

**C — Consistency.** Every transaction takes the database from one valid state to another. Foreign keys, CHECK constraints, UNIQUE indexes — Postgres enforces all of them. If you try to insert a transaction with `status = 'weird'`, the constraint in the schema (`CHECK status IN ('pending', 'completed', 'failed', 'flagged')`) rejects it before it ever hits disk.

**I — Isolation.** Concurrent transactions don't see each other's incomplete state. If two users are moving money from the same account at the same time, Postgres serializes them (using MVCC — explained below) so the final state is what you'd get if they ran one after the other.

**D — Durability.** Once a transaction commits and Postgres says "OK", that change survives even if the server crashes one nanosecond later. This is guaranteed by the **Write-Ahead Log (WAL)** — which is exactly what chapter 03 is about. Remember the word *durability*. It's the bridge from this chapter to the next.

### MVCC in 90 seconds

*Multi-Version Concurrency Control* is how Postgres gives you Isolation without locking every row. When you UPDATE a row, Postgres doesn't overwrite the old version — it writes a new version next to the old one and marks the old one as "superseded at transaction X". Readers who started before transaction X still see the old version. Readers who start after see the new one. Eventually a background process called **VACUUM** removes the old, unreferenced versions.

Why you care: MVCC is why reads don't block writes and writes don't block reads. It's also why, in chapter 03, the WAL contains not just "UPDATE account A" but the full before-and-after row contents — and that's what Debezium reads.

### B-tree indexes — how Postgres finds a row fast

Without an index, `SELECT * FROM transactions WHERE account_id = 'some-uuid'` would scan all rows. With 100 million transactions that's slow. An index is a separate on-disk structure that maps column values to row locations. Postgres's default index is a **B-tree** — a balanced tree where each node holds sorted keys and pointers to children. Looking up a value is O(log n) — 100 million rows, about 27 comparisons.

FinWatch's schema creates B-tree indexes on every column you'll query a lot: `account_id`, `merchant_id`, `created_at`, `status`, `type`. Every index makes writes slightly slower (because the index also has to be updated) and reads dramatically faster.

Trade-off: only index what you'll query. Indexing every column wastes disk and slows writes without helping most queries.

### Triggers — side effects that run inside the database

A trigger is a stored function that runs automatically when something happens — before/after INSERT, UPDATE, DELETE. FinWatch uses triggers for one thing: auto-updating the `updated_at` column on every UPDATE. The alternative would be to remember to set `updated_at = NOW()` in every single query across your codebase, which nobody ever does consistently. A trigger makes it impossible to forget.

You'll see these triggers in the schema walkthrough below.

---

## How it's used in FinWatch

The whole schema lives in one file: `D:/Major/Graduate_Project/finwatch/postgres/init/01_init_schema.sql`. Open it in your editor alongside this chapter. We'll walk through it in order.

### The three tables

FinWatch has three tables:

```
accounts    ←  who owns money
merchants   ←  who money gets paid to
transactions  ←  individual money movements linking account → merchant
```

### `accounts` — the money owners

```sql
CREATE TABLE IF NOT EXISTS accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name       VARCHAR(255) NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    phone           VARCHAR(20),
    balance         DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    currency        VARCHAR(3) NOT NULL DEFAULT 'VND',
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'closed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Notable choices:

- **UUID primary keys, not integers.** Integer IDs leak information (your user ID #5 knows they signed up early; competitor can see exactly how many users you have by checking the latest ID). UUIDs don't. They're also safe to generate client-side without coordinating. `uuid_generate_v4()` needs the `uuid-ossp` extension, which the schema enables at the top.
- **`DECIMAL(18, 2)` for money.** Never use `FLOAT` or `DOUBLE` for currency. Floats lose precision: `0.1 + 0.2` is `0.30000000000000004` in float arithmetic. In a bank that's a lawsuit. `DECIMAL(18, 2)` means "up to 16 digits before the decimal, 2 after" — exact, always.
- **`TIMESTAMPTZ`, not `TIMESTAMP`.** The `TZ` variant stores times as UTC and knows which timezone they were inserted in. Your dashboards display times to users in Vietnam (UTC+7) while the DB stores UTC. Conversion is automatic. Always use `TIMESTAMPTZ` unless you have a very specific reason.
- **`CHECK` constraint on `status`.** Postgres refuses any value outside `active/suspended/closed`. The application layer also validates, but the CHECK is the last-line-of-defense. If your app has a bug that tries to write `'actiev'` (typo), the database rejects it.

### `merchants` — the money recipients

```sql
CREATE TABLE IF NOT EXISTS merchants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(255) NOT NULL,
    category        VARCHAR(100) NOT NULL,
    mcc_code        VARCHAR(4),
    risk_level      VARCHAR(20) NOT NULL DEFAULT 'low'
                    CHECK (risk_level IN ('low', 'medium', 'high')),
    country         VARCHAR(3) NOT NULL DEFAULT 'VN',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Note:

- **`mcc_code`** is the Merchant Category Code — an industry-standard 4-digit number classifying what kind of business this is. `5411` is grocery stores. `7995` is gambling. Regulatory systems and fraud rules use this.
- **`risk_level`** is a FinWatch-specific attribute. High-risk merchants (gambling, crypto) trigger stricter fraud monitoring later in the pipeline.

### `transactions` — the action

```sql
CREATE TABLE IF NOT EXISTS transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id      UUID NOT NULL REFERENCES accounts(id),
    merchant_id     UUID REFERENCES merchants(id),
    amount          DECIMAL(18, 2) NOT NULL,
    currency        VARCHAR(3) NOT NULL DEFAULT 'VND',
    type            VARCHAR(20) NOT NULL
                    CHECK (type IN ('purchase', 'transfer', 'withdrawal', 'refund', 'deposit')),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed', 'flagged')),
    description     TEXT,
    metadata        JSONB DEFAULT '{}',
    ip_address      VARCHAR(45),
    device_id       VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Notable:

- **Foreign keys.** `account_id REFERENCES accounts(id)` means you cannot insert a transaction whose `account_id` doesn't exist in `accounts`. Postgres enforces referential integrity. `merchant_id` has no `NOT NULL`, so a transaction can be merchant-less (a peer-to-peer transfer, for example).
- **`JSONB` metadata.** `JSONB` is a binary-encoded JSON type that supports indexing, querying, and efficient storage. It's the escape hatch for any extra data you don't want as a separate column: fraud flags, device fingerprints, A/B test buckets, etc. Use with caution — if you're putting everything in `metadata`, your schema is lying about its shape.
- **`ip_address VARCHAR(45)`.** Why 45? IPv6 addresses can be 39 characters (eight groups of four hex digits plus colons), plus up to 6 extra characters for IPv4-mapped notation. 45 is the safe maximum.
- **`device_id`.** For fraud detection — if the same `device_id` is doing transactions on 50 different `account_id`s, something smells.

### The indexes

```sql
CREATE INDEX idx_transactions_account_id ON transactions(account_id);
CREATE INDEX idx_transactions_merchant_id ON transactions(merchant_id);
CREATE INDEX idx_transactions_created_at ON transactions(created_at);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_accounts_status ON accounts(status);
CREATE INDEX idx_merchants_risk_level ON merchants(risk_level);
```

Each index answers one question quickly:

- `idx_transactions_account_id` — "show me everything this account did"
- `idx_transactions_created_at` — "show me transactions in this time range"
- `idx_transactions_status` — "show me failed transactions"
- And so on.

There's no index on `amount` because nobody queries "show me all transactions exactly equal to 12,345.67 VND". There's no index on `ip_address` because fraud queries on it are rare enough to be OK with a full scan.

### The `updated_at` trigger

```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_accounts_updated_at
    BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
-- (same for merchants and transactions)
```

What this does: before any UPDATE on any row in these three tables, Postgres sets `NEW.updated_at = NOW()`. The application never has to set `updated_at` manually. Every modification is automatically timestamped. This matters for CDC — downstream consumers can tell when a row last changed.

### The Debezium user and the publication

```sql
CREATE ROLE debezium WITH LOGIN PASSWORD 'debezium_secret_2024' REPLICATION;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO debezium;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO debezium;

CREATE PUBLICATION finwatch_pub FOR TABLE accounts, merchants, transactions;
```

This is the bridge to CDC — you don't need to understand it yet. Just know: a separate `debezium` user is created with `REPLICATION` privilege (this is key — it's what lets Debezium read the WAL), and a **publication** named `finwatch_pub` is declared over our three tables. Chapter 03 explains what a publication actually does.

### The seed data

The file ends with 12 merchants and 10 accounts pre-loaded. This is why the stack is interactive out of the box — you can immediately insert transactions against real accounts and merchants. `Nguyen Van A` through `Ngo Thi K` are your test accounts. `VinMart`, `Shopee Vietnam`, `Grab Vietnam`, etc. are your test merchants.

---

## Hands-on

### Step 1 — Connect to Postgres with `psql`

`psql` is the standard PostgreSQL command-line client. We'll run it inside the `finwatch-postgres` container so we don't need to install anything on the host:

```bash
docker exec -it finwatch-postgres psql -U finwatch -d finwatch
```

You should land in a prompt like:

```
psql (15.x)
Type "help" for help.

finwatch=#
```

The `=#` at the end means "ready for a command, connected as a superuser". If you see `=>` instead, you're connected as a non-superuser — that's fine.

### Step 2 — Explore the schema

At the `psql` prompt, list all tables:

```sql
\dt
```

Expected:

```
           List of relations
 Schema |     Name     | Type  |  Owner
--------+--------------+-------+----------
 public | accounts     | table | finwatch
 public | merchants    | table | finwatch
 public | transactions | table | finwatch
(3 rows)
```

Describe one table in detail:

```sql
\d transactions
```

You'll see every column, type, default, plus the primary key, foreign keys, indexes, and triggers. This is the single most useful `psql` command. Memorize it.

### Step 3 — Read the seed data

```sql
SELECT id, full_name, email, balance FROM accounts LIMIT 5;
```

Expected (UUIDs will be different on your machine — they're random):

```
                  id                  |   full_name   |         email          |   balance
--------------------------------------+---------------+------------------------+--------------
 b8f9c2a1-...                         | Nguyen Van A  | nguyenvana@email.com   | 50000000.00
 ...                                  | Tran Thi B    | tranthib@email.com     | 120000000.00
 ...                                  | Le Van C      | levanc@email.com       |   8000000.00
 ...                                  | Pham Thi D    | phamthid@email.com     | 250000000.00
 ...                                  | Hoang Van E   | hoangvane@email.com    |  15000000.00
```

And merchants:

```sql
SELECT name, category, risk_level FROM merchants ORDER BY risk_level DESC;
```

Expected:

```
        name         |   category    | risk_level
---------------------+---------------+------------
 Online Casino XYZ   | gambling      | high
 CryptoExchange ABC  | crypto        | high
 Shopee Vietnam      | e-commerce    | medium
 ...                 | ...           | ...
 VinMart             | grocery       | low
```

### Step 4 — Insert a transaction (by hand, using real IDs)

Postgres's foreign keys mean we can't just make up an `account_id` and a `merchant_id` — they have to exist. Use a sub-query to grab real IDs:

```sql
INSERT INTO transactions (account_id, merchant_id, amount, type, status, description)
SELECT
    (SELECT id FROM accounts WHERE email = 'nguyenvana@email.com'),
    (SELECT id FROM merchants WHERE name = 'VinMart'),
    125000.00,
    'purchase',
    'completed',
    'My first hand-rolled transaction';
```

Expected:

```
INSERT 0 1
```

The `1` is the number of rows affected. Confirm it landed:

```sql
SELECT id, amount, type, status, description, created_at
FROM transactions
WHERE description = 'My first hand-rolled transaction';
```

You should see one row. Note `created_at` was auto-filled by the `DEFAULT NOW()`. So was `updated_at`.

### Step 5 — Watch the `updated_at` trigger in action

Update the transaction's status:

```sql
UPDATE transactions
SET status = 'flagged'
WHERE description = 'My first hand-rolled transaction';

SELECT description, status, created_at, updated_at
FROM transactions
WHERE description = 'My first hand-rolled transaction';
```

`updated_at` is now *later* than `created_at`, even though you didn't set it yourself. The trigger did it. Write this on a sticky note: **triggers run on your behalf, silently, for every row touched.**

### Step 6 — Show ACID Atomicity

Open a transaction manually and show rollback:

```sql
BEGIN;

INSERT INTO accounts (full_name, email, balance)
VALUES ('Test User', 'test@example.com', 999.00);

-- You can see it within this transaction:
SELECT email, balance FROM accounts WHERE email = 'test@example.com';

-- But now roll back:
ROLLBACK;

-- And it's gone:
SELECT email, balance FROM accounts WHERE email = 'test@example.com';
```

The first `SELECT` shows one row. The second shows zero. Nothing ever hit the Debezium publication, because `ROLLBACK` means the transaction never happened from outside-the-connection's point of view.

This is Atomicity. If your application code raises an exception before `COMMIT`, Postgres quietly un-does everything.

### Step 7 — Show a CHECK constraint rejecting bad data

```sql
INSERT INTO transactions (account_id, merchant_id, amount, type, status)
SELECT
    (SELECT id FROM accounts LIMIT 1),
    (SELECT id FROM merchants LIMIT 1),
    100.00,
    'purchase',
    'weird_status';
```

Expected:

```
ERROR:  new row for relation "transactions" violates check constraint "transactions_status_check"
DETAIL:  Failing row contains (..., weird_status, ...).
```

The INSERT never happens. The database protects itself. Now repeat with a valid status to verify normal case works:

```sql
INSERT INTO transactions (account_id, merchant_id, amount, type, status)
SELECT
    (SELECT id FROM accounts LIMIT 1),
    (SELECT id FROM merchants LIMIT 1),
    100.00,
    'purchase',
    'completed';
```

`INSERT 0 1`. 

### Step 8 — Use an index (observe query plan)

Postgres's `EXPLAIN` shows how it'll execute a query:

```sql
EXPLAIN SELECT * FROM transactions WHERE status = 'flagged';
```

Expected (shape, not exact numbers):

```
 Bitmap Heap Scan on transactions  (cost=... rows=... width=...)
   Recheck Cond: ((status)::text = 'flagged'::text)
   ->  Bitmap Index Scan on idx_transactions_status  (cost=... rows=...)
         Index Cond: ((status)::text = 'flagged'::text)
```

The key line is `Index Scan on idx_transactions_status` — Postgres is using the index we created. If the line said `Seq Scan on transactions`, it would mean Postgres is reading every row (slow).

Now a query with no index on `description`:

```sql
EXPLAIN SELECT * FROM transactions WHERE description = 'No such description';
```

Expected:

```
 Seq Scan on transactions  (cost=... rows=...)
   Filter: (description = 'No such description'::text)
```

Sequential scan — no index can help, because we didn't create one on `description`. This is fine for rare ad-hoc queries but would be a disaster for hot queries. Lesson: indexes are what make OLTP fast.

### Step 9 — Exit psql cleanly

```sql
\q
```

You're back at your shell.

---

## Inspecting the database without psql

If you prefer a GUI, any Postgres client works — DBeaver, pgAdmin, DataGrip, TablePlus. Connect to:

- Host: `localhost`
- Port: `5432`
- Database: `finwatch`
- User: `finwatch`
- Password: `finwatch_secret_2024` (from `.env`)

---

## Checkpoints

1. Why does `amount` use `DECIMAL(18, 2)` and not `FLOAT`?
2. If two concurrent transactions both update User A's balance, what mechanism in Postgres makes sure one doesn't clobber the other?
3. What happens to `updated_at` if you `UPDATE` a transaction *without* mentioning `updated_at` in your query?
4. Why does the Debezium user have `REPLICATION` privilege but only `SELECT` on tables?

(Answers at the bottom.)

---

## Troubleshooting

**Problem:** `docker exec` gives "OCI runtime exec failed: container is not running".
**Cause:** `finwatch-postgres` isn't running. Check `docker compose ps`.
**Fix:** `docker compose up -d postgres` and wait for `(healthy)`.

---

**Problem:** You INSERT and the new row shows up in Postgres, but a live CDC consumer you have running in another terminal sees nothing.
**Cause:** Possible reasons — Debezium connector isn't running, or the transaction was rolled back, or you inserted into a table not in the publication.
**Fix:** Only `accounts`, `merchants`, `transactions` are in `finwatch_pub`. If you created your own table and INSERTed there, it won't flow to Kafka. Either add it to the publication (chapter 03) or stick to the three tables.

---

**Problem:** Schema on your running database has columns that aren't in `01_init_schema.sql` (e.g., you see a `risk_score` column in `transactions` but the file doesn't have it).
**Cause:** The schema has drifted. Someone applied an ALTER TABLE after the initial seed. The init script runs *only on first boot of a fresh volume*, so later changes don't re-run.
**Fix:** In a real project you'd use a migration tool like Flyway, Alembic, or Liquibase to version these changes. For learning, if you want to wipe and restart:

```bash
docker compose stop postgres
docker volume rm finwatch_postgres-data
docker compose up -d postgres
```

Your running schema will match the file again.

---

**Problem:** `psql: FATAL: password authentication failed for user "finwatch"`.
**Cause:** `.env` is out of sync with the Postgres data directory, which was initialized with a different password.
**Fix:** Either revert `.env` to the password that was in effect when Postgres first initialized (check `docker volume inspect finwatch_postgres-data`), or wipe and reinitialize as above.

---

## Where to go next

You now understand the data that's changing. In the next chapter you'll learn what Postgres writes to disk *every time* that data changes — the Write-Ahead Log — and how Debezium uses it to watch the database without slowing it down.

Next: **[Chapter 03 — WAL and logical replication](03-wal-and-logical-replication.md)**.

---

### Checkpoint answers

1. `FLOAT` and `DOUBLE` use binary floating-point — they cannot exactly represent most decimal fractions. `0.1 + 0.2` is `0.30000000000000004` in a float. For money, this is a bug. `DECIMAL(18, 2)` uses base-10 with exact precision.

2. **MVCC + row-level locking.** The first `UPDATE` to hit the row acquires a row-lock. The second transaction's `UPDATE` waits. When the first commits, its new row version is visible; the second's `UPDATE` re-reads and applies on top of it. No writes are lost. (There's also the Serializable isolation level for stricter guarantees, but default Read Committed already prevents lost updates on simple `UPDATE` statements.)

3. It gets set to `NOW()` automatically by the trigger `update_transactions_updated_at`. Even if you never mention it in your SQL.

4. `REPLICATION` is the privilege that allows connecting to Postgres's replication slot and reading the WAL stream. Without it, Debezium can't tail the log. `SELECT` on the tables is needed for the *initial snapshot* — when Debezium first starts, it reads the current rows once before switching to streaming WAL changes.
