"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultTraderFilter } = require("../src/discovery-engine");

const VALID_WALLET = "CaHbjM1AGhDPBR6JwiNHaUZAJBykqvj9LPxDouxXbiWB";

test("default trader filter rejects malformed wallet identities before evidence storage", () => {
  assert.equal(defaultTraderFilter({ address: "wallet-123" }), "invalid-wallet");
  assert.equal(defaultTraderFilter({ address: "0x1234567890abcdef" }), "invalid-wallet");
  assert.equal(defaultTraderFilter({ address: 12345 }), "invalid-wallet");
  assert.equal(defaultTraderFilter({ address: VALID_WALLET }), null);
});

test("default trader filter treats serialized suspicious flags as suspicious", () => {
  assert.equal(defaultTraderFilter({ address: VALID_WALLET, is_suspicious: "1" }), "suspicious");
  assert.equal(defaultTraderFilter({ address: VALID_WALLET, is_suspicious: "true" }), "suspicious");
});
