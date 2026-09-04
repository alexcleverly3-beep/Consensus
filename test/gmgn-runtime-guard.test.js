"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGmgnExecGuard, hardenTrendingArgs } = require("../src/gmgn-runtime-guard");

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
  assert.equal(flagValue(args, "--min-created"), "2d");
  assert.equal(flagValue(args, "--min-liquidity"), "20000");
  assert.equal(flagValue(args, "--min-marketcap"), "100000");
  assert.equal(flagValue(args, "--min-volume"), "10000");
  assert.equal(flagValue(args, "--min-holder-count"), "200");
  assert.equal(flagValue(args, "--max-top10-holder-rate"), "0.50");
  assert.equal(flagValue(args, "--max-dev-team-hold-rate"), "0.20");
  assert.equal(flagValue(args, "--max-rug-ratio"), "0.30");
  assert.ok(args.some((value, i) => value === "--filter" && args[i + 1] === "not_wash_trading"));
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
  assert.equal(flagValue(received, "--min-created"), "2d");
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
