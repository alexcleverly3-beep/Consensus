"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initIntelligence } = require("../src/intelligence");
const {
  createDiscoveryEngine,
  traderTokenEvidence,
} = require("../src/discovery-engine");

const WALLET_A = "11111111111111111111111111111111";
const WALLET_B = "22222222222222222222222222222222";
const TOKEN = "33333333333333333333333333333333";

function makeStore() {
  const db = new Database(":memory:");
  return { db, intelligence: initIntelligence(db) };
}

test("traderTokenEvidence recognises early profitable entries", () => {
  const evidence = traderTokenEvidence({
    realized_profit: 1200,
    unrealized_profit: 300,
    profit: 1500,
    profit_change: 1.4,
    buy_tx_count_cur: 2,
    sell_tx_count_cur: 1,
    start_holding_at: 10_900,
  }, {
    open_timestamp: 10_000,
  });

  assert.equal(evidence.isEarly, true);
  assert.equal(evidence.isProfitable, true);
  assert.equal(evidence.entryDelaySec, 900);
  assert.ok(evidence.tokenScore >= 70);
});

test("processToken saves free evidence before spending enrichment budget", async () => {
  const { db, intelligence } = makeStore();
  const fetched = [];
  const engine = createDiscoveryEngine({
    intelligence,
    maxFreshCalls: 1,
    maxEnrichments: 5,
    minTokenScore: 1,
    fetchWalletStats: async (wallet) => {
      fetched.push(wallet);
      return { wallet };
    },
  });

  const result = await engine.processToken({
    tokenAddress: TOKEN,
    tokenInfo: { open_timestamp: 10_000 },
    traders: [
      {
        address: WALLET_A,
        profit: 5000,
        profit_change: 2,
        realized_profit: 5000,
        start_holding_at: 10_200,
        buy_tx_count_cur: 1,
        sell_tx_count_cur: 1,
      },
      {
        address: WALLET_B,
        profit: 700,
        profit_change: 0.5,
        realized_profit: 700,
        start_holding_at: 12_000,
        buy_tx_count_cur: 2,
        sell_tx_count_cur: 1,
      },
    ],
  });

  assert.equal(result.candidates.length, 2);
  assert.equal(intelligence.getProfile(WALLET_A).observations, 1);
  assert.equal(intelligence.getProfile(WALLET_B).observations, 1);
  assert.equal(result.budget.freshCalls, 1);
  assert.equal(fetched.length, 1);
  db.close();
});

test("trusted wallets require evidence across at least four distinct tokens", async () => {
  const { db, intelligence } = makeStore();

  for (let i = 0; i < 2; i += 1) {
    intelligence.recordObservation({
      walletAddress: WALLET_A,
      tokenAddress: `${i + 70}`.repeat(32).slice(0, 32),
      source: "history",
      tokenScore: 98,
      profitChange: 3,
      entryDelaySec: 300,
      isEarly: true,
      isProfitable: true,
    });
  }

  const engine = createDiscoveryEngine({
    intelligence,
    minTokenScore: 1,
    minTrustedReputation: 1,
    minTrustedConfidence: 1,
    minConsensusWallets: 2,
  });

  const result = await engine.processToken({
    tokenAddress: TOKEN,
    tokenInfo: { open_timestamp: 1000 },
    traders: [
      { address: WALLET_A, profit: 5000, profit_change: 2, start_holding_at: 1200 },
    ],
  });

  assert.equal(intelligence.getProfile(WALLET_A).distinct_tokens, 3);
  assert.equal(result.trusted.length, 0);
  assert.equal(result.consensus, null);
  db.close();
});

test("known strong wallets are prioritised and can form consensus", async () => {
  const { db, intelligence } = makeStore();

  for (let i = 0; i < 8; i += 1) {
    intelligence.recordObservation({
      walletAddress: WALLET_A,
      tokenAddress: `${i + 10}`.repeat(32).slice(0, 32),
      source: "history",
      tokenScore: 90,
      profitChange: 1.2,
      entryDelaySec: 600,
      isEarly: true,
      isProfitable: true,
    });
    intelligence.recordObservation({
      walletAddress: WALLET_B,
      tokenAddress: `${i + 30}`.repeat(32).slice(0, 32),
      source: "history",
      tokenScore: 88,
      profitChange: 0.9,
      entryDelaySec: 900,
      isEarly: true,
      isProfitable: true,
    });
  }

  const engine = createDiscoveryEngine({
    intelligence,
    maxFreshCalls: 2,
    minTokenScore: 1,
    minTrustedReputation: 60,
    minTrustedConfidence: 40,
    minConsensusWallets: 2,
  });

  const result = await engine.processToken({
    tokenAddress: TOKEN,
    tokenInfo: { open_timestamp: 1000 },
    traders: [
      { address: WALLET_A, profit: 500, profit_change: 0.4, start_holding_at: 1300 },
      { address: WALLET_B, profit: 450, profit_change: 0.35, start_holding_at: 1400 },
    ],
  });

  assert.ok(result.consensus);
  assert.equal(result.consensus.walletCount, 2);
  assert.ok(result.consensus.wallets.every((wallet) => wallet.distinctTokens >= 4));
  assert.equal(result.candidates[0].profile.confidence_label !== "low", true);
  db.close();
});
