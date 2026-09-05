"use strict";

const DEFAULT_MIN_AGE_MS = 72 * 60 * 60 * 1000;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolFlag(value) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function optionalBool(value) {
  if (value == null || value === "") return null;
  if (boolFlag(value)) return true;
  if (value === false || value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
  return null;
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
  const liquidity = num(row?.liquidity ?? row?.liquidity_usd);
  const marketCap = num(row?.market_cap ?? row?.marketcap ?? row?.fdv);
  // GMGN's trending RankItem exposes `volume` for the requested interval. Keep
  // interval-specific aliases as fallbacks for fixtures/older payload variants.
  const volume = num(
    row?.volume ?? row?.volume_usd ?? row?.volume_24h ?? row?.volume_24h_usd ?? row?.volume_1h
  );
  const holderCount = num(row?.holder_count ?? row?.holders ?? row?.holders_count);

  return {
    liquidity,
    marketCap,
    volume,
    holderCount,
    liquidityToMarketCap: marketCap > 0 ? liquidity / marketCap : 0,
    volumeToLiquidity: liquidity > 0 ? volume / liquidity : 0,
    insider: num(row?.insider_rate ?? row?.rat_trader_amount_rate),
    bundler: num(row?.bundler_rate),
    entrapment: num(row?.entrapment_ratio),
    top70SniperHoldRate: num(row?.top_70_sniper_hold_rate ?? row?.top70_sniper_hold_rate),
    smart: num(row?.smart_degen_count ?? row?.smart_money_count),
    rugRatio: num(row?.rug_ratio),
    top10HolderRate: num(row?.top_10_holder_rate ?? row?.top10_holder_rate),
    devTeamHoldRate: num(row?.dev_team_hold_rate),
    washTrading: boolFlag(row?.is_wash_trading),
    honeypot: boolFlag(row?.is_honeypot),
    renouncedMint: optionalBool(row?.renounced_mint),
    renouncedFreeze: optionalBool(row?.renounced_freeze_account),
    creatorStatus: String(row?.creator_token_status || "").toLowerCase(),
  };
}

function qualityGate(row, {
  now = Date.now(),
  minAgeMs = DEFAULT_MIN_AGE_MS,
  minLiquidity = 50_000,
  minMarketCap = 250_000,
  minVolume = 25_000,
  minHolderCount = 500,
  minLiquidityToMarketCap = 0.02,
  maxVolumeToLiquidity = 12,
  maxInsiderRate = 0.20,
  maxBundlerRate = 0.20,
  maxEntrapmentRatio = 0.20,
  maxTop70SniperHoldRate = 0.15,
  maxRugRatio = 0.15,
  maxTop10HolderRate = 0.40,
  maxDevTeamHoldRate = 0.10,
  rejectCreatorHolding = true,
  requireKnownAge = true,
  requireKnownHolderCount = true,
} = {}) {
  const launch = launchedAt(row);
  const ageMs = launch ? Math.max(0, now - launch) : null;
  const metrics = marketMetrics(row);

  if (requireKnownAge && ageMs == null) return { ok: false, reason: "unknown-age", ageMs, ...metrics };
  if (ageMs != null && ageMs < minAgeMs) return { ok: false, reason: "too-young", ageMs, ...metrics };
  if (metrics.liquidity < minLiquidity) return { ok: false, reason: "low-liquidity", ageMs, ...metrics };
  if (metrics.marketCap < minMarketCap) return { ok: false, reason: "low-market-cap", ageMs, ...metrics };
  if (metrics.volume < minVolume) return { ok: false, reason: "low-volume", ageMs, ...metrics };

  if (requireKnownHolderCount && metrics.holderCount <= 0) {
    return { ok: false, reason: "unknown-holder-count", ageMs, ...metrics };
  }
  if (metrics.holderCount > 0 && metrics.holderCount < minHolderCount) {
    return { ok: false, reason: "low-holder-count", ageMs, ...metrics };
  }

  if (metrics.marketCap > 0 && metrics.liquidityToMarketCap < minLiquidityToMarketCap) {
    return { ok: false, reason: "thin-liquidity", ageMs, ...metrics };
  }
  if (metrics.liquidity > 0 && metrics.volumeToLiquidity > maxVolumeToLiquidity) {
    return { ok: false, reason: "extreme-turnover", ageMs, ...metrics };
  }

  if (metrics.washTrading) return { ok: false, reason: "wash-trading", ageMs, ...metrics };
  if (metrics.honeypot) return { ok: false, reason: "honeypot", ageMs, ...metrics };
  if (metrics.renouncedMint === false) return { ok: false, reason: "mutable-mint-authority", ageMs, ...metrics };
  if (metrics.renouncedFreeze === false) return { ok: false, reason: "active-freeze-authority", ageMs, ...metrics };
  if (metrics.rugRatio > maxRugRatio) return { ok: false, reason: "high-rug-risk", ageMs, ...metrics };
  if (metrics.top10HolderRate > maxTop10HolderRate) return { ok: false, reason: "concentrated-holders", ageMs, ...metrics };
  if (metrics.devTeamHoldRate > maxDevTeamHoldRate) return { ok: false, reason: "high-dev-hold", ageMs, ...metrics };
  if (rejectCreatorHolding && metrics.creatorStatus === "creator_hold") return { ok: false, reason: "creator-still-holding", ageMs, ...metrics };
  if (metrics.insider > maxInsiderRate) return { ok: false, reason: "high-insider-rate", ageMs, ...metrics };
  if (metrics.bundler > maxBundlerRate) return { ok: false, reason: "high-bundler-rate", ageMs, ...metrics };
  if (metrics.entrapment > maxEntrapmentRatio) return { ok: false, reason: "high-entrapment-ratio", ageMs, ...metrics };
  if (metrics.top70SniperHoldRate > maxTop70SniperHoldRate) return { ok: false, reason: "high-sniper-hold", ageMs, ...metrics };
  return { ok: true, reason: null, ageMs, ...metrics };
}

function qualityScore(row, gate) {
  const metrics = gate || marketMetrics(row);
  const ageDays = Number.isFinite(metrics.ageMs) ? metrics.ageMs / 86_400_000 : 0;
  let score = 0;

  score += Math.min(5, ageDays / 2);
  if (metrics.liquidity >= 50_000) score += 2;
  else if (metrics.liquidity >= 20_000) score += 1;
  if (metrics.marketCap >= 500_000) score += 2;
  else if (metrics.marketCap >= 100_000) score += 1;
  if (metrics.volume >= 100_000) score += 2;
  else if (metrics.volume >= 25_000) score += 1;
  if (metrics.holderCount >= 1_000) score += 1;
  if (metrics.liquidityToMarketCap >= 0.05) score += 1;
  if (metrics.smart >= 3) score += 2;
  else if (metrics.smart > 0) score += 1;
  if (metrics.rugRatio > 0.15) score -= 1;
  if (metrics.top10HolderRate > 0.35) score -= 1;
  if (metrics.insider > 0.25) score -= 1;
  if (metrics.bundler > 0.25) score -= 1;
  return score;
}

// Seed-wallet history is allowed to be less fashionable than the autonomous
// trending feed, but obvious low-quality tokens are rejected before the much
// more expensive trader request is spent.
function seedTokenQualityGate(row, options = {}) {
  return qualityGate(row, {
    minAgeMs: 24 * 60 * 60 * 1000,
    minLiquidity: 25_000,
    minMarketCap: 100_000,
    minVolume: 0,
    minHolderCount: 200,
    minLiquidityToMarketCap: 0.01,
    maxVolumeToLiquidity: 25,
    maxInsiderRate: 0.25,
    maxBundlerRate: 0.25,
    maxEntrapmentRatio: 0.25,
    maxTop70SniperHoldRate: 0.20,
    maxRugRatio: 0.20,
    maxTop10HolderRate: 0.45,
    maxDevTeamHoldRate: 0.15,
    requireKnownHolderCount: false,
    ...options,
  });
}

function analyzeTokenCandidates(response, { limit = 8, ...qualityOptions } = {}) {
  const rows = unwrapRows(response);
  const seen = new Set();
  const rejected = {};
  const accepted = [];
  let invalidAddress = 0;
  let duplicateAddress = 0;

  for (const row of rows) {
    const address = tokenAddress(row);
    if (typeof address !== "string" || !SOL_ADDR.test(address)) {
      invalidAddress += 1;
      continue;
    }
    if (seen.has(address)) {
      duplicateAddress += 1;
      continue;
    }
    seen.add(address);

    const gate = qualityGate(row, qualityOptions);
    if (!gate.ok) {
      rejected[gate.reason] = (rejected[gate.reason] || 0) + 1;
      continue;
    }
    accepted.push({ row, address, quality: gate, score: qualityScore(row, gate) });
  }

  accepted.sort((a, b) => b.score - a.score);
  const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 8));
  const candidates = accepted.slice(0, boundedLimit);
  return {
    candidates,
    diagnostics: {
      rows: rows.length,
      uniqueAddresses: seen.size,
      accepted: accepted.length,
      selected: candidates.length,
      invalidAddress,
      duplicateAddress,
      rejected,
    },
  };
}

function formatDiscoveryDiagnostics(diagnostics) {
  const reasons = Object.entries(diagnostics?.rejected || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",");
  return `rows=${diagnostics?.rows || 0} accepted=${diagnostics?.accepted || 0} selected=${diagnostics?.selected || 0} ` +
    `invalid=${diagnostics?.invalidAddress || 0} duplicates=${diagnostics?.duplicateAddress || 0}` +
    (reasons ? ` rejected[${reasons}]` : "");
}

function extractTokenCandidates(response, { limit = 8, diagnosticsLogger = console.log, ...qualityOptions } = {}) {
  const analysis = analyzeTokenCandidates(response, { limit, ...qualityOptions });
  // One concise line per trending fetch makes quality-gate starvation visible in
  // production and consumes no extra API calls. Tests/callers may pass false.
  if (diagnosticsLogger) diagnosticsLogger(`[market-quality] ${formatDiscoveryDiagnostics(analysis.diagnostics)}`);
  return analysis.candidates;
}

function shouldScanToken(lastScannedAt, now = Date.now(), cooldownMs = 6 * 60 * 60 * 1000) {
  return !lastScannedAt || now - Number(lastScannedAt) >= cooldownMs;
}

module.exports = {
  DEFAULT_MIN_AGE_MS,
  analyzeTokenCandidates,
  formatDiscoveryDiagnostics,
  extractTokenCandidates,
  shouldScanToken,
  tokenAddress,
  unwrapRows,
  launchedAt,
  marketMetrics,
  qualityGate,
  seedTokenQualityGate,
  qualityScore,
};
