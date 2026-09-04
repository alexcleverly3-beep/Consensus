"use strict";

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

  return row?.is_buy === true || row?.isBuy === true;
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
  minReputation = 65,
  minConfidence = 50,
  minDistinctTokens = 4,
  maxBadTokenRate = 0.25,
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
    const distinctTokens = Math.max(0, Math.floor(num(profile?.distinct_tokens ?? profile?.distinctTokens)));
    const badHits = Math.max(0, num(profile?.rug_or_bad_token_hits ?? profile?.badTokenHits));
    const badTokenRate = distinctTokens > 0 ? badHits / distinctTokens : 1;

    if (reputation < minReputation) continue;
    if (confidence < minConfidence) continue;
    if (distinctTokens < minDistinctTokens) continue;
    if (badTokenRate > maxBadTokenRate) continue;

    candidates.push({
      walletAddress,
      reputation,
      confidence,
      distinctTokens,
      badTokenRate,
    });
  }

  return candidates
    .sort((a, b) =>
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
  const ordered = [
    ...configured.map((walletAddress) => ({ walletAddress, source: "configured" })),
    ...trusted.map((profile) => ({ ...profile, source: "trusted" })),
  ];

  return ordered.find((candidate) => {
    const state = stateByWallet(candidate.walletAddress);
    const lastRefreshedAt = num(state?.last_refreshed_at ?? state?.lastRefreshedAt, 0);
    return !lastRefreshedAt || now - lastRefreshedAt >= refreshMs;
  }) || null;
}

module.exports = {
  extractBoughtTokens,
  nextDueSeedWallet,
  parseSeedWallets,
  tokenAddress,
  trustedWalletSeeds,
  isBuy,
};
