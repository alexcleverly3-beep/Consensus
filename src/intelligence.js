"use strict";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function confidenceFromEvidence(observations, distinctTokens, positiveSignals) {
  const sample = clamp(Math.log2(1 + observations) / 5, 0, 1);
  const breadth = clamp(Math.log2(1 + distinctTokens) / 5, 0, 1);
  const quality = observations > 0
    ? clamp(positiveSignals / observations, 0, 1)
    : 0;

  const score = Math.round(100 * (0.45 * sample + 0.35 * breadth + 0.20 * quality));

  return {
    score,
    label: score >= 75 ? "high" : score >= 50 ? "medium" : "low",
  };
}

function initIntelligence(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_profiles (
      wallet_address TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      observations INTEGER NOT NULL DEFAULT 0,
      distinct_tokens INTEGER NOT NULL DEFAULT 0,
      positive_signals INTEGER NOT NULL DEFAULT 0,
      negative_signals INTEGER NOT NULL DEFAULT 0,
      early_entries INTEGER NOT NULL DEFAULT 0,
      profitable_entries INTEGER NOT NULL DEFAULT 0,
      rug_or_bad_token_hits INTEGER NOT NULL DEFAULT 0,
      avg_entry_delay_sec REAL,
      avg_hold_sec REAL,
      avg_token_score REAL,
      reputation_score REAL NOT NULL DEFAULT 0,
      confidence_score REAL NOT NULL DEFAULT 0,
      confidence_label TEXT NOT NULL DEFAULT 'low',
      last_refreshed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS wallet_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      token_address TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'scan',
      token_score REAL,
      entry_delay_sec REAL,
      hold_sec REAL,
      profit_change REAL,
      realized_profit REAL,
      is_early INTEGER NOT NULL DEFAULT 0,
      is_profitable INTEGER NOT NULL DEFAULT 0,
      is_bad_token INTEGER NOT NULL DEFAULT 0,
      evidence_weight REAL NOT NULL DEFAULT 1,
      UNIQUE(wallet_address, token_address, source)
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_evidence_wallet
      ON wallet_evidence(wallet_address, observed_at DESC);

    CREATE INDEX IF NOT EXISTS idx_wallet_evidence_token
      ON wallet_evidence(token_address, observed_at DESC);
  `);

  const insertEvidence = db.prepare(`
    INSERT INTO wallet_evidence (
      wallet_address,
      token_address,
      observed_at,
      source,
      token_score,
      entry_delay_sec,
      hold_sec,
      profit_change,
      realized_profit,
      is_early,
      is_profitable,
      is_bad_token,
      evidence_weight
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet_address, token_address, source)
    DO UPDATE SET
      observed_at = excluded.observed_at,
      token_score = excluded.token_score,
      entry_delay_sec = excluded.entry_delay_sec,
      hold_sec = excluded.hold_sec,
      profit_change = excluded.profit_change,
      realized_profit = excluded.realized_profit,
      is_early = excluded.is_early,
      is_profitable = excluded.is_profitable,
      is_bad_token = excluded.is_bad_token,
      evidence_weight = excluded.evidence_weight
  `);

  const aggregateWallet = db.prepare(`
    SELECT
      COUNT(*) AS observations,
      COUNT(DISTINCT token_address) AS distinct_tokens,
      SUM(CASE WHEN is_early = 1 OR is_profitable = 1 THEN 1 ELSE 0 END) AS positive_signals,
      SUM(CASE WHEN is_bad_token = 1 OR profit_change < -0.5 THEN 1 ELSE 0 END) AS negative_signals,
      SUM(is_early) AS early_entries,
      SUM(is_profitable) AS profitable_entries,
      SUM(is_bad_token) AS rug_or_bad_token_hits,
      AVG(CASE WHEN entry_delay_sec IS NOT NULL AND entry_delay_sec >= 0 THEN entry_delay_sec END) AS avg_entry_delay_sec,
      AVG(CASE WHEN hold_sec IS NOT NULL AND hold_sec >= 0 THEN hold_sec END) AS avg_hold_sec,
      AVG(token_score) AS avg_token_score,
      MIN(observed_at) AS first_seen_at,
      MAX(observed_at) AS last_seen_at
    FROM wallet_evidence
    WHERE wallet_address = ?
  `);

  const upsertProfile = db.prepare(`
    INSERT INTO wallet_profiles (
      wallet_address,
      first_seen_at,
      last_seen_at,
      observations,
      distinct_tokens,
      positive_signals,
      negative_signals,
      early_entries,
      profitable_entries,
      rug_or_bad_token_hits,
      avg_entry_delay_sec,
      avg_hold_sec,
      avg_token_score,
      reputation_score,
      confidence_score,
      confidence_label
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet_address)
    DO UPDATE SET
      first_seen_at = excluded.first_seen_at,
      last_seen_at = excluded.last_seen_at,
      observations = excluded.observations,
      distinct_tokens = excluded.distinct_tokens,
      positive_signals = excluded.positive_signals,
      negative_signals = excluded.negative_signals,
      early_entries = excluded.early_entries,
      profitable_entries = excluded.profitable_entries,
      rug_or_bad_token_hits = excluded.rug_or_bad_token_hits,
      avg_entry_delay_sec = excluded.avg_entry_delay_sec,
      avg_hold_sec = excluded.avg_hold_sec,
      avg_token_score = excluded.avg_token_score,
      reputation_score = excluded.reputation_score,
      confidence_score = excluded.confidence_score,
      confidence_label = excluded.confidence_label
  `);

  const getProfileStmt = db.prepare(`
    SELECT * FROM wallet_profiles WHERE wallet_address = ?
  `);

  const topProfilesStmt = db.prepare(`
    SELECT *
    FROM wallet_profiles
    WHERE observations >= ?
    ORDER BY reputation_score DESC, confidence_score DESC, observations DESC
    LIMIT ?
  `);

  const walletsForTokenStmt = db.prepare(`
    SELECT DISTINCT wallet_address
    FROM wallet_evidence
    WHERE token_address = ?
  `);

  const applyOutcomeStmt = db.prepare(`
    UPDATE wallet_evidence
    SET token_score = CASE
          WHEN ? IS NULL THEN token_score
          WHEN token_score IS NULL THEN ?
          ELSE ROUND(token_score * 0.55 + ? * 0.45, 2)
        END,
        is_bad_token = CASE WHEN ? = 1 THEN 1 ELSE is_bad_token END,
        evidence_weight = CASE
          WHEN ? = 1 THEN MAX(evidence_weight, 1.35)
          WHEN ? >= 85 THEN MAX(evidence_weight, 1.2)
          ELSE evidence_weight
        END
    WHERE token_address = ?
  `);

  function refreshProfile(walletAddress, now = Date.now()) {
    const aggregate = aggregateWallet.get(walletAddress);
    const observations = num(aggregate.observations);
    const distinctTokens = num(aggregate.distinct_tokens);
    const positiveSignals = num(aggregate.positive_signals);
    const negativeSignals = num(aggregate.negative_signals);
    const earlyEntries = num(aggregate.early_entries);
    const profitableEntries = num(aggregate.profitable_entries);
    const badHits = num(aggregate.rug_or_bad_token_hits);

    const earlyRate = observations ? earlyEntries / observations : 0;
    const profitRate = observations ? profitableEntries / observations : 0;
    const badRate = observations ? badHits / observations : 0;
    const avgScore = num(aggregate.avg_token_score, 50);

    const reputationScore = Math.round(clamp(
      0.30 * avgScore +
      25 * earlyRate +
      25 * profitRate -
      30 * badRate -
      Math.min(12, negativeSignals * 1.5) +
      Math.min(10, Math.log2(1 + distinctTokens) * 2.5),
      0,
      100
    ));

    const confidence = confidenceFromEvidence(
      observations,
      distinctTokens,
      positiveSignals
    );

    upsertProfile.run(
      walletAddress,
      num(aggregate.first_seen_at, now),
      num(aggregate.last_seen_at, now),
      observations,
      distinctTokens,
      positiveSignals,
      negativeSignals,
      earlyEntries,
      profitableEntries,
      badHits,
      aggregate.avg_entry_delay_sec,
      aggregate.avg_hold_sec,
      aggregate.avg_token_score,
      reputationScore,
      confidence.score,
      confidence.label
    );

    return getProfileStmt.get(walletAddress);
  }

  const recordObservation = db.transaction((observation) => {
    const now = num(observation.observedAt, Date.now());
    const source = String(observation.source || "scan");
    const profitChange = observation.profitChange == null ? null : num(observation.profitChange);
    const tokenScore = observation.tokenScore == null ? null : num(observation.tokenScore);
    const entryDelaySec = observation.entryDelaySec == null ? null : num(observation.entryDelaySec);
    const holdSec = observation.holdSec == null ? null : num(observation.holdSec);
    const realizedProfit = observation.realizedProfit == null ? null : num(observation.realizedProfit);
    const isEarly = observation.isEarly ? 1 : 0;
    const isProfitable = (observation.isProfitable ?? (profitChange != null && profitChange > 0.15)) ? 1 : 0;
    const isBadToken = observation.isBadToken ? 1 : 0;
    const evidenceWeight = clamp(num(observation.evidenceWeight, 1), 0.1, 5);

    insertEvidence.run(
      observation.walletAddress,
      observation.tokenAddress,
      now,
      source,
      tokenScore,
      entryDelaySec,
      holdSec,
      profitChange,
      realizedProfit,
      isEarly,
      isProfitable,
      isBadToken,
      evidenceWeight
    );

    return refreshProfile(observation.walletAddress, now);
  });

  const applyTokenOutcome = db.transaction(({ tokenAddress, outcomeScore, status } = {}) => {
    if (!tokenAddress) throw new Error("tokenAddress is required");
    const score = outcomeScore == null ? null : clamp(num(outcomeScore), 0, 100);
    const isBad = status === "bad" || (score != null && score <= 10) ? 1 : 0;
    const wallets = walletsForTokenStmt.all(tokenAddress).map((row) => row.wallet_address);
    if (!wallets.length) return { tokenAddress, updatedWallets: 0, profiles: [] };

    applyOutcomeStmt.run(score, score, score, isBad, isBad, score == null ? 0 : score, tokenAddress);
    const profiles = wallets.map((walletAddress) => refreshProfile(walletAddress));
    return { tokenAddress, updatedWallets: profiles.length, profiles };
  });

  return {
    db,
    recordObservation,
    applyTokenOutcome,
    getProfile(walletAddress) {
      return getProfileStmt.get(walletAddress) || null;
    },
    getTopProfiles({ limit = 25, minObservations = 2 } = {}) {
      return topProfilesStmt.all(
        clamp(Math.floor(num(minObservations, 2)), 1, 1000000),
        clamp(Math.floor(num(limit, 25)), 1, 500)
      );
    },
  };
}

module.exports = {
  initIntelligence,
  confidenceFromEvidence,
};
