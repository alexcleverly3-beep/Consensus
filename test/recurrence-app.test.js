"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { publicHealth } = require("../src/recurrence-app");

test("recurrence health exposes collection progress without wallet or token identities", () => {
  const store = {
    summary: () => ({
      tokensSeen: 50,
      tokensScanned: 12,
      totalTokenScans: 13,
      queuedTokens: 38,
      walletTokenLinks: 900,
      walletsSeen: 720,
      repeatWallets: 42,
      lastScanAt: 9_000,
      walletAddress: "secret-wallet",
      tokenAddress: "secret-token",
    }),
  };
  const guard = {
    snapshot: () => ({
      freshCalls: 3,
      maxFreshCalls: 8,
      effectiveMaxFreshCalls: 7,
      remaining: 4,
      cacheHits: 2,
      coalesced: 1,
      rejected: 0,
      rateLimitEvents: 0,
      cooldownRemainingMs: 0,
      request: "secret-token",
    }),
  };

  const health = publicHealth(store, guard, 10_000);
  assert.equal(health.mode, "recurrence-first");
  assert.equal(health.collection.tokensSeen, 50);
  assert.equal(health.collection.repeatWallets, 42);
  assert.equal(health.collection.lastScanAgeMs, 1000);
  assert.equal(health.gmgn.effectiveMax, 7);
  assert.equal(health.gmgn.remaining, 4);

  const serialized = JSON.stringify(health);
  assert.doesNotMatch(serialized, /secret-wallet|secret-token|walletAddress|tokenAddress|request/);
});
