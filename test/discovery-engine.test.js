"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initIntelligence } = require("../src/intelligence");
const {
  createDiscoveryEngine,
  defaultTraderFilter,
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
    end_holding_at: 14_500,
  }, {
    open_timestamp: 10_000,
  });

  assert.equal(evidence.isEarly, true);
  assert.equal(evidence.isProfitable, true);
  assert.equal(evidence.entryDelaySec, 900);
  assert.equal(evidence.holdSec, 3600);
  assert.equal(evidence.profitChange, 1.4);
  assert.ok(evidence.tokenScore >= 70);
});

test("new evidence no longer treats six-hour entries or tiny green trades as strong wins", () => {
  const late = traderTokenEvidence({
    profit: 5000,
    profit_change: 1.2,
    start_holding_at: 10_000 + 3 * 60 * 60,
  }, { open_timestamp: 10_000 });
  assert.equal(late.isEarly, false);

  const tinyWin = traderTokenEvidence({
    profit: 500,
    profit_change: 0.10,
    start_holding_at: 10_300,
  }, { open_timestamp: 10_000 });
  assert.equal(tinyWin.isEarly, true);
  assert.equal(tinyWin.isProfitable, false);
});

test("default trader filter rejects extreme single-token churn even without a bot tag", () => {
  assert.equal(defaultTraderFilter({
    address: WALLET_A,
    buy_tx_count_cur: 45,
    sell_tx_count_cur: 35,
  }), "high-frequency-trading");

  assert.equal(defaultTraderFilter({
    address: WALLET_A,
    buy_tx_count_cur: 12,
    sell_tx_count_cur: 10,
  }), null);

  assert.equal(defaultTraderFilter({
    address: WALLET_A,
    transfer_in: "1",
    buy_tx_count_cur: 2,
  }), "transfer-funded");
});

test("processToken does not persist high-frequency bot-like wallets as evidence", async () => {
  const { db, intelligence } = makeStore();
  const engine = createDiscoveryEngine({ intelligence, minTokenScore: 1 });

  const result = await engine.processToken({
    tokenAddress: TOKEN,
    tokenInfo: { open_timestamp: 1000 },
    traders: [{
      address: WALLET_A,
      profit: 50_000,
      profit_change: 5,
      realized_profit: 50_000,
      start_holding_at: 1100,
      buy_tx_count_cur: 60,
      sell_tx_count_cur: 40,
    }],
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0].reason, "high-frequency-trading");
  assert.equal(intelligence.getProfile(WALLET_A), null);
  db.close();
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

test("duplicate trader rows cannot inflate distinct-wallet consensus", async () => {
  const { db, intelligence } = makeStore();

  for (let i = 0; i < 12; i += 1) {
    const tokenAddress = `${i + 90}`.repeat(32).slice(0, 32);
    intelligence.recordObservation({
      walletAddress: WALLET_A,
      tokenAddress,
      source: "history",
      tokenScore: 95,
      profitChange: 1.5,
      entryDelaySec: 300,
      holdSec: 7200,
      isEarly: true,
      isProfitable: true,
    });
    if (i < 8) {
      intelligence.applyTokenOutcome({ tokenAddress, outcomeScore: 85, status: "strong" });
    }
  }

  const engine = createDiscoveryEngine({
    intelligence,
    minTokenScore: 1,
    minTrustedReputation: 1,
    minTrustedConfidence: 1,
    minConsensusWallets: 2,
  });

  const duplicate = {
    address: WALLET_A,
    profit: 5000,
    profit_change: 2,
    realized_profit: 5000,
    start_holding_at: 1200,
  };
  const result = await engine.processToken({
    tokenAddress: TOKEN,
    tokenInfo: { open_timestamp: 1000 },
    traders: [duplicate, { ...duplicate }],
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.trusted.length, 1);
  assert.equal(result.consensus, null);
  assert.equal(
    result.rejected.some((entry) => entry.walletAddress === WALLET_A && entry.reason === "duplicate-wallet"),
    true
  );
  assert.equal(intelligence.getProfile(WALLET_A).observations, 13);
  db.close();
});

test("trusted wallets require evidence across at least twelve distinct tokens", async () => {
  const { db, intelligence } = makeStore();

  for (let i = 0; i < 11; i += 1) {
    intelligence.recordObservation({
      walletAddress: WALLET_A,
      tokenAddress: `${i + 70}`.repeat(32).slice(0, 32),
      source: "history",
      tokenScore: 98,
      profitChange: 3,
      entryDelaySec: 300,
      holdSec: 7200,
      isEarly: true,
      isProfitable: true,
    });
  }

  const engine = createDiscoveryEngine({
    intelligence,
    minTokenScore: 1,
    minTrustedReputation: 1,
    minTrustedConfidence: 1,
    minTrustedDistinctTokens: 4,
    minConsensusWallets: 2,
  });

  const result = await engine.processToken({
    tokenAddress: TOKEN,
    tokenInfo: { open_timestamp: 1000 },
    traders: [
      { address: WALLET_A, profit: 5000, profit_change: 2, start_holding_at: 1200 },
    ],
  });

  assert.equal(intelligence.getProfile(WALLET_A).distinct_tokens, 12);
  assert.equal(result.trusted.length, 0);
  assert.equal(result.consensus, null);
  db.close();
});

test("the current token cannot make its own wallet historically trusted", async () => {
  const { db, intelligence } = makeStore();
  for (let i = 0; i < 11; i += 1) {
    const tokenAddress = `history-${i}`;
    intelligence.recordObservation({
      walletAddress: WALLET_A,
      tokenAddress,
      source: "history",
      tokenScore: 95,
      profitChange: 1.5,
      entryDelaySec: 300,
      holdSec: 7200,
      isEarly: true,
      isProfitable: true,
    });
    if (i < 8) {
      intelligence.applyTokenOutcome({ tokenAddress, outcomeScore: 85, status: "strong" });
    }
  }

  const engine = createDiscoveryEngine({
    intelligence,
    minTokenScore: 1,
    minTrustedReputation: 1,
    minTrustedConfidence: 1,
    minTrustedDistinctTokens: 12,
    minConsensusWallets: 1,
  });
  const trader = {
    address: WALLET_A,
    profit: 5000,
    profit_change: 2,
    start_holding_at: 1200,
  };

  const first = await engine.processToken({
    tokenAddress: TOKEN,
    tokenInfo: { open_timestamp: 1000 },
    traders: [trader],
  });
  assert.equal(intelligence.getProfile(WALLET_A).distinct_tokens, 12);
  assert.equal(first.trusted.length, 0);
  assert.equal(first.consensus, null);

  intelligence.recordObservation({
    walletAddress: WALLET_A,
    tokenAddress: "history-11",
    source: "history",
    tokenScore: 95,
    profitChange: 1.5,
    entryDelaySec: 300,
    holdSec: 7200,
    isEarly: true,
    isProfitable: true,
  });
  const second = await engine.processToken({
    tokenAddress: TOKEN,
    tokenInfo: { open_timestamp: 1000 },
    traders: [trader],
  });
  assert.equal(second.trusted.length, 1);
  assert.equal(second.consensus.walletCount, 1);
  assert.equal(second.consensus.wallets[0].distinctTokens, 12);
  db.close();
});

test("high reputation alone cannot promote a consistently late wallet", async () => {
  const { db, intelligence } = makeStore();
  for (let i = 0; i < 12; i += 1) {
    intelligence.recordObservation({
      walletAddress: WALLET_A,
      tokenAddress: `late-${i}`,
      source: "history",
      tokenScore: 95,
      profitChange: 2,
      entryDelaySec: 4 * 60 * 60,
      holdSec: 7200,
      isEarly: false,
      isProfitable: true,
    });
    if (i < 8) {
      intelligence.applyTokenOutcome({ tokenAddress: `late-${i}`, outcomeScore: 85, status: "strong" });
    }
  }

  const engine = createDiscoveryEngine({
    intelligence,
    minTokenScore: 1,
    minTrustedReputation: 1,
    minTrustedConfidence: 1,
    minConsensusWallets: 1,
  });
  const result = await engine.processToken({
    tokenAddress: TOKEN,
    tokenInfo: { open_timestamp: 1000 },
    traders: [{ address: WALLET_A, profit: 5000, profit_change: 2, start_holding_at: 1200 }],
  });

  assert.ok(intelligence.getProfile(WALLET_A).reputation_score > 60);
  assert.equal(result.trusted.length, 0);
  assert.equal(result.consensus, null);
  assert.ok(result.candidates[0].trustQuality.reasons.includes("weak-early-entry-rate"));
  db.close();
});

test("known strong wallets are prioritised and can form consensus", async () => {
  const { db, intelligence } = makeStore();

  for (let i = 0; i < 12; i += 1) {
    const tokenA = `strong-a-${i}`;
    const tokenB = `strong-b-${i}`;
    intelligence.recordObservation({
      walletAddress: WALLET_A,
      tokenAddress: tokenA,
      source: "history",
      tokenScore: 90,
      profitChange: 1.2,
      entryDelaySec: 600,
      holdSec: 7200,
      isEarly: true,
      isProfitable: true,
    });
    intelligence.recordObservation({
      walletAddress: WALLET_B,
      tokenAddress: tokenB,
      source: "history",
      tokenScore: 88,
      profitChange: 0.9,
      entryDelaySec: 900,
      holdSec: 7200,
      isEarly: true,
      isProfitable: true,
    });
    if (i < 8) {
      intelligence.applyTokenOutcome({ tokenAddress: tokenA, outcomeScore: 85, status: "strong" });
      intelligence.applyTokenOutcome({ tokenAddress: tokenB, outcomeScore: 85, status: "strong" });
    }
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
      { address: WALLET_A, profit: 5000, profit_change: 1.2, start_holding_at: 1300 },
      { address: WALLET_B, profit: 4500, profit_change: 1.1, start_holding_at: 1400 },
    ],
  });

  assert.ok(result.consensus);
  assert.equal(result.consensus.walletCount, 2);
  assert.ok(result.consensus.wallets.every((wallet) => wallet.distinctTokens >= 12));
  assert.equal(result.candidates[0].profile.confidence_label !== "low", true);
  db.close();
});
