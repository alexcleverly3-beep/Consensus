"use strict";

const { qualityGate } = require("./market-discovery");

function flag(value) {
  if (value === true || value === 1 || /^(true|yes|1)$/i.test(String(value))) return true;
  if (value === false || value === 0 || /^(false|no|0)$/i.test(String(value))) return false;
  return null;
}

// Rank trading samples, not wallets or investment recommendations. All inputs
// come from the existing 24h RankItem; there is no enrichment request.
function selectRecurrenceToken(row, observedAt = Date.now()) {
  const reject = (reason) => ({ eligible: false, score: 0, reason });
  if (!row || typeof row !== "object") return reject("missing-metadata");
  const completeSafetyData = ["renounced_mint", "renounced_freeze_account", "top_10_holder_rate"]
    .some((key) => row[key] != null);
  if (!completeSafetyData) return { eligible: true, score: 0, reason: "metadata-pending" };
  if (flag(row.is_honeypot) === true) return reject("honeypot");
  if (flag(row.is_wash_trading) === true) return reject("wash-trading");
  if (flag(row.renounced_mint) === false || flag(row.renounced_freeze_account) === false) {
    return reject("unsafe-authority");
  }
  const concentration = row.top_10_holder_rate ?? row.top10_holder_rate;
  if (concentration != null && (String(concentration).trim() === "" ||
      !Number.isFinite(Number(concentration)) || Number(concentration) < 0)) {
    return reject("unknown-concentration");
  }
  if (concentration != null && Number(concentration) > 0.40) return reject("concentrated-holders");
  // A malformed supplied risk value is not evidence of zero risk.
  for (const key of ["rug_ratio", "insider_rate", "rat_trader_amount_rate", "bundler_rate",
    "entrapment_ratio", "dev_team_hold_rate", "top_70_sniper_hold_rate", "top70_sniper_hold_rate"]) {
    const value = row[key];
    if (value != null && (!Number.isFinite(Number(value)) || String(value).trim() === "" || Number(value) < 0)) {
      return reject("invalid-risk-data");
    }
  }
  const hasSafetyData = completeSafetyData;
  const hasMarketData = ["liquidity", "market_cap", "marketcap", "fdv", "volume", "holder_count"]
    .some((key) => row[key] != null);
  if (!hasMarketData || !hasSafetyData) return { eligible: true, score: 0, reason: "metadata-pending" };
  const gate = qualityGate(row, {
    now: observedAt,
    minAgeMs: 6 * 60 * 60 * 1000,
    minMarketCap: 100_000,
    // Keeping a small dev position alone is not a reason to discard a sample;
    // the existing 10% dev concentration ceiling still applies.
    rejectCreatorHolding: false,
    requireKnownAge: false,
    requireKnownHolderCount: false,
  });
  if (!gate.ok) return reject(gate.reason);
  for (const key of ["buys", "sells"]) {
    if (row[key] != null && (!Number.isFinite(Number(row[key])) || Number(row[key]) <= 0)) {
      return reject("no-two-sided-trading");
    }
  }
  const saturate = (value, ceiling) => Math.min(1, Math.max(0, value) / ceiling);
  // Capped contributions prevent huge old tokens or volume alone dominating.
  let score = 25 * saturate(gate.liquidity, 250_000) +
    20 * saturate(gate.volume, 1_000_000) +
    20 * saturate(gate.holderCount, 5_000) +
    15 * saturate(gate.volumeToLiquidity, 4);
  const buys = Number(row.buys) || 0;
  const sells = Number(row.sells) || 0;
  score += 10 * saturate(buys + sells, 2_000);
  if (buys > 0 && sells > 0) score += 10 * Math.min(buys, sells) / Math.max(buys, sells);
  // Heavy turnover near the rejection boundary is weaker evidence, not a bonus.
  score -= Math.max(0, gate.volumeToLiquidity - 4) * 2;
  score -= 10 * gate.top10HolderRate + 10 * gate.insider + 10 * gate.bundler;
  return { eligible: true, score: Math.round(Math.max(0, score) * 100) / 100, reason: null };
}

module.exports = { selectRecurrenceToken };
