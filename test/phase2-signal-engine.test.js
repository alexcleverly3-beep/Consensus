"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {
  USDC_MINT,
  WSOL_MINT,
  canonicalTrustedProfiles,
  enhancedSwapBuys,
  initPhase2SignalStore,
  phase1LeaderboardProfiles,
  rawTransactionBuys,
  signalPoints,
} = require("../src/phase2-signal-engine");

const WALLET_A = "CaHbjM1AGhDPBR6JwiNHaUZAJBykqvj9LPxDouxXbiWB";
const WALLET_B = "7YttLkHDo4yisJ9fsgFj6aNfA7SKz3JcM1wQh2Ve8XrP";
const WALLET_C = "8YttLkHDo4yisJ9fsgFj6aNfA7SKz3JcM1wQh2Ve8XrQ";
const WALLET_D = "9ZttLkHDo4yisJ9fsgFj6aNfA7SKz3JcM1wQh2Ve8XrS";
const TOKEN = "9YttLkHDo4yisJ9fsgFj6aNfA7SKz3JcM1wQh2Ve8XrR";

function enhanced({ wallet = WALLET_A, signature = "sig-1", token = TOKEN, timestamp = 2 } = {}) {
  return {
    type: "SWAP", signature, timestamp, feePayer: wallet,
    events: { swap: {
      nativeInput: { account: wallet, amount: 50_000_000 },
      tokenOutputs: [{ userAccount: wallet, mint: token, rawTokenAmount: { tokenAmount: "100000" } }],
    } },
  };
}

test("signal point bands are simple and bounded", () => {
  assert.equal(signalPoints(69), 0);
  assert.equal(signalPoints(70), 1);
  assert.equal(signalPoints(80), 2);
  assert.equal(signalPoints(90), 3);
  assert.equal(signalPoints(999), 3);
});

test("tracked selection uses the strict existing trust gate rather than recurrence rank", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE wallet_profiles (
    wallet_address TEXT PRIMARY KEY, first_seen_at INTEGER,last_seen_at INTEGER,observations INTEGER,
    distinct_tokens INTEGER,positive_signals INTEGER,negative_signals INTEGER,early_entries INTEGER,
    profitable_entries INTEGER,rug_or_bad_token_hits INTEGER,avg_entry_delay_sec REAL,avg_hold_sec REAL,
    avg_token_score REAL,mature_tokens INTEGER,positive_outcome_tokens INTEGER,strong_outcome_tokens INTEGER,
    validated_winner_tokens INTEGER,hold_evidence_tokens INTEGER,meaningful_hold_tokens INTEGER,
    avg_outcome_score REAL,reputation_score REAL,confidence_score REAL,confidence_label TEXT,last_refreshed_at INTEGER
  ); CREATE TABLE recurrence_wallet_tokens(wallet_address TEXT,token_address TEXT);`);
  const insert = db.prepare(`INSERT INTO wallet_profiles VALUES (?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?)`);
  insert.run(WALLET_A, 1, 2, 12, 12, 12, 0, 12, 12, 0, 60, 7200, 90, 12, 10, 4, 4, 12, 10, 90, 92, 90, "high", 2);
  insert.run(WALLET_B, 1, 2, 1, 1, 1, 0, 1, 1, 0, 60, 7200, 90, 1, 1, 1, 1, 1, 1, 90, 99, 99, "high", 2);
  for (let index = 0; index < 30; index += 1) db.prepare("INSERT INTO recurrence_wallet_tokens VALUES (?,?)").run(WALLET_B, `${"A".repeat(31)}${index % 9 + 1}`);
  const selected = canonicalTrustedProfiles(db, 100);
  assert.deepEqual(selected.map((item) => item.walletAddress), [WALLET_A]);
  assert.equal(selected[0].points, 3);
});

test("tracked selection automatically includes strong Phase 1 leaderboard wallets", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE recurrence_wallet_tokens (
    wallet_address TEXT NOT NULL, token_address TEXT NOT NULL, scan_appearances INTEGER NOT NULL DEFAULT 1,
    best_rank INTEGER NOT NULL, is_creator INTEGER NOT NULL DEFAULT 0, is_insider INTEGER NOT NULL DEFAULT 0
  )`);
  const insert = db.prepare("INSERT INTO recurrence_wallet_tokens VALUES (?,?,?,?,?,?)");
  for (let index = 0; index < 10; index += 1) {
    insert.run(WALLET_C, `${"C".repeat(31)}${index + 1}`, 1, index === 0 ? 8 : 45, 0, 0);
  }
  const selected = phase1LeaderboardProfiles(db, 100);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].walletAddress, WALLET_C);
  assert.equal(selected[0].source, "phase1-leaderboard");
  assert.ok(selected[0].points >= 1);
  assert.deepEqual(canonicalTrustedProfiles(db, 100).map((item) => item.walletAddress), [WALLET_C]);
});

test("Phase 1 leaderboard bridge allows creator and insider wallets during calibration", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE recurrence_wallet_tokens (
    wallet_address TEXT NOT NULL, token_address TEXT NOT NULL, scan_appearances INTEGER NOT NULL DEFAULT 1,
    best_rank INTEGER NOT NULL, is_creator INTEGER NOT NULL DEFAULT 0, is_insider INTEGER NOT NULL DEFAULT 0
  )`);
  const insert = db.prepare("INSERT INTO recurrence_wallet_tokens VALUES (?,?,?,?,?,?)");
  for (let index = 0; index < 12; index += 1) {
    insert.run(WALLET_A, `${"D".repeat(31)}${index + 1}`, 1, index < 4 ? index + 1 : 20, index === 0 ? 1 : 0, 0);
    insert.run(WALLET_B, `${"E".repeat(31)}${index + 1}`, 1, index < 4 ? index + 1 : 20, 0, index === 0 ? 1 : 0);
  }
  assert.deepEqual(phase1LeaderboardProfiles(db, 100).map((profile) => profile.walletAddress), [WALLET_B, WALLET_A]);
});

test("enhanced swaps accept quote-to-token buys and ignore transfers, sells and dust", () => {
  const tracked = new Set([WALLET_A]);
  assert.deepEqual(enhancedSwapBuys(enhanced(), tracked).map((buy) => buy.tokenMint), [TOKEN]);
  assert.deepEqual(enhancedSwapBuys({ ...enhanced(), type: "TRANSFER" }, tracked), []);
  const sell = enhanced();
  sell.events.swap = {
    tokenInputs: [{ userAccount: WALLET_A, mint: TOKEN, rawTokenAmount: { tokenAmount: "10" } }],
    nativeOutput: { account: WALLET_A, amount: 50_000_000 },
  };
  assert.deepEqual(enhancedSwapBuys(sell, tracked), []);
  const dust = enhanced();
  dust.events.swap.nativeInput.amount = 10;
  assert.deepEqual(enhancedSwapBuys(dust, tracked), []);
  const quoteOutput = enhanced({ token: USDC_MINT });
  assert.deepEqual(enhancedSwapBuys(quoteOutput, tracked), []);
});

test("enhanced BUY events cover classified launchpad buys without accepting sells", () => {
  const buy = {
    type: "BUY", signature: "classified-buy", timestamp: 2, feePayer: WALLET_A,
    nativeTransfers: [{ fromUserAccount: WALLET_A, toUserAccount: WALLET_B, amount: 50_000_000 }],
    tokenTransfers: [{ fromUserAccount: WALLET_B, toUserAccount: WALLET_A, tokenAmount: 100, mint: TOKEN }],
  };
  assert.deepEqual(enhancedSwapBuys(buy, new Set([WALLET_A])).map((item) => item.tokenMint), [TOKEN]);
  assert.deepEqual(enhancedSwapBuys({ ...buy, type: "SELL", signature: "classified-sell" }, new Set([WALLET_A])), []);
});

test("raw reconciliation requires a signer spending a quote asset and gaining a token", () => {
  const raw = {
    result: {
      blockTime: 2,
      transaction: {
        signatures: ["raw-sig"],
        message: { accountKeys: [{ pubkey: WALLET_A, signer: true }, { pubkey: TOKEN, signer: false }] },
      },
      meta: {
        err: null, fee: 5_000,
        preBalances: [100_000_000, 0], postBalances: [49_995_000, 0],
        preTokenBalances: [{ owner: WALLET_A, mint: TOKEN, uiTokenAmount: { amount: "0" } }],
        postTokenBalances: [{ owner: WALLET_A, mint: TOKEN, uiTokenAmount: { amount: "100" } }],
      },
    },
  };
  assert.equal(rawTransactionBuys(raw, new Set([WALLET_A])).length, 1);
  raw.result.meta.preBalances[0] = 50_000_000;
  assert.deepEqual(rawTransactionBuys(raw, new Set([WALLET_A])), []);
});

test("store freezes points, deduplicates rebuys and creates one durable threshold alert", () => {
  const db = new Database(":memory:");
  let clock = 1_000;
  const store = initPhase2SignalStore(db, { now: () => clock });
  store.refreshTrackedWallets([
    { walletAddress: WALLET_A, reputation: 92, confidence: 90, points: 3, source: "test", scoreVersion: "v1" },
    { walletAddress: WALLET_B, reputation: 82, confidence: 85, points: 2, source: "test", scoreVersion: "v1" },
    { walletAddress: WALLET_C, reputation: 75, confidence: 80, points: 1, source: "test", scoreVersion: "v1" },
  ], clock);

  clock = 2_000;
  const first = store.recordBuy({ signature: "a1", walletAddress: WALLET_A, tokenMint: TOKEN, boughtAt: clock, source: "test" });
  assert.equal(first.alerted, false);
  clock = 3_000;
  const second = store.recordBuy({ signature: "b1", walletAddress: WALLET_B, tokenMint: TOKEN, boughtAt: clock, source: "test" });
  assert.equal(second.alerted, false);
  clock = 3_500;
  const third = store.recordBuy({ signature: "c1", walletAddress: WALLET_C, tokenMint: TOKEN, boughtAt: clock, source: "test" });
  assert.equal(third.alerted, true);
  assert.equal(third.signal.walletCount, 3);
  assert.equal(third.signal.totalPoints, 6);
  assert.equal(store.nextOutbox().alert_id, third.alertId);

  clock = 4_000;
  const rebuy = store.recordBuy({ signature: "a2", walletAddress: WALLET_A, tokenMint: TOKEN, boughtAt: clock, source: "test" });
  assert.equal(rebuy.alerted, false);
  assert.equal(rebuy.signal.walletCount, 3);
  assert.equal(rebuy.signal.totalPoints, 6);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM phase2_signal_alerts").get().n, 1);
});

test("tracked history rejects old events and preserves frozen points after refresh", () => {
  const db = new Database(":memory:");
  let clock = 10_000;
  const store = initPhase2SignalStore(db, { now: () => clock });
  store.refreshTrackedWallets([{ walletAddress: WALLET_A, reputation: 90, confidence: 90, points: 3, source: "test", scoreVersion: "v1" }], clock);
  assert.equal(store.recordBuy({ signature: "too-old", walletAddress: WALLET_A, tokenMint: TOKEN, boughtAt: 9_999, source: "test" }).reason, "wallet-not-tracked");
  clock = 20_000;
  store.recordBuy({ signature: "first", walletAddress: WALLET_A, tokenMint: TOKEN, boughtAt: 15_000, source: "test" });
  store.refreshTrackedWallets([{ walletAddress: WALLET_A, reputation: 75, confidence: 90, points: 1, source: "test", scoreVersion: "v1" }], clock);
  const saved = db.prepare("SELECT points FROM phase2_wallet_buys WHERE signature='first'").get();
  assert.equal(saved.points, 3);
});

test("a delayed webhook still uses the wallet snapshot active at transaction time", () => {
  const db = new Database(":memory:");
  let clock = 1_000;
  const store = initPhase2SignalStore(db, { now: () => clock });
  store.refreshTrackedWallets([profilesForStore(WALLET_A, 3)], clock);
  clock = 5_000;
  store.refreshTrackedWallets([], clock);
  const event = enhanced({ timestamp: 4, signature: "delayed" });
  store.acceptEnvelope(event, { receivedAt: 6_000 });
  const processed = store.processNext();
  assert.equal(processed.parsedBuys, 1);
  assert.equal(processed.buys[0].accepted, true);
  assert.equal(db.prepare("SELECT points FROM phase2_wallet_buys WHERE signature='delayed'").get().points, 3);
});

test("webhook inbox is idempotent and uses the same signal path", () => {
  const db = new Database(":memory:");
  let clock = 1_000;
  const store = initPhase2SignalStore(db, { now: () => clock });
  store.refreshTrackedWallets([{ walletAddress: WALLET_A, reputation: 90, confidence: 90, points: 3, source: "test", scoreVersion: "v1" }], clock);
  clock = 2_000;
  assert.equal(store.acceptEnvelope(enhanced()).inserted, true);
  assert.equal(store.acceptEnvelope(enhanced()).duplicate, true);
  const processed = store.processNext();
  assert.equal(processed.parsedBuys, 1);
  assert.equal(store.processNext(), null);
  assert.equal(store.stats().duplicateEvents, 1);
});

test("wSOL input counts as quote spend", () => {
  const event = enhanced();
  delete event.events.swap.nativeInput;
  event.events.swap.tokenInputs = [{ userAccount: WALLET_A, mint: WSOL_MINT, rawTokenAmount: { tokenAmount: "50000000" } }];
  assert.equal(enhancedSwapBuys(event, new Set([WALLET_A])).length, 1);
});

test("rolling window expires old wallet contributions", () => {
  const db = new Database(":memory:");
  let clock = 1_000;
  const store = initPhase2SignalStore(db, { env: { SIGNAL_WINDOW_MINUTES: "5" }, now: () => clock });
  store.refreshTrackedWallets([
    { walletAddress: WALLET_A, reputation: 92, confidence: 90, points: 3, source: "test", scoreVersion: "v1" },
    { walletAddress: WALLET_B, reputation: 82, confidence: 85, points: 2, source: "test", scoreVersion: "v1" },
  ], clock);
  clock = 2_000;
  store.recordBuy({ signature: "old-a", walletAddress: WALLET_A, tokenMint: TOKEN, boughtAt: clock, source: "test" });
  clock = 6 * 60_000;
  const result = store.recordBuy({ signature: "late-b", walletAddress: WALLET_B, tokenMint: TOKEN, boughtAt: clock, source: "test" });
  assert.equal(result.signal.walletCount, 1);
  assert.equal(result.alerted, false);
});

test("a token re-alerts only after a new wallet adds the configured point increase", () => {
  const db = new Database(":memory:");
  let clock = 1_000;
  const store = initPhase2SignalStore(db, { now: () => clock });
  store.refreshTrackedWallets([
    profilesForStore(WALLET_A, 3), profilesForStore(WALLET_B, 2), profilesForStore(WALLET_C, 1), profilesForStore(WALLET_D, 3),
  ], clock);
  store.recordBuy({ signature: "a", walletAddress: WALLET_A, tokenMint: TOKEN, boughtAt: 2_000, source: "test" });
  assert.equal(store.recordBuy({ signature: "b", walletAddress: WALLET_B, tokenMint: TOKEN, boughtAt: 3_000, source: "test" }).alerted, false);
  assert.equal(store.recordBuy({ signature: "c", walletAddress: WALLET_C, tokenMint: TOKEN, boughtAt: 4_000, source: "test" }).alerted, true);
  const stronger = store.recordBuy({ signature: "d", walletAddress: WALLET_D, tokenMint: TOKEN, boughtAt: 5_000, source: "test" });
  assert.equal(stronger.alerted, true);
  assert.equal(stronger.signal.totalPoints, 9);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM phase2_signal_alerts").get().n, 2);
});

test("dashboard settings persist, clamp the wallet cap, and immediately change alert rules", () => {
  const db = new Database(":memory:");
  const store = initPhase2SignalStore(db, { now: () => 1_000 });
  const updated = store.updateSettings({
    minDistinctTokens: "7", minTop10Tokens: "2", maxAverageRank: "40",
    trackedWalletLimit: "500", minDistinctWallets: "4", pointsThreshold: "9", signalWindowMinutes: "90",
  });
  assert.equal(updated.trackedWalletLimit, 100);
  assert.equal(updated.minDistinctWallets, 4);
  assert.equal(updated.pointsThreshold, 9);
  assert.equal(updated.signalWindowMs, 90 * 60_000);
  assert.deepEqual(updated.phase1LeaderboardGate, {
    minDistinctTokens: 7, minTop10Tokens: 2, maxAverageRank: 40,
    excludeCreators: false, excludeInsiders: false,
  });
  const restarted = initPhase2SignalStore(db, { now: () => 2_000 });
  assert.equal(restarted.config.trackedWalletLimit, 100);
  assert.equal(restarted.config.pointsThreshold, 9);
  assert.equal(restarted.config.phase1LeaderboardGate.maxAverageRank, 40);
});

test("additive signal-store initialization preserves existing Phase 1 and Phase 2 data", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE recurrence_token_queue(token_address TEXT PRIMARY KEY); INSERT INTO recurrence_token_queue VALUES ('phase-one-token')");
  let store = initPhase2SignalStore(db, { now: () => 1_000 });
  store.refreshTrackedWallets([profilesForStore(WALLET_A, 3)], 1_000);
  store.recordBuy({ signature: "preserved", walletAddress: WALLET_A, tokenMint: TOKEN, boughtAt: 2_000, source: "test" });
  store = initPhase2SignalStore(db, { now: () => 3_000 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recurrence_token_queue").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM phase2_wallet_buys").get().n, 1);
  assert.equal(store.trackedWallets().length, 1);
});

test("Phase 2 reports the last wallet refresh and separates today's Helius credits", () => {
  const db = new Database(":memory:");
  let clock = Date.parse("2026-09-14T23:50:00Z");
  const store = initPhase2SignalStore(db, { now: () => clock });
  store.refreshTrackedWallets([profilesForStore(WALLET_A, 3)], clock);
  store.recordHeliusUsage("webhook-management", 100, clock);
  clock = Date.parse("2026-09-15T00:10:00Z");
  store.recordHeliusUsage("webhook-delivery", 7, clock);
  const status = store.stats(clock);
  assert.equal(status.lastWalletRefreshAt, Date.parse("2026-09-14T23:50:00Z"));
  assert.equal(status.estimatedHeliusCredits, 107);
  assert.equal(status.heliusCallsThisMonth, 2);
  assert.equal(status.estimatedHeliusCreditsToday, 7);
  assert.equal(status.heliusCallsToday, 1);
  assert.deepEqual(status.heliusUsageTodayByKind, { "webhook-delivery": { calls: 1, credits: 7 } });
  assert.deepEqual(store.heliusUsage(clock), { calls: 2, credits: 107, callsToday: 1, creditsToday: 7 });
});

function profilesForStore(walletAddress, points) {
  return { walletAddress, reputation: points === 3 ? 92 : 82, confidence: 90, points, source: "test", scoreVersion: "v1" };
}
