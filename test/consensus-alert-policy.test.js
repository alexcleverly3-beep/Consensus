"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_ATTEMPT_TTL_MS,
  consensusWalletCount,
  shouldEmitConsensusAlert,
} = require("../src/consensus-alert-policy");

let tokenId = 0;
function consensus(...wallets) {
  tokenId += 1;
  return {
    tokenAddress: `token-${tokenId}`,
    walletCount: wallets.length,
    wallets: wallets.map((walletAddress) => ({ walletAddress })),
  };
}

function consensusFor(tokenAddress, ...wallets) {
  return {
    tokenAddress,
    walletCount: wallets.length,
    wallets: wallets.map((walletAddress) => ({ walletAddress })),
  };
}

function previous(...wallets) {
  const payload = {
    tokenAddress: "persisted-token",
    walletCount: wallets.length,
    wallets: wallets.map((walletAddress) => ({ walletAddress })),
  };
  return {
    wallet_count: wallets.length,
    sent_at: 1,
    payload_json: JSON.stringify(payload),
  };
}

test("consensus cardinality is based on exact distinct wallet evidence", () => {
  assert.equal(consensusWalletCount({
    walletCount: 3,
    wallets: [
      { walletAddress: "wallet-a" },
      { walletAddress: "wallet-a" },
      { walletAddress: "wallet-b" },
    ],
  }), 2);
});

test("first multi-wallet consensus is alertable", () => {
  assert.equal(shouldEmitConsensusAlert(null, consensus("wallet-a", "wallet-b")), true);
});

test("headline wallet count cannot manufacture consensus", () => {
  assert.equal(shouldEmitConsensusAlert(null, {
    tokenAddress: "duplicate-wallet-token",
    walletCount: 2,
    wallets: [{ walletAddress: "wallet-a" }, { walletAddress: "wallet-a" }],
  }), false);
});

test("equivalent consensus stays suppressed indefinitely", () => {
  assert.equal(
    shouldEmitConsensusAlert(previous("wallet-a", "wallet-b", "wallet-c"), consensus("wallet-a", "wallet-b", "wallet-c")),
    false
  );
});

test("weaker consensus never replaces the stronger stored signal", () => {
  assert.equal(
    shouldEmitConsensusAlert(previous("wallet-a", "wallet-b", "wallet-c", "wallet-d"), consensus("wallet-a", "wallet-b")),
    false
  );
});

test("wider trusted-wallet consensus can supersede an earlier alert", () => {
  assert.equal(
    shouldEmitConsensusAlert(previous("wallet-a", "wallet-b"), consensus("wallet-a", "wallet-b", "wallet-c")),
    true
  );
});

test("malformed historical alert state fails closed", () => {
  assert.equal(
    shouldEmitConsensusAlert({ wallet_count: 2, payload_json: "not-json" }, consensus("wallet-a", "wallet-b", "wallet-c")),
    false
  );
});

test("stored headline count must match persisted exact wallet evidence", () => {
  const stored = previous("wallet-a", "wallet-b");
  stored.wallet_count = 3;
  assert.equal(
    shouldEmitConsensusAlert(stored, consensus("wallet-a", "wallet-b", "wallet-c", "wallet-d")),
    false
  );
});

test("concurrent same-token alert attempts are serialized", () => {
  const current = consensusFor("race-token", "wallet-a", "wallet-b");
  assert.equal(shouldEmitConsensusAlert(null, current, { now: 1000 }), true);
  assert.equal(shouldEmitConsensusAlert(null, current, { now: 1001 }), false);
});

test("persisted alert releases the in-process reservation back to monotonic policy", () => {
  const current = consensusFor("persist-token", "wallet-a", "wallet-b");
  assert.equal(shouldEmitConsensusAlert(null, current, { now: 2000 }), true);

  const stored = {
    wallet_count: 2,
    sent_at: 2001,
    payload_json: JSON.stringify(current),
  };
  assert.equal(shouldEmitConsensusAlert(stored, current, { now: 2002 }), false);

  const stronger = consensusFor("persist-token", "wallet-a", "wallet-b", "wallet-c");
  assert.equal(shouldEmitConsensusAlert(stored, stronger, { now: 2003 }), true);
});

test("failed alert attempt becomes retryable after bounded reservation expiry", () => {
  const current = consensusFor("retry-token", "wallet-a", "wallet-b");
  assert.equal(shouldEmitConsensusAlert(null, current, { now: 3000 }), true);
  assert.equal(
    shouldEmitConsensusAlert(null, current, { now: 3000 + DEFAULT_ATTEMPT_TTL_MS - 1 }),
    false
  );
  assert.equal(
    shouldEmitConsensusAlert(null, current, { now: 3000 + DEFAULT_ATTEMPT_TTL_MS }),
    true
  );
});
