"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {
  initTokenOutcomes,
  classifyOutcome,
  normalizeTokenSnapshot,
  hasSnapshotData,
} = require("../src/token-outcomes");

test("normalizes common GMGN token fields", () => {
  assert.deepEqual(
    normalizeTokenSnapshot({ price_usd: "0.002", market_cap: "500000", liquidity_usd: "75000" }),
    { price: 0.002, marketCap: 500000, liquidity: 75000 }
  );
  assert.equal(hasSnapshotData({ symbol: "TOKEN" }), false);
  assert.equal(hasSnapshotData({ market_cap: "500000" }), true);
});

test("classifies a mature 3x token as strong", () => {
  const result = classifyOutcome({
    baseline: { price: 1, marketCap: 100000, liquidity: 50000 },
    current: { price: 3.2, marketCap: 320000, liquidity: 90000 },
    maxPrice: 3.5,
    ageMs: 12 * 60 * 60 * 1000,
  });
  assert.equal(result.status, "strong");
  assert.equal(result.score, 85);
  assert.ok(result.multiple >= 3);
});

test("classifies a collapsed token with drained liquidity as bad", () => {
  const result = classifyOutcome({
    baseline: { price: 1, marketCap: 100000, liquidity: 50000 },
    current: { price: 0.1, marketCap: 12000, liquidity: 5000 },
    maxPrice: 1.2,
    ageMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(result.status, "bad");
  assert.equal(result.score, 0);
});

test("persists baseline and later outcome without losing the original reference point", () => {
  const db = new Database(":memory:");
  const outcomes = initTokenOutcomes(db);
  const start = 1_700_000_000_000;

  outcomes.recordSnapshot({
    tokenAddress: "token-a",
    observedAt: start,
    tokenInfo: { price: 1, market_cap: 100000, liquidity: 50000 },
  });

  const row = outcomes.recordSnapshot({
    tokenAddress: "token-a",
    observedAt: start + 8 * 60 * 60 * 1000,
    tokenInfo: { price: 4, market_cap: 400000, liquidity: 80000 },
  });

  assert.equal(row.first_price, 1);
  assert.equal(row.current_price, 4);
  assert.equal(row.max_price, 4);
  assert.equal(row.snapshot_count, 2);
  assert.equal(row.outcome_status, "strong");
  assert.ok(row.best_multiple >= 4);
  db.close();
});

test("fills a missing baseline from the first later snapshot that contains market data", () => {
  const db = new Database(":memory:");
  const outcomes = initTokenOutcomes(db);
  const start = 1_700_000_000_000;

  outcomes.recordSnapshot({ tokenAddress: "token-sparse", observedAt: start, tokenInfo: {} });
  const row = outcomes.recordSnapshot({
    tokenAddress: "token-sparse",
    observedAt: start + 60 * 60 * 1000,
    tokenInfo: { price: 2, market_cap: 200000, liquidity: 60000 },
  });

  assert.equal(row.first_price, 2);
  assert.equal(row.first_market_cap, 200000);
  assert.equal(row.first_liquidity, 60000);
  assert.equal(row.outcome_status, "immature");
  db.close();
});
