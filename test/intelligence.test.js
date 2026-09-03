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
