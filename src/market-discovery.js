"use strict";

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function riskScore(row) {
  const liquidity = num(row?.liquidity ?? row?.liquidity_usd);
  const marketCap = num(row?.market_cap ?? row?.marketcap ?? row?.fdv);
  const volume = num(row?.volume ?? row?.volume_usd ?? row?.volume_1h);
  const smart = num(row?.smart_degen_count ?? row?.smart_money_count);
  const insider = num(row?.insider_rate);
  const bundler = num(row?.bundler_rate);

  let score = 0;
  if (liquidity >= 10000) score += 2;
  if (marketCap >= 50000) score += 1;
  if (volume >= 25000) score += 1;
  if (smart > 0) score += 1;
  if (insider > 0.35) score -= 2;
  if (bundler > 0.35) score -= 2;
  return score;
}

function extractTokenCandidates(response, { limit = 8 } = {}) {
  const seen = new Set();
  return unwrapRows(response)
    .map((row) => ({ row, address: tokenAddress(row), score: riskScore(row) }))
    .filter(({ address }) => typeof address === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
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

module.exports = { extractTokenCandidates, shouldScanToken, tokenAddress, unwrapRows };
