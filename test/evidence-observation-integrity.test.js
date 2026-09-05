"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initIntelligence } = require("../src/intelligence");
const { installEvidenceObservationIntegrity } = require("../src/evidence-observation-integrity");

const WALLET = "11111111111111111111111111111111";
const TOKEN = "22222222222222222222222222222222";

test("rescanning the same wallet/token/source preserves first seen and advances last seen", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);
  installEvidenceObservationIntegrity(db);

  intelligence.recordObservation({
    walletAddress: WALLET,
    tokenAddress: TOKEN,
    source: "autonomous",
    observedAt: 1_000,
    tokenScore: 72,
    profitChange: 0.30,
    entryDelaySec: 300,
    holdSec: 900,
    isEarly: true,
    isProfitable: true,
  });

  intelligence.recordObservation({
    walletAddress: WALLET,
    tokenAddress: TOKEN,
    source: "autonomous",
    observedAt: 5_000,
    tokenScore: 80,
    profitChange: 0.60,
    entryDelaySec: 300,
    holdSec: 4_900,
    isEarly: true,
    isProfitable: true,
  });

  const evidence = db.prepare(`
    SELECT observed_at, token_score, profit_change, hold_sec
    FROM wallet_evidence
    WHERE wallet_address = ? AND token_address = ? AND source = ?
  `).get(WALLET, TOKEN, "autonomous");
  const clock = db.prepare(`
    SELECT first_observed_at, last_observed_at
    FROM wallet_evidence_observation_clock
    WHERE wallet_address = ? AND token_address = ? AND source = ?
  `).get(WALLET, TOKEN, "autonomous");
  const profile = intelligence.getProfile(WALLET);

  assert.equal(evidence.observed_at, 1_000);
  assert.equal(evidence.token_score, 80);
  assert.equal(evidence.profit_change, 0.60);
  assert.equal(evidence.hold_sec, 4_900);
  assert.deepEqual(clock, { first_observed_at: 1_000, last_observed_at: 5_000 });
  assert.equal(profile.first_seen_at, 1_000);
  assert.equal(profile.last_seen_at, 5_000);
  assert.equal(profile.observations, 1);
  assert.equal(profile.distinct_tokens, 1);

  db.close();
});

test("observation clock backfills existing evidence without changing evidence cardinality", () => {
  const db = new Database(":memory:");
  const intelligence = initIntelligence(db);

  intelligence.recordObservation({
    walletAddress: WALLET,
    tokenAddress: TOKEN,
    source: "history",
    observedAt: 2_000,
    tokenScore: 70,
    isEarly: true,
    isProfitable: true,
  });

  const before = db.prepare("SELECT COUNT(*) AS count FROM wallet_evidence").get().count;
  const result = installEvidenceObservationIntegrity(db);
  const after = db.prepare("SELECT COUNT(*) AS count FROM wallet_evidence").get().count;
  const clock = db.prepare("SELECT * FROM wallet_evidence_observation_clock").get();

  assert.equal(result.clockRows, 1);
  assert.equal(before, 1);
  assert.equal(after, 1);
  assert.equal(clock.first_observed_at, 2_000);
  assert.equal(clock.last_observed_at, 2_000);

  db.close();
});
