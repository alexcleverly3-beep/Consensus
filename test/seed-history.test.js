"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { collectSeedHistory, nextCursor } = require("../src/seed-history");

const WALLET = "CaHbjM1AGhDPBR6JwiNHaUZAJBykqvj9LPxDouxXbiWB";
const TOKEN_A = "So11111111111111111111111111111111111111112";
const TOKEN_B = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6wX2Kx7X1Y8fGZQ";

function buy(address, timestamp) {
  return { type: "buy", token_address: address, timestamp };
}

test("nextCursor tolerates common GMGN response shapes", () => {
  assert.equal(nextCursor({ data: { next_cursor: "abc" } }), "abc");
  assert.equal(nextCursor({ nextCursor: "def" }), "def");
  assert.equal(nextCursor({ data: { next: "ghi" } }), "ghi");
  assert.equal(nextCursor({ data: {} }), null);
});

test("collectSeedHistory follows cursors, deduplicates tokens, and keeps newest activity", async () => {
  const calls = [];
  const pages = new Map([
    [null, { data: { list: [buy(TOKEN_A, 100)], next_cursor: "p2" } }],
    ["p2", { data: { list: [buy(TOKEN_A, 200), buy(TOKEN_B, 150)] } }],
  ]);

  const result = await collectSeedHistory({
    walletAddress: WALLET,
    maxPages: 5,
    fetchPage: async ({ cursor }) => {
      calls.push(cursor);
      return pages.get(cursor);
    },
  });

  assert.deepEqual(calls, [null, "p2"]);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.tokens.length, 2);
  assert.equal(result.tokens[0].address, TOKEN_A);
  assert.equal(result.tokens[0].lastActivityAt, 200000);
});

test("collectSeedHistory obeys the page budget even if another cursor exists", async () => {
  let calls = 0;
  const result = await collectSeedHistory({
    walletAddress: WALLET,
    maxPages: 2,
    fetchPage: async ({ cursor }) => {
      calls += 1;
      return { data: { list: [buy(TOKEN_A, calls)], next_cursor: `${cursor || "start"}-${calls}` } };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.pagesFetched, 2);
});
