"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { resolveDbPath } = require("./runtime-config");

function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function trustedThresholds(env = process.env) {
  return {
    reputation: int(env.TRUSTED_REPUTATION, 65),
    confidence: int(env.TRUSTED_CONFIDENCE, 50),
    distinctTokens: int(env.TRUSTED_DISTINCT_TOKENS, 4),
  };
}

function gmgnBudgetSnapshot(value = {}) {
  const configured = int(value.maxFreshCalls);
  const effective = int(value.effectiveMaxFreshCalls, configured);
  return {
    freshCalls: int(value.freshCalls),
    configuredMax: configured,
    effectiveMax: effective,
    remaining: int(value.remaining),
    cacheHits: int(value.cacheHits),
    coalesced: int(value.coalesced),
    rejected: int(value.rejected),
    rateLimitEvents: int(value.rateLimitEvents),
    cooldownRemainingMs: int(value.cooldownRemainingMs),
    persistenceErrors: int(value.persistenceErrors),
  };
}

function createProgressStore(db, { env = process.env, gmgnGuard = null } = {}) {
  const thresholds = trustedThresholds(env);
  const totalsStmt = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM token_discovery_state WHERE scan_count > 0) AS tokens_scanned,
      (SELECT COALESCE(SUM(scan_count), 0) FROM token_discovery_state) AS total_scans,
      (SELECT COUNT(*) FROM wallet_evidence) AS evidence_observations,
      (SELECT COUNT(*) FROM wallet_profiles) AS wallets_observed,
      (SELECT COUNT(*) FROM wallet_profiles
        WHERE reputation_score >= ?
          AND confidence_score >= ?
          AND distinct_tokens >= ?) AS smart_wallets_found,
      (SELECT COUNT(*) FROM consensus_alerts) AS consensus_alerts,
      (SELECT COUNT(*) FROM seed_token_queue WHERE status = 'pending') AS queued_tokens
  `);
  const recentStmt = db.prepare(`
    SELECT last_scanned_at, last_candidate_count, last_consensus_count
    FROM token_discovery_state
    WHERE last_scanned_at IS NOT NULL
    ORDER BY last_scanned_at DESC
    LIMIT ?
  `);
  const cycleStmt = db.prepare("SELECT value FROM meta WHERE key = 'discovery_cycle_number'");
  const blockedUntilStmt = db.prepare("SELECT value FROM meta WHERE key = 'gmgn_blocked_until'");

  return {
    snapshot({ recentLimit = 8 } = {}) {
      const totals = totalsStmt.get(
        thresholds.reputation,
        thresholds.confidence,
        thresholds.distinctTokens
      ) || {};
      const gmgn = gmgnBudgetSnapshot(
        typeof gmgnGuard?.snapshot === "function" ? gmgnGuard.snapshot() : {}
      );
      const persistedBlockedUntil = int(blockedUntilStmt.get()?.value);
      gmgn.cooldownRemainingMs = Math.max(
        gmgn.cooldownRemainingMs,
        persistedBlockedUntil > Date.now() ? persistedBlockedUntil - Date.now() : 0
      );
      return {
        generatedAt: Date.now(),
        discoveryCycle: int(cycleStmt.get()?.value, 0),
        thresholds,
        gmgn,
        totals: {
          tokensScanned: int(totals.tokens_scanned),
          totalScans: int(totals.total_scans),
          evidenceObservations: int(totals.evidence_observations),
          walletsObserved: int(totals.wallets_observed),
          smartWalletsFound: int(totals.smart_wallets_found),
          consensusAlerts: int(totals.consensus_alerts),
          queuedTokens: int(totals.queued_tokens),
        },
        recent: recentStmt.all(Math.max(1, Math.min(25, int(recentLimit, 8)))).map((row) => ({
          scannedAt: int(row.last_scanned_at),
          candidatesFound: int(row.last_candidate_count),
          consensusWallets: int(row.last_consensus_count),
        })),
      };
    },
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(timestamp) {
  if (!timestamp) return "Not yet";
  return new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function renderDashboard(snapshot) {
  const t = snapshot.totals;
  const cards = [
    ["Tokens scanned", t.tokensScanned],
    ["Wallets observed", t.walletsObserved],
    ["Smart wallets found", t.smartWalletsFound],
    ["Evidence saved", t.evidenceObservations],
    ["Consensus alerts", t.consensusAlerts],
    ["Queued tokens", t.queuedTokens],
    ["Discovery cycles", snapshot.discoveryCycle],
    ["GMGN calls / window", `${snapshot.gmgn.freshCalls}/${snapshot.gmgn.effectiveMax}`],
    ["GMGN cache + dedupe", snapshot.gmgn.cacheHits + snapshot.gmgn.coalesced],
    ["GMGN rate limits", snapshot.gmgn.rateLimitEvents],
    ["GMGN cooldown", snapshot.gmgn.cooldownRemainingMs > 0
      ? `${Math.ceil(snapshot.gmgn.cooldownRemainingMs / 1000)}s`
      : "clear"],
  ];
  const activity = snapshot.recent.length
    ? snapshot.recent.map((item) => `
      <tr>
        <td>${escapeHtml(formatTime(item.scannedAt))}</td>
        <td>Token scan completed</td>
        <td>${item.candidatesFound} promising wallet${item.candidatesFound === 1 ? "" : "s"} found</td>
        <td>${item.consensusWallets > 0 ? `${item.consensusWallets} trusted wallet${item.consensusWallets === 1 ? "" : "s"}` : "No consensus"}</td>
      </tr>`).join("")
    : '<tr><td colspan="4">No completed scans yet.</td></tr>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>Consensus V1 Progress</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #0d1117; color: #e6edf3; }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px 48px; }
    h1 { margin: 0 0 6px; font-size: 28px; }
    .muted { color: #8b949e; margin: 0 0 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 12px; }
    .card { border: 1px solid #30363d; border-radius: 10px; background: #161b22; padding: 16px; }
    .label { color: #8b949e; font-size: 13px; }
    .value { margin-top: 6px; font-size: 28px; font-weight: 700; }
    section { margin-top: 28px; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid #30363d; font-size: 14px; }
    th { color: #8b949e; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .note { margin-top: 14px; color: #8b949e; font-size: 13px; }
  </style>
</head>
<body>
<main>
  <h1>Consensus V1</h1>
  <p class="muted">Live progress only. Wallet identities are deliberately not exposed here. Auto-refreshes every 30 seconds.</p>
  <div class="grid">
    ${cards.map(([label, value]) => `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`).join("")}
  </div>
  <section>
    <h2>Recent activity</h2>
    <table>
      <thead><tr><th>Time</th><th>Activity</th><th>Result</th><th>Consensus</th></tr></thead>
      <tbody>${activity}</tbody>
    </table>
    <p class="note">Smart wallet count uses the same minimum reputation (${snapshot.thresholds.reputation}), confidence (${snapshot.thresholds.confidence}), and distinct-token (${snapshot.thresholds.distinctTokens}) thresholds as V1 discovery.</p>
  </section>
</main>
</body>
</html>`;
}

function startProgressDashboard({
  dbPath = resolveDbPath(),
  port = int(process.env.DASHBOARD_PORT || process.env.PORT, 3000),
  host = process.env.DASHBOARD_HOST || "0.0.0.0",
  env = process.env,
  gmgnGuard = null,
} = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const store = createProgressStore(db, { env, gmgnGuard });
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/api/progress") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(store.snapshot()));
      return;
    }
    if (req.url !== "/" && req.url !== "/index.html") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderDashboard(store.snapshot()));
  });
  server.listen(port, host, () => {
    console.log(`[dashboard] listening on ${host}:${port}; wallet identities are hidden`);
  });
  return { server, db, store };
}

module.exports = {
  createProgressStore,
  gmgnBudgetSnapshot,
  renderDashboard,
  startProgressDashboard,
  trustedThresholds,
};
