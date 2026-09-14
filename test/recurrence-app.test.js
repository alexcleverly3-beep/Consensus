"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const {
  clampInt,
  createDiscoveryCycleRunner,
  isGlobalGmgnThrottle,
  publicHealth,
  readJsonBody,
} = require("../src/recurrence-app");

const TOKEN_A = "A".repeat(32);

test("missing dashboard query parameters keep their intended defaults", () => {
  assert.equal(clampInt(null, 3, 2, 100), 3);
  assert.equal(clampInt(undefined, 250, 1, 1000), 250);
  assert.equal(clampInt("", 250, 1, 1000), 250);
  assert.equal(clampInt("4", 3, 2, 100), 4);
  assert.equal(clampInt("5000", 250, 1, 1000), 1000);
});

test("webhook JSON reader validates JSON and enforces its byte limit", async () => {
  const valid = new PassThrough();
  valid.end(JSON.stringify([{ signature: "one" }]));
  assert.deepEqual(await readJsonBody(valid, 100), [{ signature: "one" }]);

  const malformed = new PassThrough();
  malformed.end("not-json");
  await assert.rejects(readJsonBody(malformed, 100), (error) => error.status === 400);

  const oversized = new PassThrough();
  oversized.end(JSON.stringify({ payload: "x".repeat(200) }));
  await assert.rejects(readJsonBody(oversized, 20), (error) => error.status === 413);
});

test("recurrence health exposes collection progress without wallet or token identities", () => {
  const store = {
    summary: () => ({
      tokensSeen: 50,
      tokensScanned: 12,
      totalTokenScans: 13,
      queuedTokens: 38,
      newQueuedTokens: 30,
      rescanQueuedTokens: 8,
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

  const health = publicHealth(store, guard, 10_000, {
    scansLastHour: 9,
    firstScansLastHour: 7,
    rescansLastHour: 2,
    targetScansPerHour: 12,
    maxTargetScansPerHour: 18,
  });
  assert.equal(health.mode, "recurrence-first");
  assert.equal(health.collection.tokensSeen, 50);
  assert.equal(health.collection.repeatWallets, 42);
  assert.equal(health.collection.newQueuedTokens, 30);
  assert.equal(health.collection.rescanQueuedTokens, 8);
  assert.equal(health.collection.lastScanAgeMs, 1000);
  assert.equal(health.collection.scansLastHour, 9);
  assert.equal(health.collection.rescansLastHour, 2);
  assert.equal(health.collection.targetScansPerHour, 12);
  assert.equal(health.gmgn.effectiveMax, 7);
  assert.equal(health.gmgn.remaining, 4);

  const serialized = JSON.stringify(health);
  assert.doesNotMatch(serialized, /secret-wallet|secret-token|walletAddress|tokenAddress|request/);
});

test("queued top-trader work runs before a trending refresh", async () => {
  const events = [];
  let queuedTokens = 1;
  let tokenTaken = false;
  const store = {
    summary: () => ({
      tokensSeen: 10,
      tokensScanned: 0,
      totalTokenScans: 0,
      queuedTokens,
      walletTokenLinks: 0,
      walletsSeen: 0,
      repeatWallets: 0,
      lastScanAt: null,
    }),
    nextToken: () => {
      if (tokenTaken || queuedTokens === 0) return null;
      tokenTaken = true;
      return { token_address: TOKEN_A, trend_json: "{}" };
    },
    ingestTokenTraders: () => {
      events.push("ingest");
      queuedTokens = 0;
      return { accepted: 0, rejected: 0 };
    },
    enqueueTrending: () => {
      events.push("enqueue-trending");
      queuedTokens = 5;
      return { rows: 5, uniqueTokens: 5, added: 5 };
    },
    markFailed: () => { throw new Error("unexpected markFailed"); },
  };

  const runner = createDiscoveryCycleRunner({
    store,
    tokensPerCycle: 2,
    trendingRefreshMs: 60 * 60 * 1000,
    now: () => 1000,
    logger: { log() {}, warn() {} },
    fetchTopTraders: async () => { events.push("top-traders"); return []; },
    fetchTrending: async () => { events.push("fetch-trending"); return { data: { list: [] } }; },
  });

  const result = await runner.discoveryCycle();
  assert.equal(result.successfulScans, 1);
  assert.deepEqual(events.slice(0, 2), ["top-traders", "ingest"]);
  assert.ok(events.indexOf("fetch-trending") > events.indexOf("top-traders"));
});

test("new-token intake refreshes before a routine rescan backlog", async () => {
  const events = [];
  let newQueuedTokens = 0;
  let rescanQueuedTokens = 4;
  let tokenTaken = false;
  const store = {
    summary: () => ({
      tokensSeen: 10,
      queuedTokens: newQueuedTokens + rescanQueuedTokens,
      newQueuedTokens,
      rescanQueuedTokens,
      priorityQueuedTokens: 0,
    }),
    nextToken: () => {
      if (tokenTaken) return null;
      tokenTaken = true;
      return { token_address: TOKEN_A, trend_json: "{}" };
    },
    ingestTokenTraders: () => {
      events.push("ingest");
      newQueuedTokens -= 1;
      return { accepted: 0, rejected: 0 };
    },
    enqueueTrending: () => {
      events.push("enqueue-trending");
      newQueuedTokens = 2;
      return { rows: 2, uniqueTokens: 2, added: 2 };
    },
    markFailed: () => { throw new Error("unexpected markFailed"); },
  };

  const runner = createDiscoveryCycleRunner({
    store,
    tokensPerCycle: 1,
    now: () => 1000,
    logger: { log() {}, warn() {} },
    fetchTopTraders: async () => { events.push("top-traders"); return []; },
    fetchTrending: async () => { events.push("fetch-trending"); return { data: { list: [] } }; },
  });

  const result = await runner.discoveryCycle();
  assert.equal(result.successfulScans, 1);
  assert.deepEqual(events, ["fetch-trending", "enqueue-trending", "top-traders", "ingest"]);
});

test("manual priority work bypasses a new-token intake refresh", async () => {
  const events = [];
  let queuedTokens = 1;
  const store = {
    summary: () => ({ queuedTokens, newQueuedTokens: 0, rescanQueuedTokens: 1, priorityQueuedTokens: queuedTokens }),
    nextToken: () => ({ token_address: TOKEN_A, trend_json: "{}" }),
    ingestTokenTraders: () => { events.push("ingest"); queuedTokens = 0; return { accepted: 0, rejected: 0 }; },
    enqueueTrending: () => { events.push("enqueue-trending"); return { rows: 0, uniqueTokens: 0, added: 0 }; },
    markFailed: () => { throw new Error("unexpected markFailed"); },
  };
  const runner = createDiscoveryCycleRunner({
    store,
    tokensPerCycle: 1,
    now: () => 1000,
    logger: { log() {}, warn() {} },
    fetchTopTraders: async () => { events.push("top-traders"); return []; },
    fetchTrending: async () => { events.push("fetch-trending"); return {}; },
  });

  await runner.discoveryCycle();
  assert.deepEqual(events.slice(0, 2), ["top-traders", "ingest"]);
});

test("global GMGN budget exhaustion does not demote a healthy queued token", async () => {
  let markFailedCalls = 0;
  let trendingCalls = 0;
  const store = {
    summary: () => ({
      tokensSeen: 10,
      tokensScanned: 0,
      totalTokenScans: 0,
      queuedTokens: 5,
      walletTokenLinks: 0,
      walletsSeen: 0,
      repeatWallets: 0,
      lastScanAt: null,
    }),
    nextToken: () => ({ token_address: TOKEN_A, trend_json: "{}" }),
    ingestTokenTraders: () => { throw new Error("unexpected ingest"); },
    enqueueTrending: () => { throw new Error("unexpected trending enqueue"); },
    markFailed: () => { markFailedCalls += 1; },
  };
  const budgetError = new Error("GMGN request budget exhausted (1/1 fresh calls in 20m)");
  budgetError.code = "GMGN_BUDGET_EXHAUSTED";

  const runner = createDiscoveryCycleRunner({
    store,
    tokensPerCycle: 2,
    now: () => 1000,
    logger: { log() {}, warn() {} },
    fetchTopTraders: async () => { throw budgetError; },
    fetchTrending: async () => { trendingCalls += 1; return {}; },
  });

  const result = await runner.discoveryCycle();
  assert.equal(result.throttled, true);
  assert.equal(result.successfulScans, 0);
  assert.equal(markFailedCalls, 0);
  assert.equal(trendingCalls, 0);
});

test("hourly scan plan can pause work without consuming intake or trader calls", async () => {
  let trendingCalls = 0;
  let traderCalls = 0;
  const store = {
    summary: () => ({ tokensSeen: 10, queuedTokens: 4 }),
    nextToken: () => ({ token_address: TOKEN_A, trend_json: "{}" }),
    ingestTokenTraders: () => { throw new Error("unexpected ingest"); },
    enqueueTrending: () => { throw new Error("unexpected trending enqueue"); },
    markFailed: () => { throw new Error("unexpected failure"); },
  };
  const runner = createDiscoveryCycleRunner({
    store,
    tokensPerCycle: 3,
    getScanPlan: () => ({ allowance: 0, reason: "hourly-target-reached" }),
    now: () => 1000,
    logger: { log() {}, warn() {} },
    fetchTopTraders: async () => { traderCalls += 1; return []; },
    fetchTrending: async () => { trendingCalls += 1; return {}; },
  });

  const result = await runner.discoveryCycle();
  assert.equal(result.successfulScans, 0);
  assert.equal(result.scanPlan.reason, "hourly-target-reached");
  assert.equal(traderCalls, 0);
  assert.equal(trendingCalls, 0);
});

test("GMGN throttle detection covers budget, cooldown and provider rate-limit errors", () => {
  assert.equal(isGlobalGmgnThrottle(Object.assign(new Error("budget"), { code: "GMGN_BUDGET_EXHAUSTED" })), true);
  assert.equal(isGlobalGmgnThrottle(new Error("GMGN adaptive cooldown active for 20s")), true);
  assert.equal(isGlobalGmgnThrottle(new Error("429 rate limit exceeded")), true);
  assert.equal(isGlobalGmgnThrottle(new Error("token not found")), false);
});
