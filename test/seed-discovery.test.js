"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractBoughtTokens, parseSeedWallets } = require("../src/seed-discovery");

const A = "So11111111111111111111111111111111111111112";
const B = "9xQeWvG816bUx9EPfEZyK7xQ3jPTQh27W5YbH7M8hA9";
const WALLET = "CaHbjM1AGhDPBR6JwiNHaUZAJBykqvj9LPxDouxXbiWB";

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
