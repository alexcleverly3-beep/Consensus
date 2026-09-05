"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initIntelligence } = require("../src/intelligence");

test("validated winners require early, profitable, and positive mature outcome on the same token", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);
  const walletAddress = "wallet-validated";

  const observations = [
    { tokenAddress: "aligned", isEarly: true, isProfitable: true },
    { tokenAddress: "late-winner", isEarly: false, isProfitable: true },
    { tokenAddress: "unprofitable-winner", isEarly: true, isProfitable: false },
    { tokenAddress: "aligned-loser", isEarly: true, isProfitable: true },
  ];

  for (const observation of observations) {
    intelligence.recordObservation({
      walletAddress,
      tokenAddress: observation.tokenAddress,
      tokenScore: 80,
      profitChange: observation.isProfitable ? 0.8 : -0.2,
      isEarly: observation.isEarly,
      isProfitable: observation.isProfitable,
      entryDelaySec: observation.isEarly ? 600 : 10_800,
      holdSec: 7200,
    });
  }

  intelligence.applyTokenOutcome({ tokenAddress: "aligned", outcomeScore: 90, status: "strong" });
  intelligence.applyTokenOutcome({ tokenAddress: "late-winner", outcomeScore: 90, status: "strong" });
  intelligence.applyTokenOutcome({ tokenAddress: "unprofitable-winner", outcomeScore: 90, status: "strong" });
  intelligence.applyTokenOutcome({ tokenAddress: "aligned-loser", outcomeScore: 20, status: "weak" });

  const profile = intelligence.getProfile(walletAddress);
  assert.equal(profile.mature_tokens, 4);
  assert.equal(profile.positive_outcome_tokens, 3);
  assert.equal(profile.validated_winner_tokens, 1);

  const historical = intelligence.getProfileExcludingToken(walletAddress, "aligned");
  assert.equal(historical.validated_winner_tokens, 0);

  db.close();
});

test("adding the validated winner column backfills existing evidence", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);

  intelligence.recordObservation({
    walletAddress: "wallet-backfill",
    tokenAddress: "winner",
    tokenScore: 85,
    profitChange: 1.1,
    isEarly: true,
    isProfitable: true,
  });
  intelligence.applyTokenOutcome({ tokenAddress: "winner", outcomeScore: 88, status: "strong" });

  db.exec("ALTER TABLE wallet_profiles RENAME COLUMN validated_winner_tokens TO legacy_validated_winner_tokens");
  const reloaded = initIntelligence(db);
  const profile = reloaded.getProfile("wallet-backfill");

  assert.equal(profile.validated_winner_tokens, 1);
  db.close();
});
