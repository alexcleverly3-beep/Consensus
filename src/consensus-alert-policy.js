"use strict";

function consensusWalletCount(consensus) {
  const count = Number(consensus?.walletCount);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

function shouldEmitConsensusAlert(previousAlert, consensus) {
  const currentCount = consensusWalletCount(consensus);
  if (currentCount < 2) return false;
  if (!previousAlert) return true;

  const previousCount = Number(previousAlert.wallet_count);
  if (!Number.isFinite(previousCount) || previousCount < 0) return false;

  // A token only deserves another alert when consensus has materially widened.
  // Time alone must never make an equivalent or weaker signal alert again.
  return currentCount > Math.floor(previousCount);
}

module.exports = { consensusWalletCount, shouldEmitConsensusAlert };
