"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  rankTrustedCandidates,
  consensusWalletSummary,
} = require("../src/discovery-engine");

function candidate(walletAddress, {
  validatedWinnerRate,
  validatedWinnerTokens,
  strongOutcomeRate = 0.5,
  positiveOutcomeRate = 0.8,
  confidence = 80,
  reputation = 80,
  distinctTokens = 20,
  matureTokens = 16,
  tokenScore = 80,
  profitChange = 1,
  entryDelaySec = 600,
} = {}) {
  return {
    walletAddress,
    trustedProfile: {
      reputation_score: reputation,
      confidence_score: confidence,
      distinct_tokens: distinctTokens,
      mature_tokens: matureTokens,
    },
    trustQuality: {
      metrics: {
        validatedWinnerRate,
        validatedWinnerTokens,
        strongOutcomeRate,
        positiveOutcomeRate,
        confidence,
        reputation,
        distinctTokens,
        matureTokens,
      },
    },
    evidence: { tokenScore, profitChange, entryDelaySec },
  };
}

test("trusted consensus wallets rank exact validated-winner quality before generic confidence", () => {
  const confidenceHeavy = candidate("A", {
    validatedWinnerRate: 0.25,
    validatedWinnerTokens: 4,
    confidence: 99,
    reputation: 99,
  });
  const repeatWinner = candidate("B", {
    validatedWinnerRate: 0.50,
    validatedWinnerTokens: 8,
    confidence: 78,
    reputation: 75,
  });

  const ranked = rankTrustedCandidates([confidenceHeavy, repeatWinner]);
  assert.deepEqual(ranked.map((entry) => entry.walletAddress), ["B", "A"]);
});

test("trusted consensus ranking uses exact winner count after equal winner rate", () => {
  const narrower = candidate("A", {
    validatedWinnerRate: 0.40,
    validatedWinnerTokens: 4,
    confidence: 99,
  });
  const broader = candidate("B", {
    validatedWinnerRate: 0.40,
    validatedWinnerTokens: 8,
    confidence: 75,
  });

  const ranked = rankTrustedCandidates([narrower, broader]);
  assert.deepEqual(ranked.map((entry) => entry.walletAddress), ["B", "A"]);
});

test("consensus wallet summary exposes longitudinal proof and current-token evidence", () => {
  const summary = consensusWalletSummary(candidate("A", {
    validatedWinnerRate: 0.5,
    validatedWinnerTokens: 8,
    strongOutcomeRate: 0.375,
    positiveOutcomeRate: 0.875,
    confidence: 82,
    reputation: 84,
    distinctTokens: 20,
    matureTokens: 16,
    tokenScore: 91,
    profitChange: 1.4,
    entryDelaySec: 420,
  }));

  assert.deepEqual(summary, {
    walletAddress: "A",
    reputation: 84,
    confidence: 82,
    distinctTokens: 20,
    matureTokens: 16,
    validatedWinnerTokens: 8,
    validatedWinnerRate: 0.5,
    strongOutcomeRate: 0.375,
    positiveOutcomeRate: 0.875,
    tokenScore: 91,
    profitChange: 1.4,
    entryDelaySec: 420,
  });
});
