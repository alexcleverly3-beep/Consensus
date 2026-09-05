"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldEmitConsensusAlert } = require("../src/consensus-alert-policy");

test("first multi-wallet consensus is alertable", () => {
  assert.equal(shouldEmitConsensusAlert(null, { walletCount: 2 }), true);
});

test("equivalent consensus stays suppressed indefinitely", () => {
  const previous = { wallet_count: 3, sent_at: 1 };
  assert.equal(shouldEmitConsensusAlert(previous, { walletCount: 3 }), false);
});

test("weaker consensus never replaces the stronger stored signal", () => {
  const previous = { wallet_count: 4, sent_at: 1 };
  assert.equal(shouldEmitConsensusAlert(previous, { walletCount: 2 }), false);
});

test("wider trusted-wallet consensus can supersede an earlier alert", () => {
  const previous = { wallet_count: 2, sent_at: 1 };
  assert.equal(shouldEmitConsensusAlert(previous, { walletCount: 3 }), true);
});

test("malformed historical alert state fails closed", () => {
  assert.equal(shouldEmitConsensusAlert({ wallet_count: "bad" }, { walletCount: 3 }), false);
});
