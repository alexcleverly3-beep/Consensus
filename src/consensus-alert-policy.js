"use strict";

const DEFAULT_ATTEMPT_TTL_MS = 2 * 60 * 1000;
const pendingAttempts = new Map();

function consensusWalletCount(consensus) {
  if (!Array.isArray(consensus?.wallets)) return 0;
  const wallets = new Set();
  for (const wallet of consensus.wallets) {
    const address = String(wallet?.walletAddress || "").trim();
    if (address) wallets.add(address);
  }
  return wallets.size;
}

function parsedPreviousConsensus(previousAlert) {
  if (!previousAlert) return null;
  try {
    return JSON.parse(previousAlert.payload_json);
  } catch {
    return null;
  }
}

function pendingKey(consensus) {
  return String(consensus?.tokenAddress || "").trim();
}

function pendingAttemptActive(previousAlert, consensus, currentCount, now, ttlMs) {
  const tokenAddress = pendingKey(consensus);
  if (!tokenAddress) return false;

  const pending = pendingAttempts.get(tokenAddress);
  if (!pending) return false;

  const previousConsensus = parsedPreviousConsensus(previousAlert);
  const persistedCount = consensusWalletCount(previousConsensus);
  const persistedClaim = Number(previousAlert?.wallet_count);
  const persistedMatches = persistedCount >= 2 &&
    Number.isFinite(persistedClaim) &&
    Math.floor(persistedClaim) === persistedCount;

  // Once the prior attempt is visible in persistent state, its in-memory
  // reservation has served its purpose. Normal monotonic policy decides whether
  // a later, genuinely wider consensus should emit.
  if (persistedMatches && persistedCount >= pending.walletCount) {
    pendingAttempts.delete(tokenAddress);
    return false;
  }

  // A Discord/network failure occurs after policy evaluation but before the
  // database write. Expire the reservation so that kind of failed attempt can be
  // retried later instead of suppressing the token forever.
  if (now - pending.reservedAt >= ttlMs) {
    pendingAttempts.delete(tokenAddress);
    return false;
  }

  // While one attempt is unresolved, do not let a concurrent manual/autonomous
  // path emit or overwrite persistent state for the same token. Preserve the
  // strongest count observed so a weaker first attempt cannot release this guard.
  pending.walletCount = Math.max(pending.walletCount, currentCount);
  return true;
}

function shouldEmitConsensusAlert(previousAlert, consensus, options = {}) {
  const currentCount = consensusWalletCount(consensus);
  if (currentCount < 2) return false;

  const claimedCount = Number(consensus?.walletCount);
  if (!Number.isFinite(claimedCount) || Math.floor(claimedCount) !== currentCount) return false;

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const ttlMs = Number.isFinite(Number(options.attemptTtlMs))
    ? Math.max(1, Number(options.attemptTtlMs))
    : DEFAULT_ATTEMPT_TTL_MS;
  if (pendingAttemptActive(previousAlert, consensus, currentCount, now, ttlMs)) return false;

  if (previousAlert) {
    const previousCount = Number(previousAlert.wallet_count);
    if (!Number.isFinite(previousCount) || previousCount < 0) return false;

    // Do not trust a headline count that is larger than the exact distinct-wallet
    // evidence persisted in the previous payload. Malformed/legacy state fails closed.
    const previousConsensus = parsedPreviousConsensus(previousAlert);
    if (!previousConsensus) return false;
    const previousExactCount = consensusWalletCount(previousConsensus);
    if (previousExactCount < 2 || Math.floor(previousCount) !== previousExactCount) return false;

    // A token only deserves another alert when exact distinct trusted-wallet
    // consensus has materially widened. Time alone never re-alerts.
    if (currentCount <= previousExactCount) return false;
  }

  const tokenAddress = pendingKey(consensus);
  if (tokenAddress) {
    pendingAttempts.set(tokenAddress, { walletCount: currentCount, reservedAt: now });
  }
  return true;
}

module.exports = {
  DEFAULT_ATTEMPT_TTL_MS,
  consensusWalletCount,
  shouldEmitConsensusAlert,
};
