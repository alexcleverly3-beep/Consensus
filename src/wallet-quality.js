"use strict";

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function trustedProfileQuality(profile, {
  minDistinctTokens = 6,
  minEarlyRate = 0.5,
  minProfitableRate = 0.6,
  maxBadTokenRate = 0.2,
  maxAverageEntryDelaySec = 2 * 60 * 60,
  minAverageTokenScore = 60,
} = {}) {
  const distinctTokens = Math.max(0, Math.floor(num(profile?.distinct_tokens ?? profile?.distinctTokens)));
  const earlyEntries = Math.max(0, num(profile?.early_entries ?? profile?.earlyEntries));
  const profitableEntries = Math.max(0, num(profile?.profitable_entries ?? profile?.profitableEntries));
  const badHits = Math.max(0, num(profile?.rug_or_bad_token_hits ?? profile?.badTokenHits));
  const avgEntryDelay = profile?.avg_entry_delay_sec ?? profile?.averageEntryDelaySeconds;
  const avgTokenScore = profile?.avg_token_score ?? profile?.averageTokenScore;

  const earlyRate = distinctTokens > 0 ? clamp(earlyEntries / distinctTokens, 0, 1) : 0;
  const profitableRate = distinctTokens > 0 ? clamp(profitableEntries / distinctTokens, 0, 1) : 0;
  const badTokenRate = distinctTokens > 0 ? clamp(badHits / distinctTokens, 0, 1) : 1;
  const averageEntryDelaySec = avgEntryDelay == null ? null : Math.max(0, num(avgEntryDelay));
  const averageTokenScore = avgTokenScore == null ? null : clamp(num(avgTokenScore), 0, 100);

  const reasons = [];
  // This is intentionally a hard quality floor. A low environment override must
  // not turn a handful of lucky trades into a learned discovery seed.
  const breadthFloor = Math.max(6, Math.floor(num(minDistinctTokens, 6)));
  if (distinctTokens < breadthFloor) reasons.push("insufficient-breadth");
  if (earlyRate < minEarlyRate) reasons.push("weak-early-entry-rate");
  if (profitableRate < minProfitableRate) reasons.push("weak-profitability-rate");
  if (badTokenRate > maxBadTokenRate) reasons.push("high-bad-token-rate");
  if (averageEntryDelaySec == null || averageEntryDelaySec > maxAverageEntryDelaySec) {
    reasons.push("late-average-entry");
  }
  if (averageTokenScore == null || averageTokenScore < minAverageTokenScore) {
    reasons.push("weak-average-token-score");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    metrics: {
      distinctTokens,
      earlyRate,
      profitableRate,
      badTokenRate,
      averageEntryDelaySec,
      averageTokenScore,
    },
  };
}

module.exports = {
  trustedProfileQuality,
};
