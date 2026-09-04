"use strict";

function formatBudgetSnapshot(snapshot = {}) {
  const fresh = Number(snapshot.freshCalls || 0);
  const max = Number(snapshot.maxFreshCalls || 0);
  const effectiveMax = Number(snapshot.effectiveMaxFreshCalls ?? max);
  const remaining = Number(snapshot.remaining || 0);
  const cacheHits = Number(snapshot.cacheHits || 0);
  const coalesced = Number(snapshot.coalesced || 0);
  const rejected = Number(snapshot.rejected || 0);
  const rateLimits = Number(snapshot.rateLimitEvents || 0);
  const cooldownSeconds = Math.ceil(Number(snapshot.cooldownRemainingMs || 0) / 1000);
  const persistenceErrors = Number(snapshot.persistenceErrors || 0);
  const windowMinutes = Math.max(1, Math.round(Number(snapshot.windowMs || 0) / 60000));
  return `fresh=${fresh}/${effectiveMax} configured=${max} remaining=${remaining} cache=${cacheHits} ` +
    `coalesced=${coalesced} rejected=${rejected} rateLimits=${rateLimits} cooldown=${cooldownSeconds}s ` +
    `persistenceErrors=${persistenceErrors} window=${windowMinutes}m`;
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
