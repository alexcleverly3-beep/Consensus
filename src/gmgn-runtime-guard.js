"use strict";

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function commandKind(args = []) {
  const parts = Array.isArray(args) ? args.map(String) : [];
  if (parts[0] === "token" && parts[1] === "info") return "token-info";
  if (parts[0] === "token" && parts[1] === "traders") return "token-traders";
  if (parts[0] === "market" && parts[1] === "trending") return "market-trending";
  if (parts[0] === "portfolio" && parts[1] === "activity") return "portfolio-activity";
  return "other";
}

function defaultTtlMs(kind) {
  if (kind === "market-trending") return 60 * 1000;
  if (kind === "token-info") return 5 * 60 * 1000;
  if (kind === "token-traders") return 15 * 60 * 1000;
  if (kind === "portfolio-activity") return 5 * 60 * 1000;
  return 0;
}

function createGmgnExecGuard({
  execFile,
  maxFreshCalls = 5,
  windowMs = 20 * 60 * 1000,
  now = () => Date.now(),
  ttlForKind = defaultTtlMs,
} = {}) {
  if (typeof execFile !== "function") throw new Error("execFile is required");

  const maxCalls = clampInt(maxFreshCalls, 5, 1, 100);
  const safeWindowMs = clampInt(windowMs, 20 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
  const cache = new Map();
  const inflight = new Map();
  let windowStartedAt = now();
  let freshCalls = 0;
  let cacheHits = 0;
  let coalesced = 0;
  let rejected = 0;

  function rollWindow(at) {
    if (at - windowStartedAt < safeWindowMs) return;
    windowStartedAt = at;
    freshCalls = 0;
  }

  function keyFor(file, args) {
    return `${file}\u0000${(args || []).map(String).join("\u0000")}`;
  }

  function snapshot() {
    rollWindow(now());
    return {
      maxFreshCalls: maxCalls,
      freshCalls,
      remaining: Math.max(0, maxCalls - freshCalls),
      cacheHits,
      coalesced,
      rejected,
      windowStartedAt,
      windowMs: safeWindowMs,
    };
  }

  function guardedExecFile(file, args, options, callback) {
    // Preserve normal child_process behavior for anything except gmgn-cli.
    if (file !== "gmgn-cli") return execFile(file, args, options, callback);

    const at = now();
    rollWindow(at);
    const key = keyFor(file, args);
    const kind = commandKind(args);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > at) {
      cacheHits += 1;
      queueMicrotask(() => callback(null, cached.stdout, cached.stderr));
      return { cached: true };
    }
    if (cached) cache.delete(key);

    const pending = inflight.get(key);
    if (pending) {
      coalesced += 1;
      pending.push(callback);
      return { coalesced: true };
    }

    if (freshCalls >= maxCalls) {
      rejected += 1;
      const error = new Error(
        `GMGN request budget exhausted (${freshCalls}/${maxCalls} fresh calls in ${Math.round(safeWindowMs / 60000)}m)`
      );
      error.code = "GMGN_BUDGET_EXHAUSTED";
      queueMicrotask(() => callback(error, "", ""));
      return { rejected: true };
    }

    freshCalls += 1;
    inflight.set(key, [callback]);
    return execFile(file, args, options, (error, stdout, stderr) => {
      const callbacks = inflight.get(key) || [];
      inflight.delete(key);
      if (!error) {
        const ttlMs = Math.max(0, Number(ttlForKind(kind)) || 0);
        if (ttlMs > 0) {
          cache.set(key, { stdout, stderr, expiresAt: now() + ttlMs });
        }
      }
      for (const cb of callbacks) cb(error, stdout, stderr);
    });
  }

  guardedExecFile.snapshot = snapshot;
  guardedExecFile.clearCache = () => cache.clear();
  return guardedExecFile;
}

function install(options = {}) {
  const childProcess = require("child_process");
  if (childProcess.execFile?.__consensusGmgnGuard) return childProcess.execFile;

  const original = childProcess.execFile;
  const maxFreshCalls = clampInt(process.env.GMGN_MAX_FRESH_CALLS_PER_WINDOW, 5, 1, 100);
  const windowMinutes = clampInt(process.env.GMGN_BUDGET_WINDOW_MINUTES, 20, 1, 1440);
  const guarded = createGmgnExecGuard({
    execFile: original,
    maxFreshCalls,
    windowMs: windowMinutes * 60 * 1000,
    ...options,
  });
  guarded.__consensusGmgnGuard = true;
  childProcess.execFile = guarded;
  return guarded;
}

module.exports = {
  createGmgnExecGuard,
  commandKind,
  defaultTtlMs,
  install,
};
