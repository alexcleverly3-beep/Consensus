"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractTokenCandidates,
  shouldScanToken,
  qualityGate,
  launchedAt,
} = require("../src/market-discovery");

const A = "11111111111111111111111111111111";
const B = "So11111111111111111111111111111111111111112";
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function mature(overrides = {}) {
  return {
    creation_timestamp: Math.floor((NOW - 5 * DAY) / 1000),
    liquidity: 100000,
    market_cap: 1000000,
    volume: 100000,
    ...overrides,
  };
}

test("extractTokenCandidates rejects young pumps and prioritizes mature durable tokens", () => {
  const response = {
    data: {
      list: [
        {
          address: A,
          creation_timestamp: Math.floor((NOW - 6 * 60 * 60 * 1000) / 1000),
          liquidity: 500000,
          market_cap: 5000000,
          volume: 1000000,
        },
        {
          address: B,
          creation_timestamp: Math.floor((NOW - 5 * DAY) / 1000),
          liquidity: 50000,
          market_cap: 500000,
          volume: 90000,
          smart_degen_count: 2,
        },
        { address: B, liquidity: 70000 },
      ],
    },
  };
  const rows = extractTokenCandidates(response, { limit: 10, now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, B);
  assert.ok(rows[0].quality.ageMs >= 5 * DAY);
});

test("qualityGate requires known age and durable market quality by default", () => {
  assert.equal(qualityGate({ liquidity: 100000, market_cap: 1000000, volume: 100000 }, { now: NOW }).reason, "unknown-age");
  assert.equal(qualityGate({ creation_timestamp: (NOW - DAY) / 1000, liquidity: 100000, market_cap: 1000000, volume: 100000 }, { now: NOW }).reason, "too-young");
  assert.equal(qualityGate({ creation_timestamp: (NOW - 3 * DAY) / 1000, liquidity: 1000, market_cap: 1000000, volume: 100000 }, { now: NOW }).reason, "low-liquidity");
  assert.equal(qualityGate(mature(), { now: NOW }).ok, true);
});

test("qualityGate rejects mature tokens with pump-and-dump or rug characteristics", () => {
  assert.equal(qualityGate(mature({ is_wash_trading: true }), { now: NOW }).reason, "wash-trading");
  assert.equal(qualityGate(mature({ rug_ratio: 0.31 }), { now: NOW }).reason, "high-rug-risk");
  assert.equal(qualityGate(mature({ top_10_holder_rate: 0.51 }), { now: NOW }).reason, "concentrated-holders");
  assert.equal(qualityGate(mature({ dev_team_hold_rate: 0.21 }), { now: NOW }).reason, "high-dev-hold");
  assert.equal(qualityGate(mature({ creator_token_status: "creator_hold" }), { now: NOW }).reason, "creator-still-holding");
  assert.equal(qualityGate(mature({ rat_trader_amount_rate: 0.36 }), { now: NOW }).reason, "high-insider-rate");
});

test("launchedAt normalizes second and millisecond timestamps", () => {
  assert.equal(launchedAt({ creation_timestamp: 1700000000 }), 1700000000000);
  assert.equal(launchedAt({ pair_created_at: 1700000000000 }), 1700000000000);
});

test("shouldScanToken enforces the rescan cooldown", () => {
  const now = 10_000_000;
  assert.equal(shouldScanToken(null, now, 1000), true);
  assert.equal(shouldScanToken(now - 999, now, 1000), false);
  assert.equal(shouldScanToken(now - 1000, now, 1000), true);
});
