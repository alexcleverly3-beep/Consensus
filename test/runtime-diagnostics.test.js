"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntimeDiagnostics, formatBudgetSnapshot } = require("../src/runtime-diagnostics");

test("formatBudgetSnapshot exposes request pressure and savings", () => {
  const text = formatBudgetSnapshot({
    freshCalls: 3,
    maxFreshCalls: 5,
    remaining: 2,
    cacheHits: 4,
    coalesced: 1,
    rejected: 2,
    windowMs: 20 * 60 * 1000,
  });
  assert.match(text, /fresh=3\/5/);
  assert.match(text, /remaining=2/);
  assert.match(text, /cache=4/);
  assert.match(text, /coalesced=1/);
  assert.match(text, /rejected=2/);
  assert.match(text, /window=20m/);
});

test("runtime diagnostics reads the installed guard without making GMGN calls", () => {
  let reads = 0;
  const logs = [];
  const diagnostics = createRuntimeDiagnostics({
    gmgnGuard: {
      snapshot() {
        reads += 1;
        return { freshCalls: 1, maxFreshCalls: 5, remaining: 4, windowMs: 1200000 };
      },
    },
    logger: { log: (line) => logs.push(line) },
  });

  const snapshot = diagnostics.log();
  assert.equal(reads, 1);
  assert.equal(snapshot.remaining, 4);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[gmgn-budget\]/);
});
