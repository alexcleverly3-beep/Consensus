"use strict";

const crypto = require("crypto");
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
const { initPhase2WalletLab, renderPhase2WalletLab } = require("./phase2-wallet-lab");
const { initPhase2Runtime } = require("./phase2-runtime");
const { parseWalletStats } = require("./phase2-performance");
const { resolveDbPath, resolveDiscoveryIntervalMinutes } = require("./runtime-config");

function clampInt(value, fallback, min, max) {
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeJson(value, fallback = {}) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function stableDashboardActionToken(env = process.env) {
  const credentials = dashboardCredentials(env);
  if (!credentials.password) return "";
  return crypto.createHmac("sha256", credentials.password)
    .update(`consensus-dashboard-actions-v1\0${credentials.username}`)
    .digest("hex");
}

function readFormBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        settled = true;
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(new URLSearchParams(body));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        const error = new Error("request body too large");
        error.status = 413;
        reject(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")); }
      catch {
        const error = new Error("invalid JSON body");
        error.status = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
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

function publicHealth(store, gmgnGuard = null, generatedAt = Date.now(), throughput = {}) {
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
      newQueuedTokens: summary.newQueuedTokens,
      rescanQueuedTokens: summary.rescanQueuedTokens,
      walletsSeen: summary.walletsSeen,
      walletTokenLinks: summary.walletTokenLinks,
      repeatWallets: summary.repeatWallets,
      scansLastHour: num(throughput.scansLastHour),
      firstScansLastHour: num(throughput.firstScansLastHour),
      rescansLastHour: num(throughput.rescansLastHour),
      targetScansPerHour: num(throughput.targetScansPerHour),
      maxTargetScansPerHour: num(throughput.maxTargetScansPerHour),
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
  return JSON.stringify({ mode: health.mode, tokensScanned: c.tokensScanned, walletsSeen: c.walletsSeen, repeatWallets: c.repeatWallets });
}

function createDiscoveryCycleRunner({ store, fetchTrending, fetchTopTraders, tokensPerCycle = 2, getScanPlan = null, trendingRefreshMs = 60 * 60 * 1000, now = () => Date.now(), logger = console } = {}) {
  if (!store || typeof store.summary !== "function" || typeof store.nextToken !== "function") throw new Error("recurrence store is required");
  if (typeof fetchTrending !== "function" || typeof fetchTopTraders !== "function") throw new Error("fetchTrending and fetchTopTraders are required");
  let running = false;
  let cycle = 0;
  let lastTrendingAt = store.summary().tokensSeen > 0 ? now() : 0;

  async function refreshTrending() {
    const trending = await fetchTrending();
    const intake = store.enqueueTrending(trending);
    lastTrendingAt = now();
    const summary = store.summary();
    logger.log(`[recurrence] cycle=${cycle} trending rows=${intake.rows} unique=${intake.uniqueTokens} new=${intake.added} queue=${summary.queuedTokens} queue-new=${summary.newQueuedTokens ?? "unknown"} queue-rescan=${summary.rescanQueuedTokens ?? "unknown"}`);
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
      const plan = typeof getScanPlan === "function"
        ? getScanPlan()
        : { allowance: tokensPerCycle, reason: "fixed-cycle-limit" };
      const plannedScans = Math.max(0, Math.min(tokensPerCycle, Math.floor(Number(plan?.allowance) || 0)));
      const startingSummary = store.summary();
      const trendingStaleAtStart = now() - lastTrendingAt >= trendingRefreshMs;
      const hasQueueBreakdown = Number.isFinite(Number(startingSummary.newQueuedTokens));
      const needsNewTokenIntake = Number(startingSummary.priorityQueuedTokens || 0) === 0 && (hasQueueBreakdown
        ? Number(startingSummary.newQueuedTokens) === 0
        : startingSummary.queuedTokens === 0);
      if (plannedScans === 0) {
        if (startingSummary.queuedTokens === 0 && trendingStaleAtStart) {
          try { await refreshTrending(); trendingRefreshed = true; }
          catch (error) {
            throttled = isGlobalGmgnThrottle(error);
            logger.warn(`[recurrence] trending refresh deferred: ${String(error?.message || error).slice(0, 1000)}`);
          }
        }
        return { skipped: false, successfulScans, tokenFailures, throttled, trendingRefreshed, scanPlan: plan };
      }
      if (needsNewTokenIntake) {
        try { await refreshTrending(); trendingRefreshed = true; }
        catch (error) {
          throttled = isGlobalGmgnThrottle(error);
          logger.warn(`[recurrence] trending refresh failed: ${String(error?.message || error).slice(0, 1000)}`);
          return { skipped: false, successfulScans, tokenFailures, throttled, trendingRefreshed };
        }
      }
      for (let i = 0; i < plannedScans; i += 1) {
        const token = store.nextToken();
        if (!token) break;
        try {
          const traders = await fetchTopTraders(token.token_address);
          const result = store.ingestTokenTraders({ tokenAddress: token.token_address, traders, tokenMeta: safeJson(token.trend_json) });
          successfulScans += 1;
          const summary = store.summary();
          logger.log(`[recurrence] trader-scan accepted=${result.accepted} rejected=${result.rejected} wallets=${summary.walletsSeen} repeats=${summary.repeatWallets} queue=${summary.queuedTokens}`);
        } catch (error) {
          if (isGlobalGmgnThrottle(error)) {
            throttled = true;
            logger.warn(`[recurrence] GMGN budget/cooldown paused token scans: ${String(error?.message || error).slice(0, 1000)}`);
            break;
          }
          store.markFailed(token.token_address, error);
          tokenFailures += 1;
          logger.warn(`[recurrence] token trader scan failed; deferring token=${token.token_address}: ${String(error?.message || error).slice(0, 1000)}`);
        }
      }
      const summary = store.summary();
      const trendingStale = now() - lastTrendingAt >= trendingRefreshMs;
      const queueLow = Number.isFinite(Number(summary.newQueuedTokens))
        ? Number(summary.newQueuedTokens) < plannedScans
        : summary.queuedTokens < tokensPerCycle;
      if (!trendingRefreshed && !throttled && (queueLow || trendingStale)) {
        try { await refreshTrending(); trendingRefreshed = true; }
        catch (error) {
          throttled = isGlobalGmgnThrottle(error);
          logger.warn(`[recurrence] trending refresh deferred: ${String(error?.message || error).slice(0, 1000)}`);
        }
      }
      return { skipped: false, successfulScans, tokenFailures, throttled, trendingRefreshed, scanPlan: plan };
    } finally { running = false; }
  }
  return { discoveryCycle };
}

function startRecurrenceApp({ gmgnGuard = null, env = process.env } = {}) {
  const dbPath = resolveDbPath(env);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  const intervalMinutes = clampInt(env.RECURRENCE_INTERVAL_MINUTES, resolveDiscoveryIntervalMinutes(env), 5, 120);
  const trendingLimit = clampInt(env.RECURRENCE_TRENDING_LIMIT, 100, 10, 100);
  const traderLimit = clampInt(env.RECURRENCE_TRADER_LIMIT, 100, 25, 100);
  const rescanHours = clampInt(env.RECURRENCE_RESCAN_HOURS, 24, 6, 168);
  const trendingRefreshMinutes = clampInt(env.RECURRENCE_TRENDING_REFRESH_MINUTES, 60, 15, 360);
  const minGapMs = clampInt(env.GMGN_MIN_REQUEST_GAP_MS, 12_000, 3_000, 60_000);
  const requestedDefaultTarget = clampInt(env.RECURRENCE_TARGET_SCANS_PER_HOUR, 12, 1, 60);
  const requestedMaxTarget = clampInt(env.RECURRENCE_MAX_SCANS_PER_HOUR, 18, 1, 60);
  const scheduleCapacityPerHour = Math.max(1, Math.floor((60 / intervalMinutes) * 3));
  const maxTargetScansPerHour = Math.min(requestedMaxTarget, scheduleCapacityPerHour);
  const defaultTargetScansPerHour = Math.min(requestedDefaultTarget, maxTargetScansPerHour);
  const configuredTokensPerCycle = clampInt(env.RECURRENCE_TOKENS_PER_CYCLE, 3, 1, 3);
  const tokensPerCycle = Math.min(3, Math.max(configuredTokensPerCycle, Math.ceil(maxTargetScansPerHour * intervalMinutes / 60)));
  const performanceBatchSize = clampInt(env.PHASE2_PERFORMANCE_BATCH_SIZE, 5, 1, 10);
  const performanceIntervalMinutes = clampInt(env.PHASE2_PERFORMANCE_INTERVAL_MINUTES, 30, 15, 1440);
  const performanceRefreshDays = clampInt(env.PHASE2_PERFORMANCE_REFRESH_DAYS, 7, 1, 30);
  const store = initRecurrenceStore(db, { rescanMs: rescanHours * 60 * 60 * 1000 });
  const dashboardStore = createRecurrenceDashboardStore(db, { defaultTargetScansPerHour, maxTargetScansPerHour });
  const phase2Lab = initPhase2WalletLab(db);
  const phase2Signals = initPhase2Runtime(db, { env, autoStart: false });
  const cli = createCli({ minGapMs });
  const trendingProfiles = [
    { interval: "24h", orderBy: "volume" },
    { interval: "6h", orderBy: "swaps" },
    { interval: "1h", orderBy: "volume" },
    { interval: "24h", orderBy: "holder_count" },
  ];
  let trendingProfileIndex = 0;

  async function fetchTrending() {
    const profile = trendingProfiles[trendingProfileIndex % trendingProfiles.length];
    trendingProfileIndex += 1;
    return cli(["market", "trending", "--chain", "sol", "--interval", profile.interval, "--order-by", profile.orderBy, "--direction", "desc", "--limit", String(trendingLimit), "--raw"]);
  }
  async function fetchTopTraders(token) {
    const response = await cli(["token", "traders", "--chain", "sol", "--address", token, "--order-by", "profit", "--direction", "desc", "--limit", String(traderLimit), "--raw"]);
    return unwrapRows(response);
  }
  async function fetchWalletActivity(wallet) {
    return cli(["portfolio", "activity", "--chain", "sol", "--wallet", wallet, "--limit", "100", "--raw"]);
  }
  async function fetchWalletStats(wallets) {
    return cli(["portfolio", "stats", "--chain", "sol", "--wallet", ...wallets, "--period", "30d", "--raw"]);
  }

  const runner = createDiscoveryCycleRunner({
    store,
    fetchTrending,
    fetchTopTraders,
    tokensPerCycle,
    getScanPlan: () => dashboardStore.scanPlan({ cycleCap: tokensPerCycle }),
    trendingRefreshMs: trendingRefreshMinutes * 60 * 1000,
  });
  const discoveryCycle = runner.discoveryCycle;
  let performanceRunning = false;
  async function performanceEnrichmentCycle() {
    if (performanceRunning) return { skipped: true, reason: "already-running" };
    const budget = typeof gmgnGuard?.snapshot === "function" ? gmgnGuard.snapshot() : null;
    if (budget && Number(budget.remaining || 0) < 2) return { skipped: true, reason: "preserving-phase1-budget" };
    const candidates = phase2Signals.candidateProfiles(100);
    const due = phase2Signals.store.performanceDueWallets(candidates.map((profile) => profile.walletAddress), {
      limit: performanceBatchSize,
      refreshMs: performanceRefreshDays * 24 * 60 * 60_000,
    });
    if (!due.length) return { skipped: true, reason: "up-to-date" };

    performanceRunning = true;
    try {
      const response = await fetchWalletStats(due);
      const parsed = parseWalletStats(response, due);
      let analyzed = 0;
      for (const wallet of due) {
        const result = parsed.get(wallet);
        if (result) {
          phase2Signals.store.recordPerformance(wallet, result);
          analyzed += 1;
        } else {
          phase2Signals.store.recordPerformanceFailure(wallet, new Error("GMGN returned no wallet statistics"));
        }
      }
      await phase2Signals.refreshAndSync();
      console.log(`[phase2] GMGN performance enrichment analyzed ${analyzed}/${due.length} candidate wallet(s)`);
      return { analyzed, requested: due.length };
    } catch (error) {
      if (!isGlobalGmgnThrottle(error)) {
        for (const wallet of due) phase2Signals.store.recordPerformanceFailure(wallet, error);
      }
      console.warn(`[phase2] performance enrichment deferred: ${String(error?.message || error).slice(0, 240)}`);
      return { skipped: true, reason: isGlobalGmgnThrottle(error) ? "gmgn-budget" : "provider-error" };
    } finally { performanceRunning = false; }
  }
  const port = clampInt(env.PORT || env.DASHBOARD_PORT, 3000, 0, 65535);
  const host = env.DASHBOARD_HOST || "0.0.0.0";
  // Derive the action token from the existing private-dashboard secret so an
  // ordinary Railway restart does not invalidate forms in an open browser tab.
  // Changing the dashboard password intentionally invalidates old forms.
  const dashboardActionToken = stableDashboardActionToken(env);
  const privateHeaders = {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };

  function rejectPrivate(res, status, message) {
    res.writeHead(status, { ...privateHeaders, "content-type": "text/plain; charset=utf-8" });
    res.end(message);
  }
  function requirePrivateAccess(req, res) {
    const credentials = dashboardCredentials(env);
    if (!credentials.password) { rejectPrivate(res, 503, "Private Consensus dashboard is disabled. Set DASHBOARD_PASSWORD in Railway."); return false; }
    if (!isAuthorized(req, env)) {
      res.writeHead(401, { ...privateHeaders, "content-type": "text/plain; charset=utf-8", "www-authenticate": 'Basic realm="Consensus private dashboard", charset="UTF-8"' });
      res.end("Authentication required");
      return false;
    }
    return true;
  }
  function redirectNotice(res, message, kind = "success", base = "/") {
    const query = new URLSearchParams({ notice: String(message).slice(0, 180), kind });
    const separator = base.includes("?") ? "&" : "?";
    res.writeHead(303, { ...privateHeaders, location: `${base}${separator}${query.toString()}` });
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    let requestUrl;
    let pathname;
    try { requestUrl = new URL(req.url, "http://recurrence.local"); pathname = requestUrl.pathname; }
    catch { pathname = req.url; }

    if (pathname === "/webhooks/helius") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
        res.end(JSON.stringify({ error: "POST required" }));
        return;
      }
      try {
        const payload = await readJsonBody(req);
        const result = phase2Signals.acceptWebhook(req.headers.authorization, payload);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
      } catch (error) {
        const status = Number(error?.status) || 400;
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: status === 401 ? "unauthorized" : String(error?.message || error).slice(0, 120) }));
      }
      return;
    }

    if (pathname === "/health" || pathname === "/api/progress") {
      try {
        const health = publicHealth(store, gmgnGuard, Date.now(), dashboardStore.throughput());
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(health));
      } catch {
        res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, status: "unavailable", mode: "recurrence-first" }));
      }
      return;
    }

    const privatePath = pathname === "/" || pathname === "/index.html" || pathname === "/api/wallets" || pathname === "/api/queue" || pathname === "/api/throughput" ||
      pathname === "/actions/token/add" || pathname === "/actions/token/cancel" || pathname === "/actions/wallet/checked" || pathname === "/actions/scanner/target" || pathname === "/phase2" ||
      pathname === "/api/phase2/wallets" || pathname === "/api/phase2/signals" || pathname === "/actions/phase2/analyze" || pathname === "/actions/phase2/label" ||
      pathname === "/actions/phase2/test-discord" || pathname === "/actions/phase2/settings";
    if (privatePath) {
      if (!requirePrivateAccess(req, res)) return;

      if (pathname === "/phase2" || pathname === "/api/phase2/wallets") {
        const items = phase2Lab.list(100);
        const signalStatus = phase2Signals.status();
        const nearSignals = phase2Signals.store.nearSignals();
        if (pathname === "/api/phase2/wallets") {
          res.writeHead(200, { ...privateHeaders, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ generatedAt: Date.now(), wallets: items }, null, 2));
          return;
        }
        const notice = String(requestUrl?.searchParams.get("notice") || "").slice(0, 180);
        res.writeHead(200, { ...privateHeaders, "content-type": "text/html; charset=utf-8" });
        res.end(renderPhase2WalletLab(items, dashboardActionToken, notice, { status: signalStatus, nearSignals }));
        return;
      }

      if (pathname === "/api/phase2/signals") {
        res.writeHead(200, { ...privateHeaders, "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ generatedAt: Date.now(), status: phase2Signals.status(), nearSignals: phase2Signals.store.nearSignals() }, null, 2));
        return;
      }

      if (pathname === "/actions/phase2/test-discord") {
        if (req.method !== "POST") { rejectPrivate(res, 405, "POST required"); return; }
        try {
          const form = await readFormBody(req);
          if (!safeTokenEqual(form.get("csrf"), dashboardActionToken)) { rejectPrivate(res, 403, "Invalid dashboard action token"); return; }
          await phase2Signals.sendTestDiscord();
          redirectNotice(res, "Discord test notification sent. No production signal was created.", "success", "/phase2");
        } catch (error) { redirectNotice(res, String(error?.message || error).slice(0, 160), "error", "/phase2"); }
        return;
      }

      if (pathname === "/actions/phase2/settings") {
        if (req.method !== "POST") { rejectPrivate(res, 405, "POST required"); return; }
        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        if (!contentType.startsWith("application/x-www-form-urlencoded")) { rejectPrivate(res, 415, "Form submission required"); return; }
        try {
          const form = await readFormBody(req);
          if (!safeTokenEqual(form.get("csrf"), dashboardActionToken)) { rejectPrivate(res, 403, "Invalid dashboard action token"); return; }
          const result = await phase2Signals.updateSettings({
            minDistinctTokens: form.get("minDistinctTokens"),
            minTop10Tokens: form.get("minTop10Tokens"),
            maxAverageRank: form.get("maxAverageRank"),
            trackedWalletLimit: form.get("trackedWalletLimit"),
            minDistinctWallets: form.get("minDistinctWallets"),
            pointsThreshold: form.get("pointsThreshold"),
            signalWindowMinutes: form.get("signalWindowMinutes"),
          });
          redirectNotice(res, `Phase 2 settings saved. Now tracking ${result.tracked} eligible wallet${result.tracked === 1 ? "" : "s"}.`, "success", "/phase2");
        } catch (error) { redirectNotice(res, String(error?.message || error).slice(0, 160), "error", "/phase2"); }
        return;
      }

      if (pathname === "/actions/phase2/analyze" || pathname === "/actions/phase2/label") {
        if (req.method !== "POST") { rejectPrivate(res, 405, "POST required"); return; }
        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        if (!contentType.startsWith("application/x-www-form-urlencoded")) { rejectPrivate(res, 415, "Form submission required"); return; }
        try {
          const form = await readFormBody(req);
          if (!safeTokenEqual(form.get("csrf"), dashboardActionToken)) { rejectPrivate(res, 403, "Invalid dashboard action token"); return; }
          const wallet = String(form.get("wallet") || "").trim();
          if (pathname === "/actions/phase2/label") {
            const result = phase2Lab.label(wallet, form.get("label"));
            redirectNotice(res, `Saved ${result.humanLabel} calibration label.`, "success", "/phase2");
            return;
          }
          const activity = await fetchWalletActivity(wallet);
          const result = phase2Lab.analyze(wallet, activity);
          redirectNotice(res, `Analysis complete: ${result.score}/100 with ${result.confidence}% evidence confidence.`, "success", "/phase2");
          return;
        } catch (error) {
          redirectNotice(res, String(error?.message || error).slice(0, 160), "error", "/phase2");
          return;
        }
      }

      if (pathname === "/actions/token/add" || pathname === "/actions/token/cancel") {
        if (req.method !== "POST") { rejectPrivate(res, 405, "POST required"); return; }
        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        if (!contentType.startsWith("application/x-www-form-urlencoded")) { rejectPrivate(res, 415, "Form submission required"); return; }
        try {
          const form = await readFormBody(req);
          if (!safeTokenEqual(form.get("csrf"), dashboardActionToken)) { rejectPrivate(res, 403, "Invalid dashboard action token"); return; }
          const token = String(form.get("token") || "").trim();
          if (pathname === "/actions/token/add") {
            const result = store.enqueuePriorityToken(token, { source: "dashboard" });
            queueMicrotask(() => Promise.resolve(discoveryCycle()).catch((error) => console.warn(`[dashboard] immediate manual scan trigger failed: ${String(error?.message || error).slice(0, 300)}`)));
            redirectNotice(res, result.added ? "Token added to the priority queue." : "Token re-queued as priority.");
            return;
          }
          const result = dashboardStore.cancelQueuedToken(token);
          redirectNotice(res, result.cancelled ? "Token removed from the current scan queue." : "Token was not currently queued.", result.cancelled ? "success" : "error");
          return;
        } catch (error) { redirectNotice(res, String(error?.message || error).slice(0, 160), "error"); return; }
      }

      if (pathname === "/actions/wallet/checked") {
        if (req.method !== "POST") { rejectPrivate(res, 405, "POST required"); return; }
        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        if (!contentType.startsWith("application/x-www-form-urlencoded")) { rejectPrivate(res, 415, "Form submission required"); return; }
        try {
          const form = await readFormBody(req);
          if (!safeTokenEqual(form.get("csrf"), dashboardActionToken)) { rejectPrivate(res, 403, "Invalid dashboard action token"); return; }
          const checkedValue = String(form.get("checked") || "");
          if (checkedValue !== "0" && checkedValue !== "1") throw new Error("checked state must be 0 or 1");
          const result = dashboardStore.setWalletChecked(form.get("wallet"), checkedValue === "1");
          const minDistinctTokens = clampInt(form.get("min"), 3, 2, 100);
          const returnTo = form.get("returnTo") === "/phase2" ? "/phase2" : `/?min=${minDistinctTokens}`;
          redirectNotice(res, result.checked ? "Wallet marked as checked." : "Wallet marked as not checked.", "success", returnTo);
          return;
        } catch (error) { redirectNotice(res, String(error?.message || error).slice(0, 160), "error"); return; }
      }

      if (pathname === "/actions/scanner/target") {
        if (req.method !== "POST") { rejectPrivate(res, 405, "POST required"); return; }
        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        if (!contentType.startsWith("application/x-www-form-urlencoded")) { rejectPrivate(res, 415, "Form submission required"); return; }
        try {
          const form = await readFormBody(req);
          if (!safeTokenEqual(form.get("csrf"), dashboardActionToken)) { rejectPrivate(res, 403, "Invalid dashboard action token"); return; }
          const result = dashboardStore.setTargetScansPerHour(Number(form.get("target")));
          queueMicrotask(() => Promise.resolve(discoveryCycle()).catch((error) => console.warn(`[dashboard] scan-target trigger failed: ${String(error?.message || error).slice(0, 300)}`)));
          redirectNotice(res, `Scanner target saved at ${result.targetScansPerHour} scans/hour. API protection remains automatic.`);
          return;
        } catch (error) { redirectNotice(res, String(error?.message || error).slice(0, 160), "error"); return; }
      }

      try {
        const minDistinctTokens = clampInt(requestUrl?.searchParams.get("min"), 3, 2, 100);
        const apiWalletLimit = clampInt(requestUrl?.searchParams.get("limit"), 250, 1, 1000);
        const queueLimit = clampInt(requestUrl?.searchParams.get("queueLimit"), 100, 1, 500);
        const stats = dashboardStore.stats(store.summary(), gmgnGuard?.snapshot?.() || {});
        const walletTotal = dashboardStore.walletCount({ minDistinctTokens });
        const wallets = dashboardStore.wallets({ minDistinctTokens, limit: pathname === "/api/wallets" ? apiWalletLimit : 100 });
        const queue = dashboardStore.queue({ limit: queueLimit });
        if (pathname === "/api/wallets") {
          res.writeHead(200, { ...privateHeaders, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ generatedAt: stats.generatedAt, minDistinctTokens, walletTotal, stats, wallets }, null, 2));
          return;
        }
        if (pathname === "/api/queue") {
          res.writeHead(200, { ...privateHeaders, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ generatedAt: stats.generatedAt, stats, queue }, null, 2));
          return;
        }
        if (pathname === "/api/throughput") {
          res.writeHead(200, { ...privateHeaders, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ generatedAt: stats.generatedAt, throughput: {
            targetScansPerHour: stats.targetScansPerHour,
            maxTargetScansPerHour: stats.maxTargetScansPerHour,
            scansLastHour: stats.scansLastHour,
            firstScansLastHour: stats.firstScansLastHour,
            rescansLastHour: stats.rescansLastHour,
            queueDepth: stats.queuedTokens,
            newQueueDepth: stats.newQueuedTokens,
            rescanQueueDepth: stats.rescanQueuedTokens,
            gmgn: stats.gmgn,
          } }, null, 2));
          return;
        }
        const notice = String(requestUrl?.searchParams.get("notice") || "").slice(0, 180);
        const noticeKind = requestUrl?.searchParams.get("kind") === "error" ? "error" : "success";
        res.writeHead(200, { ...privateHeaders, "content-type": "text/html; charset=utf-8" });
        res.end(renderPrivateDashboard(stats, wallets, { queue, minDistinctTokens, walletTotal, csrfToken: dashboardActionToken, notice, noticeKind }));
      } catch (error) { rejectPrivate(res, 503, `Dashboard temporarily unavailable: ${String(error?.message || error).slice(0, 200)}`); }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  server.listen(port, host, () => {
    console.log(`[recurrence] listening on ${host}:${server.address()?.port || port}; interval=${intervalMinutes}m; trending=${trendingLimit}; scans/cycle=${tokensPerCycle}; target=${dashboardStore.throughput().targetScansPerHour}/h; target-max=${maxTargetScansPerHour}/h; top-traders=${traderLimit}; rescan=${rescanHours}h; trending-refresh=${trendingRefreshMinutes}m`);
  });
  server.once("listening", () => phase2Signals.start());
  queueMicrotask(() => discoveryCycle());
  const timer = setInterval(discoveryCycle, intervalMinutes * 60 * 1000);
  const performanceStartTimer = setTimeout(() => performanceEnrichmentCycle()
    .catch((error) => console.warn(`[phase2] performance scheduler failed: ${String(error?.message || error).slice(0, 240)}`)), 2 * 60 * 1000);
  const performanceTimer = setInterval(() => performanceEnrichmentCycle()
    .catch((error) => console.warn(`[phase2] performance scheduler failed: ${String(error?.message || error).slice(0, 240)}`)), performanceIntervalMinutes * 60 * 1000);
  timer.unref?.();
  performanceStartTimer.unref?.();
  performanceTimer.unref?.();
  server.once("close", () => { clearInterval(timer); clearTimeout(performanceStartTimer); clearInterval(performanceTimer); phase2Signals.stop(); });
  return { db, server, store, dashboardStore, phase2Lab, phase2Signals, discoveryCycle, performanceEnrichmentCycle };
}

module.exports = { clampInt, createCli, createDiscoveryCycleRunner, isGlobalGmgnThrottle, publicHealth, readFormBody, readJsonBody, renderDashboard, safeTokenEqual, stableDashboardActionToken, startRecurrenceApp };
