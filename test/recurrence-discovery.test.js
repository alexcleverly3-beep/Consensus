"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {
  initRecurrenceStore,
  recurrenceTraderExclusion,
} = require("../src/recurrence-discovery");

const TOKEN_A = "A".repeat(32);
const TOKEN_B = "B".repeat(32);
const WALLET_REPEAT = "C".repeat(32);
const WALLET_BOT = "D".repeat(32);
const WALLET_DEV = "E".repeat(32);
const WALLET_OTHER = "F".repeat(32);

function trader(address, overrides = {}) {
  return {
    address,
    buy_tx_count_cur: 2,
    sell_tx_count_cur: 1,
    profit: 1000,
    profit_change: 1.2,
    ...overrides,
  };
}

test("recurrence intake queues every valid trending token without old quality gates", () => {
  const db = new Database(":memory:");
  const store = initRecurrenceStore(db);
  const result = store.enqueueTrending({
    data: {
      list: [
        { address: TOKEN_A, liquidity: 1, holder_count: 2, insider_rate: 0.95 },
        { address: TOKEN_B, is_wash_trading: true, dev_team_hold_rate: 0.9 },
        { address: "not-solana" },
      ],
    },
  }, 1000);

  assert.equal(result.rows, 3);
  assert.equal(result.uniqueTokens, 2);
  assert.equal(result.added, 2);
  assert.equal(result.invalid, 1);
  assert.equal(store.summary().queuedTokens, 2);
  db.close();
});

test("failed token is deprioritized behind untouched pending tokens", () => {
  const db = new Database(":memory:");
  const store = initRecurrenceStore(db);
  store.enqueueTrending({ data: { list: [{ address: TOKEN_A }, { address: TOKEN_B }] } }, 1000);

  assert.equal(store.nextToken().token_address, TOKEN_A);
  store.markFailed(TOKEN_A, new Error("provider failure"));
  assert.equal(store.nextToken().token_address, TOKEN_B);
  assert.equal(store.summary().queuedTokens, 2);

  store.ingestTokenTraders({ tokenAddress: TOKEN_B, observedAt: 2000, traders: [trader(WALLET_OTHER)] });
  assert.equal(store.nextToken().token_address, TOKEN_A);
  db.close();
});

test("recurrence trader filter removes bot-like actors but keeps dev and insider-like wallets", () => {
  assert.equal(recurrenceTraderExclusion(trader(WALLET_BOT, { tags: ["mev_bot"] })), "tag:mev_bot");
  assert.equal(recurrenceTraderExclusion(trader(WALLET_BOT, { addr_type: 2 })), "exchange-or-pool");
  assert.equal(recurrenceTraderExclusion(trader(WALLET_BOT, { buy_tx_count_cur: 30, sell_tx_count_cur: 25 })), "high-frequency-trading");
  assert.equal(recurrenceTraderExclusion(trader(WALLET_DEV, { tags: ["dev"] })), null);
  assert.equal(recurrenceTraderExclusion(trader(WALLET_DEV, { tags: ["insider"] })), null);
  assert.equal(recurrenceTraderExclusion(trader(WALLET_DEV, { transfer_in: true, is_suspicious: true })), null);
});

test("wallet recurrence counts independent tokens rather than repeated rescans", () => {
  const db = new Database(":memory:");
  const store = initRecurrenceStore(db);
  store.enqueueTrending({ data: { list: [{ address: TOKEN_A }, { address: TOKEN_B }] } }, 1000);

  const first = store.ingestTokenTraders({
    tokenAddress: TOKEN_A,
    observedAt: 2000,
    tokenMeta: { creator_address: WALLET_DEV },
    traders: [
      trader(WALLET_REPEAT),
      trader(WALLET_DEV, { tags: ["dev"] }),
      trader(WALLET_BOT, { tags: ["dex_bot"] }),
      trader(WALLET_REPEAT),
    ],
  });
  assert.equal(first.accepted, 2);
  assert.equal(first.rejected, 2);
  assert.equal(first.rejectedByReason["tag:dex_bot"], 1);
  assert.equal(first.rejectedByReason["duplicate-wallet"], 1);

  store.ingestTokenTraders({
    tokenAddress: TOKEN_A,
    observedAt: 3000,
    traders: [trader(WALLET_REPEAT, { profit: 1500 }), trader(WALLET_OTHER)],
  });

  let top = store.topWallets(10);
  const repeatAfterRescan = top.find((row) => row.walletAddress === WALLET_REPEAT);
  assert.equal(repeatAfterRescan.distinctTokens, 1);
  assert.equal(repeatAfterRescan.totalAppearances, 2);
  assert.equal(store.summary().repeatWallets, 0);

  store.ingestTokenTraders({
    tokenAddress: TOKEN_B,
    observedAt: 4000,
    traders: [trader(WALLET_REPEAT), trader(WALLET_OTHER)],
  });

  top = store.topWallets(10);
  assert.equal(top[0].walletAddress, WALLET_REPEAT);
  assert.equal(top[0].distinctTokens, 2);
  assert.equal(top[0].totalAppearances, 3);
  assert.equal(top[0].top10Tokens, 2);
  assert.equal(store.summary().repeatWallets, 2);

  const dev = top.find((row) => row.walletAddress === WALLET_DEV);
  assert.equal(dev.everCreator, true);
  assert.equal(dev.everInsider, true);
  db.close();
});
