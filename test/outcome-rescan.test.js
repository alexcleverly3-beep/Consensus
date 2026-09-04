"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initTokenOutcomes } = require("../src/token-outcomes");
const { followupStage, initOutcomeRescan, SIX_HOURS_MS, DAY_MS } = require("../src/outcome-rescan");

test("schedules one 6h and one 24h outcome follow-up", () => {
  const start = 1_700_000_000_000;
  assert.equal(followupStage({ token_address: "a", first_observed_at: start, snapshot_count: 1 }, start + SIX_HOURS_MS), "6h");
  assert.equal(followupStage({ token_address: "a", first_observed_at: start, snapshot_count: 2 }, start + SIX_HOURS_MS), null);
  assert.equal(followupStage({ token_address: "a", first_observed_at: start, snapshot_count: 2 }, start + DAY_MS), "24h");
  assert.equal(followupStage({ token_address: "a", first_observed_at: start, snapshot_count: 3 }, start + DAY_MS), null);
});

test("retry cooldown prevents a failed token from consuming every discovery cycle", () => {
  const db = new Database(":memory:");
  const outcomes = initTokenOutcomes(db);
  const scheduler = initOutcomeRescan(db);
  const start = 1_700_000_000_000;
  const dueAt = start + SIX_HOURS_MS;

  outcomes.recordSnapshot({ tokenAddress: "token-a", observedAt: start, tokenInfo: { price: 1 } });
  assert.equal(scheduler.nextDue(dueAt)?.token_address, "token-a");

  scheduler.markAttempt("token-a", { attemptedAt: dueAt, error: "temporary failure" });
  assert.equal(scheduler.nextDue(dueAt + 60 * 60 * 1000), null);
  assert.equal(scheduler.nextDue(dueAt + 2 * 60 * 60 * 1000)?.token_address, "token-a");
  db.close();
});

test("a recorded 6h snapshot advances the token to the 24h stage", () => {
  const db = new Database(":memory:");
  const outcomes = initTokenOutcomes(db);
  const scheduler = initOutcomeRescan(db);
  const start = 1_700_000_000_000;

  outcomes.recordSnapshot({ tokenAddress: "token-a", observedAt: start, tokenInfo: { price: 1 } });
  outcomes.recordSnapshot({ tokenAddress: "token-a", observedAt: start + SIX_HOURS_MS, tokenInfo: { price: 2 } });
  assert.equal(scheduler.nextDue(start + 12 * 60 * 60 * 1000), null);
  assert.equal(scheduler.nextDue(start + DAY_MS)?.stage, "24h");
  db.close();
});
