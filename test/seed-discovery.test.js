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

test("parseSeedWallets accepts comma/space separated wallets and removes duplicates", () => {
  assert.deepEqual(parseSeedWallets(`${WALLET}, ${WALLET}`), [WALLET]);
  assert.deepEqual(parseSeedWallets("", [WALLET]), [WALLET]);
});

test("trustedWalletSeeds only promotes wallets with broad high-confidence evidence", () => {
  const seeds = trustedWalletSeeds([
    {
      wallet_address: TRUSTED_A,
      reputation_score: 82,
      confidence_score: 74,
      distinct_tokens: 7,
      rug_or_bad_token_hits: 1,
    },
    {
      wallet_address: TRUSTED_B,
      reputation_score: 91,
      confidence_score: 72,
      distinct_tokens: 3,
      rug_or_bad_token_hits: 0,
    },
    {
      wallet_address: WALLET,
      reputation_score: 78,
      confidence_score: 68,
      distinct_tokens: 8,
      rug_or_bad_token_hits: 3,
    },
  ]);

  assert.deepEqual(seeds.map((seed) => seed.walletAddress), [TRUSTED_A]);
  assert.equal(seeds[0].distinctTokens, 7);
});

test("trustedWalletSeeds excludes configured seeds and ranks confidence before reputation", () => {
  const seeds = trustedWalletSeeds([
    {
      wallet_address: TRUSTED_A,
      reputation_score: 99,
      confidence_score: 60,
      distinct_tokens: 9,
      rug_or_bad_token_hits: 0,
    },
    {
      wallet_address: TRUSTED_B,
      reputation_score: 75,
      confidence_score: 85,
      distinct_tokens: 6,
      rug_or_bad_token_hits: 0,
    },
    {
      wallet_address: WALLET,
      reputation_score: 90,
      confidence_score: 90,
      distinct_tokens: 10,
      rug_or_bad_token_hits: 0,
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
      confidence_score: 74,
      distinct_tokens: 7,
      rug_or_bad_token_hits: 0,
    }],
    stateByWallet: (walletAddress) => state.get(walletAddress),
    now,
    refreshMs,
  });

  assert.equal(next.walletAddress, TRUSTED_A);
  assert.equal(next.source, "trusted");
});

test("nextDueSeedWallet keeps due configured seeds ahead of learned seeds", () => {
  const next = nextDueSeedWallet({
    configuredWallets: [WALLET],
    trustedProfiles: [{
      wallet_address: TRUSTED_A,
      reputation_score: 90,
      confidence_score: 90,
      distinct_tokens: 10,
      rug_or_bad_token_hits: 0,
    }],
    stateByWallet: () => null,
    now: 5_000,
    refreshMs: 1_000,
  });

  assert.equal(next.walletAddress, WALLET);
  assert.equal(next.source, "configured");
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
