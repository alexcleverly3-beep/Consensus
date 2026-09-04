"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { createProgressStore, renderDashboard } = require("../src/progress-dashboard");

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE token_discovery_state (
      token_address TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_scanned_at INTEGER,
      scan_count INTEGER NOT NULL DEFAULT 0,
      last_candidate_count INTEGER NOT NULL DEFAULT 0,
      last_consensus_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE consensus_alerts (
      token_address TEXT PRIMARY KEY,
      sent_at INTEGER NOT NULL,
      wallet_count INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE seed_token_queue (
      token_address TEXT NOT NULL,
      source_wallet TEXT NOT NULL,
      discovered_at INTEGER NOT NULL,
      activity_at INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(token_address, source_wallet)
    );
    CREATE TABLE wallet_profiles (
      wallet_address TEXT PRIMARY KEY,
      reputation_score REAL NOT NULL DEFAULT 0,
      confidence_score REAL NOT NULL DEFAULT 0,
      distinct_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE wallet_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      token_address TEXT NOT NULL
    );
  `);
  return db;
}

test("progress snapshot counts trusted wallets without exposing their identities", () => {
  const db = makeDb();
  db.prepare("INSERT INTO meta(key, value) VALUES ('discovery_cycle_number', '14')").run();
  db.prepare(`
    INSERT INTO token_discovery_state(
      token_address, first_seen_at, last_seen_at, last_scanned_at,
      scan_count, last_candidate_count, last_consensus_count
    ) VALUES (?, 1, 1, ?, ?, ?, ?)
  `).run("token-a", 1000, 3, 5, 2);
  db.prepare(`
    INSERT INTO token_discovery_state(
      token_address, first_seen_at, last_seen_at, last_scanned_at,
      scan_count, last_candidate_count, last_consensus_count
    ) VALUES (?, 1, 1, ?, ?, ?, ?)
  `).run("token-b", 2000, 1, 1, 0);
  db.prepare("INSERT INTO wallet_profiles VALUES (?, ?, ?, ?)").run("secret-smart-wallet", 82, 71, 8);
  db.prepare("INSERT INTO wallet_profiles VALUES (?, ?, ?, ?)").run("not-yet-trusted", 90, 20, 10);
  db.prepare("INSERT INTO wallet_evidence(wallet_address, token_address) VALUES (?, ?)").run("secret-smart-wallet", "token-a");
  db.prepare("INSERT INTO wallet_evidence(wallet_address, token_address) VALUES (?, ?)").run("not-yet-trusted", "token-b");
  db.prepare("INSERT INTO consensus_alerts VALUES (?, ?, ?, ?)").run("token-a", 2000, 2, "{}");
  db.prepare("INSERT INTO seed_token_queue(token_address, source_wallet, discovered_at, status) VALUES (?, ?, ?, ?)")
    .run("token-c", "seed-secret", 2000, "pending");

  const store = createProgressStore(db, {
    env: {
      TRUSTED_REPUTATION: "65",
      TRUSTED_CONFIDENCE: "50",
      TRUSTED_DISTINCT_TOKENS: "4",
    },
  });
  const snapshot = store.snapshot();

  assert.equal(snapshot.discoveryCycle, 14);
  assert.deepEqual(snapshot.totals, {
    tokensScanned: 2,
    totalScans: 4,
    evidenceObservations: 2,
    walletsObserved: 2,
    smartWalletsFound: 1,
    consensusAlerts: 1,
    queuedTokens: 1,
  });
  assert.equal(snapshot.recent[0].scannedAt, 2000);
  assert.equal(snapshot.recent[1].candidatesFound, 5);

  const html = renderDashboard(snapshot);
  assert.match(html, /Smart wallets found/);
  assert.match(html, /Recent activity/);
  assert.doesNotMatch(html, /secret-smart-wallet|not-yet-trusted|seed-secret|token-a|token-b/);
  db.close();
});
