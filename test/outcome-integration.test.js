"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initIntelligence } = require("../src/intelligence");
const { createDiscoveryEngine } = require("../src/discovery-engine");

const WALLET = "11111111111111111111111111111111";
const TOKEN = "33333333333333333333333333333333";

function trader() {
  return {
    address: WALLET,
    profit: 1500,
    realized_profit: 1500,
    profit_change: 1.2,
    buy_tx_count_cur: 1,
    sell_tx_count_cur: 1,
    start_holding_at: 1100,
  };
}

test("mature token outcome feeds back into wallet evidence without compounding rescans", async () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);
  const engine = createDiscoveryEngine({ intelligence, minTokenScore: 1 });

  await engine.processToken({
    tokenAddress: TOKEN,
    source: "autonomous",
    tokenInfo: {
      open_timestamp: 1000,
      price: 1,
      market_cap: 100000,
      liquidity: 50000,
    },
    traders: [trader()],
  });

  const rawBefore = db.prepare(
    "SELECT token_score, outcome_score FROM wallet_evidence WHERE wallet_address = ? AND token_address = ?"
  ).get(WALLET, TOKEN);
  assert.equal(rawBefore.outcome_score, null);

  db.prepare("UPDATE token_outcomes SET first_observed_at = ? WHERE token_address = ?")
    .run(Date.now() - 8 * 60 * 60 * 1000, TOKEN);

  const mature = await engine.processToken({
    tokenAddress: TOKEN,
    source: "autonomous",
    tokenInfo: {
      open_timestamp: 1000,
      price: 4,
      market_cap: 400000,
      liquidity: 80000,
    },
    traders: [trader()],
  });

  assert.equal(mature.tokenOutcome.outcome_status, "strong");
  assert.equal(mature.tokenOutcome.outcome_score, 85);
  assert.equal(mature.outcomeFeedback.updatedWallets, 1);

  const afterMature = db.prepare(
    "SELECT token_score, outcome_score FROM wallet_evidence WHERE wallet_address = ? AND token_address = ?"
  ).get(WALLET, TOKEN);
  assert.equal(afterMature.token_score, rawBefore.token_score);
  assert.equal(afterMature.outcome_score, 85);
  const reputationAfterMature = intelligence.getProfile(WALLET).reputation_score;

  await engine.processToken({
    tokenAddress: TOKEN,
    source: "autonomous",
    tokenInfo: {
      open_timestamp: 1000,
      price: 4,
      market_cap: 400000,
      liquidity: 80000,
    },
    traders: [trader()],
  });

  const afterRepeat = db.prepare(
    "SELECT token_score, outcome_score FROM wallet_evidence WHERE wallet_address = ? AND token_address = ?"
  ).get(WALLET, TOKEN);
  assert.equal(afterRepeat.token_score, rawBefore.token_score);
  assert.equal(afterRepeat.outcome_score, 85);
  assert.equal(intelligence.getProfile(WALLET).reputation_score, reputationAfterMature);
  db.close();
});
