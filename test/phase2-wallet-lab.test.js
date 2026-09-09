"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initRecurrenceStore } = require("../src/recurrence-discovery");
const { initPhase2WalletLab, scoreWalletActivity } = require("../src/phase2-wallet-lab");

const WALLET = "A".repeat(32);
const TOKENS = Array.from({ length: 12 }, (_, i) => String.fromCharCode(66 + i).repeat(32));

function activity() {
  const list = [];
  let t = 1_700_000_000;
  TOKENS.forEach((token, i) => {
    list.push({ event_type: "buy", token_address: token, timestamp: t + i * 7200 });
    list.push({ event_type: "sell", token_address: token, timestamp: t + i * 7200 + 5400 });
  });
  return { data: { list } };
}

test("phase2 lab produces a bounded provisional score with evidence metrics", () => {
  const result = scoreWalletActivity(activity(), { distinctTokens: 4, top10Tokens: 3 });
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(result.confidence >= 0 && result.confidence <= 100);
  assert.equal(result.version, "phase2-lab-v0.1");
  assert.equal(result.metrics.distinctBoughtTokens, 12);
  assert.equal(result.metrics.pairedHoldTokens, 12);
  assert.equal(result.metrics.recurrenceDistinctTokens, 4);
  assert.equal(result.metrics.rapidFlipRate, 0);
});

test("phase2 lab stores analysis separately from human good/bad calibration", () => {
  const db = new Database(":memory:");
  initRecurrenceStore(db);
  const lab = initPhase2WalletLab(db, { now: () => 123456 });
  const first = lab.analyze(WALLET, activity());
  assert.equal(first.humanLabel, "unsure");
  lab.label(WALLET, "good");
  const stored = lab.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].humanLabel, "good");
  assert.equal(stored[0].analyzedAt, 123456);
  assert.equal(stored[0].analysis.version, "phase2-lab-v0.1");
  db.close();
});

test("known-good label survives re-analysis and is not used to inflate the score", () => {
  let now = 100;
  const db = new Database(":memory:");
  initRecurrenceStore(db);
  const lab = initPhase2WalletLab(db, { now: () => now });
  const before = lab.analyze(WALLET, activity()).score;
  lab.label(WALLET, "good");
  now = 200;
  const after = lab.analyze(WALLET, activity());
  assert.equal(after.score, before);
  assert.equal(after.humanLabel, "good");
  assert.equal(lab.list()[0].humanLabel, "good");
  db.close();
});
