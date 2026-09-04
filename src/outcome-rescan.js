"use strict";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_COOLDOWN_MS = 2 * 60 * 60 * 1000;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function followupStage(row, now = Date.now()) {
  if (!row?.token_address) return null;
  const firstObservedAt = num(row.first_observed_at);
  const snapshots = Math.max(0, Math.floor(num(row.snapshot_count)));
  if (!firstObservedAt) return null;

  const ageMs = Math.max(0, num(now, Date.now()) - firstObservedAt);
  if (ageMs >= DAY_MS && snapshots < 3) return "24h";
  if (ageMs >= SIX_HOURS_MS && snapshots < 2) return "6h";
  return null;
}

function initOutcomeRescan(db, { retryCooldownMs = DEFAULT_RETRY_COOLDOWN_MS } = {}) {
  if (!db?.prepare || !db?.exec) throw new Error("initOutcomeRescan requires a sqlite database");

  db.exec(`
    CREATE TABLE IF NOT EXISTS outcome_rescan_state (
      token_address TEXT PRIMARY KEY,
      last_attempt_at INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);

  const candidateStmt = db.prepare(`
    SELECT o.*, s.last_attempt_at, s.attempt_count, s.last_error
    FROM token_outcomes o
    LEFT JOIN outcome_rescan_state s ON s.token_address = o.token_address
    WHERE
      (o.first_observed_at <= ? AND o.snapshot_count < 2)
      OR (o.first_observed_at <= ? AND o.snapshot_count < 3)
    ORDER BY o.first_observed_at ASC, o.last_observed_at ASC
    LIMIT 50
  `);
  const markStmt = db.prepare(`
    INSERT INTO outcome_rescan_state(token_address, last_attempt_at, attempt_count, last_error)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(token_address) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      attempt_count = outcome_rescan_state.attempt_count + 1,
      last_error = excluded.last_error
  `);

  function nextDue(now = Date.now()) {
    const timestamp = num(now, Date.now());
    const rows = candidateStmt.all(timestamp - SIX_HOURS_MS, timestamp - DAY_MS);
    for (const row of rows) {
      const stage = followupStage(row, timestamp);
      if (!stage) continue;
      const lastAttemptAt = num(row.last_attempt_at);
      if (lastAttemptAt && timestamp - lastAttemptAt < retryCooldownMs) continue;
      return { ...row, stage };
    }
    return null;
  }

  function markAttempt(tokenAddress, { attemptedAt = Date.now(), error = null } = {}) {
    if (!tokenAddress) throw new Error("tokenAddress is required");
    markStmt.run(
      tokenAddress,
      num(attemptedAt, Date.now()),
      error == null ? null : String(error).slice(0, 1000)
    );
  }

  return { nextDue, markAttempt };
}

module.exports = {
  SIX_HOURS_MS,
  DAY_MS,
  DEFAULT_RETRY_COOLDOWN_MS,
  followupStage,
  initOutcomeRescan,
};
