"use strict";

const crypto = require("crypto");

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function dashboardCredentials(env = process.env) {
  return {
    username: String(env.DASHBOARD_USERNAME || "consensus").trim() || "consensus",
    password: String(env.DASHBOARD_PASSWORD || ""),
  };
}

function isAuthorized(req, env = process.env) {
  const expected = dashboardCredentials(env);
  if (!expected.password) return false;
  const header = String(req?.headers?.authorization || "");
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); }
  catch { return false; }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return safeEqual(decoded.slice(0, separator), expected.username) &&
    safeEqual(decoded.slice(separator + 1), expected.password);
}

function createRecurrenceDashboardStore(db, { now = () => Date.now() } = {}) {
  const scansLastHour = db.prepare(`
    SELECT COUNT(*) AS count
    FROM recurrence_token_queue
    WHERE last_scanned_at IS NOT NULL AND last_scanned_at >= ?
  `);
  const recurringCounts = db.prepare(`
    SELECT
      COUNT(*) AS repeat_wallets,
      SUM(CASE WHEN distinct_tokens >= 3 THEN 1 ELSE 0 END) AS review_wallets
    FROM (
      SELECT wallet_address, COUNT(*) AS distinct_tokens
      FROM recurrence_wallet_tokens
      GROUP BY wallet_address
      HAVING COUNT(*) >= 2
    )
  `);
  const recurringWallets = db.prepare(`
    SELECT wallet_address,
      COUNT(*) AS distinct_tokens,
      SUM(scan_appearances) AS total_appearances,
      SUM(CASE WHEN best_rank <= 10 THEN 1 ELSE 0 END) AS top10_tokens,
      SUM(CASE WHEN best_rank <= 25 THEN 1 ELSE 0 END) AS top25_tokens,
      ROUND(AVG(best_rank), 1) AS average_best_rank,
      MIN(best_rank) AS best_rank,
      MIN(first_seen_at) AS first_seen_at,
      MAX(last_seen_at) AS last_seen_at,
      MAX(is_creator) AS ever_creator,
      MAX(is_insider) AS ever_insider
    FROM recurrence_wallet_tokens
    GROUP BY wallet_address
    HAVING COUNT(*) >= ?
    ORDER BY distinct_tokens DESC, top10_tokens DESC, average_best_rank ASC, last_seen_at DESC
    LIMIT ?
  `);

  return {
    stats(summary) {
      const generatedAt = now();
      const recurrence = recurringCounts.get() || {};
      return {
        ...summary,
        generatedAt,
        scansLastHour: num(scansLastHour.get(generatedAt - 60 * 60 * 1000)?.count),
        repeatWallets: num(recurrence.repeat_wallets),
        reviewWallets: num(recurrence.review_wallets),
      };
    },
    wallets({ minDistinctTokens = 3, limit = 250 } = {}) {
      const min = Math.max(2, Math.min(100, Math.floor(Number(minDistinctTokens) || 3)));
      const bounded = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 250)));
      return recurringWallets.all(min, bounded).map((row) => ({
        walletAddress: row.wallet_address,
        distinctTokens: num(row.distinct_tokens),
        totalAppearances: num(row.total_appearances),
        top10Tokens: num(row.top10_tokens),
        top25Tokens: num(row.top25_tokens),
        averageBestRank: row.average_best_rank == null ? null : Number(row.average_best_rank),
        bestRank: num(row.best_rank),
        firstSeenAt: num(row.first_seen_at),
        lastSeenAt: num(row.last_seen_at),
        everCreator: Boolean(row.ever_creator),
        everInsider: Boolean(row.ever_insider),
      }));
    },
  };
}

function activityState(stats, { activeWindowMs = 30 * 60 * 1000 } = {}) {
  if (!stats.lastScanAt) return { active: false, label: "INACTIVE", reason: "No completed trader scan yet" };
  const ageMs = Math.max(0, stats.generatedAt - stats.lastScanAt);
  return ageMs <= activeWindowMs
    ? { active: true, label: "ACTIVE", reason: `Last scan ${Math.max(0, Math.floor(ageMs / 60000))}m ago` }
    : { active: false, label: "INACTIVE", reason: `Last scan ${Math.floor(ageMs / 60000)}m ago` };
}

function renderPrivateDashboard(stats, wallets) {
  const activity = activityState(stats);
  const rows = wallets.length ? wallets.map((wallet, index) => {
    const flags = [wallet.everCreator ? "creator" : null, wallet.everInsider ? "insider" : null].filter(Boolean).join(", ") || "—";
    return `<tr><td>${index + 1}</td><td class="wallet"><a href="https://solscan.io/account/${encodeURIComponent(wallet.walletAddress)}" target="_blank" rel="noreferrer">${escapeHtml(wallet.walletAddress)}</a></td><td><strong>${wallet.distinctTokens}</strong></td><td>${wallet.totalAppearances}</td><td>${wallet.top10Tokens}</td><td>${wallet.top25Tokens}</td><td>${wallet.bestRank}</td><td>${wallet.averageBestRank == null ? "—" : escapeHtml(wallet.averageBestRank)}</td><td>${escapeHtml(flags)}</td><td>${escapeHtml(formatTime(wallet.lastSeenAt))}</td></tr>`;
  }).join("") : '<tr><td colspan="10">No wallets have reached 3 distinct top-trader appearances yet.</td></tr>';

  const cards = [
    ["Scanner", `<span class="${activity.active ? "active" : "inactive"}">${activity.label}</span><div class="small">${escapeHtml(activity.reason)}</div>`],
    ["Tokens scanned", stats.tokensScanned],
    ["Scanned / last hour", stats.scansLastHour],
    ["Queued tokens", stats.queuedTokens],
    ["Unique wallets", stats.walletsSeen],
    ["Wallet/token links", stats.walletTokenLinks],
    ["Recurring wallets 2+", stats.repeatWallets],
    ["Review wallets 3+", stats.reviewWallets],
  ];

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Consensus Phase 1</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}body{margin:0;background:#0d1117;color:#e6edf3}main{max-width:1320px;margin:0 auto;padding:28px 20px 48px}h1{margin:0 0 6px}.muted,.small{color:#8b949e}.small{font-size:12px;margin-top:5px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:24px 0}.card{border:1px solid #30363d;border-radius:10px;background:#161b22;padding:16px}.label{font-size:13px;color:#8b949e}.value{font-size:27px;font-weight:700;margin-top:6px}.active{color:#3fb950}.inactive{color:#f85149}.table-wrap{overflow-x:auto;border:1px solid #30363d;border-radius:10px;background:#161b22}table{width:100%;min-width:1100px;border-collapse:collapse}th,td{padding:11px;border-bottom:1px solid #30363d;text-align:left;font-size:13px;white-space:nowrap}th{color:#8b949e}.wallet{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}a{color:#58a6ff}</style></head><body><main><h1>Consensus — Phase 1</h1><p class="muted">Private recurrence database view. Auto-refreshes every 30 seconds.</p><div class="grid">${cards.map(([label, value]) => `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${value}</div></div>`).join("")}</div><h2>Recurring wallets — 3+ distinct tokens</h2><p class="muted">These are candidates for manual review only. Recurrence is not yet a trust score. Creator/insider flags are shown rather than silently removed.</p><div class="table-wrap"><table><thead><tr><th>#</th><th>Wallet</th><th>Distinct tokens</th><th>Appearances</th><th>Top 10</th><th>Top 25</th><th>Best rank</th><th>Avg best rank</th><th>Flags</th><th>Last seen</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted">Private JSON: <a href="/api/wallets">/api/wallets</a>. Public health remains identity-free at <a href="/health">/health</a>.</p></main></body></html>`;
}

module.exports = {
  activityState,
  createRecurrenceDashboardStore,
  dashboardCredentials,
  isAuthorized,
  renderPrivateDashboard,
};
