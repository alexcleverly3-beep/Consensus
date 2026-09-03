"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RequestBudget, RequestCoalescer } = require("../src/request-budget");

test("request budget stops fresh work at the configured limit", () => {
  const budget = new RequestBudget({ maxFreshCalls: 2 });

  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), false);

  assert.deepEqual(budget.snapshot(), {
    maxFreshCalls: 2,
    freshCalls: 2,
    remaining: 0,
    cacheHits: 0,
    coalesced: 0,
    skipped: 1,
  });
});

test("coalescer shares an in-flight request", async () => {
  const coalescer = new RequestCoalescer();
  let calls = 0;
  let joined = 0;

  const work = () => coalescer.run(
    "wallet:abc:30d",
    async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true };
    },
    () => { joined += 1; }
  );

  const [a, b] = await Promise.all([work(), work()]);

  assert.equal(calls, 1);
  assert.equal(joined, 1);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: true });
});
