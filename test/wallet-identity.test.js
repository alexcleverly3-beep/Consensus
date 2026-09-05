"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDiscoveryEngine, defaultTraderFilter } = require("../src/discovery-engine");

const WALLET = "11111111111111111111111111111111";
const CREATOR = "22222222222222222222222222222222";

function trader(address) {
  const opened = Math.floor(Date.now() / 1000) - 300;
  return {
    address,
    realized_profit: 100,
    unrealized_profit: 0,
    profit: 100,
    profit_change: 0.5,
    buy_tx_count_cur: 1,
    sell_tx_count_cur: 1,
    start_holding_at: opened + 60,
  };
}

test("trader filter canonicalizes wallet and creator whitespace", () => {
  assert.equal(defaultTraderFilter(trader(`  ${CREATOR}  `), ` ${CREATOR} `), "creator");
  assert.equal(defaultTraderFilter(trader(`  ${WALLET}  `), CREATOR), null);
});

test("discovery stores and deduplicates the canonical wallet address", async () => {
  const observations = [];
  const profiles = new Map();
  const intelligence = {
    recordObservation(observation) {
      observations.push(observation);
      const profile = {
        wallet_address: observation.walletAddress,
        reputation_score: 0,
        confidence_score: 0,
        distinct_tokens: 1,
      };
      profiles.set(observation.walletAddress, profile);
      return profile;
    },
    getProfile(walletAddress) {
      return profiles.get(walletAddress) || null;
    },
    getProfileExcludingToken() {
      return null;
    },
  };
  const engine = createDiscoveryEngine({ intelligence, maxEnrichments: 0 });
  const opened = Math.floor(Date.now() / 1000) - 300;
  const result = await engine.processToken({
    tokenAddress: "33333333333333333333333333333333",
    tokenInfo: { open_timestamp: opened, dev: { creator_address: CREATOR } },
    traders: [trader(`  ${WALLET}  `), trader(WALLET)],
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0].walletAddress, WALLET);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].walletAddress, WALLET);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(result.rejected[0], { walletAddress: WALLET, reason: "duplicate-wallet" });
});
