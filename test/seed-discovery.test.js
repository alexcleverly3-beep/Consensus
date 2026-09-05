"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  boundedSeedQueueSelection,
  extractBoughtTokens,
  nextDueSeedWallet,
  parseSeedWallets,
  trustedWalletSeeds,
} = require("../src/seed-discovery");

const A = "So11111111111111111111111111111111111111112";
const B = "9xQeWvG816bUx9EPfEZyK7xQ3jPTQh27W5YbH7M8hA9";
const WALLET = "CaHbjM1AGhDPBR6JwiNHaUZAJBykqvj9LPxDouxXbiWB";
const TRUSTED_A = "4Nd1mXJdV4QAsUQ6iaCN3XP3XQCrFP3Gdd8tWJ5bQ7Mm";
const TRUSTED_B = "7YttLkHDoNj9wyDur5ERHy45Qb2V1Bq8yTzJdK1A8V6q";

function qualityFields(distinctTokens) {
  const matureTokens = Math.max(8, Math.ceil(distinctTokens * 0.67));
  const holdEvidenceTokens = Math.ceil(distinctTokens * 0.8);
  return {
    negative_signals: 0,
    early_entries: Math.ceil(distinctTokens * 0.75),
    profitable_entries: Math.ceil(distinctTokens * 0.75),
    mature_tokens: matureTokens,
    positive_outcome_tokens: Math.ceil(matureTokens * 0.8),
    strong_outcome_tokens: 3,
    validated_winner_tokens: Math.ceil(matureTokens * 0.3),
    hold_evidence_tokens: holdEvidenceTokens,
    meaningful_hold_tokens: Math.ceil(holdEvidenceTokens * 0.8),
    avg_entry_delay_sec: 1800,
    avg_hold_sec: 7200,
    avg_token_score: 78,
    avg_outcome_score: 82,
  };
}

test("extractBoughtTokens keeps unique buys ordered by most recent activity", () => {
  const response = {
    data: {
      list: [
        { event_type: "buy", token_address: A, timestamp: 100 },
        { event_type: "sell", token_address: B, timestamp: 400 },
        { side: "buy", token_address: B, timestamp: 200 },
        { event_type: "buy", token_address: A, timestamp: 300 },
      ],
    },
  };

  const tokens = extractBoughtTokens(response, { walletAddress: WALLET });
  assert.deepEqual(tokens.map((x) => x.address), [A, B]);
  assert.equal(tokens[0].lastActivityAt, 300000);
});

test("extractBoughtTokens accepts serialized GMGN buy flags but explicit sells still win", () => {
  const response = {
    data: {
      list: [
        { is_buy: "1", token_address: A, timestamp: 100 },
        { isBuy: "true", token_address: B, timestamp: 200 },
        { event_type: "sell", is_buy: "1", token_address: A, timestamp: 300 },
      ],
    },
  };

  const tokens = extractBoughtTokens(response, { walletAddress: WALLET });
  assert.deepEqual(tokens.map((x) => x.address), [B, A]);
  assert.equal(tokens.find((x) => x.address === A).lastActivityAt, 100000);
});

test("parseSeedWallets accepts comma/space separated wallets and removes duplicates", () => {
  assert.deepEqual(parseSeedWallets(`${WALLET}, ${WALLET}`), [WALLET]);
  assert.deepEqual(parseSeedWallets("", [WALLET]), [WALLET]);
});

test("trustedWalletSeeds only promotes repeatably early, profitable wallets", () => {
  const seeds = trustedWalletSeeds([
    {
      wallet_address: TRUSTED_A,
      reputation_score: 82,
      confidence_score: 80,
      distinct_tokens: 15,
      rug_or_bad_token_hits: 1,
      ...qualityFields(15),
    },
    {
      wallet_address: TRUSTED_B,
      reputation_score: 91,
      confidence_score: 72,
      distinct_tokens: 11,
      rug_or_bad_token_hits: 0,
      ...qualityFields(11),
    },
    {
      wallet_address: WALLET,
      reputation_score: 78,
      confidence_score: 80,
      distinct_tokens: 15,
      rug_or_bad_token_hits: 3,
      ...qualityFields(15),
    },
  ]);

  assert.deepEqual(seeds.map((seed) => seed.walletAddress), [TRUSTED_A]);
  assert.equal(seeds[0].distinctTokens, 15);
});

test("trustedWalletSeeds rejects high-scoring wallets with weak consistency", () => {
  const seeds = trustedWalletSeeds([{
    wallet_address: TRUSTED_A,
    reputation_score: 95,
    confidence_score: 90,
    distinct_tokens: 12,
    early_entries: 3,
    profitable_entries: 5,
    rug_or_bad_token_hits: 0,
    avg_entry_delay_sec: 14_000,
    avg_token_score: 88,
  }]);

  assert.deepEqual(seeds, []);
});

test("trustedWalletSeeds excludes configured seeds and ranks confidence before reputation", () => {
  const seeds = trustedWalletSeeds([
    {
      wallet_address: TRUSTED_A,
      reputation_score: 99,
      confidence_score: 80,
      distinct_tokens: 15,
      rug_or_bad_token_hits: 0,
      ...qualityFields(15),
    },
    {
      wallet_address: TRUSTED_B,
      reputation_score: 75,
      confidence_score: 85,
      distinct_tokens: 12,
      rug_or_bad_token_hits: 0,
      ...qualityFields(12),
    },
    {
      wallet_address: WALLET,
      reputation_score: 90,
      confidence_score: 90,
      distinct_tokens: 15,
      rug_or_bad_token_hits: 0,
      ...qualityFields(15),
    },
  ], { exclude: [WALLET] });

  assert.deepEqual(seeds.map((seed) => seed.walletAddress), [TRUSTED_B, TRUSTED_A]);
});

test("nextDueSeedWallet shares one refresh slot between configured and trusted seeds", () => {
  const now = 10_000_000;
  const refreshMs = 1_000;
  const state = new Map([
    [WALLET, { last_refreshed_at: now - 100 }],
    [TRUSTED_A, { last_refreshed_at: now - 2_000 }],
  ]);

  const next = nextDueSeedWallet({
    configuredWallets: [WALLET],
    trustedProfiles: [{
      wallet_address: TRUSTED_A,
      reputation_score: 82,
      confidence_score: 80,
      distinct_tokens: 15,
      rug_or_bad_token_hits: 0,
      ...qualityFields(15),
    }],
    stateByWallet: (walletAddress) => state.get(walletAddress),
    now,
    refreshMs,
  });

  assert.equal(next.walletAddress, TRUSTED_A);
  assert.equal(next.source, "trusted");
});

test("nextDueSeedWallet keeps due configured seeds ahead of learned seeds on equal staleness", () => {
  const next = nextDueSeedWallet({
    configuredWallets: [WALLET],
    trustedProfiles: [{
      wallet_address: TRUSTED_A,
      reputation_score: 90,
      confidence_score: 90,
      distinct_tokens: 15,
      rug_or_bad_token_hits: 0,
      ...qualityFields(15),
    }],
    stateByWallet: () => null,
    now: 5_000,
    refreshMs: 1_000,
  });

  assert.equal(next.walletAddress, WALLET);
  assert.equal(next.source, "configured");
});

test("nextDueSeedWallet prevents configured seeds from starving older learned seeds", () => {
  const now = 50_000;
  const refreshMs = 1_000;
  const state = new Map([
    [WALLET, { last_refreshed_at: now - 1_500 }],
    [TRUSTED_A, { last_refreshed_at: now - 8_000 }],
  ]);

  const next = nextDueSeedWallet({
    configuredWallets: [WALLET],
    trustedProfiles: [{
      wallet_address: TRUSTED_A,
      reputation_score: 88,
      confidence_score: 80,
      distinct_tokens: 15,
      rug_or_bad_token_hits: 0,
      ...qualityFields(15),
    }],
    stateByWallet: (walletAddress) => state.get(walletAddress),
    now,
    refreshMs,
  });

  assert.equal(next.walletAddress, TRUSTED_A);
  assert.equal(next.source, "trusted");
});

test("boundedSeedQueueSelection caps new pending work but still updates existing rows", () => {
  const tokens = [{ address: A }, { address: B }, { address: "new-token" }];
  const result = boundedSeedQueueSelection(tokens, {
    pendingCount: 2,
    maxPending: 3,
    exists: (token) => token.address === A,
  });

  assert.deepEqual(result.selected.map((token) => token.address), [A, B]);
  assert.equal(result.skipped, 1);
});
