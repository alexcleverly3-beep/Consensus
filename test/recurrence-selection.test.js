"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectRecurrenceToken } = require("../src/recurrence-selection");

const base = {
  address: "A".repeat(32), open_timestamp: 1_000, liquidity: 100_000,
  market_cap: 500_000, volume: 300_000, holder_count: 1_500,
  top_10_holder_rate: 0.18, is_wash_trading: false, renounced_mint: true,
  renounced_freeze_account: true, buys: 500, sells: 400,
};

test("recurrence selection keeps safe early samples and ranks stronger activity higher", () => {
  const strong = selectRecurrenceToken({ ...base, open_timestamp: 1_000 }, 1000 + 7 * 60 * 60 * 1000);
  const weak = selectRecurrenceToken({ ...base, liquidity: 50_000, volume: 25_000, holder_count: 500 }, 1000 + 7 * 60 * 60 * 1000);
  assert.equal(strong.eligible, true);
  assert.equal(weak.eligible, true);
  assert.ok(strong.score > weak.score);
});

test("obvious manipulation and concentration are rejected", () => {
  assert.equal(selectRecurrenceToken({ ...base, is_wash_trading: true }, Date.now()).reason, "wash-trading");
  assert.equal(selectRecurrenceToken({ ...base, top_10_holder_rate: 0.41 }, Date.now()).reason, "concentrated-holders");
  assert.equal(selectRecurrenceToken({ ...base, renounced_mint: false }, Date.now()).reason, "unsafe-authority");
});

test("metadata-light legacy rows remain queueable for additive migration", () => {
  const result = selectRecurrenceToken({ address: "B".repeat(32) }, Date.now());
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "metadata-pending");
});
