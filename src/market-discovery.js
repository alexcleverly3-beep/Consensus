"use strict";

const DEFAULT_MIN_AGE_MS = 48 * 60 * 60 * 1000;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolFlag(value) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function tokenAddress(row) {
  return row?.address || row?.token_address || row?.token?.address || row?.base_token?.address || row?.base_token_address || null;
}

function unwrapRows(response) {
  const payload = response?.data ?? response ?? {};
  if (Array.isArray(payload)) return payload;
  for (const key of ["list", "rank", "tokens", "items", "data"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function normalizeTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function launchedAt(row) {
  const candidates = [
    row?.open_timestamp,
    row?.creation_timestamp,
    row?.created_at,
    row?.launch_timestamp,
    row?.launch_time,
    row?.pool_creation_timestamp,
    row?.pair_created_at,
    row?.token?.open_timestamp,
    row?.token?.creation_timestamp,
    row?.base_token?.open_timestamp,
    row?.base_token?.creation_timestamp,
  ];
  for (const value of candidates) {
    const timestamp = normalizeTimestamp(value);
    if (timestamp) return timestamp;
  }
  return null;
}

function marketMetrics(row) {
  return {
    liquidity: num(row?.liquidity ?? row?.liquidity_usd),
    marketCap: num(row?.market_cap ?? row?.marketcap ?? row?.fdv),
    volume: num(row?.volume ?? row?.volume_usd ?? row?.volume_1h),
    insider: num(row?.insider_rate ?? row?.rat_trader_amount_rate),
    bundler: num(row?.bundler_rate),
    smart: num(row?.smart_degen_count ?? row?.smart_money_count),
    rugRatio: num(row?.rug_ratio),
    top10HolderRate: num(row?.top_10_holder_rate ?? row?.top10_holder_rate),
    devTeamHoldRate: num(row?.dev_team_hold_rate),
    washTrading: boolFlag(row?.is_wash_trading),
    creatorStatus: String(row?.creator_token_status || "").toLowerCase(),
  };
}

function qualityGate(row, {
  now = Date.now(),
  minAgeMs = DEFAULT_MIN_AGE_MS,
  minLiquidity = 20_000,
  minMarketCap = 100_000,
  minVolume = 10_000,
  maxInsiderRate = 0.35,
  maxBundlerRate = 0.35,
  maxRugRatio = 0.30,
  maxTop10HolderRate = 0.50,
  maxDevTeamHoldRate = 0.20,
  rejectCreatorHolding = true,
  requireKnownAge = true,
} = {}) {
  const launch = launchedAt(row);
  const ageMs = launch ? Math.max(0, now - launch) : null;
  const metrics = marketMetrics(row);

  if (requireKnownAge && ageMs == null) return { ok: false, reason: "unknown-age", ageMs, ...metrics };
  if (ageMs != null && ageMs < minAgeMs) return { ok: false, reason: "too-young", ageMs, ...metrics };
  if (metrics.liquidity < minLiquidity) return { ok: false, reason: "low-liquidity", ageMs, ...metrics };
  if (metrics.marketCap < minMarketCap) return { ok: false, reason: "low-market-cap", ageMs, ...metrics };
  if (metrics.volume < minVolume) return { ok: false, reason: "low-volume", ageMs, ...metrics };
  if (metrics.washTrading) return { ok: false, reason: "wash-trading", ageMs, ...metrics };
  if (metrics.rugRatio > maxRugRatio) return { ok: false, reason: "high-rug-risk", ageMs, ...metrics };
  if (metrics.top10HolderRate > maxTop10HolderRate) return { ok: false, reason: "concentrated-holders", ageMs, ...metrics };
  if (metrics.devTeamHoldRate > maxDevTeamHoldRate) return { ok: false, reason: "high-dev-hold", ageMs, ...metrics };
  if (rejectCreatorHolding && metrics.creatorStatus === "creator_hold") return { ok: false, reason: "creator-still-holding", ageMs, ...metrics };
  if (metrics.insider > maxInsiderRate) return { ok: false, reason: "high-insider-rate", ageMs, ...metrics };
  if (metrics.bundler > maxBundlerRate) return { ok: false, reason: "high-bundler-rate", ageMs, ...metrics };
  return { ok: true, reason: null, ageMs, ...metrics };
}

function qualityScore(row, gate) {
  const metrics = gate || marketMetrics(row);
  const ageDays = Number.isFinite(metrics.ageMs) ? metrics.ageMs / 86_400_000 : 0;
  let score = 0;

  // Survival is deliberately valuable: a token that remains liquid and active for
  // several days is a better training example than a fresh one-hour pump.
  score += Math.min(5, ageDays / 2);
  if (metrics.liquidity >= 50_000) score += 2;
  else if (metrics.liquidity >= 20_000) score += 1;
  if (metrics.marketCap >= 500_000) score += 2;
  else if (metrics.marketCap >= 100_000) score += 1;
  if (metrics.volume >= 100_000) score += 2;
  else if (metrics.volume >= 25_000) score += 1;
  if (metrics.smart >= 3) score += 2;
  else if (metrics.smart > 0) score += 1;
  if (metrics.rugRatio > 0.15) score -= 1;
  if (metrics.top10HolderRate > 0.35) score -= 1;
  if (metrics.insider > 0.25) score -= 1;
  if (metrics.bundler > 0.25) score -= 1;
  return score;
}

function extractTokenCandidates(response, { limit = 8, ...qualityOptions } = {}) {
  const seen = new Set();
  return unwrapRows(response)
    .map((row) => {
      const gate = qualityGate(row, qualityOptions);
      return { row, address: tokenAddress(row), quality: gate, score: gate.ok ? qualityScore(row, gate) : -Infinity };
    })
    .filter(({ address, quality }) => quality.ok && typeof address === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
    .filter(({ address }) => {
      if (seen.has(address)) return false;
      seen.add(address);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 8)));
}

function shouldScanToken(lastScannedAt, now = Date.now(), cooldownMs = 6 * 60 * 60 * 1000) {
  return !lastScannedAt || now - Number(lastScannedAt) >= cooldownMs;
}

module.exports = {
  DEFAULT_MIN_AGE_MS,
  extractTokenCandidates,
  shouldScanToken,
  tokenAddress,
  unwrapRows,
  launchedAt,
  marketMetrics,
  qualityGate,
  qualityScore,
};
