"use strict";

const { trustedProfileQuality } = require("./wallet-quality");

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function activityRows(response) {
  const payload = response?.data ?? response ?? {};
  const rows = Array.isArray(payload)
    ? payload
    : payload?.list || payload?.activities || payload?.items || response?.list || [];
  return Array.isArray(rows) ? rows : [];
}

function activityKind(row) {
  return String(
    row?.event_type ?? row?.eventType ?? row?.type ?? row?.side ?? row?.action ?? row?.event ?? ""
  ).toLowerCase();
}

function tokenAddress(row) {
  const candidates = [
    row?.token_address,
    row?.tokenAddress,
    row?.token?.address,
    row?.token?.token_address,
    row?.base_token_address,
    row?.baseTokenAddress,
    row?.mint,
    row?.token_mint,
  ];
  return candidates.find((value) => SOL_ADDR.test(String(value || ""))) || null;
}

function activityTimestamp(row) {
  const raw = row?.timestamp ?? row?.time ?? row?.created_at ?? row?.createdAt ?? row?.block_time ?? row?.blockTime;
  const n = num(raw, 0);
  if (n > 0) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isBuy(row) {
  const kind = activityKind(row);
  if (/(^|[^a-z])buy([^a-z]|$)|swap_buy|token_buy/.test(kind)) return true;
  if (/(^|[^a-z])sell([^a-z]|$)|swap_sell|token_sell/.test(kind)) return false;

  const buyAmount = num(row?.buy_amount ?? row?.buyAmount, 0);
  const sellAmount = num(row?.sell_amount ?? row?.sellAmount, 0);
  if (buyAmount > 0 && sellAmount <= 0) return true;

  const flag = row?.is_buy ?? row?.isBuy;
  return flag === true || flag === 1 || String(flag).toLowerCase() === "true" || String(flag) === "1";
}

function extractBoughtTokens(response, { walletAddress = null, limit = 100 } = {}) {
  const seen = new Map();
  for (const row of activityRows(response)) {
    if (!isBuy(row)) continue;
    const address = tokenAddress(row);
    if (!address || address === walletAddress) continue;
    const timestamp = activityTimestamp(row);
    const previous = seen.get(address);
    if (!previous || timestamp > previous.lastActivityAt) {
      seen.set(address, { address, lastActivityAt: timestamp, row });
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, Math.max(1, Math.floor(limit)));
}

function parseSeedWallets(value, fallback = []) {
  const raw = String(value || "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const combined = raw.length ? raw : fallback;
  return [...new Set(combined.filter((wallet) => SOL_ADDR.test(wallet)))];
}

function trustedWalletSeeds(profiles, {
  minReputation = 70,
  minConfidence = 75,
  minDistinctTokens = 12,
  minMatureTokens = 8,
  minStrongOutcomeTokens = 2,
  maxBadTokenRate = 0.10,
  maxNegativeSignalRate = 0.15,
  minEarlyRate = 2 / 3,
  minProfitableRate = 2 / 3,
  minPositiveOutcomeRate = 0.75,
  minHoldEvidenceRate = 0.50,
  minMeaningfulHoldRate = 0.75,
  minAverageHoldSec = 60 * 60,
  maxAverageEntryDelaySec = 60 * 60,
  minAverageTokenScore = 68,
  minAverageOutcomeScore = 68,
  limit = 20,
  exclude = [],
} = {}) {
  const excluded = new Set(exclude.map(String));
  const candidates = [];

  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const walletAddress = String(profile?.wallet_address || profile?.walletAddress || "");
    if (!SOL_ADDR.test(walletAddress) || excluded.has(walletAddress)) continue;

    const reputation = num(profile?.reputation_score ?? profile?.reputationScore);
    const confidence = num(profile?.confidence_score ?? profile?.confidenceScore);
    const quality = trustedProfileQuality(profile, {
      minReputation,
      minConfidence,
      minDistinctTokens,
      minMatureTokens,
      minStrongOutcomeTokens,
      maxBadTokenRate,
      maxNegativeSignalRate,
      minEarlyRate,
      minProfitableRate,
      minPositiveOutcomeRate,
      minHoldEvidenceRate,
      minMeaningfulHoldRate,
      minAverageHoldSec,
      maxAverageEntryDelaySec,
      minAverageTokenScore,
      minAverageOutcomeScore,
    });
    if (!quality.eligible) continue;

    candidates.push({
      walletAddress,
      reputation,
      confidence,
      distinctTokens: quality.metrics.distinctTokens,
      matureTokens: quality.metrics.matureTokens,
      strongOutcomeTokens: quality.metrics.strongOutcomeTokens,
      validatedWinnerTokens: quality.metrics.validatedWinnerTokens,
      validatedWinnerRate: quality.metrics.validatedWinnerRate,
      badTokenRate: quality.metrics.badTokenRate,
      negativeSignalRate: quality.metrics.negativeSignalRate,
      earlyRate: quality.metrics.earlyRate,
      profitableRate: quality.metrics.profitableRate,
      averageEntryDelaySec: quality.metrics.averageEntryDelaySec,
      averageTokenScore: quality.metrics.averageTokenScore,
      positiveOutcomeRate: quality.metrics.positiveOutcomeRate,
      strongOutcomeRate: quality.metrics.strongOutcomeRate,
      averageOutcomeScore: quality.metrics.averageOutcomeScore,
      holdEvidenceRate: quality.metrics.holdEvidenceRate,
      meaningfulHoldRate: quality.metrics.meaningfulHoldRate,
      averageHoldSec: quality.metrics.averageHoldSec,
    });
  }

  // Learned seeds are a scarce recursive-discovery resource. Once wallets clear
  // the same strict trust gate, prefer repeatable exact winners rather than the
  // old confidence-first ordering. This makes the limited learned-seed pool
  // favour wallets that repeatedly bought early, made meaningful profit, and
  // were later validated on the same token. No extra GMGN request is required.
  return candidates
    .sort((a, b) =>
      b.validatedWinnerRate - a.validatedWinnerRate ||
      b.validatedWinnerTokens - a.validatedWinnerTokens ||
      b.strongOutcomeRate - a.strongOutcomeRate ||
      b.positiveOutcomeRate - a.positiveOutcomeRate ||
      b.confidence - a.confidence ||
      b.reputation - a.reputation ||
      b.distinctTokens - a.distinctTokens ||
      a.walletAddress.localeCompare(b.walletAddress)
    )
    .slice(0, Math.max(1, Math.floor(num(limit, 20))));
}

function nextDueSeedWallet({
  configuredWallets = [],
  trustedProfiles = [],
  stateByWallet = () => null,
  now = Date.now(),
  refreshMs = 6 * 60 * 60 * 1000,
  trustedOptions = {},
} = {}) {
  const configured = parseSeedWallets(configuredWallets.join(" "));
  const trusted = trustedWalletSeeds(trustedProfiles, {
    ...trustedOptions,
    exclude: [...configured, ...(trustedOptions.exclude || [])],
  });
  const candidates = [
    ...configured.map((walletAddress, index) => ({ walletAddress, source: "configured", sourceRank: 0, rank: index })),
    ...trusted.map((profile, index) => ({ ...profile, source: "trusted", sourceRank: 1, rank: index })),
  ].map((candidate) => {
    const state = stateByWallet(candidate.walletAddress);
    const lastRefreshedAt = num(state?.last_refreshed_at ?? state?.lastRefreshedAt, 0);
    return { ...candidate, lastRefreshedAt };
  }).filter((candidate) =>
    !candidate.lastRefreshedAt || now - candidate.lastRefreshedAt >= refreshMs
  );

  candidates.sort((a, b) =>
    a.lastRefreshedAt - b.lastRefreshedAt ||
    a.sourceRank - b.sourceRank ||
    a.rank - b.rank ||
    a.walletAddress.localeCompare(b.walletAddress)
  );

  const selected = candidates[0];
  if (!selected) return null;
  const { sourceRank, rank, lastRefreshedAt, ...result } = selected;
  return result;
}

function boundedSeedQueueSelection(tokens, {
  pendingCount = 0,
  maxPending = 1000,
  exists = () => false,
} = {}) {
  const selected = [];
  let skipped = 0;
  let available = Math.max(0, Math.floor(num(maxPending, 1000)) - Math.max(0, num(pendingCount)));

  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (exists(token)) {
      selected.push(token);
      continue;
    }
    if (available <= 0) {
      skipped += 1;
      continue;
    }
    selected.push(token);
    available -= 1;
  }

  return { selected, skipped };
}

module.exports = {
  boundedSeedQueueSelection,
  extractBoughtTokens,
  nextDueSeedWallet,
  parseSeedWallets,
  tokenAddress,
  trustedWalletSeeds,
  isBuy,
};
