"use strict";

const { RequestBudget, RequestCoalescer } = require("./request-budget");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeFraction(value) {
  const n = num(value);
  if (n > 1 && n <= 100) return n / 100;
  return clamp(n, -10, 10);
}

function traderAddress(trader) {
  return trader?.address || trader?.wallet_address || trader?.wallet || null;
}

function traderTokenEvidence(trader, tokenInfo = {}) {
  const realized = num(trader?.realized_profit);
  const unrealized = num(trader?.unrealized_profit);
  const totalProfit = num(trader?.profit, realized + unrealized);
  const profitChange = normalizeFraction(
    trader?.profit_change ?? trader?.realized_pnl ?? 0
  );
  const buyCount = num(trader?.buy_tx_count_cur);
  const sellCount = num(trader?.sell_tx_count_cur);
  const firstHeld = num(trader?.start_holding_at);
  const opened = num(
    tokenInfo?.open_timestamp ?? tokenInfo?.creation_timestamp
  );
  const entryDelaySec = firstHeld && opened && firstHeld >= opened
    ? firstHeld - opened
    : null;

  const roiQuality = clamp((profitChange + 0.1) / 1.6, 0, 1);
  const profitQuality = clamp(
    Math.log10(1 + Math.max(0, totalProfit)) / Math.log10(50001),
    0,
    1
  );
  const timingQuality = entryDelaySec == null
    ? 0.45
    : entryDelaySec <= 1800
      ? 1
      : entryDelaySec <= 7200
        ? 0.82
        : entryDelaySec <= 21600
          ? 0.68
          : 0.35;
  const txCount = buyCount + sellCount;
  const simplicity = clamp(1 - Math.max(0, txCount - 12) / 70, 0, 1);
  const tokenScore = Math.round(100 * (
    0.4 * roiQuality +
    0.25 * profitQuality +
    0.25 * timingQuality +
    0.10 * simplicity
  ));

  return {
    tokenScore,
    profitChange,
    realizedProfit: realized,
    totalProfit,
    entryDelaySec,
    isEarly: entryDelaySec != null && entryDelaySec <= 21600,
    isProfitable: totalProfit > 0 && profitChange > 0,
    buyCount,
    sellCount,
  };
}

function candidatePriority({ evidence, profile, tags = [] }) {
  const knownQuality = profile
    ? 0.58 * num(profile.reputation_score) +
      0.30 * num(profile.confidence_score) +
      Math.min(12, Math.log2(1 + num(profile.distinct_tokens)) * 3)
    : 0;
  const smartTag = tags.some((tag) =>
    ["smart_degen", "renowned", "kol"].includes(String(tag).toLowerCase())
  ) ? 6 : 0;
  const discoveryQuality =
    0.7 * evidence.tokenScore +
    Math.min(18, Math.log10(1 + Math.max(0, evidence.totalProfit)) * 4);

  return discoveryQuality + knownQuality + smartTag;
}

function defaultTraderFilter(trader, creatorAddress) {
  const wallet = traderAddress(trader);
  if (!wallet) return "invalid-wallet";
  if (creatorAddress && wallet === creatorAddress) return "creator";
  if (Number(trader?.addr_type) === 2) return "exchange-or-pool";
  if (trader?.is_suspicious === true || trader?.is_suspicious === 1) {
    return "suspicious";
  }
  const tags = [
    ...(Array.isArray(trader?.tags) ? trader.tags : []),
    ...(Array.isArray(trader?.maker_token_tags) ? trader.maker_token_tags : []),
  ].map((tag) => String(tag).toLowerCase());
  const blocked = ["rat_trader", "bundler", "dex_bot", "dev", "arbitrager", "mev_bot"];
  const bad = tags.find((tag) => blocked.includes(tag));
  return bad ? `tag:${bad}` : null;
}

function createDiscoveryEngine({
  intelligence,
  fetchWalletStats,
  maxFreshCalls = 12,
  maxEnrichments = 8,
  minTokenScore = 35,
  minTrustedReputation = 65,
  minTrustedConfidence = 50,
  minConsensusWallets = 2,
  traderFilter = defaultTraderFilter,
} = {}) {
  if (!intelligence?.recordObservation || !intelligence?.getProfile) {
    throw new Error("createDiscoveryEngine requires an intelligence store");
  }

  const coalescer = new RequestCoalescer();

  async function processToken({ tokenAddress, tokenInfo = {}, traders = [], source = "discovery" }) {
    if (!tokenAddress) throw new Error("tokenAddress is required");

    const budget = new RequestBudget({ maxFreshCalls });
    const creatorAddress = tokenInfo?.dev?.creator_address || null;
    const candidates = [];
    const rejected = [];

    for (const trader of traders) {
      const walletAddress = traderAddress(trader);
      const exclusion = traderFilter(trader, creatorAddress);
      if (exclusion) {
        rejected.push({ walletAddress, reason: exclusion });
        continue;
      }

      const evidence = traderTokenEvidence(trader, tokenInfo);
      if (evidence.tokenScore < minTokenScore && !evidence.isProfitable) {
        rejected.push({ walletAddress, reason: "weak-token-result" });
        continue;
      }

      // This evidence is already present in the token-trader response, so saving it
      // costs no additional GMGN request. Persist first; enrich only afterwards.
      const profile = intelligence.recordObservation({
        walletAddress,
        tokenAddress,
        source,
        tokenScore: evidence.tokenScore,
        profitChange: evidence.profitChange,
        realizedProfit: evidence.realizedProfit,
        entryDelaySec: evidence.entryDelaySec,
        isEarly: evidence.isEarly,
        isProfitable: evidence.isProfitable,
        evidenceWeight: evidence.isEarly && evidence.isProfitable ? 1.25 : 1,
      });

      const tags = [
        ...(Array.isArray(trader?.tags) ? trader.tags : []),
        ...(Array.isArray(trader?.maker_token_tags) ? trader.maker_token_tags : []),
      ];

      candidates.push({
        walletAddress,
        trader,
        evidence,
        profile,
        priority: candidatePriority({ evidence, profile, tags }),
      });
    }

    candidates.sort((a, b) => b.priority - a.priority);

    let enrichments = 0;
    if (typeof fetchWalletStats === "function") {
      for (const candidate of candidates) {
        if (enrichments >= maxEnrichments) break;
        if (!budget.spend(1)) break;

        try {
          candidate.stats = await coalescer.run(
            `wallet-stats:${candidate.walletAddress}`,
            () => fetchWalletStats(candidate.walletAddress),
            () => budget.hitCoalesced()
          );
          enrichments += 1;
        } catch (error) {
          candidate.statsError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    const trusted = candidates.filter((candidate) => {
      const profile = intelligence.getProfile(candidate.walletAddress) || candidate.profile;
      candidate.profile = profile;
      return num(profile?.reputation_score) >= minTrustedReputation &&
        num(profile?.confidence_score) >= minTrustedConfidence;
    });

    const consensus = trusted.length >= minConsensusWallets
      ? {
          tokenAddress,
          walletCount: trusted.length,
          wallets: trusted.map((candidate) => ({
            walletAddress: candidate.walletAddress,
            reputation: num(candidate.profile?.reputation_score),
            confidence: num(candidate.profile?.confidence_score),
            tokenScore: candidate.evidence.tokenScore,
          })),
        }
      : null;

    return {
      tokenAddress,
      candidates,
      rejected,
      trusted,
      consensus,
      budget: budget.snapshot(),
    };
  }

  return { processToken };
}

module.exports = {
  createDiscoveryEngine,
  traderTokenEvidence,
  candidatePriority,
  defaultTraderFilter,
};
