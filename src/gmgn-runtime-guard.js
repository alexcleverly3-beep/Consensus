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

function isRateLimitFailure(error, stdout = "", stderr = "") {
  const text = [error?.message || error, stdout, stderr].filter(Boolean).join("\n");
  return /RATE_LIMIT_EXCEEDED|RATE_LIMIT_BANNED|IP rate limit exceeded|\b429\b|rate[ _-]?limit/i.test(text);
}

function setFlag(args, flag, value) {
  const next = [...args];
  const index = next.indexOf(flag);
  if (index >= 0) {
    if (index + 1 < next.length) next[index + 1] = String(value);
    else next.push(String(value));
    return next;
  }
  const rawIndex = next.lastIndexOf("--raw");
  const insertion = [flag, String(value)];
  if (rawIndex >= 0) next.splice(rawIndex, 0, ...insertion);
  else next.push(...insertion);
  return next;
}

function addRepeatableFlag(args, flag, value) {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === flag && String(args[i + 1]) === String(value)) return [...args];
  }
  const next = [...args];
  const rawIndex = next.lastIndexOf("--raw");
  if (rawIndex >= 0) next.splice(rawIndex, 0, flag, String(value));
  else next.push(flag, String(value));
  return next;
}

function hardenTrendingArgs(args = []) {
  let next = Array.isArray(args) ? args.map(String) : [];
  if (commandKind(next) !== "market-trending") return next;

  next = setFlag(next, "--interval", "24h");
  next = setFlag(next, "--min-created", "2d");
  next = setFlag(next, "--min-liquidity", "20000");
  next = setFlag(next, "--min-marketcap", "100000");
  next = setFlag(next, "--min-volume", "10000");
  next = setFlag(next, "--min-holder-count", "200");
  next = setFlag(next, "--max-top10-holder-rate", "0.50");
  next = setFlag(next, "--max-dev-team-hold-rate", "0.20");
  next = setFlag(next, "--max-rug-ratio", "0.30");
  next = setFlag(next, "--max-insider-rate", "0.35");
  next = setFlag(next, "--max-bundler-rate", "0.35");
  next = addRepeatableFlag(next, "--filter", "not_wash_trading");
  return next;
}

function createGmgnExecGuard({
  execFile,
  maxFreshCalls = 8,
  minFreshCalls = 1,
  windowMs = 20 * 60 * 1000,
  cooldownMs = 30 * 1000,
  recoveryWindows = 2,
  adaptive = true,
  now = () => Date.now(),
  ttlForKind = defaultTtlMs,
  initialState = {},
  onStateChange = null,
} = {}) {
  if (typeof execFile !== "function") throw new Error("execFile is required");

  const maxCalls = clampInt(maxFreshCalls, 8, 1, 100);
  const minCalls = clampInt(minFreshCalls, 1, 1, maxCalls);
  const safeWindowMs = clampInt(windowMs, 20 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
  const safeCooldownMs = clampInt(cooldownMs, 30 * 1000, 1000, 60 * 60 * 1000);
  const cleanWindowsNeeded = clampInt(recoveryWindows, 2, 1, 20);
  const cache = new Map();
  const inflight = new Map();
  const startedAt = Number(initialState.windowStartedAt);
  let windowStartedAt = Number.isFinite(startedAt) && startedAt >= 0 && startedAt <= now()
    ? startedAt
    : now();
  let freshCalls = Math.max(0, Math.floor(Number(initialState.freshCalls) || 0));
  let cacheHits = 0;
  let coalesced = 0;
  let rejected = 0;
  let rateLimitEvents = Math.max(0, Math.floor(Number(initialState.rateLimitEvents) || 0));
  let windowRateLimits = Math.max(0, Math.floor(Number(initialState.windowRateLimits) || 0));
  let cleanWindows = Math.max(0, Math.floor(Number(initialState.cleanWindows) || 0));
  let effectiveMaxFreshCalls = clampInt(
    initialState.effectiveMaxFreshCalls,
    maxCalls,
    minCalls,
    maxCalls
  );
  let blockedUntil = Math.max(0, Math.floor(Number(initialState.blockedUntil) || 0));
  let persistenceErrors = 0;

  function persistentState() {
    return {
      windowStartedAt,
      freshCalls,
      effectiveMaxFreshCalls,
      rateLimitEvents,
      cleanWindows,
      windowRateLimits,
      blockedUntil,
    };
  }

  function persistState() {
    if (typeof onStateChange !== "function") return;
    try {
      onStateChange(persistentState());
    } catch {
      persistenceErrors += 1;
    }
  }

  function rollWindow(at) {
    if (at - windowStartedAt < safeWindowMs) return;
    if (adaptive && freshCalls > 0) {
      if (windowRateLimits === 0) {
        cleanWindows += 1;
        if (cleanWindows >= cleanWindowsNeeded && effectiveMaxFreshCalls < maxCalls) {
          effectiveMaxFreshCalls += 1;
          cleanWindows = 0;
        }
      } else {
        cleanWindows = 0;
      }
    }
    const elapsedWindows = Math.max(1, Math.floor((at - windowStartedAt) / safeWindowMs));
    windowStartedAt += elapsedWindows * safeWindowMs;
    freshCalls = 0;
    windowRateLimits = 0;
    persistState();
  }

  function keyFor(file, args) {
    return `${file}\u0000${(args || []).map(String).join("\u0000")}`;
  }

  function snapshot() {
    const at = now();
    rollWindow(at);
    return {
      maxFreshCalls: maxCalls,
      effectiveMaxFreshCalls,
      minFreshCalls: minCalls,
      freshCalls,
      remaining: Math.max(0, effectiveMaxFreshCalls - freshCalls),
      cacheHits,
      coalesced,
      rejected,
      rateLimitEvents,
      cleanWindows,
      blockedUntil,
      cooldownRemainingMs: Math.max(0, blockedUntil - at),
      persistenceErrors,
      windowStartedAt,
      windowMs: safeWindowMs,
      adaptive: Boolean(adaptive),
    };
  }

  function guardedExecFile(file, args, options, callback) {
    if (file !== "gmgn-cli") return execFile(file, args, options, callback);

    const effectiveArgs = hardenTrendingArgs(args);
    const at = now();
    rollWindow(at);
    const key = keyFor(file, effectiveArgs);
    const kind = commandKind(effectiveArgs);
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

    if (at < blockedUntil) {
      rejected += 1;
      const error = new Error(`GMGN adaptive cooldown active for ${Math.ceil((blockedUntil - at) / 1000)}s`);
      error.code = "GMGN_COOLDOWN_ACTIVE";
      queueMicrotask(() => callback(error, "", ""));
      return { rejected: true, cooldown: true };
    }

    if (freshCalls >= effectiveMaxFreshCalls) {
      rejected += 1;
      const error = new Error(
        `GMGN request budget exhausted (${freshCalls}/${effectiveMaxFreshCalls} fresh calls in ${Math.round(safeWindowMs / 60000)}m)`
      );
      error.code = "GMGN_BUDGET_EXHAUSTED";
      queueMicrotask(() => callback(error, "", ""));
      return { rejected: true };
    }

    freshCalls += 1;
    persistState();
    inflight.set(key, [callback]);
    return execFile(file, effectiveArgs, options, (error, stdout, stderr) => {
      const callbacks = inflight.get(key) || [];
      inflight.delete(key);

      if (error && adaptive && isRateLimitFailure(error, stdout, stderr)) {
        rateLimitEvents += 1;
        windowRateLimits += 1;
        cleanWindows = 0;
        effectiveMaxFreshCalls = Math.max(minCalls, Math.floor(effectiveMaxFreshCalls / 2));
        blockedUntil = Math.max(blockedUntil, now() + safeCooldownMs);
        persistState();
      } else if (!error) {
        const ttlMs = Math.max(0, Number(ttlForKind(kind)) || 0);
        if (ttlMs > 0) cache.set(key, { stdout, stderr, expiresAt: now() + ttlMs });
      }

      for (const cb of callbacks) cb(error, stdout, stderr);
    });
  }

  guardedExecFile.snapshot = snapshot;
  guardedExecFile.persistentState = persistentState;
  guardedExecFile.clearCache = () => cache.clear();
  return guardedExecFile;
}

function install(options = {}) {
  const childProcess = require("child_process");
  if (childProcess.execFile?.__consensusGmgnGuard) return childProcess.execFile;

  const original = childProcess.execFile;
  const maxFreshCalls = clampInt(process.env.GMGN_MAX_FRESH_CALLS_PER_WINDOW, 8, 1, 100);
  const minFreshCalls = clampInt(process.env.GMGN_MIN_FRESH_CALLS_PER_WINDOW, 1, 1, maxFreshCalls);
  const windowMinutes = clampInt(process.env.GMGN_BUDGET_WINDOW_MINUTES, 20, 1, 1440);
  const cooldownSeconds = clampInt(process.env.GMGN_ADAPTIVE_COOLDOWN_SECONDS, 30, 1, 3600);
  const recoveryWindows = clampInt(process.env.GMGN_ADAPTIVE_RECOVERY_WINDOWS, 2, 1, 20);
  const guarded = createGmgnExecGuard({
    execFile: original,
    maxFreshCalls,
    minFreshCalls,
    windowMs: windowMinutes * 60 * 1000,
    cooldownMs: cooldownSeconds * 1000,
    recoveryWindows,
    adaptive: process.env.GMGN_ADAPTIVE_BUDGET !== "0",
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
  hardenTrendingArgs,
  isRateLimitFailure,
  install,
};
