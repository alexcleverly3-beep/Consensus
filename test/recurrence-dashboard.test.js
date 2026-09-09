"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initRecurrenceStore } = require("../src/recurrence-discovery");
const {
  activityState,
  createRecurrenceDashboardStore,
  dashboardCredentials,
  isAuthorized,
  renderPrivateDashboard,
} = require("../src/recurrence-dashboard");

const TOKEN_A = "A".repeat(32);
const TOKEN_B = "B".repeat(32);
const TOKEN_C = "C".repeat(32);
const WALLET_REPEAT = "D".repeat(32);
const WALLET_OTHER = "E".repeat(32);

function trader(address, overrides = {}) {
  return {
    address,
    buy_tx_count_cur: 2,
    sell_tx_count_cur: 1,
    profit: 1000,
    ...overrides,
  };
}

test("private dashboard surfaces exact recurring-wallet candidates and last-hour scans", () => {
  let now = 4_000_000;
  const db = new Database(":memory:");
  const recurrence = initRecurrenceStore(db);
  recurrence.enqueueTrending({ data: { list: [
    { address: TOKEN_A }, { address: TOKEN_B }, { address: TOKEN_C },
  ] } }, now - 10_000);

  recurrence.ingestTokenTraders({ tokenAddress: TOKEN_A, observedAt: now - 50 * 60 * 1000, traders: [trader(WALLET_REPEAT)] });
  recurrence.ingestTokenTraders({ tokenAddress: TOKEN_B, observedAt: now - 30 * 60 * 1000, traders: [trader(WALLET_REPEAT), trader(WALLET_OTHER)] });
  recurrence.ingestTokenTraders({ tokenAddress: TOKEN_C, observedAt: now - 5 * 60 * 1000, traders: [trader(WALLET_REPEAT), trader(WALLET_OTHER)] });

  const dashboard = createRecurrenceDashboardStore(db, { now: () => now });
  const stats = dashboard.stats(recurrence.summary());
  const wallets = dashboard.wallets({ minDistinctTokens: 3 });

  assert.equal(stats.tokensScanned, 3);
  assert.equal(stats.scansLastHour, 3);
  assert.equal(stats.repeatWallets, 2);
  assert.equal(stats.reviewWallets, 1);
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].walletAddress, WALLET_REPEAT);
  assert.equal(wallets[0].distinctTokens, 3);
  assert.equal(wallets[0].top10Tokens, 3);
  assert.equal(activityState(stats).active, true);
  db.close();
});

test("dashboard lists queue in scanner order and can remove queued work without deleting evidence", () => {
  const now = 5_000_000;
  const db = new Database(":memory:");
  const recurrence = initRecurrenceStore(db);
  recurrence.enqueueTrending({ data: { list: [
    { address: TOKEN_A, symbol: "AAA" },
    { address: TOKEN_B, symbol: "BBB" },
  ] } }, now - 20_000);
  recurrence.enqueuePriorityToken(TOKEN_C, { observedAt: now - 5_000, source: "dashboard" });

  const dashboard = createRecurrenceDashboardStore(db, { now: () => now });
  let queue = dashboard.queue();
  assert.equal(queue.length, 3);
  assert.equal(queue[0].tokenAddress, TOKEN_C);
  assert.equal(queue[0].priority, true);
  assert.equal(queue[0].source, "dashboard");
  assert.equal(queue[1].label, "AAA");

  const cancelled = dashboard.cancelQueuedToken(TOKEN_C);
  assert.equal(cancelled.cancelled, true);
  assert.equal(recurrence.summary().queuedTokens, 2);
  queue = dashboard.queue();
  assert.equal(queue.some((row) => row.tokenAddress === TOKEN_C), false);

  recurrence.enqueuePriorityToken(TOKEN_C, { observedAt: now, source: "dashboard" });
  assert.equal(recurrence.nextToken().token_address, TOKEN_C);
  db.close();
});

test("dashboard HTML includes queue controls and recurrence threshold filters", () => {
  const stats = {
    generatedAt: 10_000,
    lastScanAt: 9_000,
    tokensScanned: 12,
    scansLastHour: 4,
    queuedTokens: 1,
    priorityQueuedTokens: 1,
    walletsSeen: 100,
    walletTokenLinks: 110,
    repeatWallets: 8,
    reviewWallets: 2,
  };
  const html = renderPrivateDashboard(stats, [], {
    minDistinctTokens: 2,
    csrfToken: "csrf-test",
    queue: [{
      tokenAddress: TOKEN_A,
      label: "AAA",
      status: "pending",
      priority: true,
      source: "dashboard",
      firstSeenAt: 8_000,
      lastSeenAt: 9_000,
      lastScannedAt: null,
      scanCount: 0,
      lastError: null,
      priorityQueuedAt: 9_000,
    }],
  });

  assert.match(html, /Add priority scan/);
  assert.match(html, /actions\/token\/cancel/);
  assert.match(html, /csrf-test/);
  assert.match(html, /Recurring wallets — 2\+ distinct tokens/);
  assert.match(html, /href="\/\?min=3"/);
  assert.match(html, new RegExp(TOKEN_A));
});

test("dashboard basic auth fails closed without password and accepts exact credentials", () => {
  assert.equal(dashboardCredentials({}).password, "");
  assert.equal(isAuthorized({ headers: {} }, {}), false);

  const env = { DASHBOARD_USERNAME: "owner", DASHBOARD_PASSWORD: "secret" };
  const good = `Basic ${Buffer.from("owner:secret").toString("base64")}`;
  const bad = `Basic ${Buffer.from("owner:wrong").toString("base64")}`;
  assert.equal(isAuthorized({ headers: { authorization: good } }, env), true);
  assert.equal(isAuthorized({ headers: { authorization: bad } }, env), false);
});

test("scanner activity becomes inactive when completed scans are stale", () => {
  const generatedAt = 10 * 60 * 60 * 1000;
  assert.equal(activityState({ generatedAt, lastScanAt: generatedAt - 5 * 60 * 1000 }).active, true);
  assert.equal(activityState({ generatedAt, lastScanAt: generatedAt - 31 * 60 * 1000 }).active, false);
  assert.equal(activityState({ generatedAt, lastScanAt: null }).active, false);
});
