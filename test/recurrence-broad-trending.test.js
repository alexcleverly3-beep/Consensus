"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGmgnExecGuard } = require("../src/gmgn-runtime-guard");

function call(execFile, args) {
  return new Promise((resolve, reject) => {
    execFile("gmgn-cli", args, {}, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

test("recurrence can use the GMGN guard without legacy trending filters", async () => {
  let received = null;
  const fake = (file, args, options, cb) => {
    received = args;
    queueMicrotask(() => cb(null, "ok", ""));
    return {};
  };
  const guarded = createGmgnExecGuard({
    execFile: fake,
    hardenTrending: false,
    ttlForKind: () => 0,
  });
  const requested = [
    "market", "trending", "--chain", "sol", "--interval", "24h",
    "--order-by", "volume", "--limit", "50", "--raw",
  ];

  await call(guarded, requested);

  assert.deepEqual(received, requested);
  assert.equal(received.includes("--min-created"), false);
  assert.equal(received.includes("--min-liquidity"), false);
  assert.equal(received.includes("--min-marketcap"), false);
  assert.equal(received.includes("--min-holder-count"), false);
  assert.equal(received.includes("--max-insider-rate"), false);
  assert.equal(received.includes("--filter"), false);
  assert.equal(guarded.snapshot().hardenTrending, false);
});
