// TypeScript mirror of scripts/simulate_fraud.py. Lives in the Next.js server
// so demo controls can fire scenarios via HTTP without shelling out to Python.
//
// Each scenario INSERTs into postgres; CDC + ClickHouse + the alerts feed do
// the rest. Keep the inputs (counts, amounts) close enough to the Python
// version that pytest expectations still hold.

import { pg } from "./pg";

export type ScenarioName =
  | "card-cloning"
  | "wire-fraud"
  | "fx-laundering"
  | "account-takeover"
  | "mule-account"
  | "card-testing";

export interface ScenarioMeta {
  name: ScenarioName;
  rule: string;
  typology: string;
  story: string;
}

export const SCENARIOS: ScenarioMeta[] = [
  {
    name: "card-cloning",
    rule: "VELOCITY",
    typology: "Card cloning / skimmer",
    story:
      "Attacker cloned a card via a skimmer and races to drain the balance " +
      "with rapid micro-purchases before the issuer blocks it.",
  },
  {
    name: "wire-fraud",
    rule: "LARGE_AMT",
    typology: "Business Email Compromise",
    story:
      "BEC scam: attacker spoofs the CFO and instructs a single oversized " +
      "wire transfer to a controlled account.",
  },
  {
    name: "fx-laundering",
    rule: "MULTI_CCY",
    typology: "ML layering",
    story:
      "Money launderer fragments a sum across multiple currencies in rapid " +
      "succession to obscure the audit trail (the 'layering' stage).",
  },
  {
    name: "account-takeover",
    rule: "ZSCORE",
    typology: "Account takeover",
    story:
      "Attacker uses stolen credentials. Account's history is small recurring " +
      "txns; attacker drains it with one transfer 1000× the norm.",
  },
  {
    name: "mule-account",
    rule: "HIGH_RISK",
    typology: "Money muling",
    story:
      "Funds routed through a merchant flagged risk_level='high' (shell / " +
      "sanctions / known mule). Individual txn looks normal — the counter-party is the red flag.",
  },
  {
    name: "card-testing",
    rule: "FAIL_SPIKE",
    typology: "Stolen-card validation",
    story:
      "Attacker probes a batch of stolen card details; most charges fail " +
      "(declined / CVV mismatch). The failure-rate spike reveals the recon.",
  },
];

// ---------- helpers ----------

interface Ids { accountId: string; merchantId: string; merchantName: string }

async function randomAccount(): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    "SELECT id FROM accounts WHERE status='active' ORDER BY random() LIMIT 1",
  );
  if (!rows[0]) throw new Error("no active accounts");
  return rows[0].id;
}

async function randomMerchant(riskLevel?: "low" | "medium" | "high"): Promise<{ id: string; name: string }> {
  if (riskLevel) {
    const r = await pg.query<{ id: string; name: string }>(
      "SELECT id, name FROM merchants WHERE risk_level=$1 ORDER BY random() LIMIT 1",
      [riskLevel],
    );
    if (r.rows[0]) return r.rows[0];
  }
  const r = await pg.query<{ id: string; name: string }>(
    "SELECT id, name FROM merchants ORDER BY random() LIMIT 1",
  );
  if (!r.rows[0]) throw new Error("no merchants");
  return r.rows[0];
}

async function pickIds(riskLevel?: "low" | "medium" | "high"): Promise<Ids> {
  const accountId = await randomAccount();
  const m = await randomMerchant(riskLevel);
  return { accountId, merchantId: m.id, merchantName: m.name };
}

const randRange = (lo: number, hi: number) =>
  Math.round(lo + Math.random() * (hi - lo));

const insertTxn = async (
  accountId: string,
  merchantId: string,
  amount: number,
  currency: string,
  txnType: string,
  status: string,
  description: string,
  meta: Record<string, unknown>,
): Promise<string> => {
  const res = await pg.query<{ id: string }>(
    `INSERT INTO transactions
       (account_id, merchant_id, amount, currency, type, status, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [accountId, merchantId, amount, currency, txnType, status, description, meta],
  );
  return res.rows[0]!.id;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- scenario implementations ----------

export interface ScenarioResult {
  scenario: ScenarioName;
  rule: string;
  story: string;
  victim: string;          // account id (or "<mule-account>")
  rowsInserted: number;
  details: string;
  durationMs: number;
  sampleTxnId?: string;    // id of the first inserted row, for stage tracking
}

async function runCardCloning(count = 15): Promise<ScenarioResult> {
  const t0 = Date.now();
  const ids = await pickIds();
  let sampleTxnId: string | undefined;
  for (let i = 0; i < count; i++) {
    const id = await insertTxn(
      ids.accountId, ids.merchantId,
      randRange(800_000, 4_500_000),
      "VND", "purchase", "completed",
      `card-cloning #${i + 1}`,
      { fraud_type: "card_cloning", sequence: i + 1 },
    );
    if (i === 0) sampleTxnId = id;
    await sleep(150);
  }
  return {
    scenario: "card-cloning", rule: "VELOCITY",
    story: SCENARIOS[0].story, victim: ids.accountId, rowsInserted: count,
    details: `${count} rapid micro-purchases (target: VELOCITY rule)`,
    durationMs: Date.now() - t0,
    sampleTxnId,
  };
}

async function runWireFraud(amount = 250_000_000): Promise<ScenarioResult> {
  const t0 = Date.now();
  const ids = await pickIds();
  const sampleTxnId = await insertTxn(
    ids.accountId, ids.merchantId,
    amount, "VND", "transfer", "completed",
    "wire-fraud (BEC)",
    { fraud_type: "wire_fraud", amount },
  );
  return {
    scenario: "wire-fraud", rule: "LARGE_AMT",
    story: SCENARIOS[1].story, victim: ids.accountId, rowsInserted: 1,
    details: `single ${amount.toLocaleString()} VND wire to ${ids.merchantName} (target: LARGE_AMT)`,
    durationMs: Date.now() - t0,
    sampleTxnId,
  };
}

async function runFxLaundering(): Promise<ScenarioResult> {
  const t0 = Date.now();
  const ids = await pickIds();
  const currencies = ["VND", "USD", "EUR", "JPY", "THB"];
  let sampleTxnId: string | undefined;
  for (let i = 0; i < currencies.length; i++) {
    const id = await insertTxn(
      ids.accountId, ids.merchantId,
      randRange(500_000, 8_000_000),
      currencies[i]!, "purchase", "completed",
      `fx-laundering hop ${i + 1}/${currencies.length}`,
      { fraud_type: "fx_laundering", currency: currencies[i] },
    );
    if (i === 0) sampleTxnId = id;
    await sleep(300);
  }
  return {
    scenario: "fx-laundering", rule: "MULTI_CCY",
    story: SCENARIOS[2].story, victim: ids.accountId, rowsInserted: currencies.length,
    details: `${currencies.length} currencies (${currencies.join(", ")}) (target: MULTI_CCY)`,
    durationMs: Date.now() - t0,
    sampleTxnId,
  };
}

async function runAccountTakeover(): Promise<ScenarioResult> {
  const t0 = Date.now();
  const ids = await pickIds();
  const baselineN = 20;
  const baselineMean = 120_000;
  const outlier = 350_000_000;
  let sampleTxnId: string | undefined;
  for (let i = 0; i < baselineN; i++) {
    const id = await insertTxn(
      ids.accountId, ids.merchantId,
      baselineMean + randRange(-15_000, 15_000),
      "VND", "purchase", "completed",
      `ato-baseline ${i + 1}`,
      { fraud_type: "account_takeover_baseline" },
    );
    if (i === 0) sampleTxnId = id;
  }
  await insertTxn(
    ids.accountId, ids.merchantId,
    outlier, "VND", "transfer", "completed",
    "ato-outlier",
    { fraud_type: "account_takeover_outlier" },
  );
  return {
    scenario: "account-takeover", rule: "ZSCORE",
    story: SCENARIOS[3].story, victim: ids.accountId, rowsInserted: baselineN + 1,
    details: `${baselineN} baseline + 1 outlier (${outlier.toLocaleString()} VND) (target: ZSCORE)`,
    durationMs: Date.now() - t0,
    sampleTxnId,
  };
}

async function runMuleAccount(count = 4): Promise<ScenarioResult> {
  const t0 = Date.now();
  const ids = await pickIds("high");
  let sampleTxnId: string | undefined;
  for (let i = 0; i < count; i++) {
    const id = await insertTxn(
      ids.accountId, ids.merchantId,
      randRange(3_000_000, 12_000_000),
      "VND", "transfer", "completed",
      `mule routing ${i + 1}/${count}`,
      { fraud_type: "mule_account" },
    );
    if (i === 0) sampleTxnId = id;
    await sleep(200);
  }
  return {
    scenario: "mule-account", rule: "HIGH_RISK",
    story: SCENARIOS[4].story, victim: ids.accountId, rowsInserted: count,
    details: `${count} routings via ${ids.merchantName} (risk_level=high) (target: HIGH_RISK)`,
    durationMs: Date.now() - t0,
    sampleTxnId,
  };
}

async function runCardTesting(failedN = 6, completedN = 1): Promise<ScenarioResult> {
  const t0 = Date.now();
  const ids = await pickIds();
  let sampleTxnId: string | undefined;
  for (let i = 0; i < failedN; i++) {
    const id = await insertTxn(
      ids.accountId, ids.merchantId,
      randRange(50_000, 500_000),
      "VND", "purchase", "failed",
      `card-testing fail #${i + 1}`,
      { fraud_type: "card_testing", outcome: "failed" },
    );
    if (i === 0) sampleTxnId = id;
    await sleep(100);
  }
  for (let i = 0; i < completedN; i++) {
    await insertTxn(
      ids.accountId, ids.merchantId,
      randRange(50_000, 500_000),
      "VND", "purchase", "completed",
      `card-testing ok #${i + 1}`,
      { fraud_type: "card_testing", outcome: "completed" },
    );
    await sleep(100);
  }
  return {
    scenario: "card-testing", rule: "FAIL_SPIKE",
    story: SCENARIOS[5].story, victim: ids.accountId,
    rowsInserted: failedN + completedN,
    details: `${failedN} failed + ${completedN} completed (target: FAIL_SPIKE)`,
    durationMs: Date.now() - t0,
    sampleTxnId,
  };
}

const RUNNERS: Record<ScenarioName, () => Promise<ScenarioResult>> = {
  "card-cloning":     () => runCardCloning(),
  "wire-fraud":       () => runWireFraud(),
  "fx-laundering":    () => runFxLaundering(),
  "account-takeover": () => runAccountTakeover(),
  "mule-account":     () => runMuleAccount(),
  "card-testing":     () => runCardTesting(),
};

export function isScenarioName(s: string): s is ScenarioName {
  return s in RUNNERS;
}

export async function runScenario(name: ScenarioName): Promise<ScenarioResult> {
  return RUNNERS[name]();
}

// ---------- generic load generator ----------

export interface LoadResult {
  rowsInserted: number;
  tps: number;
  durationMs: number;
}

export async function driveLoad(count = 200): Promise<LoadResult> {
  const t0 = Date.now();
  // Pre-fetch active accounts and merchants once instead of per-row.
  const accs = await pg.query<{ id: string }>(
    "SELECT id FROM accounts WHERE status='active'",
  );
  const mer = await pg.query<{ id: string }>("SELECT id FROM merchants");
  if (!accs.rows.length || !mer.rows.length) throw new Error("no accounts/merchants");

  const types = ["purchase", "transfer", "withdrawal", "deposit", "refund"];
  for (let i = 0; i < count; i++) {
    const a = accs.rows[Math.floor(Math.random() * accs.rows.length)]!.id;
    const m = mer.rows[Math.floor(Math.random() * mer.rows.length)]!.id;
    const type = types[Math.floor(Math.random() * types.length)]!;
    await insertTxn(
      a, m, randRange(20_000, 5_000_000), "VND", type, "completed",
      `drive-load #${i + 1}`,
      { source: "demo_ui_load_button" },
    );
  }
  const durationMs = Date.now() - t0;
  return {
    rowsInserted: count,
    tps: Math.round((count / Math.max(durationMs, 1)) * 1000),
    durationMs,
  };
}
