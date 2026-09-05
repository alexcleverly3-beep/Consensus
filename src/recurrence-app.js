"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const Database = require("better-sqlite3");
const { initRecurrenceStore, unwrapRows } = require("./recurrence-discovery");
const { resolveDbPath, resolveDiscoveryIntervalMinutes } = require("./runtime-config");

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

function safeJson(value, fallback = {}) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
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
          reject(new Error(message || "gmgn-cli failed"));
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
  const cards = [
    ["Trending tokens seen", c.tokensSeen],
    ["Tokens trader-scanned", c.tokensScanned],
    ["Top-trader wallet/token links", c.walletTokenLinks],
    ["Unique wallets saved", c.walletsSeen],
    ["Repeat wallets", c.repeatWallets],
    ["Queued tokens", c.queuedTokens],
    ["GMGN calls / window", `${health.gmgn.freshCalls}/${health.gmgn.effectiveMax}`],
    ["GMGN cache + dedupe", health.gmgn.cacheHits + health.gmgn.coalesced],
  ];
  const last = c.lastScanAt ? new Date(c.lastScanAt).toISOString() : "Not yet";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Consensus recurrence discovery</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}body{margin:0;background:#0d1117;color:#e6edf3}main{max-width:980px;margin:0 auto;padding:32px 20px}.muted{color:#8b949e}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-top:24px}.card{border:1px solid #30363d;border-radius:10px;background:#161b22;padding:16px}.label{color:#8b949e;font-size:13px}.value{margin-top:6px;font-size:28px;font-weight:700}.note{margin-top:24px;color:#8b949e;line-height:1.5}</style></head><body><main><h1>Consensus — recurrence discovery</h1><p class="muted">Breadth-first mode: scan trending tokens, save non-bot top traders, and rank wallets by independent token recurrence.</p><div class="grid">${cards.map(([label,value]) => `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`).join("")}</div><p class="note">Last completed trader scan: ${escapeHtml(last)}. Wallet identities remain private. Dev/insider-like wallets are retained and labelled internally; obvious bots, exchanges/pools and extreme high-frequency accounts are excluded. Existing V1 evidence tables and code are preserved but are not driving autonomous discovery in this mode.</p></main></body></html>`;
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
  const minGapMs = clampInt(env.GMGN_MIN_REQUEST_GAP_MS, 12_000, 3_000, 60_000);
  const store = initRecurrenceStore(db, { rescanMs: rescanHours * 60 * 60 * 1000 });
  const cli = createCli({ minGapMs });
  let running = false;
  let cycle = 0;

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

  async function discoveryCycle() {
    if (running) return;
    running = true;
    cycle += 1;
    try {
      const trending = await fetchTrending();
      const intake = store.enqueueTrending(trending);
      console.log(
        `[recurrence] cycle=${cycle} trending rows=${intake.rows} unique=${intake.uniqueTokens} ` +
        `new=${intake.added} queue=${store.summary().queuedTokens}`
      );

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
          const summary = store.summary();
          console.log(
            `[recurrence] trader-scan accepted=${result.accepted} rejected=${result.rejected} ` +
            `wallets=${summary.walletsSeen} repeats=${summary.repeatWallets} queue=${summary.queuedTokens}`
          );
        } catch (error) {
          store.markFailed(token.token_address, error);
          throw error;
        }
      }
    } catch (error) {
      console.warn(`[recurrence] cycle failed: ${String(error?.message || error).slice(0, 1000)}`);
    } finally {
      running = false;
    }
  }

  const port = clampInt(env.PORT || env.DASHBOARD_PORT, 3000, 0, 65535);
  const host = env.DASHBOARD_HOST || "0.0.0.0";
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url, "http://recurrence.local").pathname; }
    catch { pathname = req.url; }
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
    if (pathname !== "/" && pathname !== "/index.html") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const health = publicHealth(store, gmgnGuard);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderDashboard(health));
  });

  server.listen(port, host, () => {
    console.log(
      `[recurrence] listening on ${host}:${server.address()?.port || port}; interval=${intervalMinutes}m; ` +
      `trending=${trendingLimit}; scans/cycle=${tokensPerCycle}; top-traders=${traderLimit}; rescan=${rescanHours}h`
    );
  });
  queueMicrotask(() => discoveryCycle());
  const timer = setInterval(discoveryCycle, intervalMinutes * 60 * 1000);
  timer.unref?.();
  server.once("close", () => clearInterval(timer));

  return { db, server, store, discoveryCycle };
}

module.exports = {
  createCli,
  publicHealth,
  renderDashboard,
  startRecurrenceApp,
};
