"use strict";

function formatBudgetSnapshot(snapshot = {}) {
  const fresh = Number(snapshot.freshCalls || 0);
  const max = Number(snapshot.maxFreshCalls || 0);
  const remaining = Number(snapshot.remaining || 0);
  const cacheHits = Number(snapshot.cacheHits || 0);
  const coalesced = Number(snapshot.coalesced || 0);
  const rejected = Number(snapshot.rejected || 0);
  const windowMinutes = Math.max(1, Math.round(Number(snapshot.windowMs || 0) / 60000));
  return `fresh=${fresh}/${max} remaining=${remaining} cache=${cacheHits} coalesced=${coalesced} rejected=${rejected} window=${windowMinutes}m`;
}

function createRuntimeDiagnostics({ gmgnGuard, logger = console, intervalMs = 20 * 60 * 1000 } = {}) {
  if (!gmgnGuard || typeof gmgnGuard.snapshot !== "function") {
    throw new Error("gmgnGuard with snapshot() is required");
  }

  const safeIntervalMs = Math.max(60 * 1000, Number(intervalMs) || 20 * 60 * 1000);

  function snapshot() {
    return gmgnGuard.snapshot();
  }

  function log() {
    const current = snapshot();
    logger.log(`[gmgn-budget] ${formatBudgetSnapshot(current)}`);
    return current;
  }

  function start() {
    log();
    const timer = setInterval(log, safeIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  return { snapshot, log, start };
}

module.exports = { createRuntimeDiagnostics, formatBudgetSnapshot };
