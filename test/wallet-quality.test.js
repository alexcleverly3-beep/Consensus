"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { trustedProfileQuality } = require("../src/wallet-quality");

function profile(overrides = {}) {
  return {
    reputation_score: 82,
    confidence_score: 80,
    distinct_tokens: 15,
    negative_signals: 1,
    early_entries: 12,
    profitable_entries: 12,
    rug_or_bad_token_hits: 1,
    mature_tokens: 10,
    positive_outcome_tokens: 8,
    strong_outcome_tokens: 3,
    hold_evidence_tokens: 12,
    meaningful_hold_tokens: 9,
    avg_entry_delay_sec: 1800,
    avg_hold_sec: 7200,
    avg_token_score: 78,
    avg_outcome_score: 82,
    ...overrides,
  };
}

test("trustedProfileQuality accepts repeatable early profitable behaviour", () => {
  const result = trustedProfileQuality(profile());
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.metrics.earlyRate, 0.8);
  assert.equal(result.metrics.profitableRate, 0.8);
  assert.equal(result.metrics.positiveOutcomeRate, 0.8);
  assert.equal(result.metrics.guaranteedValidatedTokens, 2);
});

test("trustedProfileQuality keeps a twelve-token hard floor even with a low override", () => {
  const result = trustedProfileQuality(profile({
    distinct_tokens: 11,
    early_entries: 11,
    profitable_entries: 11,
    rug_or_bad_token_hits: 0,
  }), { minDistinctTokens: 2 });

  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("insufficient-breadth"));
});

test("trustedProfileQuality rejects jackpot-looking wallets with poor repeatability", () => {
  const result = trustedProfileQuality(profile({
    distinct_tokens: 12,
    negative_signals: 3,
    early_entries: 3,
    profitable_entries: 5,
    rug_or_bad_token_hits: 3,
    avg_entry_delay_sec: 15_000,
    avg_token_score: 91,
  }));

  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("weak-early-entry-rate"));
  assert.ok(result.reasons.includes("weak-profitability-rate"));
  assert.ok(result.reasons.includes("high-bad-token-rate"));
  assert.ok(result.reasons.includes("high-negative-signal-rate"));
  assert.ok(result.reasons.includes("late-average-entry"));
});

test("trustedProfileQuality requires several genuinely positive mature outcomes", () => {
  const tooYoung = trustedProfileQuality(profile({
    mature_tokens: 7,
    positive_outcome_tokens: 7,
    avg_outcome_score: 95,
  }));
  assert.equal(tooYoung.eligible, false);
  assert.ok(tooYoung.reasons.includes("insufficient-mature-outcomes"));

  const weakOutcomes = trustedProfileQuality(profile({
    mature_tokens: 8,
    positive_outcome_tokens: 2,
    avg_outcome_score: 52,
  }));
  assert.equal(weakOutcomes.eligible, false);
  assert.ok(weakOutcomes.reasons.includes("weak-mature-outcome-rate"));
  assert.ok(weakOutcomes.reasons.includes("weak-average-outcome-score"));
});

test("trustedProfileQuality rejects disjoint early/profitable/outcome headline rates", () => {
  const result = trustedProfileQuality(profile({
    distinct_tokens: 15,
    early_entries: 10,
    profitable_entries: 10,
    mature_tokens: 10,
    positive_outcome_tokens: 8,
    strong_outcome_tokens: 3,
    avg_entry_delay_sec: 1800,
    avg_hold_sec: 7200,
    avg_token_score: 82,
    avg_outcome_score: 84,
  }));

  // Each headline rate independently clears its floor, but the counts do not
  // guarantee that even two tokens were early + profitable + eventual winners.
  assert.ok(result.metrics.earlyRate >= 2 / 3);
  assert.ok(result.metrics.profitableRate >= 2 / 3);
  assert.ok(result.metrics.positiveOutcomeRate >= 0.75);
  assert.equal(result.metrics.guaranteedValidatedTokens, 0);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("insufficient-aligned-winner-evidence"));
});

test("trustedProfileQuality rejects fast-flip or poorly measured holding behaviour", () => {
  const fastFlipper = trustedProfileQuality(profile({
    hold_evidence_tokens: 12,
    meaningful_hold_tokens: 3,
    avg_hold_sec: 300,
  }));
  assert.equal(fastFlipper.eligible, false);
  assert.ok(resultHas(fastFlipper, "short-hold-pattern"));
  assert.ok(resultHas(fastFlipper, "short-average-hold"));

  const unmeasured = trustedProfileQuality(profile({
    hold_evidence_tokens: 2,
    meaningful_hold_tokens: 2,
    avg_hold_sec: 7200,
  }));
  assert.equal(unmeasured.eligible, false);
  assert.ok(resultHas(unmeasured, "insufficient-hold-evidence"));
});

function resultHas(result, reason) {
  return result.reasons.includes(reason);
}
