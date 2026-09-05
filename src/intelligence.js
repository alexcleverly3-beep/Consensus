"use strict";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function confidenceFromEvidence(evidenceMass, distinctTokens, positiveMass, matureTokens = 0) {
  const breadth = clamp(Math.log2(1 + distinctTokens) / 4.5, 0, 1);
  const quality = evidenceMass > 0
    ? clamp(positiveMass / evidenceMass, 0, 1)
    : 0;
  const validation = distinctTokens > 0
    ? clamp(matureTokens / Math.max(3, distinctTokens), 0, 1)
    : 0;

  const score = Math.round(100 * (0.55 * breadth + 0.25 * quality + 0.20 * validation));

  return {
    score,
    label: score >= 75 ? "high" : score >= 50 ? "medium" : "low",
  };
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    return true;
  }
  return false;
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
      mature_tokens INTEGER NOT NULL DEFAULT 0,
      positive_outcome_tokens INTEGER NOT NULL DEFAULT 0,
      strong_outcome_tokens INTEGER NOT NULL DEFAULT 0,
      validated_winner_tokens INTEGER NOT NULL DEFAULT 0,
      hold_evidence_tokens INTEGER NOT NULL DEFAULT 0,
      meaningful_hold_tokens INTEGER NOT NULL DEFAULT 0,
      avg_outcome_score REAL,
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
      outcome_score REAL,
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

  ensureColumn(db, "wallet_evidence", "outcome_score", "REAL");
  const profileNeedsQualityBackfill = [
    ensureColumn(db, "wallet_profiles", "mature_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ensureColumn(db, "wallet_profiles", "positive_outcome_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ensureColumn(db, "wallet_profiles", "strong_outcome_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ensureColumn(db, "wallet_profiles", "validated_winner_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ensureColumn(db, "wallet_profiles", "hold_evidence_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ensureColumn(db, "wallet_profiles", "meaningful_hold_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ensureColumn(db, "wallet_profiles", "avg_outcome_score", "REAL"),
  ].some(Boolean);

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

  // Reputation is deliberately aggregated by token first. Multiple discovery
  // paths for the same wallet/token are useful provenance, but they are not
  // independent proof that the wallet repeatedly finds winners.
  const aggregateWallet = db.prepare(`
    WITH token_rollup AS (
      SELECT
        token_address,
        COUNT(*) AS source_observations,
        MAX(is_early) AS is_early,
        MAX(is_profitable) AS is_profitable,
        MAX(is_bad_token) AS is_bad_token,
        MAX(CASE WHEN profit_change < -0.5 THEN 1 ELSE 0 END) AS has_large_loss,
        MAX(evidence_weight) AS token_weight,
        AVG(CASE WHEN entry_delay_sec IS NOT NULL AND entry_delay_sec >= 0 THEN entry_delay_sec END) AS entry_delay_sec,
        AVG(CASE WHEN hold_sec IS NOT NULL AND hold_sec >= 0 THEN hold_sec END) AS hold_sec,
        AVG(token_score) AS discovery_score,
        MAX(outcome_score) AS outcome_score,
        MIN(observed_at) AS first_seen_at,
        MAX(observed_at) AS last_seen_at
      FROM wallet_evidence
      WHERE wallet_address = ?
        AND (? IS NULL OR token_address <> ?)
      GROUP BY token_address
    ), scored AS (
      SELECT *,
        CASE
          WHEN discovery_score IS NOT NULL AND outcome_score IS NOT NULL THEN discovery_score * 0.35 + outcome_score * 0.65
          WHEN outcome_score IS NOT NULL THEN outcome_score
          ELSE discovery_score
        END AS token_quality
      FROM token_rollup
    )
    SELECT
      COALESCE(SUM(source_observations), 0) AS observations,
      COUNT(*) AS distinct_tokens,
      COALESCE(SUM(CASE WHEN is_early = 1 OR is_profitable = 1 THEN 1 ELSE 0 END), 0) AS positive_signals,
      COALESCE(SUM(CASE WHEN is_bad_token = 1 OR has_large_loss = 1 THEN 1 ELSE 0 END), 0) AS negative_signals,
      COALESCE(SUM(is_early), 0) AS early_entries,
      COALESCE(SUM(is_profitable), 0) AS profitable_entries,
      COALESCE(SUM(is_bad_token), 0) AS rug_or_bad_token_hits,
      COALESCE(SUM(token_weight), 0) AS evidence_mass,
      COALESCE(SUM(CASE WHEN is_early = 1 OR is_profitable = 1 THEN token_weight ELSE 0 END), 0) AS weighted_positive_signals,
      COALESCE(SUM(CASE WHEN is_bad_token = 1 OR has_large_loss = 1 THEN token_weight ELSE 0 END), 0) AS weighted_negative_signals,
      COALESCE(SUM(CASE WHEN is_early = 1 THEN token_weight ELSE 0 END), 0) AS weighted_early_entries,
      COALESCE(SUM(CASE WHEN is_profitable = 1 THEN token_weight ELSE 0 END), 0) AS weighted_profitable_entries,
      COALESCE(SUM(CASE WHEN is_bad_token = 1 THEN token_weight ELSE 0 END), 0) AS weighted_bad_token_hits,
      COALESCE(SUM(CASE WHEN outcome_score IS NOT NULL THEN 1 ELSE 0 END), 0) AS mature_tokens,
      COALESCE(SUM(CASE WHEN outcome_score >= 68 THEN 1 ELSE 0 END), 0) AS positive_outcome_tokens,
      COALESCE(SUM(CASE WHEN outcome_score >= 85 THEN 1 ELSE 0 END), 0) AS strong_outcome_tokens,
      COALESCE(SUM(CASE
        WHEN is_early = 1 AND is_profitable = 1 AND outcome_score >= 68 THEN 1
        ELSE 0
      END), 0) AS validated_winner_tokens,
      COALESCE(SUM(CASE WHEN hold_sec IS NOT NULL THEN 1 ELSE 0 END), 0) AS hold_evidence_tokens,
      COALESCE(SUM(CASE WHEN hold_sec >= 1800 THEN 1 ELSE 0 END), 0) AS meaningful_hold_tokens,
      AVG(outcome_score) AS avg_outcome_score,
      AVG(entry_delay_sec) AS avg_entry_delay_sec,
      AVG(hold_sec) AS avg_hold_sec,
      SUM(CASE WHEN token_quality IS NOT NULL THEN token_quality * token_weight ELSE 0 END) /
        NULLIF(SUM(CASE WHEN token_quality IS NOT NULL THEN token_weight ELSE 0 END), 0) AS avg_token_score,
      MIN(first_seen_at) AS first_seen_at,
      MAX(last_seen_at) AS last_seen_at
    FROM scored
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
      mature_tokens,
      positive_outcome_tokens,
      strong_outcome_tokens,
      validated_winner_tokens,
      hold_evidence_tokens,
      meaningful_hold_tokens,
      avg_outcome_score,
      reputation_score,
      confidence_score,
      confidence_label
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      mature_tokens = excluded.mature_tokens,
      positive_outcome_tokens = excluded.positive_outcome_tokens,
      strong_outcome_tokens = excluded.strong_outcome_tokens,
      validated_winner_tokens = excluded.validated_winner_tokens,
      hold_evidence_tokens = excluded.hold_evidence_tokens,
      meaningful_hold_tokens = excluded.meaningful_hold_tokens,
      avg_outcome_score = excluded.avg_outcome_score,
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
    ORDER BY reputation_score DESC, confidence_score DESC, distinct_tokens DESC
    LIMIT ?
  `);

  const walletsForTokenStmt = db.prepare(`
    SELECT DISTINCT wallet_address
    FROM wallet_evidence
    WHERE token_address = ?
  `);

  const applyOutcomeStmt = db.prepare(`
    UPDATE wallet_evidence
    SET outcome_score = ?,
        is_bad_token = CASE WHEN ? = 1 THEN 1 ELSE is_bad_token END,
        evidence_weight = CASE
          WHEN ? = 1 THEN MAX(evidence_weight, 1.35)
          WHEN ? >= 85 THEN MAX(evidence_weight, 1.2)
          ELSE evidence_weight
        END
    WHERE token_address = ?
  `);

  function profileFromAggregate(walletAddress, aggregate = {}, now = Date.now()) {
    const observations = num(aggregate.observations);
    const distinctTokens = num(aggregate.distinct_tokens);
    const positiveSignals = num(aggregate.positive_signals);
    const negativeSignals = num(aggregate.negative_signals);
    const earlyEntries = num(aggregate.early_entries);
    const profitableEntries = num(aggregate.profitable_entries);
    const badHits = num(aggregate.rug_or_bad_token_hits);
    const evidenceMass = num(aggregate.evidence_mass, distinctTokens);
    const weightedPositiveSignals = num(aggregate.weighted_positive_signals, positiveSignals);
    const weightedNegativeSignals = num(aggregate.weighted_negative_signals, negativeSignals);
    const weightedEarlyEntries = num(aggregate.weighted_early_entries, earlyEntries);
    const weightedProfitableEntries = num(aggregate.weighted_profitable_entries, profitableEntries);
    const weightedBadHits = num(aggregate.weighted_bad_token_hits, badHits);
    const matureTokens = num(aggregate.mature_tokens);
    const positiveOutcomeTokens = num(aggregate.positive_outcome_tokens);
    const strongOutcomeTokens = num(aggregate.strong_outcome_tokens);
    const validatedWinnerTokens = num(aggregate.validated_winner_tokens);
    const holdEvidenceTokens = num(aggregate.hold_evidence_tokens);
    const meaningfulHoldTokens = num(aggregate.meaningful_hold_tokens);

    const earlyRate = evidenceMass ? weightedEarlyEntries / evidenceMass : 0;
    const profitRate = evidenceMass ? weightedProfitableEntries / evidenceMass : 0;
    const badRate = evidenceMass ? weightedBadHits / evidenceMass : 0;
    const outcomeCoverage = distinctTokens ? matureTokens / distinctTokens : 0;
    const avgScore = num(aggregate.avg_token_score, 50);

    const reputationScore = Math.round(clamp(
      0.36 * avgScore +
      18 * earlyRate +
      20 * profitRate -
      32 * badRate -
      Math.min(14, weightedNegativeSignals * 2) +
      Math.min(8, Math.log2(1 + distinctTokens) * 2.5) +
      6 * clamp(outcomeCoverage, 0, 1),
      0,
      100
    ));

    const confidence = confidenceFromEvidence(
      evidenceMass,
      distinctTokens,
      weightedPositiveSignals,
      matureTokens
    );

    return {
      wallet_address: walletAddress,
      first_seen_at: num(aggregate.first_seen_at, now),
      last_seen_at: num(aggregate.last_seen_at, now),
      observations,
      distinct_tokens: distinctTokens,
      positive_signals: positiveSignals,
      negative_signals: negativeSignals,
      early_entries: earlyEntries,
      profitable_entries: profitableEntries,
      rug_or_bad_token_hits: badHits,
      avg_entry_delay_sec: aggregate.avg_entry_delay_sec,
      avg_hold_sec: aggregate.avg_hold_sec,
      avg_token_score: aggregate.avg_token_score,
      mature_tokens: matureTokens,
      positive_outcome_tokens: positiveOutcomeTokens,
      strong_outcome_tokens: strongOutcomeTokens,
      validated_winner_tokens: validatedWinnerTokens,
      hold_evidence_tokens: holdEvidenceTokens,
      meaningful_hold_tokens: meaningfulHoldTokens,
      avg_outcome_score: aggregate.avg_outcome_score,
      reputation_score: reputationScore,
      confidence_score: confidence.score,
      confidence_label: confidence.label,
    };
  }

  function refreshProfile(walletAddress, now = Date.now()) {
    const profile = profileFromAggregate(
      walletAddress,
      aggregateWallet.get(walletAddress, null, null) || {},
      now
    );

    upsertProfile.run(
      profile.wallet_address,
      profile.first_seen_at,
      profile.last_seen_at,
      profile.observations,
      profile.distinct_tokens,
      profile.positive_signals,
      profile.negative_signals,
      profile.early_entries,
      profile.profitable_entries,
      profile.rug_or_bad_token_hits,
      profile.avg_entry_delay_sec,
      profile.avg_hold_sec,
      profile.avg_token_score,
      profile.mature_tokens,
      profile.positive_outcome_tokens,
      profile.strong_outcome_tokens,
      profile.validated_winner_tokens,
      profile.hold_evidence_tokens,
      profile.meaningful_hold_tokens,
      profile.avg_outcome_score,
      profile.reputation_score,
      profile.confidence_score,
      profile.confidence_label
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

    applyOutcomeStmt.run(score, isBad, isBad, score == null ? 0 : score, tokenAddress);
    const profiles = wallets.map((walletAddress) => refreshProfile(walletAddress));
    return { tokenAddress, updatedWallets: profiles.length, profiles };
  });

  if (profileNeedsQualityBackfill) {
    const walletRows = db.prepare("SELECT DISTINCT wallet_address FROM wallet_evidence").all();
    db.transaction((rows) => {
      for (const row of rows) refreshProfile(row.wallet_address);
    })(walletRows);
  }

  return {
    db,
    recordObservation,
    applyTokenOutcome,
    getProfile(walletAddress) {
      return getProfileStmt.get(walletAddress) || null;
    },
    getProfileExcludingToken(walletAddress, tokenAddress) {
      if (!walletAddress || !tokenAddress) return null;
      const aggregate = aggregateWallet.get(walletAddress, tokenAddress, tokenAddress) || {};
      if (num(aggregate.distinct_tokens) === 0) return null;
      return profileFromAggregate(walletAddress, aggregate);
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