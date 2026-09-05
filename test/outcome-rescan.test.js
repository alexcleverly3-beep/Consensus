"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initTokenOutcomes } = require("../src/token-outcomes");
const { followupStage, initOutcomeRescan, SIX_HOURS_MS, DAY_MS } = require("../src/outcome-rescan");

test("schedules one 6h and one 24h outcome follow-up from snapshot timing", () => {
  const start = 1_700_000_000_000;
  assert.equal(followupStage({ token_address: "a", first_observed_at: start, last_observed_at: start }, start + SIX_HOURS_MS), "6h");
  assert.equal(followupStage({ token_address: "a", first_observed_at: start, last_observed_at: start + SIX_HOURS_MS }, start + SIX_HOURS_MS), null);
  assert.equal(followupStage({ token_address: "a", first_observed_at: start, last_observed_at: start + SIX_HOURS_MS }, start + DAY_MS), "24h");
  assert.equal(followupStage({ token_address: "a", first_observed_at: start, last_observed_at: start + DAY_MS }, start + DAY_MS), null);
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

test("multiple pre-6h scans cannot consume the 6h or 24h outcome milestones", () => {
  const db = new Database(":memory:");
  const outcomes = initTokenOutcomes(db);
  const scheduler = initOutcomeRescan(db);
  const start = 1_700_000_000_000;

  outcomes.recordSnapshot({ tokenAddress: "busy-token", observedAt: start, tokenInfo: { price: 1 } });
  outcomes.recordSnapshot({ tokenAddress: "busy-token", observedAt: start + 60 * 60 * 1000, tokenInfo: { price: 1.1 } });
  outcomes.recordSnapshot({ tokenAddress: "busy-token", observedAt: start + 2 * 60 * 60 * 1000, tokenInfo: { price: 1.2 } });
  outcomes.recordSnapshot({ tokenAddress: "busy-token", observedAt: start + 3 * 60 * 60 * 1000, tokenInfo: { price: 1.3 } });

  const beforeMilestone = outcomes.getOutcome("busy-token");
  assert.equal(beforeMilestone.snapshot_count, 4);
  assert.equal(scheduler.nextDue(start + SIX_HOURS_MS)?.stage, "6h");

  outcomes.recordSnapshot({ tokenAddress: "busy-token", observedAt: start + SIX_HOURS_MS, tokenInfo: { price: 1.5 } });
  assert.equal(scheduler.nextDue(start + 12 * 60 * 60 * 1000), null);
  assert.equal(scheduler.nextDue(start + DAY_MS)?.stage, "24h");
  db.close();
});

test("an ordinary scan after a milestone satisfies that milestone without a duplicate follow-up", () => {
  const db = new Database(":memory:");
  const outcomes = initTokenOutcomes(db);
  const scheduler = initOutcomeRescan(db);
  const start = 1_700_000_000_000;

  outcomes.recordSnapshot({ tokenAddress: "token-a", observedAt: start, tokenInfo: { price: 1 } });
  outcomes.recordSnapshot({ tokenAddress: "token-a", observedAt: start + 8 * 60 * 60 * 1000, tokenInfo: { price: 2 } });

  assert.equal(scheduler.nextDue(start + 10 * 60 * 60 * 1000), null);
  assert.equal(scheduler.nextDue(start + DAY_MS)?.stage, "24h");

  outcomes.recordSnapshot({ tokenAddress: "token-a", observedAt: start + 25 * 60 * 60 * 1000, tokenInfo: { price: 3 } });
  assert.equal(scheduler.nextDue(start + 26 * 60 * 60 * 1000), null);
  db.close();
});
