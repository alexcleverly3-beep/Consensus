"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const Database = require("better-sqlite3");
const { initRecurrenceStore, unwrapRows } = require("./recurrence-discovery");
const {
  createRecurrenceDashboardStore,
  dashboardCredentials,
  isAuthorized,
  renderPrivateDashboard,
} = require("./recurrence-dashboard");
const { resolveDbPath, resolveDiscoveryIntervalMinutes } = require("./runtime-config");

function clampInt(value, fallback, min, max) {
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

function safeJson(value, fallback = {}) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function isGlobalGmgnThrottle(error) {
  const code = String(error?.code || "");
  const text = String(error?.message || error || "");
  return code === "GMGN_BUDGET_EXHAUSTED" ||
    code === "GMGN_COOLDOWN_ACTIVE" ||
    /GMGN request budget exhausted|GMGN adaptive cooldown active|RATE_LIMIT_EXCEEDED|RATE_LIMIT_BANNED|IP rate limit exceeded|\b429\b|rate[ _-]?limit/i.test(text);
}

function createCli({ minGapMs = 12_000 } = {}) {
  let queue = Promise.resolve();
  let lastFinishedAt = 0;

  function raw(args) {
    return new Promise((resolve, reject) => {
      execFile("gmgn-cli", args, {
        shell: false,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
        timeout: 60_000,
        env: process.env,
      }, (error, stdout, stderr) => {
        if (error) {
          const message = [stderr, stdout, error.message]
            .filter(Boolean).map(String).map((item) => item.trim()).filter(Boolean).join("\n");
          const wrapped = new Error(message || "gmgn-cli failed");
          if (error.code) wrapped.code = error.code;
          reject(wrapped);
          return;
        }
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`Unparseable gmgn-cli output: ${String(stdout).slice(0, 300)}`)); }
      });
    });
  }

  return function cli(args) {
    for (const arg of args) {
      if (typeof arg !== "string" || /[;&|`$()<>"'\\\n]/.test(arg)) {
        return Promise.reject(new Error(`Rejected unsafe CLI arg: ${arg}`));
      }
    }
    const job = queue.then(async () => {
      const waitMs = lastFinishedAt + minGapMs - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      try { return await raw(args); }
      finally { lastFinishedAt = Date.now(); }
    });
    queue = job.catch(() => {});
    return job;
  };
}

function publicHealth(store, gmgnGuard = null, generatedAt = Date.now()) {
  const summary = store.summary();
  const gmgn = typeof gmgnGuard?.snapshot === "function" ? gmgnGuard.snapshot() : {};
  return {
    ok: true,
    status: "running",
    mode: "recurrence-first",
    generatedAt,
    collection: {
      tokensSeen: summary.tokensSeen,
      tokensScanned: summary.tokensScanned,
      totalTokenScans: summary.totalTokenScans,
      queuedTokens: summary.queuedTokens,
      walletsSeen: summary.walletsSeen,
      walletTokenLinks: summary.walletTokenLinks,
      repeatWallets: summary.repeatWallets,
      lastScanAt: summary.lastScanAt,
      lastScanAgeMs: summary.lastScanAt == null ? null : Math.max(0, generatedAt - summary.lastScanAt),
    },
    gmgn: {
      freshCalls: Number(gmgn.freshCalls || 0),
      configuredMax: Number(gmgn.maxFreshCalls || 0),
      effectiveMax: Number(gmgn.effectiveMaxFreshCalls ?? gmgn.maxFreshCalls ?? 0),
      remaining: Number(gmgn.remaining || 0),
      cacheHits: Number(gmgn.cacheHits || 0),
      coalesced: Number(gmgn.coalesced || 0),
      rejected: Number(gmgn.rejected || 0),
      rateLimitEvents: Number(gmgn.rateLimitEvents || 0),
      cooldownRemainingMs: Number(gmgn.cooldownRemainingMs || 0),
    },
  };
}

function renderDashboard(health) {
  const c = health.collection;
  return JSON.stringify({
    mode: health.mode,
    tokensScanned: c.tokensScanned,
    walletsSeen: c.walletsSeen,
    repeatWallets: c.repeatWallets,
  });
}

function createDiscoveryCycleRunner({
  store,
  fetchTrending,
  fetchTopTraders,
  tokensPerCycle = 2,
  trendingRefreshMs = 60 * 60 * 1000,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (!store || typeof store.summary !== "function" || typeof store.nextToken !== "function") {
    throw new Error("recurrence store is required");
  }
  if (typeof fetchTrending !== "function" || typeof fetchTopTraders !== "function") {
    throw new Error("fetchTrending and fetchTopTraders are required");
  }

  let running = false;
  let cycle = 0;
  let lastTrendingAt = store.summary().tokensSeen > 0 ? now() : 0;

  async function refreshTrending() {
    const trending = await fetchTrending();
    const intake = store.enqueueTrending(trending);
    lastTrendingAt = now();
    logger.log(
      `[recurrence] cycle=${cycle} trending rows=${intake.rows} unique=${intake.uniqueTokens} ` +
      `new=${intake.added} queue=${store.summary().queuedTokens}`
    );
    return intake;
  }

  async function discoveryCycle() {
    if (running) return { skipped: true };
    running = true;
    cycle += 1;
    let successfulScans = 0;
    let tokenFailures = 0;
    let throttled = false;
    let trendingRefreshed = false;

    try {
      if (store.summary().queuedTokens === 0) {
        try {
          await refreshTrending();
          trendingRefreshed = true;
        } catch (error) {
          throttled = isGlobalGmgnThrottle(error);
          logger.warn(`[recurrence] trending refresh failed: ${String(error?.message || error).slice(0, 1000)}`);
          return { skipped: false, successfulScans, tokenFailures, throttled, trendingRefreshed };
        }
      }

      for (let i = 0; i < tokensPerCycle; i += 1) {
        const token = store.nextToken();
        if (!token) break;
        try {
          const traders = await fetchTopTraders(token.token_address);
          const result = store.ingestTokenTraders({
            tokenAddress: token.token_address,
            traders,
            tokenMeta: safeJson(token.trend_json),
          });
          successfulScans += 1;
          const summary = store.summary();
          logger.log(
            `[recurrence] trader-scan accepted=${result.accepted} rejected=${result.rejected} ` +
            `wallets=${summary.walletsSeen} repeats=${summary.repeatWallets} queue=${summary.queuedTokens}`
          );
        } catch (error) {
          if (isGlobalGmgnThrottle(error)) {
            throttled = true;
            logger.warn(`[recurrence] GMGN budget/cooldown paused token scans: ${String(error?.message || error).slice(0, 1000)}`);
            break;
          }
          store.markFailed(token.token_address, error);
          tokenFailures += 1;
          logger.warn(
            `[recurrence] token trader scan failed; deferring token=${token.token_address}: ` +
            String(error?.message || error).slice(0, 1000)
          );
        }
      }

      const summary = store.summary();
      const trendingStale = now() - lastTrendingAt >= trendingRefreshMs;
      const queueLow = summary.queuedTokens < tokensPerCycle;
      if (!trendingRefreshed && !throttled && (queueLow || trendingStale)) {
        try {
          await refreshTrending();
          trendingRefreshed = true;
        } catch (error) {
          throttled = isGlobalGmgnThrottle(error);
          logger.warn(`[recurrence] trending refresh deferred: ${String(error?.message || error).slice(0, 1000)}`);
        }
      }

      return { skipped: false, successfulScans, tokenFailures, throttled, trendingRefreshed };
    } finally {
      running = false;
    }
  }

  return { discoveryCycle };
}

function startRecurrenceApp({ gmgnGuard = null, env = process.env } = {}) {
  const dbPath = resolveDbPath(env);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  const intervalMinutes = clampInt(
    env.RECURRENCE_INTERVAL_MINUTES,
    resolveDiscoveryIntervalMinutes(env),
    5,
    120
  );
  const trendingLimit = clampInt(env.RECURRENCE_TRENDING_LIMIT, 50, 10, 100);
  const tokensPerCycle = clampInt(env.RECURRENCE_TOKENS_PER_CYCLE, 2, 1, 3);
  const traderLimit = clampInt(env.RECURRENCE_TRADER_LIMIT, 100, 25, 100);
  const rescanHours = clampInt(env.RECURRENCE_RESCAN_HOURS, 24, 6, 168);
  const trendingRefreshMinutes = clampInt(env.RECURRENCE_TRENDING_REFRESH_MINUTES, 60, 15, 360);
  const minGapMs = clampInt(env.GMGN_MIN_REQUEST_GAP_MS, 12_000, 3_000, 60_000);
  const store = initRecurrenceStore(db, { rescanMs: rescanHours * 60 * 60 * 1000 });
  const dashboardStore = createRecurrenceDashboardStore(db);
  const cli = createCli({ minGapMs });

  async function fetchTrending() {
    return cli([
      "market", "trending", "--chain", "sol", "--interval", "24h",
      "--order-by", "volume", "--limit", String(trendingLimit), "--raw",
    ]);
  }

  async function fetchTopTraders(token) {
    const response = await cli([
      "token", "traders", "--chain", "sol", "--address", token,
      "--order-by", "profit", "--direction", "desc",
      "--limit", String(traderLimit), "--raw",
    ]);
    return unwrapRows(response);
  }

  const runner = createDiscoveryCycleRunner({
    store,
    fetchTrending,
    fetchTopTraders,
    tokensPerCycle,
    trendingRefreshMs: trendingRefreshMinutes * 60 * 1000,
  });
  const discoveryCycle = runner.discoveryCycle;

  const port = clampInt(env.PORT || env.DASHBOARD_PORT, 3000, 0, 65535);
  const host = env.DASHBOARD_HOST || "0.0.0.0";
  const privateHeaders = {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };

  const server = http.createServer((req, res) => {
    let requestUrl;
    let pathname;
    try {
      requestUrl = new URL(req.url, "http://recurrence.local");
      pathname = requestUrl.pathname;
    } catch {
      pathname = req.url;
    }

    if (pathname === "/health" || pathname === "/api/progress") {
      try {
        const health = publicHealth(store, gmgnGuard);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(health));
      } catch {
        res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, status: "unavailable", mode: "recurrence-first" }));
      }
      return;
    }

    if (pathname === "/" || pathname === "/index.html" || pathname === "/api/wallets") {
      const credentials = dashboardCredentials(env);
      if (!credentials.password) {
        res.writeHead(503, { ...privateHeaders, "content-type": "text/plain; charset=utf-8" });
        res.end("Private Consensus dashboard is disabled. Set DASHBOARD_PASSWORD in Railway.");
        return;
      }
      if (!isAuthorized(req, env)) {
        res.writeHead(401, {
          ...privateHeaders,
          "content-type": "text/plain; charset=utf-8",
          "www-authenticate": 'Basic realm="Consensus private dashboard", charset="UTF-8"',
        });
        res.end("Authentication required");
        return;
      }

      try {
        const minDistinctTokens = clampInt(requestUrl?.searchParams.get("min"), 3, 2, 100);
        const limit = clampInt(requestUrl?.searchParams.get("limit"), 250, 1, 1000);
        const stats = dashboardStore.stats(store.summary());
        const wallets = dashboardStore.wallets({ minDistinctTokens, limit });
        if (pathname === "/api/wallets") {
          res.writeHead(200, { ...privateHeaders, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ generatedAt: stats.generatedAt, minDistinctTokens, stats, wallets }, null, 2));
          return;
        }
        res.writeHead(200, { ...privateHeaders, "content-type": "text/html; charset=utf-8" });
        res.end(renderPrivateDashboard(stats, wallets));
      } catch (error) {
        res.writeHead(503, { ...privateHeaders, "content-type": "text/plain; charset=utf-8" });
        res.end(`Dashboard temporarily unavailable: ${String(error?.message || error).slice(0, 200)}`);
      }
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  server.listen(port, host, () => {
    console.log(
      `[recurrence] listening on ${host}:${server.address()?.port || port}; interval=${intervalMinutes}m; ` +
      `trending=${trendingLimit}; scans/cycle=${tokensPerCycle}; top-traders=${traderLimit}; ` +
      `rescan=${rescanHours}h; trending-refresh=${trendingRefreshMinutes}m`
    );
  });
  queueMicrotask(() => discoveryCycle());
  const timer = setInterval(discoveryCycle, intervalMinutes * 60 * 1000);
  timer.unref?.();
  server.once("close", () => clearInterval(timer));

  return { db, server, store, dashboardStore, discoveryCycle };
}

module.exports = {
  clampInt,
  createCli,
  createDiscoveryCycleRunner,
  isGlobalGmgnThrottle,
  publicHealth,
  renderDashboard,
  startRecurrenceApp,
};
