"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractTokenCandidates, shouldScanToken } = require("../src/market-discovery");

const A = "11111111111111111111111111111111";
const B = "So11111111111111111111111111111111111111112";

test("extractTokenCandidates deduplicates and prioritizes safer liquid rows", () => {
  const response = {
    data: {
      list: [
        { address: A, liquidity: 500, volume: 100 },
        { address: B, liquidity: 50000, market_cap: 100000, volume: 90000, smart_degen_count: 2 },
        { address: B, liquidity: 70000 },
      ],
    },
  };
  const rows = extractTokenCandidates(response, { limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].address, B);
  assert.equal(rows[1].address, A);
});

test("shouldScanToken enforces the rescan cooldown", () => {
  const now = 10_000_000;
  assert.equal(shouldScanToken(null, now, 1000), true);
  assert.equal(shouldScanToken(now - 999, now, 1000), false);
  assert.equal(shouldScanToken(now - 1000, now, 1000), true);
});
