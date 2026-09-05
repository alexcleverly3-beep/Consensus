"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGmgnExecGuard, hardenTrendingArgs } = require("../src/gmgn-runtime-guard");

test("default guard capacity permits eight carefully spaced calls per window", () => {
  const guarded = createGmgnExecGuard({ execFile: () => {} });
  assert.equal(guarded.snapshot().maxFreshCalls, 8);
  assert.equal(guarded.snapshot().effectiveMaxFreshCalls, 8);
});

function call(execFile, args) {
  return new Promise((resolve, reject) => {
    execFile("gmgn-cli", args, {}, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

test("hardens autonomous trending toward older durable tokens", () => {
  const args = hardenTrendingArgs([
    "market", "trending", "--chain", "sol", "--interval", "1h",
    "--min-liquidity", "10000", "--min-marketcap", "50000",
    "--max-insider-rate", "0.35", "--max-bundler-rate", "0.35",
    "--order-by", "volume", "--limit", "12", "--raw",
  ]);

  assert.equal(flagValue(args, "--interval"), "24h");
  assert.equal(flagValue(args, "--min-created"), "3d");
  assert.equal(flagValue(args, "--min-liquidity"), "50000");
  assert.equal(flagValue(args, "--min-marketcap"), "250000");
  assert.equal(flagValue(args, "--min-volume"), "25000");
  assert.equal(flagValue(args, "--min-holder-count"), "500");
  assert.equal(flagValue(args, "--max-top10-holder-rate"), "0.4");
  assert.equal(flagValue(args, "--max-top70-sniper-hold-rate"), "0.15");
  assert.equal(flagValue(args, "--max-dev-team-hold-rate"), "0.1");
  assert.equal(flagValue(args, "--max-entrapment-ratio"), "0.2");
  assert.equal(flagValue(args, "--max-rug-ratio"), null);
  assert.ok(args.some((value, i) => value === "--filter" && args[i + 1] === "renounced"));
  assert.ok(args.some((value, i) => value === "--filter" && args[i + 1] === "not_wash_trading"));
});

test("trending guard preserves settings that are already stricter", () => {
  const args = hardenTrendingArgs([
    "market", "trending", "--min-created", "7d",
    "--min-liquidity", "100000", "--max-insider-rate", "0.05", "--raw",
  ]);
  assert.equal(flagValue(args, "--min-created"), "7d");
  assert.equal(flagValue(args, "--min-liquidity"), "100000");
  assert.equal(flagValue(args, "--max-insider-rate"), "0.05");
});

test("does not rewrite non-trending GMGN commands", () => {
  const args = ["token", "info", "--chain", "sol", "--address", "abc", "--raw"];
  assert.deepEqual(hardenTrendingArgs(args), args);
});

test("guard passes hardened trending args to the real CLI", async () => {
  let received = null;
  const fake = (file, args, options, cb) => {
    received = args;
    queueMicrotask(() => cb(null, "ok", ""));
    return {};
  };
  const guarded = createGmgnExecGuard({ execFile: fake, ttlForKind: () => 0 });

  await call(guarded, ["market", "trending", "--chain", "sol", "--interval", "1h", "--raw"]);
  assert.equal(flagValue(received, "--interval"), "24h");
  assert.equal(flagValue(received, "--min-created"), "3d");
});

test("guard enforces one shared fresh-call budget", async () => {
  let underlying = 0;
  const fake = (file, args, options, cb) => {
    underlying += 1;
    queueMicrotask(() => cb(null, JSON.stringify({ n: underlying }), ""));
    return {};
  };
  const guarded = createGmgnExecGuard({
    execFile: fake,
    maxFreshCalls: 2,
    windowMs: 60_000,
    ttlForKind: () => 0,
  });

  await call(guarded, ["token", "info", "--address", "a"]);
  await call(guarded, ["market", "trending"]);
  await assert.rejects(
    call(guarded, ["token", "traders", "--address", "b"]),
    (error) => error.code === "GMGN_BUDGET_EXHAUSTED"
  );

  assert.equal(underlying, 2);
  assert.equal(guarded.snapshot().rejected, 1);
});

test("guard caches identical safe reads without spending again", async () => {
  let time = 1_000;
  let underlying = 0;
  const fake = (file, args, options, cb) => {
    underlying += 1;
    queueMicrotask(() => cb(null, `result-${underlying}`, ""));
    return {};
  };
  const guarded = createGmgnExecGuard({
    execFile: fake,
    maxFreshCalls: 2,
    windowMs: 60_000,
    now: () => time,
    ttlForKind: () => 10_000,
  });

  const first = await call(guarded, ["token", "info", "--address", "same"]);
  const second = await call(guarded, ["token", "info", "--address", "same"]);

  assert.equal(first, "result-1");
  assert.equal(second, "result-1");
  assert.equal(underlying, 1);
  assert.equal(guarded.snapshot().cacheHits, 1);

  time += 10_001;
  await call(guarded, ["token", "info", "--address", "same"]);
  assert.equal(underlying, 2);
});

test("guard coalesces duplicate in-flight requests", async () => {
  let underlying = 0;
  let finish;
  const fake = (file, args, options, cb) => {
    underlying += 1;
    finish = () => cb(null, "shared", "");
    return {};
  };
  const guarded = createGmgnExecGuard({
    execFile: fake,
    maxFreshCalls: 2,
    windowMs: 60_000,
    ttlForKind: () => 0,
  });

  const a = call(guarded, ["token", "info", "--address", "same"]);
  const b = call(guarded, ["token", "info", "--address", "same"]);
  finish();
  assert.deepEqual(await Promise.all([a, b]), ["shared", "shared"]);
  assert.equal(underlying, 1);
  assert.equal(guarded.snapshot().coalesced, 1);
});

test("budget resets after its configured window", async () => {
  let time = 0;
  let underlying = 0;
  const fake = (file, args, options, cb) => {
    underlying += 1;
    queueMicrotask(() => cb(null, "ok", ""));
    return {};
  };
  const guarded = createGmgnExecGuard({
    execFile: fake,
    maxFreshCalls: 1,
    windowMs: 60_000,
    now: () => time,
    ttlForKind: () => 0,
  });

  await call(guarded, ["token", "info", "--address", "a"]);
  await assert.rejects(call(guarded, ["token", "info", "--address", "b"]));
  time = 60_001;
  await call(guarded, ["token", "info", "--address", "b"]);
  assert.equal(underlying, 2);
});

test("rate-limit feedback halves the effective budget and activates cooldown", async () => {
  let time = 0;
  let calls = 0;
  const fake = (file, args, options, cb) => {
    calls += 1;
    if (calls === 1) queueMicrotask(() => cb(new Error("429 rate limit exceeded"), "", ""));
    else queueMicrotask(() => cb(null, "ok", ""));
    return {};
  };
  const guarded = createGmgnExecGuard({
    execFile: fake,
    maxFreshCalls: 8,
    minFreshCalls: 2,
    windowMs: 60_000,
    cooldownMs: 5_000,
    now: () => time,
    ttlForKind: () => 0,
  });

  await assert.rejects(call(guarded, ["token", "info", "--address", "a"]));
  assert.equal(guarded.snapshot().effectiveMaxFreshCalls, 4);
  assert.equal(guarded.snapshot().rateLimitEvents, 1);
  await assert.rejects(
    call(guarded, ["token", "info", "--address", "b"]),
    (error) => error.code === "GMGN_COOLDOWN_ACTIVE"
  );
  assert.equal(calls, 1);

  time = 5_001;
  await call(guarded, ["token", "info", "--address", "b"]);
  assert.equal(calls, 2);
});

test("adaptive budget recovers one call after clean windows", async () => {
  let time = 0;
  let calls = 0;
  const fake = (file, args, options, cb) => {
    calls += 1;
    if (calls === 1) queueMicrotask(() => cb(new Error("RATE_LIMIT_EXCEEDED"), "", ""));
    else queueMicrotask(() => cb(null, "ok", ""));
    return {};
  };
  const guarded = createGmgnExecGuard({
    execFile: fake,
    maxFreshCalls: 6,
    minFreshCalls: 1,
    windowMs: 60_000,
    cooldownMs: 1_000,
    recoveryWindows: 1,
    now: () => time,
    ttlForKind: () => 0,
  });

  await assert.rejects(call(guarded, ["token", "info", "--address", "a"]));
  assert.equal(guarded.snapshot().effectiveMaxFreshCalls, 3);
  time = 60_001;
  await call(guarded, ["token", "info", "--address", "b"]);
  time = 120_002;
  assert.equal(guarded.snapshot().effectiveMaxFreshCalls, 4);
});

test("rolling budget and adaptive cooldown survive a guard restart", async () => {
  let time = 1_000;
  let persisted = {};
  const rateLimited = (file, args, options, cb) => {
    queueMicrotask(() => cb(new Error("429 rate limit exceeded"), "", ""));
    return {};
  };
  const first = createGmgnExecGuard({
    execFile: rateLimited,
    maxFreshCalls: 8,
    minFreshCalls: 2,
    windowMs: 60_000,
    cooldownMs: 5_000,
    now: () => time,
    ttlForKind: () => 0,
    onStateChange: (state) => { persisted = state; },
  });

  await assert.rejects(call(first, ["token", "info", "--address", "a"]));
  assert.equal(persisted.freshCalls, 1);
  assert.equal(persisted.effectiveMaxFreshCalls, 4);
  assert.equal(persisted.blockedUntil, 6_000);

  let callsAfterRestart = 0;
  const restarted = createGmgnExecGuard({
    execFile(file, args, options, cb) {
      callsAfterRestart += 1;
      queueMicrotask(() => cb(null, "ok", ""));
      return {};
    },
    maxFreshCalls: 8,
    minFreshCalls: 2,
    windowMs: 60_000,
    cooldownMs: 5_000,
    now: () => time,
    ttlForKind: () => 0,
    initialState: persisted,
  });

  assert.equal(restarted.snapshot().freshCalls, 1);
  assert.equal(restarted.snapshot().effectiveMaxFreshCalls, 4);
  await assert.rejects(
    call(restarted, ["token", "info", "--address", "b"]),
    (error) => error.code === "GMGN_COOLDOWN_ACTIVE"
  );
  assert.equal(callsAfterRestart, 0);

  time = 6_001;
  await call(restarted, ["token", "info", "--address", "b"]);
  assert.equal(callsAfterRestart, 1);
  assert.equal(restarted.snapshot().freshCalls, 2);
});
