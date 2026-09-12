"use strict";

const crypto = require("crypto");

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-GB").format(num(value));
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

function formatAge(timestamp, now = Date.now()) {
  if (!timestamp) return "—";
  const ms = Math.max(0, now - Number(timestamp));
  if (ms < 60_000) return "<1m";
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))}h`;
  return `${Math.floor(ms / (24 * 60 * 60_000))}d`;
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurrence_wallet_checks (
      wallet_address TEXT PRIMARY KEY,
      checked INTEGER NOT NULL DEFAULT 1,
      checked_at INTEGER NOT NULL
    )
  `);
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
    WITH recurring AS (
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
    )
    SELECT recurring.*, COALESCE(checks.checked, 0) AS checked, checks.checked_at
    FROM recurring
    LEFT JOIN recurrence_wallet_checks AS checks USING (wallet_address)
    ORDER BY distinct_tokens DESC, top10_tokens DESC, average_best_rank ASC, last_seen_at DESC
    LIMIT ?
  `);
  const queueActivity = db.prepare(`
    SELECT token_address, status, priority, source, first_seen_at, last_seen_at,
      last_scanned_at, scan_count, last_error, priority_queued_at, trend_json
    FROM recurrence_token_queue
    WHERE status IN ('pending', 'failed')
       OR (status = 'done' AND last_scanned_at IS NOT NULL AND last_scanned_at >= ?)
    ORDER BY
      CASE
        WHEN status = 'pending' AND priority > 0 THEN 0
        WHEN status = 'pending' THEN 1
        WHEN status = 'failed' AND priority > 0 THEN 2
        WHEN status = 'failed' THEN 3
        ELSE 4
      END,
      CASE WHEN status = 'done' THEN last_scanned_at END DESC,
      CASE WHEN priority > 0 THEN COALESCE(priority_queued_at, first_seen_at) ELSE first_seen_at END ASC,
      last_seen_at ASC
    LIMIT ?
  `);
  const cancelQueuedToken = db.prepare(`
    UPDATE recurrence_token_queue
    SET status = 'cancelled', priority = 0, priority_queued_at = NULL, last_error = NULL
    WHERE token_address = ? AND status IN ('pending', 'failed')
  `);
  const markWalletChecked = db.prepare(`
    INSERT INTO recurrence_wallet_checks(wallet_address, checked, checked_at)
    VALUES (?, 1, ?)
    ON CONFLICT(wallet_address) DO UPDATE SET checked = 1, checked_at = excluded.checked_at
  `);
  const clearWalletChecked = db.prepare("DELETE FROM recurrence_wallet_checks WHERE wallet_address = ?");

  function tokenLabel(row) {
    let meta = {};
    try { meta = JSON.parse(String(row.trend_json || "{}")); } catch {}
    const symbol = meta?.symbol || meta?.token?.symbol || meta?.base_token?.symbol || null;
    const name = meta?.name || meta?.token?.name || meta?.base_token?.name || null;
    return [symbol, name].filter(Boolean).map(String).join(" · ").slice(0, 120);
  }

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
        checked: Boolean(row.checked),
        checkedAt: row.checked_at == null ? null : num(row.checked_at),
      }));
    },
    queue({ limit = 100, recentWindowMs = 60 * 60 * 1000 } = {}) {
      const bounded = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
      const windowMs = Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Number(recentWindowMs) || 60 * 60 * 1000));
      const cutoff = now() - windowMs;
      return queueActivity.all(cutoff, bounded).map((row) => ({
        tokenAddress: row.token_address,
        label: tokenLabel(row),
        status: row.status,
        priority: Boolean(row.priority),
        source: String(row.source || "trending"),
        firstSeenAt: num(row.first_seen_at),
        lastSeenAt: num(row.last_seen_at),
        lastScannedAt: row.last_scanned_at == null ? null : num(row.last_scanned_at),
        scanCount: num(row.scan_count),
        lastError: row.last_error ? String(row.last_error).slice(0, 240) : null,
        priorityQueuedAt: row.priority_queued_at == null ? null : num(row.priority_queued_at),
      }));
    },
    cancelQueuedToken(address) {
      const token = String(address || "").trim();
      if (!SOL_ADDR.test(token)) throw new Error("valid token address is required");
      const result = cancelQueuedToken.run(token);
      return { tokenAddress: token, cancelled: result.changes > 0 };
    },
    setWalletChecked(address, checked) {
      const wallet = String(address || "").trim();
      if (!SOL_ADDR.test(wallet)) throw new Error("valid wallet address is required");
      const isChecked = checked === true;
      if (isChecked) markWalletChecked.run(wallet, now());
      else clearWalletChecked.run(wallet);
      return { walletAddress: wallet, checked: isChecked };
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

function renderPrivateDashboard(stats, wallets, {
  queue = [],
  minDistinctTokens = 3,
  csrfToken = "",
  notice = "",
  noticeKind = "success",
} = {}) {
  const activity = activityState(stats);
  const walletRows = wallets.length ? wallets.map((wallet, index) => {
    const flags = [wallet.everCreator ? "creator" : null, wallet.everInsider ? "insider" : null].filter(Boolean).join(", ") || "—";
    const checkLabel = wallet.checked ? "✓ Checked" : "Mark checked";
    const checkTitle = wallet.checked ? "Mark this wallet as not checked" : "Mark this wallet as checked";
    const checkControl = `<form class="check-form" method="post" action="/actions/wallet/checked"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="wallet" value="${escapeHtml(wallet.walletAddress)}"><input type="hidden" name="checked" value="${wallet.checked ? "0" : "1"}"><input type="hidden" name="min" value="${escapeHtml(minDistinctTokens)}"><button class="check-button ${wallet.checked ? "is-checked" : ""}" type="submit" title="${checkTitle}" aria-pressed="${wallet.checked ? "true" : "false"}">${checkLabel}</button></form>`;
    return `<tr class="${wallet.checked ? "wallet-checked" : ""}"><td>${index + 1}</td><td class="mono"><a href="https://solscan.io/account/${encodeURIComponent(wallet.walletAddress)}" target="_blank" rel="noreferrer">${escapeHtml(wallet.walletAddress)}</a>${checkControl}</td><td><strong>${wallet.distinctTokens}</strong></td><td>${wallet.totalAppearances}</td><td>${wallet.top10Tokens}</td><td>${wallet.top25Tokens}</td><td>${wallet.bestRank}</td><td>${wallet.averageBestRank == null ? "—" : escapeHtml(wallet.averageBestRank)}</td><td>${escapeHtml(flags)}</td><td>${escapeHtml(formatTime(wallet.lastSeenAt))}</td></tr>`;
  }).join("") : `<tr><td colspan="10">No wallets have reached ${minDistinctTokens}+ distinct token appearances yet.</td></tr>`;

  const queueRows = queue.length ? queue.map((token, index) => {
    const done = token.status === "done";
    const statusClass = done ? "badge done" : token.status === "failed" ? "badge warn" : token.priority ? "badge priority" : "badge";
    const statusText = done ? "scanned" : token.priority ? "priority" : token.status;
    const error = token.lastError ? `<div class="error-text" title="${escapeHtml(token.lastError)}">${escapeHtml(token.lastError)}</div>` : "";
    const label = token.label ? `<div class="token-label">${escapeHtml(token.label)}</div>` : "";
    const ageAt = done ? token.lastScannedAt : (token.priorityQueuedAt || token.firstSeenAt);
    const action = done ? '<span class="muted">completed</span>' : `<form method="post" action="/actions/token/cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="token" value="${escapeHtml(token.tokenAddress)}"><button class="button danger" type="submit">Remove</button></form>`;
    return `<tr><td>${index + 1}</td><td class="mono"><a href="https://solscan.io/token/${encodeURIComponent(token.tokenAddress)}" target="_blank" rel="noreferrer">${escapeHtml(token.tokenAddress)}</a>${label}</td><td><span class="${statusClass}">${escapeHtml(statusText)}</span></td><td>${escapeHtml(token.source)}</td><td>${token.scanCount}</td><td>${escapeHtml(formatAge(ageAt, stats.generatedAt))}</td><td>${escapeHtml(formatAge(token.lastSeenAt, stats.generatedAt))}${error}</td><td>${action}</td></tr>`;
  }).join("") : '<tr><td colspan="8">No queued or recently scanned tokens.</td></tr>';

  const primaryCards = [
    ["Tokens scanned", stats.tokensScanned, "Total tokens processed"],
    ["Scan rate", stats.scansLastHour, "Completed in the last hour"],
    ["Wallets discovered", stats.walletsSeen, "Unique wallets observed"],
    ["Recurring wallets", stats.repeatWallets, "Seen across 2+ tokens"],
    ["Review candidates", stats.reviewWallets, "Seen across 3+ tokens"],
  ];
  const secondaryStats = [
    ["Queued", stats.queuedTokens],
    ["Priority", stats.priorityQueuedTokens || 0],
    ["Wallet/token observations", stats.walletTokenLinks],
  ];

  const thresholds = [2, 3, 5, 10].map((value) =>
    `<a class="filter ${Number(minDistinctTokens) === value ? "selected" : ""}" href="/?min=${value}">${value}+</a>`
  ).join("");
  const noticeHtml = notice
    ? `<div class="notice ${noticeKind === "error" ? "notice-error" : "notice-ok"}">${escapeHtml(notice)}</div>`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Consensus Phase 1</title><style>
.wallet-checked{background:rgba(67,214,129,.045)}.wallet-checked td:first-child{box-shadow:inset 3px 0 0 var(--green)}.check-form{display:inline-block;margin-left:10px}.check-button{min-width:104px;border:1px solid #3d536c;background:#131e2b;color:#b7c7d8;padding:5px 8px;border-radius:8px;font:12px Inter,ui-sans-serif,system-ui,sans-serif;font-weight:650;cursor:pointer}.check-button:hover{border-color:#5b7694;color:#fff}.check-button.is-checked{border-color:#2d7950;background:#123321;color:#9aebbb}
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--bg:#080d14;--panel:#111923;--panel2:#0d141d;--border:#243244;--border-soft:#1b2735;--text:#f1f5f9;--muted:#8ea1b5;--link:#67b2ff;--green:#43d681;--red:#ff6e7b;--amber:#f2bd58;--blue:#78b8ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 16% -8%,#16253c 0,transparent 34%),radial-gradient(circle at 82% 0,#111c2d 0,transparent 28%),var(--bg);color:var(--text)}main{max-width:1480px;margin:0 auto;padding:30px 24px 64px}h1{margin:0;font-size:31px;letter-spacing:-.035em}h2{margin:0;font-size:20px}.header,.section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.header{padding:4px 2px 0}.muted,.small{color:var(--muted)}.small{font-size:12px;margin-top:5px}.eyebrow{color:#7f93a9;font-size:11px;text-transform:uppercase;letter-spacing:.16em;margin-bottom:8px;font-weight:700}.header-copy{margin:7px 0 0;font-size:13px}.status-pill{display:flex;align-items:center;gap:8px;border:1px solid var(--border);background:rgba(15,23,34,.78);border-radius:999px;padding:8px 12px;font-size:12px;font-weight:750;letter-spacing:.035em}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--red);box-shadow:0 0 0 4px rgba(255,110,123,.09)}.status-pill.live .status-dot{background:var(--green);box-shadow:0 0 0 4px rgba(67,214,129,.09)}.hero{margin:20px 0 22px;border:1px solid var(--border);border-radius:18px;background:linear-gradient(180deg,rgba(18,27,39,.96),rgba(11,18,27,.96));box-shadow:0 18px 45px rgba(0,0,0,.18);overflow:hidden}.hero-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr))}.hero-card{position:relative;padding:21px 20px 19px;min-height:112px;border-right:1px solid var(--border-soft)}.hero-card:last-child{border-right:0}.hero-card:before{content:"";position:absolute;left:20px;right:20px;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(120,184,255,.5),transparent);opacity:.5}.metric-label{font-size:11px;text-transform:uppercase;letter-spacing:.095em;color:#8195aa;font-weight:700}.metric-value{font-size:34px;line-height:1;font-weight:780;letter-spacing:-.035em;margin-top:11px;font-variant-numeric:tabular-nums}.metric-note{font-size:11.5px;color:#73879c;margin-top:8px}.hero-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 18px;border-top:1px solid var(--border-soft);background:rgba(7,12,18,.32)}.ops{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.op{display:inline-flex;align-items:center;gap:6px;color:#8396aa;font-size:11.5px}.op strong{color:#d9e3ec;font-weight:700;font-variant-numeric:tabular-nums}.hero-freshness{color:#718499;font-size:11.5px}.card,.panel{border:1px solid var(--border);border-radius:14px;background:linear-gradient(180deg,var(--panel),var(--panel2));box-shadow:0 8px 28px rgba(0,0,0,.16)}.active{color:var(--green)}.inactive{color:var(--red)}.panel{padding:20px;margin-top:18px}.section-head{margin-bottom:14px}.section-head p{margin:5px 0 0}.queue-form{display:flex;gap:10px;align-items:center;margin:14px 0 18px}.queue-form input[type=text]{flex:1;min-width:220px;background:#0a111a;color:var(--text);border:1px solid #334154;border-radius:10px;padding:11px 12px;font:inherit}.button{border:1px solid #3d536c;background:#182536;color:var(--text);padding:9px 12px;border-radius:9px;font-weight:650;cursor:pointer}.button.primary{background:#1c5ca0;border-color:#2876c7}.button.danger{background:#29171b;border-color:#66313b;color:#ffb3bb;padding:6px 9px;font-size:12px}.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:11px;background:#0c121a}table{width:100%;min-width:1050px;border-collapse:collapse}th,td{padding:11px 12px;border-bottom:1px solid #1f2a37;text-align:left;font-size:12.5px;white-space:nowrap;vertical-align:middle}th{color:#91a4b8;background:#0f1721;font-weight:650}tr:last-child td{border-bottom:0}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.token-label{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:var(--muted);font-size:11px;margin-top:4px}.badge{display:inline-flex;border:1px solid #3d526a;background:#172331;border-radius:999px;padding:3px 8px;color:#b8c8d8}.badge.priority{border-color:#6355a2;background:#211d38;color:#d5c9ff}.badge.warn{border-color:#6b5631;background:#2a2112;color:#ffd88b}.badge.done{border-color:#285f41;background:#10271b;color:#aee8c5}.error-text{max-width:260px;overflow:hidden;text-overflow:ellipsis;color:#e9a4aa;margin-top:4px}.filters{display:flex;gap:7px;flex-wrap:wrap}.filter{display:inline-block;text-decoration:none;color:#a9bbce;border:1px solid #334154;background:#111a25;padding:6px 10px;border-radius:999px;font-size:12px}.filter.selected{background:#1a4d7e;border-color:#3476b4;color:white}a{color:var(--link)}.notice{margin:18px 0 0;border-radius:10px;padding:10px 12px;font-size:13px}.notice-ok{border:1px solid #285f41;background:#10271b;color:#aee8c5}.notice-error{border:1px solid #6c303a;background:#2a1217;color:#ffb6bf}.footer{margin-top:18px;font-size:12px;color:var(--muted)}@media(max-width:1100px){.hero-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.hero-card:nth-child(3){border-right:0}.hero-card:nth-child(-n+3){border-bottom:1px solid var(--border-soft)}}@media(max-width:700px){main{padding:20px 14px 48px}.header,.section-head,.queue-form,.hero-footer{align-items:stretch;flex-direction:column}.queue-form input[type=text]{width:100%}.hero-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.hero-card{border-right:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft)}.hero-card:nth-child(2n){border-right:0}.hero-card:last-child{grid-column:1/-1;border-right:0}.metric-value{font-size:30px}.status-pill{align-self:flex-start}}
</style></head><body><main><div class="header"><div><div class="eyebrow">Consensus · Phase 1</div><h1>Smart-wallet discovery</h1><p class="muted header-copy">Live recurrence collection across Solana token trader data.</p></div><div class="status-pill ${activity.active ? "live" : ""}"><span class="status-dot"></span><span>${activity.label}</span><span class="muted">· ${escapeHtml(activity.reason)}</span></div></div>${noticeHtml}<section class="hero"><div class="hero-grid">${primaryCards.map(([label, value, note]) => `<div class="hero-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${formatNumber(value)}</div><div class="metric-note">${escapeHtml(note)}</div></div>`).join("")}</div><div class="hero-footer"><div class="ops">${secondaryStats.map(([label, value], index) => `${index ? '<span class="muted">•</span>' : ''}<span class="op">${escapeHtml(label)} <strong>${formatNumber(value)}</strong></span>`).join("")}</div><div class="hero-freshness">Updated automatically every 30s</div></div></section><section class="panel"><div class="section-head"><div><h2>Scanner queue & recent activity</h2><p class="muted">Waiting tokens appear first. Manual additions are priority and may be scanned immediately; completed tokens stay visible here for one hour so they do not appear to vanish.</p></div><a href="/api/queue">Queue JSON</a></div><form class="queue-form" method="post" action="/actions/token/add"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="text" name="token" maxlength="44" autocomplete="off" spellcheck="false" placeholder="Paste a Solana token CA" required><button class="button primary" type="submit">Add priority scan</button></form><div class="table-wrap"><table><thead><tr><th>#</th><th>Token</th><th>State</th><th>Source</th><th>Scans</th><th>State age</th><th>Last seen</th><th></th></tr></thead><tbody>${queueRows}</tbody></table></div></section><section class="panel"><div class="section-head"><div><h2>Recurring wallets — ${minDistinctTokens}+ distinct tokens</h2><p class="muted">Recurrence is a discovery signal, not yet a trust score. Creator/insider flags remain visible.</p></div><div class="filters">${thresholds}</div></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Wallet</th><th>Distinct tokens</th><th>Appearances</th><th>Top 10</th><th>Top 25</th><th>Best rank</th><th>Avg best rank</th><th>Flags</th><th>Last seen</th></tr></thead><tbody>${walletRows}</tbody></table></div></section><div class="footer">Private data: <a href="/api/wallets?min=${encodeURIComponent(minDistinctTokens)}">wallet JSON</a> · <a href="/api/queue">queue/activity JSON</a> · public identity-free status: <a href="/health">health</a></div></main></body></html>`;
}

module.exports = {
  activityState,
  createRecurrenceDashboardStore,
  dashboardCredentials,
  formatNumber,
  isAuthorized,
  renderPrivateDashboard,
};
