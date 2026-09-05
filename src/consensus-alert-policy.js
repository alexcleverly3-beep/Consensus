"use strict";

function consensusWalletCount(consensus) {
  if (!Array.isArray(consensus?.wallets)) return 0;
  const wallets = new Set();
  for (const wallet of consensus.wallets) {
    const address = String(wallet?.walletAddress || "").trim();
    if (address) wallets.add(address);
  }
  return wallets.size;
}

function shouldEmitConsensusAlert(previousAlert, consensus) {
  const currentCount = consensusWalletCount(consensus);
  if (currentCount < 2) return false;

  const claimedCount = Number(consensus?.walletCount);
  if (!Number.isFinite(claimedCount) || Math.floor(claimedCount) !== currentCount) return false;
  if (!previousAlert) return true;

  const previousCount = Number(previousAlert.wallet_count);
  if (!Number.isFinite(previousCount) || previousCount < 0) return false;

  // Do not trust a headline count that is larger than the exact distinct-wallet
  // evidence persisted in the previous payload. Malformed/legacy state fails closed.
  let previousConsensus;
  try {
    previousConsensus = JSON.parse(previousAlert.payload_json);
  } catch {
    return false;
  }
  const previousExactCount = consensusWalletCount(previousConsensus);
  if (previousExactCount < 2 || Math.floor(previousCount) !== previousExactCount) return false;

  // A token only deserves another alert when exact distinct trusted-wallet
  // consensus has materially widened. Time alone never re-alerts.
  return currentCount > previousExactCount;
}

module.exports = { consensusWalletCount, shouldEmitConsensusAlert };
