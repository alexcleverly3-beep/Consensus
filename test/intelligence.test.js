"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initIntelligence } = require("../src/intelligence");

test("wallet evidence accumulates into a profile", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);

  intelligence.recordObservation({
    walletAddress: "wallet-1",
    tokenAddress: "token-a",
    tokenScore: 80,
    profitChange: 1.2,
    isEarly: true,
    entryDelaySec: 900,
  });

  const profile = intelligence.recordObservation({
    walletAddress: "wallet-1",
    tokenAddress: "token-b",
    tokenScore: 72,
    profitChange: 0.4,
    isEarly: true,
    entryDelaySec: 1800,
  });

  assert.equal(profile.observations, 2);
  assert.equal(profile.distinct_tokens, 2);
  assert.equal(profile.early_entries, 2);
  assert.equal(profile.profitable_entries, 2);
  assert.ok(profile.reputation_score > 60);
  assert.ok(profile.confidence_score > 0);
});

test("bad-token evidence reduces reputation", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);

  const good = intelligence.recordObservation({
    walletAddress: "wallet-2",
    tokenAddress: "token-a",
    tokenScore: 82,
    profitChange: 1.5,
    isEarly: true,
  });

  const afterBad = intelligence.recordObservation({
    walletAddress: "wallet-2",
    tokenAddress: "token-b",
    tokenScore: 20,
    profitChange: -0.9,
    isBadToken: true,
  });

  assert.ok(afterBad.reputation_score < good.reputation_score);
  assert.equal(afterBad.rug_or_bad_token_hits, 1);
});

test("re-observing the same wallet/token/source updates rather than double counts", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);

  intelligence.recordObservation({
    walletAddress: "wallet-3",
    tokenAddress: "token-a",
    tokenScore: 50,
    profitChange: 0.1,
  });

  const profile = intelligence.recordObservation({
    walletAddress: "wallet-3",
    tokenAddress: "token-a",
    tokenScore: 75,
    profitChange: 0.8,
    isEarly: true,
  });

  assert.equal(profile.observations, 1);
  assert.equal(profile.distinct_tokens, 1);
  assert.equal(profile.early_entries, 1);
  assert.equal(profile.profitable_entries, 1);
});

test("mature bad token outcome penalizes every wallet exposed to that token", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);

  const beforeA = intelligence.recordObservation({
    walletAddress: "wallet-a",
    tokenAddress: "token-rug",
    tokenScore: 78,
    profitChange: 0.8,
    isEarly: true,
  });
  const beforeB = intelligence.recordObservation({
    walletAddress: "wallet-b",
    tokenAddress: "token-rug",
    tokenScore: 74,
    profitChange: 0.5,
    isEarly: true,
  });

  const applied = intelligence.applyTokenOutcome({
    tokenAddress: "token-rug",
    outcomeScore: 0,
    status: "bad",
  });

  assert.equal(applied.updatedWallets, 2);
  const afterA = intelligence.getProfile("wallet-a");
  const afterB = intelligence.getProfile("wallet-b");
  assert.equal(afterA.rug_or_bad_token_hits, 1);
  assert.equal(afterB.rug_or_bad_token_hits, 1);
  assert.ok(afterA.reputation_score < beforeA.reputation_score);
  assert.ok(afterB.reputation_score < beforeB.reputation_score);
});

test("strong mature outcome boosts token quality without duplicating evidence", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);

  const before = intelligence.recordObservation({
    walletAddress: "wallet-strong",
    tokenAddress: "token-winner",
    tokenScore: 50,
    profitChange: 0.2,
    isEarly: true,
  });

  intelligence.applyTokenOutcome({
    tokenAddress: "token-winner",
    outcomeScore: 100,
    status: "excellent",
  });

  const after = intelligence.getProfile("wallet-strong");
  assert.equal(after.observations, 1);
  assert.equal(after.distinct_tokens, 1);
  assert.ok(after.avg_token_score > before.avg_token_score);
  assert.ok(after.reputation_score >= before.reputation_score);
  assert.ok(after.confidence_score > before.confidence_score);
});

test("higher-quality evidence weight materially affects longitudinal reputation", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);

  for (const walletAddress of ["wallet-normal", "wallet-weighted"]) {
    intelligence.recordObservation({
      walletAddress,
      tokenAddress: "winner",
      tokenScore: 90,
      profitChange: 1.1,
      isEarly: true,
      isProfitable: true,
      evidenceWeight: walletAddress === "wallet-weighted" ? 2 : 1,
    });
    intelligence.recordObservation({
      walletAddress,
      tokenAddress: "loser",
      tokenScore: 20,
      profitChange: -0.8,
      isBadToken: true,
      evidenceWeight: 1,
    });
  }

  const normal = intelligence.getProfile("wallet-normal");
  const weighted = intelligence.getProfile("wallet-weighted");

  assert.equal(normal.observations, weighted.observations);
  assert.equal(normal.distinct_tokens, weighted.distinct_tokens);
  assert.ok(weighted.avg_token_score > normal.avg_token_score);
  assert.ok(weighted.reputation_score > normal.reputation_score);
  assert.ok(weighted.confidence_score > normal.confidence_score);
});

test("mature outcome weights are consumed by profile aggregation", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);

  intelligence.recordObservation({
    walletAddress: "wallet-outcome-weight",
    tokenAddress: "winner",
    tokenScore: 70,
    profitChange: 0.7,
    isEarly: true,
  });
  intelligence.recordObservation({
    walletAddress: "wallet-outcome-weight",
    tokenAddress: "neutral",
    tokenScore: 40,
    profitChange: 0,
  });

  const before = intelligence.getProfile("wallet-outcome-weight");
  intelligence.applyTokenOutcome({
    tokenAddress: "winner",
    outcomeScore: 100,
    status: "excellent",
  });
  const after = intelligence.getProfile("wallet-outcome-weight");

  assert.equal(after.observations, 2);
  assert.equal(after.distinct_tokens, 2);
  assert.ok(after.avg_token_score > before.avg_token_score);
  assert.ok(after.reputation_score > before.reputation_score);
});

test("multiple evidence sources for one token do not fake repeat-wallet skill", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);

  const once = intelligence.recordObservation({
    walletAddress: "wallet-multisource",
    tokenAddress: "same-token",
    source: "discovery",
    tokenScore: 92,
    profitChange: 1.4,
    isEarly: true,
    isProfitable: true,
  });

  const repeated = intelligence.recordObservation({
    walletAddress: "wallet-multisource",
    tokenAddress: "same-token",
    source: "history",
    tokenScore: 92,
    profitChange: 1.4,
    isEarly: true,
    isProfitable: true,
  });

  assert.equal(repeated.observations, 2);
  assert.equal(repeated.distinct_tokens, 1);
  assert.equal(repeated.positive_signals, 1);
  assert.equal(repeated.early_entries, 1);
  assert.equal(repeated.profitable_entries, 1);
  assert.equal(repeated.reputation_score, once.reputation_score);
  assert.equal(repeated.confidence_score, once.confidence_score);
  db.close();
});

test("four independent winners build materially more confidence than four sources for one winner", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);

  for (const source of ["discovery", "history", "seed-history", "rescan"]) {
    intelligence.recordObservation({
      walletAddress: "wallet-one-token",
      tokenAddress: "winner",
      source,
      tokenScore: 88,
      profitChange: 1.1,
      isEarly: true,
      isProfitable: true,
    });
  }

  for (let i = 0; i < 4; i += 1) {
    intelligence.recordObservation({
      walletAddress: "wallet-four-tokens",
      tokenAddress: `winner-${i}`,
      source: "discovery",
      tokenScore: 88,
      profitChange: 1.1,
      isEarly: true,
      isProfitable: true,
    });
  }

  const repeated = intelligence.getProfile("wallet-one-token");
  const broad = intelligence.getProfile("wallet-four-tokens");
  assert.equal(repeated.observations, 4);
  assert.equal(repeated.distinct_tokens, 1);
  assert.equal(broad.observations, 4);
  assert.equal(broad.distinct_tokens, 4);
  assert.ok(broad.confidence_score >= 50);
  assert.ok(broad.confidence_score > repeated.confidence_score);
  db.close();
});
