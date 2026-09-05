"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { consensusWalletCount, shouldEmitConsensusAlert } = require("../src/consensus-alert-policy");

function consensus(...wallets) {
  return {
    walletCount: wallets.length,
    wallets: wallets.map((walletAddress) => ({ walletAddress })),
  };
}

function previous(...wallets) {
  const payload = consensus(...wallets);
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
