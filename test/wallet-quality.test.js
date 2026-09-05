"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { trustedProfileQuality } = require("../src/wallet-quality");

function profile(overrides = {}) {
  return {
    distinct_tokens: 10,
    early_entries: 8,
    profitable_entries: 8,
    rug_or_bad_token_hits: 1,
    avg_entry_delay_sec: 1800,
    avg_token_score: 78,
    ...overrides,
  };
}

test("trustedProfileQuality accepts repeatable early profitable behaviour", () => {
  const result = trustedProfileQuality(profile());
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.metrics.earlyRate, 0.8);
  assert.equal(result.metrics.profitableRate, 0.8);
});

test("trustedProfileQuality keeps a six-token hard floor even with a low override", () => {
  const result = trustedProfileQuality(profile({
    distinct_tokens: 5,
    early_entries: 5,
    profitable_entries: 5,
    rug_or_bad_token_hits: 0,
  }), { minDistinctTokens: 2 });

  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("insufficient-breadth"));
});

test("trustedProfileQuality rejects jackpot-looking wallets with poor repeatability", () => {
  const result = trustedProfileQuality(profile({
    distinct_tokens: 12,
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
  assert.ok(result.reasons.includes("late-average-entry"));
});
