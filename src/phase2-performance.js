"use strict";

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeWinRate(value) {
  const parsed = num(value, 0);
  return Math.max(0, Math.min(1, parsed > 1 && parsed <= 100 ? parsed / 100 : parsed));
}

function performanceScore(row = {}) {
  const pnl = row?.pnl_stat || row?.pnlStat || {};
  const winRate = normalizeWinRate(pnl.winrate ?? pnl.win_rate ?? row.winrate ?? row.win_rate);
  const realizedProfit = num(row.realized_profit ?? row.realizedProfit);
  const totalCost = num(row.bought_cost ?? row.boughtCost ?? row.total_cost ?? row.totalCost);
  const roi = num(row.realized_profit_pnl ?? row.realizedProfitPnl ?? row.pnl,
    totalCost > 0 ? realizedProfit / totalCost : 0);
  const positiveTokens = Math.max(0, Math.floor(num(pnl.pnl_gt_5x_num))) +
    Math.max(0, Math.floor(num(pnl.pnl_2x_5x_num))) +
    Math.max(0, Math.floor(num(pnl.pnl_0x_2x_num)));
  const losingTokens = Math.max(0, Math.floor(num(pnl.pnl_nd5_0x_num))) +
    Math.max(0, Math.floor(num(pnl.pnl_lt_nd5_num)));
  const distributionTokens = positiveTokens + losingTokens;
  const tokenCount = Math.max(0, Math.floor(num(pnl.token_num ?? row.token_num, distributionTokens)));
  const severeLossTokens = Math.max(0, Math.floor(num(pnl.pnl_lt_nd5_num)));
  const severeLossRate = tokenCount > 0 ? severeLossTokens / tokenCount : 0;

  let bonus = 0;
  let reason = "insufficient-sample";
  if (tokenCount >= 20 && realizedProfit > 0 && severeLossRate <= 0.25) {
    reason = "win-rate-below-bonus-floor";
    if (winRate >= 0.70) bonus = 8;
    else if (winRate >= 0.60) bonus = 6;
    else if (winRate >= 0.50) bonus = 3;
    if (bonus > 0) {
      if (tokenCount >= 50) bonus += 1;
      if (roi >= 0.20) bonus += 1;
      bonus = Math.min(10, bonus);
      reason = "qualified-performance-bonus";
    }
  } else if (tokenCount >= 20 && realizedProfit <= 0) reason = "non-positive-realized-profit";
  else if (tokenCount >= 20 && severeLossRate > 0.25) reason = "excessive-severe-loss-rate";

  return {
    winRate,
    realizedProfit,
    totalCost,
    roi,
    tokenCount,
    positiveTokens,
    severeLossTokens,
    severeLossRate,
    bonus,
    reason,
  };
}

function statsPayload(response) {
  let payload = response?.data ?? response ?? {};
  if (payload?.data != null && payload.data !== payload) payload = payload.data;
  return payload;
}

function parseWalletStats(response, requestedWallets = []) {
  const requested = requestedWallets.map(String).filter((wallet) => SOL_ADDR.test(wallet));
  const payload = statsPayload(response);
  let rows = [];
  if (Array.isArray(payload)) rows = payload;
  else if (Array.isArray(payload?.list)) rows = payload.list;
  else if (Array.isArray(payload?.wallets)) rows = payload.wallets;
  else if (payload && typeof payload === "object") {
    const keyed = Object.entries(payload).filter(([key, value]) => SOL_ADDR.test(key) && value && typeof value === "object");
    if (keyed.length) rows = keyed.map(([walletAddress, value]) => ({ wallet_address: walletAddress, ...value }));
    else if (requested.length === 1) rows = [{ wallet_address: requested[0], ...payload }];
  }

  const parsed = new Map();
  rows.forEach((row, index) => {
    const walletAddress = String(row?.wallet_address ?? row?.walletAddress ?? row?.wallet ?? row?.address ?? requested[index] ?? "").trim();
    if (!SOL_ADDR.test(walletAddress) || !requested.includes(walletAddress)) return;
    parsed.set(walletAddress, { walletAddress, raw: row, ...performanceScore(row) });
  });
  return parsed;
}

module.exports = { normalizeWinRate, parseWalletStats, performanceScore };
