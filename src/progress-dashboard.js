"use strict";

const crypto = require("crypto");
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

function createProgressStore(db, { env = process.env, gmgnGuard = null, now = () => Date.now() } = {}) {
  const thresholds = trustedThresholds(env);
  const changeWindowMinutes = Math.max(1, int(env.DASHBOARD_CHANGE_MINUTES, 30));
  const changeWindowMs = changeWindowMinutes * 60 * 1000;
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
  const changeStateStmt = db.prepare("SELECT value FROM meta WHERE key = 'dashboard_change_state_v1'");
  const saveChangeStateStmt = db.prepare(`
    INSERT INTO meta(key, value) VALUES ('dashboard_change_state_v1', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const walletsStmt = db.prepare(`
    SELECT
      wallet_address,
      first_seen_at,
      last_seen_at,
      observations,
      distinct_tokens,
      positive_signals,
      negative_signals,
      early_entries,
      profitable_entries,
      rug_or_bad_token_hits,
      avg_entry_delay_sec,
      avg_hold_sec,
      avg_token_score,
      reputation_score,
      confidence_score,
      confidence_label,
      CASE WHEN reputation_score >= ?
        AND confidence_score >= ?
        AND distinct_tokens >= ? THEN 1 ELSE 0 END AS is_trusted
    FROM wallet_profiles
    WHERE observations >= ?
    ORDER BY
      is_trusted DESC,
      confidence_score DESC,
      reputation_score DESC,
      distinct_tokens DESC,
      last_seen_at DESC
    LIMIT ?
  `);

  function trackedValues(snapshot) {
    return {
      tokensScanned: snapshot.totals.tokensScanned,
      walletsObserved: snapshot.totals.walletsObserved,
      smartWalletsFound: snapshot.totals.smartWalletsFound,
      evidenceObservations: snapshot.totals.evidenceObservations,
      consensusAlerts: snapshot.totals.consensusAlerts,
      queuedTokens: snapshot.totals.queuedTokens,
      discoveryCycle: snapshot.discoveryCycle,
      gmgnFreshCalls: snapshot.gmgn.freshCalls,
      gmgnCacheSavings: snapshot.gmgn.cacheHits + snapshot.gmgn.coalesced,
      gmgnRateLimitEvents: snapshot.gmgn.rateLimitEvents,
      gmgnCooldownSeconds: Math.ceil(snapshot.gmgn.cooldownRemainingMs / 1000),
    };
  }

  function readChangeState() {
    try {
      const parsed = JSON.parse(changeStateStmt.get()?.value || "null");
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function changeSnapshot(snapshot) {
    const capturedAt = now();
    const values = trackedValues(snapshot);
    let state = readChangeState();
    if (!state?.checkpoint?.capturedAt || !state.checkpoint.values) {
      state = { checkpoint: { capturedAt, values }, last: null };
      saveChangeStateStmt.run(JSON.stringify(state));
    } else if (capturedAt - Number(state.checkpoint.capturedAt) >= changeWindowMs) {
      const deltas = {};
      for (const [key, value] of Object.entries(values)) {
        deltas[key] = value - Number(state.checkpoint.values[key] || 0);
      }
      state = {
        checkpoint: { capturedAt, values },
        last: {
          from: Number(state.checkpoint.capturedAt),
          to: capturedAt,
          deltas,
        },
      };
      saveChangeStateStmt.run(JSON.stringify(state));
    }
    return {
      windowMinutes: changeWindowMinutes,
      ready: Boolean(state.last),
      from: Number(state.last?.from || state.checkpoint.capturedAt),
      to: Number(state.last?.to || 0),
      nextAt: Number(state.checkpoint.capturedAt) + changeWindowMs,
      deltas: state.last?.deltas || {},
    };
  }

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
        persistedBlockedUntil > now() ? persistedBlockedUntil - now() : 0
      );
      const snapshot = {
        generatedAt: now(),
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
      snapshot.changes = changeSnapshot(snapshot);
      return snapshot;
    },
    wallets({ limit = 100, minObservations = 2 } = {}) {
      return walletsStmt.all(
        thresholds.reputation,
        thresholds.confidence,
        thresholds.distinctTokens,
        Math.max(1, int(minObservations, 2)),
        Math.max(1, Math.min(250, int(limit, 100)))
      ).map((row) => ({
        walletAddress: row.wallet_address,
        firstSeenAt: int(row.first_seen_at),
        lastSeenAt: int(row.last_seen_at),
        observations: int(row.observations),
        distinctTokens: int(row.distinct_tokens),
        positiveSignals: int(row.positive_signals),
        negativeSignals: int(row.negative_signals),
        earlyEntries: int(row.early_entries),
        profitableEntries: int(row.profitable_entries),
        badTokenHits: int(row.rug_or_bad_token_hits),
        averageEntryDelaySeconds: row.avg_entry_delay_sec == null ? null : Number(row.avg_entry_delay_sec),
        averageHoldSeconds: row.avg_hold_sec == null ? null : Number(row.avg_hold_sec),
        averageTokenScore: row.avg_token_score == null ? null : Number(row.avg_token_score),
        reputation: Number(row.reputation_score || 0),
        confidence: Number(row.confidence_score || 0),
        confidenceLabel: String(row.confidence_label || "low"),
        trusted: Boolean(row.is_trusted),
      }));
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

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function privateDashboardCredentials(env = process.env) {
  return {
    username: String(env.DASHBOARD_USERNAME || "consensus").trim() || "consensus",
    password: String(env.DASHBOARD_PASSWORD || ""),
  };
}

function isPrivateRequestAuthorized(req, env = process.env) {
  const expected = privateDashboardCredentials(env);
  if (!expected.password) return false;
  const header = String(req?.headers?.authorization || "");
  if (!header.startsWith("Basic ")) return false;

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return safeEqual(decoded.slice(0, separator), expected.username) &&
    safeEqual(decoded.slice(separator + 1), expected.password);
}

function walletVerdict(wallet, thresholds) {
  if (wallet.trusted) return { label: "Trusted", className: "trusted" };
  const badRate = wallet.distinctTokens > 0 ? wallet.badTokenHits / wallet.distinctTokens : 0;
  if (wallet.reputation < 40 || (wallet.badTokenHits >= 2 && badRate >= 0.25)) {
    return { label: "Risk watch", className: "risk" };
  }
  const missing = [];
  if (wallet.reputation < thresholds.reputation) missing.push("reputation");
  if (wallet.confidence < thresholds.confidence) missing.push("confidence");
  if (wallet.distinctTokens < thresholds.distinctTokens) missing.push("breadth");
  return {
    label: missing.length ? `Building: ${missing.join(", ")}` : "Building evidence",
    className: "building",
  };
}

function formatScore(value) {
  return Number.isFinite(value) ? Math.round(value) : "—";
}

function renderChange(changes, key) {
  if (!changes?.ready) {
    return `<div class="change steady">${escapeHtml(changes?.windowMinutes || 30)}m baseline warming up</div>`;
  }
  const delta = Number(changes.deltas?.[key] || 0);
  const className = delta > 0 ? "up" : delta < 0 ? "down" : "steady";
  const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
  const signed = delta > 0 ? `+${delta}` : String(delta);
  return `<div class="change ${className}">${arrow} ${escapeHtml(signed)} / ${escapeHtml(changes.windowMinutes)}m</div>`;
}

function renderWalletsPage(wallets, thresholds) {
  const rows = wallets.length
    ? wallets.map((wallet, index) => {
      const verdict = walletVerdict(wallet, thresholds);
      return `<tr>
        <td>${index + 1}</td>
        <td class="wallet"><a href="https://solscan.io/account/${encodeURIComponent(wallet.walletAddress)}" target="_blank" rel="noreferrer">${escapeHtml(wallet.walletAddress)}</a></td>
        <td><span class="badge ${verdict.className}">${escapeHtml(verdict.label)}</span></td>
        <td>${formatScore(wallet.reputation)}</td>
        <td>${formatScore(wallet.confidence)}</td>
        <td>${wallet.distinctTokens}</td>
        <td>${wallet.positiveSignals}</td>
        <td>${wallet.earlyEntries}</td>
        <td>${wallet.profitableEntries}</td>
        <td>${wallet.badTokenHits}</td>
        <td>${formatScore(wallet.averageTokenScore)}</td>
        <td>${escapeHtml(formatTime(wallet.lastSeenAt))}</td>
      </tr>`;
    }).join("")
    : '<tr><td colspan="12">No wallets have enough evidence to review yet.</td></tr>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <title>Consensus Private Wallet Review</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #0d1117; color: #e6edf3; }
    main { max-width: 1500px; margin: 0 auto; padding: 32px 20px 48px; }
    h1 { margin: 0 0 6px; font-size: 28px; }
    a { color: #58a6ff; }
    .muted, .note { color: #8b949e; }
    .summary { display: flex; flex-wrap: wrap; gap: 12px; margin: 22px 0; }
    .card { border: 1px solid #30363d; border-radius: 10px; background: #161b22; padding: 14px 16px; }
    .table-wrap { overflow-x: auto; border: 1px solid #30363d; border-radius: 10px; }
    table { width: 100%; min-width: 1250px; border-collapse: collapse; background: #161b22; }
    th, td { text-align: left; padding: 11px; border-bottom: 1px solid #30363d; font-size: 13px; white-space: nowrap; }
    th { color: #8b949e; font-weight: 600; position: sticky; top: 0; background: #161b22; }
    tr:last-child td { border-bottom: 0; }
    .wallet { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; font-weight: 700; }
    .trusted { color: #3fb950; background: #16351f; }
    .building { color: #d29922; background: #3d2e09; }
    .risk { color: #f85149; background: #3d1618; }
  </style>
</head>
<body>
<main>
  <h1>Private wallet review</h1>
  <p class="muted">Ranked longitudinal evidence. Auto-refreshes every 60 seconds. Wallet links open in Solscan.</p>
  <div class="summary">
    <div class="card"><strong>${wallets.filter((wallet) => wallet.trusted).length}</strong> trusted in this view</div>
    <div class="card"><strong>${wallets.length}</strong> wallets with repeat observations</div>
    <div class="card">Trust requires rep ≥ <strong>${thresholds.reputation}</strong>, confidence ≥ <strong>${thresholds.confidence}</strong>, and ≥ <strong>${thresholds.distinctTokens}</strong> independent tokens</div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>#</th><th>Wallet</th><th>Verdict</th><th>Rep</th><th>Conf</th><th>Tokens</th><th>Positive</th><th>Early</th><th>Profitable</th><th>Bad hits</th><th>Avg token</th><th>Last seen</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <p class="note">“Trusted” means the wallet meets the configured historical thresholds; it is not a guarantee of future performance. Bad-token exposure and weak breadth remain visible for review.</p>
  <p><a href="/">Back to public progress</a></p>
</main>
</body>
</html>`;
}

function renderDashboard(snapshot) {
  const t = snapshot.totals;
  const cards = [
    ["Tokens scanned", t.tokensScanned, "tokensScanned"],
    ["Wallets observed", t.walletsObserved, "walletsObserved"],
    ["Smart wallets found", t.smartWalletsFound, "smartWalletsFound"],
    ["Evidence saved", t.evidenceObservations, "evidenceObservations"],
    ["Consensus alerts", t.consensusAlerts, "consensusAlerts"],
    ["Queued tokens", t.queuedTokens, "queuedTokens"],
    ["Discovery cycles", snapshot.discoveryCycle, "discoveryCycle"],
    ["GMGN calls / window", `${snapshot.gmgn.freshCalls}/${snapshot.gmgn.effectiveMax}`, "gmgnFreshCalls"],
    ["GMGN cache + dedupe", snapshot.gmgn.cacheHits + snapshot.gmgn.coalesced, "gmgnCacheSavings"],
    ["GMGN rate limits", snapshot.gmgn.rateLimitEvents, "gmgnRateLimitEvents"],
    ["GMGN cooldown", snapshot.gmgn.cooldownRemainingMs > 0
      ? `${Math.ceil(snapshot.gmgn.cooldownRemainingMs / 1000)}s`
      : "clear", "gmgnCooldownSeconds"],
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
    .change { margin-top: 7px; font-size: 12px; font-weight: 700; }
    .up { color: #3fb950; }
    .down { color: #f85149; }
    .steady { color: #8b949e; }
    a { color: #58a6ff; }
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
  <p class="muted">Live database progress. Wallet identities are deliberately not exposed here. Auto-refreshes every 30 seconds.</p>
  <div class="grid">
    ${cards.map(([label, value, changeKey]) => `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div>${renderChange(snapshot.changes, changeKey)}</div>`).join("")}
  </div>
  <section>
    <h2>Recent successful token scans</h2>
    <table>
      <thead><tr><th>Time</th><th>Activity</th><th>Result</th><th>Consensus</th></tr></thead>
      <tbody>${activity}</tbody>
    </table>
    <p class="note">This activity is read from completed token scans in the live database; it is not sample data. Failed scans, seed refreshes, and outcome-only follow-ups are not included here.</p>
    <p class="note">Arrows compare each value with the previous completed ${snapshot.changes.windowMinutes}-minute checkpoint. They show direction only: for example, a shrinking queue or cooldown can be healthy.</p>
    <p class="note">Smart wallet count uses the same minimum reputation (${snapshot.thresholds.reputation}), confidence (${snapshot.thresholds.confidence}), and distinct-token (${snapshot.thresholds.distinctTokens}) thresholds as V1 discovery.</p>
    <p class="note"><a href="/wallets">Open private wallet review</a></p>
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
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  const store = createProgressStore(db, { env, gmgnGuard });
  // Keep a durable comparison checkpoint moving even when nobody has the page
  // open. This reads only local SQLite/guard state and never spends a GMGN call.
  store.snapshot({ recentLimit: 1 });
  const changeTimer = setInterval(() => {
    try {
      store.snapshot({ recentLimit: 1 });
    } catch (error) {
      console.warn(`[dashboard] change checkpoint failed: ${error.message}`);
    }
  }, 60 * 1000);
  changeTimer.unref?.();
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://dashboard.local").pathname;
    } catch {
      pathname = req.url;
    }
    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (pathname === "/api/progress") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(store.snapshot()));
      return;
    }
    if (pathname === "/wallets" || pathname === "/api/wallets") {
      const credentials = privateDashboardCredentials(env);
      const securityHeaders = {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      };
      if (!credentials.password) {
        res.writeHead(503, { ...securityHeaders, "content-type": "text/plain; charset=utf-8" });
        res.end("Private wallet review is disabled. Set DASHBOARD_PASSWORD in Railway.");
        return;
      }
      if (!isPrivateRequestAuthorized(req, env)) {
        res.writeHead(401, {
          ...securityHeaders,
          "content-type": "text/plain; charset=utf-8",
          "www-authenticate": 'Basic realm="Consensus private wallet review", charset="UTF-8"',
        });
        res.end("Authentication required");
        return;
      }
      const wallets = store.wallets();
      if (pathname === "/api/wallets") {
        res.writeHead(200, { ...securityHeaders, "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ generatedAt: Date.now(), thresholds: trustedThresholds(env), wallets }));
        return;
      }
      res.writeHead(200, { ...securityHeaders, "content-type": "text/html; charset=utf-8" });
      res.end(renderWalletsPage(wallets, trustedThresholds(env)));
      return;
    }
    if (pathname !== "/" && pathname !== "/index.html") {
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
  server.once("close", () => {
    clearInterval(changeTimer);
  });
  return { server, db, store };
}

module.exports = {
  createProgressStore,
  gmgnBudgetSnapshot,
  isPrivateRequestAuthorized,
  renderDashboard,
  renderWalletsPage,
  startProgressDashboard,
  trustedThresholds,
  walletVerdict,
};
