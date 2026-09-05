"use strict";

// Precision-first floors: runtime settings may tighten these values but can
// never weaken them and relabel an ordinary candidate as a strong wallet.
const STRONG_WALLET_FLOORS = Object.freeze({
  reputation: 70,
  confidence: 75,
  distinctTokens: 12,
  matureTokens: 8,
  strongOutcomeTokens: 2,
  minEarlyRate: 2 / 3,
  minProfitableRate: 2 / 3,
  maxBadTokenRate: 0.10,
  maxNegativeSignalRate: 0.15,
  minOutcomeCoverageRate: 2 / 3,
  minPositiveOutcomeRate: 0.75,
  minStrongOutcomeRate: 0.25,
  minValidatedWinnerTokens: 2,
  minValidatedWinnerRate: 0.20,
  minHoldEvidenceRate: 0.50,
  minMeaningfulHoldRate: 0.75,
  minAverageHoldSec: 60 * 60,
  maxAverageEntryDelaySec: 60 * 60,
  minAverageTokenScore: 68,
  minAverageOutcomeScore: 68,
});

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function atLeast(value, floor) {
  return Math.max(floor, num(value, floor));
}

function atMost(value, ceiling) {
  return Math.min(ceiling, num(value, ceiling));
}

function trustedProfileQuality(profile, {
  minReputation = STRONG_WALLET_FLOORS.reputation,
  minConfidence = STRONG_WALLET_FLOORS.confidence,
  minDistinctTokens = STRONG_WALLET_FLOORS.distinctTokens,
  minMatureTokens = STRONG_WALLET_FLOORS.matureTokens,
  minStrongOutcomeTokens = STRONG_WALLET_FLOORS.strongOutcomeTokens,
  minEarlyRate = STRONG_WALLET_FLOORS.minEarlyRate,
  minProfitableRate = STRONG_WALLET_FLOORS.minProfitableRate,
  maxBadTokenRate = STRONG_WALLET_FLOORS.maxBadTokenRate,
  maxNegativeSignalRate = STRONG_WALLET_FLOORS.maxNegativeSignalRate,
  minOutcomeCoverageRate = STRONG_WALLET_FLOORS.minOutcomeCoverageRate,
  minPositiveOutcomeRate = STRONG_WALLET_FLOORS.minPositiveOutcomeRate,
  minStrongOutcomeRate = STRONG_WALLET_FLOORS.minStrongOutcomeRate,
  minValidatedWinnerTokens = STRONG_WALLET_FLOORS.minValidatedWinnerTokens,
  minValidatedWinnerRate = STRONG_WALLET_FLOORS.minValidatedWinnerRate,
  minHoldEvidenceRate = STRONG_WALLET_FLOORS.minHoldEvidenceRate,
  minMeaningfulHoldRate = STRONG_WALLET_FLOORS.minMeaningfulHoldRate,
  minAverageHoldSec = STRONG_WALLET_FLOORS.minAverageHoldSec,
  maxAverageEntryDelaySec = STRONG_WALLET_FLOORS.maxAverageEntryDelaySec,
  minAverageTokenScore = STRONG_WALLET_FLOORS.minAverageTokenScore,
  minAverageOutcomeScore = STRONG_WALLET_FLOORS.minAverageOutcomeScore,
} = {}) {
  const reputation = clamp(num(
    profile?.reputation_score ?? profile?.reputationScore ?? profile?.reputation
  ), 0, 100);
  const confidence = clamp(num(
    profile?.confidence_score ?? profile?.confidenceScore ?? profile?.confidence
  ), 0, 100);
  const distinctTokens = Math.max(0, Math.floor(num(profile?.distinct_tokens ?? profile?.distinctTokens)));
  const negativeSignals = Math.max(0, num(profile?.negative_signals ?? profile?.negativeSignals));
  const earlyEntries = Math.max(0, num(profile?.early_entries ?? profile?.earlyEntries));
  const profitableEntries = Math.max(0, num(profile?.profitable_entries ?? profile?.profitableEntries));
  const badHits = Math.max(0, num(profile?.rug_or_bad_token_hits ?? profile?.badTokenHits));
  const matureTokens = Math.max(0, Math.floor(num(profile?.mature_tokens ?? profile?.matureTokens)));
  const positiveOutcomeTokens = Math.max(0, Math.floor(num(
    profile?.positive_outcome_tokens ?? profile?.positiveOutcomeTokens
  )));
  const strongOutcomeTokens = Math.max(0, Math.floor(num(
    profile?.strong_outcome_tokens ?? profile?.strongOutcomeTokens
  )));
  const validatedWinnerTokens = Math.max(0, Math.floor(num(
    profile?.validated_winner_tokens ?? profile?.validatedWinnerTokens
  )));
  const holdEvidenceTokens = Math.max(0, Math.floor(num(
    profile?.hold_evidence_tokens ?? profile?.holdEvidenceTokens
  )));
  const meaningfulHoldTokens = Math.max(0, Math.floor(num(
    profile?.meaningful_hold_tokens ?? profile?.meaningfulHoldTokens
  )));
  const avgEntryDelay = profile?.avg_entry_delay_sec ?? profile?.averageEntryDelaySeconds;
  const avgHold = profile?.avg_hold_sec ?? profile?.averageHoldSeconds;
  const avgTokenScore = profile?.avg_token_score ?? profile?.averageTokenScore;
  const avgOutcomeScore = profile?.avg_outcome_score ?? profile?.averageOutcomeScore;

  const earlyRate = distinctTokens > 0 ? clamp(earlyEntries / distinctTokens, 0, 1) : 0;
  const profitableRate = distinctTokens > 0 ? clamp(profitableEntries / distinctTokens, 0, 1) : 0;
  const badTokenRate = distinctTokens > 0 ? clamp(badHits / distinctTokens, 0, 1) : 1;
  const negativeSignalRate = distinctTokens > 0 ? clamp(negativeSignals / distinctTokens, 0, 1) : 1;
  const outcomeCoverageRate = distinctTokens > 0
    ? clamp(matureTokens / distinctTokens, 0, 1)
    : 0;
  const positiveOutcomeRate = matureTokens > 0
    ? clamp(positiveOutcomeTokens / matureTokens, 0, 1)
    : 0;
  const strongOutcomeRate = matureTokens > 0
    ? clamp(strongOutcomeTokens / matureTokens, 0, 1)
    : 0;
  // This is an exact longitudinal intersection, not an aggregate overlap proxy:
  // each counted token must itself be early, meaningfully profitable, and later
  // validated as a positive mature outcome.
  const validatedWinnerRate = matureTokens > 0
    ? clamp(validatedWinnerTokens / matureTokens, 0, 1)
    : 0;

  const holdEvidenceRate = distinctTokens > 0
    ? clamp(holdEvidenceTokens / distinctTokens, 0, 1)
    : 0;
  const meaningfulHoldRate = holdEvidenceTokens > 0
    ? clamp(meaningfulHoldTokens / holdEvidenceTokens, 0, 1)
    : 0;
  const averageEntryDelaySec = avgEntryDelay == null ? null : Math.max(0, num(avgEntryDelay));
  const averageHoldSec = avgHold == null ? null : Math.max(0, num(avgHold));
  const averageTokenScore = avgTokenScore == null ? null : clamp(num(avgTokenScore), 0, 100);
  const averageOutcomeScore = avgOutcomeScore == null ? null : clamp(num(avgOutcomeScore), 0, 100);

  const thresholds = {
    reputation: atLeast(minReputation, STRONG_WALLET_FLOORS.reputation),
    confidence: atLeast(minConfidence, STRONG_WALLET_FLOORS.confidence),
    distinctTokens: Math.floor(atLeast(minDistinctTokens, STRONG_WALLET_FLOORS.distinctTokens)),
    matureTokens: Math.floor(atLeast(minMatureTokens, STRONG_WALLET_FLOORS.matureTokens)),
    strongOutcomeTokens: Math.floor(atLeast(minStrongOutcomeTokens, STRONG_WALLET_FLOORS.strongOutcomeTokens)),
    minEarlyRate: atLeast(minEarlyRate, STRONG_WALLET_FLOORS.minEarlyRate),
    minProfitableRate: atLeast(minProfitableRate, STRONG_WALLET_FLOORS.minProfitableRate),
    maxBadTokenRate: atMost(maxBadTokenRate, STRONG_WALLET_FLOORS.maxBadTokenRate),
    maxNegativeSignalRate: atMost(maxNegativeSignalRate, STRONG_WALLET_FLOORS.maxNegativeSignalRate),
    minOutcomeCoverageRate: atLeast(minOutcomeCoverageRate, STRONG_WALLET_FLOORS.minOutcomeCoverageRate),
    minPositiveOutcomeRate: atLeast(minPositiveOutcomeRate, STRONG_WALLET_FLOORS.minPositiveOutcomeRate),
    minStrongOutcomeRate: atLeast(minStrongOutcomeRate, STRONG_WALLET_FLOORS.minStrongOutcomeRate),
    minValidatedWinnerTokens: Math.floor(atLeast(
      minValidatedWinnerTokens,
      STRONG_WALLET_FLOORS.minValidatedWinnerTokens
    )),
    minValidatedWinnerRate: atLeast(
      minValidatedWinnerRate,
      STRONG_WALLET_FLOORS.minValidatedWinnerRate
    ),
    minHoldEvidenceRate: atLeast(minHoldEvidenceRate, STRONG_WALLET_FLOORS.minHoldEvidenceRate),
    minMeaningfulHoldRate: atLeast(minMeaningfulHoldRate, STRONG_WALLET_FLOORS.minMeaningfulHoldRate),
    minAverageHoldSec: atLeast(minAverageHoldSec, STRONG_WALLET_FLOORS.minAverageHoldSec),
    maxAverageEntryDelaySec: atMost(
      maxAverageEntryDelaySec,
      STRONG_WALLET_FLOORS.maxAverageEntryDelaySec
    ),
    minAverageTokenScore: atLeast(minAverageTokenScore, STRONG_WALLET_FLOORS.minAverageTokenScore),
    minAverageOutcomeScore: atLeast(minAverageOutcomeScore, STRONG_WALLET_FLOORS.minAverageOutcomeScore),
  };

  const reasons = [];
  if (reputation < thresholds.reputation) reasons.push("low-reputation");
  if (confidence < thresholds.confidence) reasons.push("low-confidence");
  if (distinctTokens < thresholds.distinctTokens) reasons.push("insufficient-breadth");
  if (matureTokens < thresholds.matureTokens) reasons.push("insufficient-mature-outcomes");
  if (strongOutcomeTokens < thresholds.strongOutcomeTokens) reasons.push("insufficient-strong-outcomes");
  if (earlyRate < thresholds.minEarlyRate) reasons.push("weak-early-entry-rate");
  if (profitableRate < thresholds.minProfitableRate) reasons.push("weak-profitability-rate");
  if (badTokenRate > thresholds.maxBadTokenRate) reasons.push("high-bad-token-rate");
  if (negativeSignalRate > thresholds.maxNegativeSignalRate) reasons.push("high-negative-signal-rate");
  if (outcomeCoverageRate < thresholds.minOutcomeCoverageRate) reasons.push("insufficient-outcome-coverage");
  if (positiveOutcomeRate < thresholds.minPositiveOutcomeRate) reasons.push("weak-mature-outcome-rate");
  if (strongOutcomeRate < thresholds.minStrongOutcomeRate) reasons.push("weak-strong-outcome-rate");
  if (
    validatedWinnerTokens < thresholds.minValidatedWinnerTokens ||
    validatedWinnerRate < thresholds.minValidatedWinnerRate
  ) {
    reasons.push("insufficient-aligned-winner-evidence");
  }
  if (holdEvidenceRate < thresholds.minHoldEvidenceRate) reasons.push("insufficient-hold-evidence");
  if (meaningfulHoldRate < thresholds.minMeaningfulHoldRate) reasons.push("short-hold-pattern");
  if (averageHoldSec == null || averageHoldSec < thresholds.minAverageHoldSec) {
    reasons.push("short-average-hold");
  }
  if (averageEntryDelaySec == null || averageEntryDelaySec > thresholds.maxAverageEntryDelaySec) {
    reasons.push("late-average-entry");
  }
  if (averageTokenScore == null || averageTokenScore < thresholds.minAverageTokenScore) {
    reasons.push("weak-average-token-score");
  }
  if (averageOutcomeScore == null || averageOutcomeScore < thresholds.minAverageOutcomeScore) {
    reasons.push("weak-average-outcome-score");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    thresholds,
    metrics: {
      reputation,
      confidence,
      distinctTokens,
      matureTokens,
      positiveOutcomeTokens,
      strongOutcomeTokens,
      validatedWinnerTokens,
      holdEvidenceTokens,
      meaningfulHoldTokens,
      earlyRate,
      profitableRate,
      badTokenRate,
      negativeSignalRate,
      outcomeCoverageRate,
      positiveOutcomeRate,
      strongOutcomeRate,
      validatedWinnerRate,
      holdEvidenceRate,
      meaningfulHoldRate,
      averageEntryDelaySec,
      averageHoldSec,
      averageTokenScore,
      averageOutcomeScore,
    },
  };
}

module.exports = {
  STRONG_WALLET_FLOORS,
  trustedProfileQuality,
};
