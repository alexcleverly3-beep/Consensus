"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeWinRate, parseWalletStats, performanceScore } = require("../src/phase2-performance");

const WALLET_A = "CaHbjM1AGhDPBR6JwiNHaUZAJBykqvj9LPxDouxXbiWB";
const WALLET_B = "7YttLkHDo4yisJ9fsgFj6aNfA7SKz3JcM1wQh2Ve8XrP";

function strongStats(walletAddress = WALLET_A) {
  return {
    wallet_address: walletAddress,
    realized_profit: 12_000,
    total_cost: 40_000,
    pnl: 0.30,
    pnl_stat: {
      token_num: 60,
      winrate: 0.72,
      pnl_gt_5x_num: 2,
      pnl_2x_5x_num: 8,
      pnl_0x_2x_num: 33,
      pnl_nd5_0x_num: 14,
      pnl_lt_nd5_num: 3,
    },
  };
}

test("performance bonus rewards repeatable profitable win rate but stays capped", () => {
  const scored = performanceScore(strongStats());
  assert.equal(scored.winRate, 0.72);
  assert.equal(scored.tokenCount, 60);
  assert.equal(scored.bonus, 10);
  assert.equal(scored.reason, "qualified-performance-bonus");
});

test("performance bonus rejects thin samples, losses and severe downside", () => {
  assert.equal(performanceScore({ ...strongStats(), pnl_stat: { token_num: 10, winrate: 0.9 } }).bonus, 0);
  assert.equal(performanceScore({ ...strongStats(), realized_profit: -1 }).bonus, 0);
  assert.equal(performanceScore({ ...strongStats(), pnl_stat: { token_num: 20, winrate: 0.9, pnl_lt_nd5_num: 8 } }).bonus, 0);
  assert.equal(normalizeWinRate(72), 0.72);
});

test("batch GMGN wallet stats are mapped back to requested wallets", () => {
  const parsed = parseWalletStats({ data: { list: [strongStats(WALLET_A), { ...strongStats(WALLET_B), pnl_stat: { ...strongStats().pnl_stat, winrate: 0.61 } }] } }, [WALLET_A, WALLET_B]);
  assert.equal(parsed.size, 2);
  assert.equal(parsed.get(WALLET_A).bonus, 10);
  assert.equal(parsed.get(WALLET_B).winRate, 0.61);

  const keyed = parseWalletStats({ data: { [WALLET_A]: strongStats() } }, [WALLET_A]);
  assert.equal(keyed.get(WALLET_A).tokenCount, 60);
});
