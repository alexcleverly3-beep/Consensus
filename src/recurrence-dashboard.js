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

function createRecurrenceDashboardStore(db, {
  now = () => Date.now(),
  defaultTargetScansPerHour = 12,
  maxTargetScansPerHour = 18,
} = {}) {
  const safeMaxTarget = Math.max(1, Math.min(60, Math.floor(Number(maxTargetScansPerHour) || 18)));
  const safeDefaultTarget = Math.max(1, Math.min(safeMaxTarget, Math.floor(Number(defaultTargetScansPerHour) || 12)));
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurrence_wallet_checks (
      wallet_address TEXT PRIMARY KEY,
      checked INTEGER NOT NULL DEFAULT 1,
      checked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recurrence_runtime_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT OR IGNORE INTO recurrence_runtime_settings(key, value, updated_at)
    VALUES ('target_scans_per_hour', ?, ?)
  `).run(String(safeDefaultTarget), now());
  const scanActivity = db.prepare(`
    SELECT COUNT(*) AS total_scans,
      SUM(CASE WHEN was_rescan = 0 THEN 1 ELSE 0 END) AS first_scans,
      SUM(CASE WHEN was_rescan = 1 THEN 1 ELSE 0 END) AS rescans,
      MAX(scanned_at) AS last_scan_at
    FROM recurrence_scan_events
    WHERE scanned_at >= ?
  `);
  const getTargetScans = db.prepare("SELECT value FROM recurrence_runtime_settings WHERE key = 'target_scans_per_hour'");
  const setTargetScans = db.prepare(`
    INSERT INTO recurrence_runtime_settings(key, value, updated_at)
    VALUES ('target_scans_per_hour', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
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
        WHEN status = 'pending' AND last_scanned_at IS NULL THEN 1
        WHEN status = 'pending' THEN 2
        WHEN status = 'failed' AND priority > 0 THEN 3
        WHEN status = 'failed' AND last_scanned_at IS NULL THEN 4
        WHEN status = 'failed' THEN 5
        ELSE 6
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

  function throughput() {
    const generatedAt = now();
    const row = scanActivity.get(generatedAt - 60 * 60 * 1000) || {};
    const storedTarget = Math.floor(Number(getTargetScans.get()?.value));
    return {
      generatedAt,
      targetScansPerHour: Number.isFinite(storedTarget) ? Math.max(1, Math.min(safeMaxTarget, storedTarget)) : safeDefaultTarget,
      maxTargetScansPerHour: safeMaxTarget,
      scansLastHour: num(row.total_scans),
      firstScansLastHour: num(row.first_scans),
      rescansLastHour: num(row.rescans),
      lastScanEventAt: row.last_scan_at == null ? null : num(row.last_scan_at),
    };
  }

  return {
    stats(summary, gmgn = {}) {
      const scanRate = throughput();
      const recurrence = recurringCounts.get() || {};
      return {
        ...summary,
        ...scanRate,
        repeatWallets: num(recurrence.repeat_wallets),
        reviewWallets: num(recurrence.review_wallets),
        gmgn: {
          freshCalls: num(gmgn.freshCalls),
          configuredMax: num(gmgn.maxFreshCalls),
          effectiveMax: num(gmgn.effectiveMaxFreshCalls, num(gmgn.maxFreshCalls)),
          remaining: num(gmgn.remaining),
          rateLimitEvents: num(gmgn.rateLimitEvents),
          cooldownRemainingMs: num(gmgn.cooldownRemainingMs),
          windowMs: num(gmgn.windowMs, 20 * 60 * 1000),
          lastRateLimitAt: gmgn.lastRateLimitAt == null ? null : num(gmgn.lastRateLimitAt),
        },
      };
    },
    throughput,
    scanPlan({ cycleCap = 3 } = {}) {
      const state = throughput();
      const remaining = Math.max(0, state.targetScansPerHour - state.scansLastHour);
      const safeCycleCap = Math.max(1, Math.min(10, Math.floor(Number(cycleCap) || 3)));
      if (remaining === 0) return { ...state, allowance: 0, reason: "hourly-target-reached" };
      if (!state.lastScanEventAt) return { ...state, allowance: Math.min(safeCycleCap, remaining), reason: "initial-catch-up" };
      const desiredGapMs = 60 * 60 * 1000 / state.targetScansPerHour;
      const dueByPace = Math.floor(Math.max(0, state.generatedAt - state.lastScanEventAt) / desiredGapMs);
      return {
        ...state,
        allowance: Math.min(safeCycleCap, remaining, dueByPace),
        reason: dueByPace > 0 ? "scan-due" : "pace-wait",
      };
    },
    setTargetScansPerHour(value) {
      const target = Number(value);
      if (!Number.isInteger(target) || target < 1 || target > safeMaxTarget) {
        throw new Error(`target scans/hour must be a whole number from 1 to ${safeMaxTarget}`);
      }
      setTargetScans.run(String(target), now());
      return { targetScansPerHour: target, maxTargetScansPerHour: safeMaxTarget };
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
        scanType: row.last_scanned_at == null ? "new" : "rescan",
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

function throughputState(stats) {
  const gmgn = stats?.gmgn || {};
  if (num(gmgn.cooldownRemainingMs) > 0) {
    return { kind: "blocked", label: "API cooldown", detail: `Provider rate limit detected; retrying in ${Math.ceil(num(gmgn.cooldownRemainingMs) / 1000)}s.` };
  }
  if (num(gmgn.effectiveMax) < num(gmgn.configuredMax)) {
    return { kind: "limited", label: "Automatic backoff", detail: `Provider limit reduced the safe API budget to ${num(gmgn.effectiveMax)} calls per ${Math.round(num(gmgn.windowMs, 20 * 60 * 1000) / 60000)}m. It will recover gradually after clean windows.` };
  }
  if (num(gmgn.remaining) <= 0 && num(gmgn.configuredMax) > 0) {
    return { kind: "limited", label: "API budget used", detail: "The local safety budget is full for this window; scanning resumes automatically when it resets." };
  }
  if (num(stats?.scansLastHour) >= num(stats?.targetScansPerHour)) {
    return { kind: "healthy", label: "Target reached", detail: "The scanner is holding the configured rolling-hour target." };
  }
  if (num(stats?.queuedTokens) === 0) {
    return { kind: "waiting", label: "Waiting for token intake", detail: "API capacity is available, but no unscanned or due-for-rescan tokens are queued." };
  }
  if (Number.isFinite(Number(stats?.newQueuedTokens)) && num(stats?.newQueuedTokens) === 0) {
    return { kind: "waiting", label: "Refreshing for new tokens", detail: `${num(stats?.rescanQueuedTokens)} rescans are waiting while intake checks rotating sources for fresh tokens.` };
  }
  const queueDetail = Number.isFinite(Number(stats?.newQueuedTokens))
    ? `${num(stats?.newQueuedTokens)} new tokens are first in line; ${num(stats?.rescanQueuedTokens)} rescans will follow.`
    : `${num(stats?.queuedTokens)} queued tokens are available and API protection is clear.`;
  return { kind: "healthy", label: "Scanning toward target", detail: queueDetail };
}

function renderPrivateDashboard(stats, wallets, {
  queue = [],
  minDistinctTokens = 3,
  csrfToken = "",
  notice = "",
  noticeKind = "success",
} = {}) {
  const activity = activityState(stats);
  const targetScansPerHour = Math.max(1, num(stats.targetScansPerHour, 12));
  const maxTargetScansPerHour = Math.max(targetScansPerHour, num(stats.maxTargetScansPerHour, 18));
  const firstScansLastHour = num(stats.firstScansLastHour);
  const rescansLastHour = num(stats.rescansLastHour);
  const newQueuedTokens = num(stats.newQueuedTokens);
  const rescanQueuedTokens = num(stats.rescanQueuedTokens);
  const walletRows = wallets.length ? wallets.map((wallet, index) => {
    const flags = [wallet.everCreator ? "creator" : null, wallet.everInsider ? "insider" : null].filter(Boolean).join(", ") || "—";
    const checkLabel = wallet.checked ? "✓ Checked" : "Mark checked";
    const checkTitle = wallet.checked ? "Mark this wallet as not checked" : "Mark this wallet as checked";
    const checkControl = `<form class="check-form" method="post" action="/actions/wallet/checked"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="wallet" value="${escapeHtml(wallet.walletAddress)}"><input type="hidden" name="checked" value="${wallet.checked ? "0" : "1"}"><input type="hidden" name="min" value="${escapeHtml(minDistinctTokens)}"><button class="check-button ${wallet.checked ? "is-checked" : ""}" type="submit" title="${checkTitle}" aria-pressed="${wallet.checked ? "true" : "false"}">${checkLabel}</button></form>`;
    return `<tr class="${wallet.checked ? "wallet-checked" : ""}"><td>${index + 1}</td><td class="mono"><a href="https://solscan.io/account/${encodeURIComponent(wallet.walletAddress)}" target="_blank" rel="noreferrer">${escapeHtml(wallet.walletAddress)}</a>${checkControl}</td><td><strong>${wallet.distinctTokens}</strong></td><td>${wallet.totalAppearances}</td><td>${wallet.top10Tokens}</td><td>${wallet.top25Tokens}</td><td>${wallet.bestRank}</td><td>${wallet.averageBestRank == null ? "—" : escapeHtml(wallet.averageBestRank)}</td><td>${escapeHtml(flags)}</td><td>${escapeHtml(formatTime(wallet.lastSeenAt))}</td></tr>`;
  }).join("") : `<tr><td colspan="10">No wallets have reached ${minDistinctTokens}+ distinct token appearances yet.</td></tr>`;

  const queueRows = queue.length ? queue.map((token, index) => {
    const done = token.status === "done";
    const statusClass = done ? "badge done" : token.status === "failed" ? "badge warn" : token.priority ? "badge priority" : token.scanType === "new" ? "badge new" : "badge rescan";
    const statusText = done ? "scanned" : token.priority ? "priority" : token.status === "failed" ? "failed" : token.scanType === "new" ? "new" : "rescan";
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
  const noticeMessage = notice
    ? `<div class="notice ${noticeKind === "error" ? "notice-error" : "notice-ok"}">${escapeHtml(notice)}</div>`
    : "";
  const throughput = throughputState({ ...stats, targetScansPerHour });
  const gmgn = stats.gmgn || {};
  const windowMinutes = Math.max(1, Math.round(num(gmgn.windowMs, 20 * 60 * 1000) / 60000));
  const lastLimit = gmgn.lastRateLimitAt ? ` Last provider limit: ${formatAge(gmgn.lastRateLimitAt, stats.generatedAt)} ago.` : "";
  const throughputPanel = `<section class="throughput-panel"><div class="throughput-head"><div><div class="eyebrow">Adaptive throughput</div><h2>Scanner control</h2><p class="muted">Set the maximum successful token scans per rolling hour. New tokens are scanned before routine rescans, while manual priority additions remain first. The scanner automatically backs off before retrying after an API limit.</p></div><form class="target-form" method="post" action="/actions/scanner/target"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><label for="scan-target">Target scans/hour</label><div><input id="scan-target" name="target" type="number" min="1" max="${maxTargetScansPerHour}" value="${targetScansPerHour}" required><button class="button primary" type="submit">Save target</button></div><span>Allowed range: 1–${maxTargetScansPerHour}</span></form></div><div class="throughput-grid"><div><span>Actual / target</span><strong>${num(stats.scansLastHour)} / ${targetScansPerHour}</strong></div><div><span>First scans</span><strong>${firstScansLastHour}</strong></div><div><span>Rescans</span><strong>${rescansLastHour}</strong></div><div><span>Queue</span><strong>${num(stats.queuedTokens)}</strong><small>${newQueuedTokens} new · ${rescanQueuedTokens} rescans</small></div><div><span>API calls</span><strong>${num(gmgn.freshCalls)} / ${num(gmgn.effectiveMax)}</strong><small>${windowMinutes}m window</small></div><div><span>Protection</span><strong>Automatic</strong><small>${num(gmgn.rateLimitEvents)} limits recorded</small></div></div><div class="throughput-status ${escapeHtml(throughput.kind)}"><strong>${escapeHtml(throughput.label)}</strong><span>${escapeHtml(throughput.detail + lastLimit)}</span></div></section>`;
  const noticeHtml = `${noticeMessage}${throughputPanel}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Consensus Phase 1</title><style>
.throughput-panel{margin:18px 0 0;border:1px solid var(--border);border-radius:14px;background:linear-gradient(180deg,#121c28,#0d151e);padding:20px}.throughput-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}.throughput-head p{max-width:760px;margin:6px 0 0}.target-form{min-width:270px}.target-form label{display:block;color:#91a4b8;font-size:12px;font-weight:700;margin-bottom:7px}.target-form div{display:flex;gap:8px}.target-form input{width:92px;background:#08111a;color:var(--text);border:1px solid #3a4b60;border-radius:9px;padding:9px 10px;font:inherit}.target-form span{display:block;color:var(--muted);font-size:11px;margin-top:6px}.throughput-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-top:17px}.throughput-grid>div{border:1px solid var(--border-soft);background:#0b131c;border-radius:10px;padding:11px}.throughput-grid span,.throughput-grid small{display:block;color:var(--muted);font-size:11px}.throughput-grid strong{display:block;font-size:20px;margin-top:5px}.throughput-grid small{margin-top:4px}.throughput-status{display:flex;gap:9px;align-items:center;margin-top:12px;padding:9px 11px;border:1px solid #2d5d43;background:#10251a;border-radius:9px;font-size:12px}.throughput-status span{color:#a9bdaf}.throughput-status.limited,.throughput-status.waiting{border-color:#66542f;background:#271f10}.throughput-status.limited span,.throughput-status.waiting span{color:#dbc38f}.throughput-status.blocked{border-color:#70333d;background:#2a1418}.throughput-status.blocked span{color:#efb0b7}@media(max-width:950px){.throughput-head{flex-direction:column}.target-form{min-width:0}.throughput-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:600px){.throughput-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.throughput-status{align-items:flex-start;flex-direction:column}}
.queue-panel{padding:0;overflow:hidden}.queue-summary{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 20px;cursor:pointer;list-style:none}.queue-summary::-webkit-details-marker{display:none}.queue-summary:hover{background:rgba(120,184,255,.035)}.queue-summary p{margin:5px 0 0}.queue-summary-meta{display:flex;align-items:center;gap:10px;white-space:nowrap}.queue-count{color:#b7c9dc;border:1px solid #33465b;background:#111d2a;border-radius:999px;padding:5px 9px;font-size:11px}.queue-action{color:var(--link);font-size:12px}.queue-action:before{content:"Show queue"}.queue-panel[open] .queue-action:before{content:"Hide queue"}.queue-chevron{color:#91a4b8;font-size:19px;line-height:1;transition:transform .15s ease}.queue-panel[open] .queue-chevron{transform:rotate(180deg)}.queue-content{padding:0 20px 20px;border-top:1px solid var(--border-soft)}.queue-tools{display:flex;justify-content:flex-end;padding-top:12px}@media(max-width:700px){.queue-summary{align-items:flex-start;flex-direction:column}.queue-summary-meta{width:100%;white-space:normal}.queue-action{margin-left:auto}}
.wallet-checked{background:rgba(67,214,129,.045)}.wallet-checked td:first-child{box-shadow:inset 3px 0 0 var(--green)}.check-form{display:inline-block;margin-left:10px}.check-button{min-width:104px;border:1px solid #3d536c;background:#131e2b;color:#b7c7d8;padding:5px 8px;border-radius:8px;font:12px Inter,ui-sans-serif,system-ui,sans-serif;font-weight:650;cursor:pointer}.check-button:hover{border-color:#5b7694;color:#fff}.check-button.is-checked{border-color:#2d7950;background:#123321;color:#9aebbb}
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--bg:#080d14;--panel:#111923;--panel2:#0d141d;--border:#243244;--border-soft:#1b2735;--text:#f1f5f9;--muted:#8ea1b5;--link:#67b2ff;--green:#43d681;--red:#ff6e7b;--amber:#f2bd58;--blue:#78b8ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 16% -8%,#16253c 0,transparent 34%),radial-gradient(circle at 82% 0,#111c2d 0,transparent 28%),var(--bg);color:var(--text)}main{max-width:1480px;margin:0 auto;padding:30px 24px 64px}h1{margin:0;font-size:31px;letter-spacing:-.035em}h2{margin:0;font-size:20px}.header,.section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.header{padding:4px 2px 0}.muted,.small{color:var(--muted)}.small{font-size:12px;margin-top:5px}.eyebrow{color:#7f93a9;font-size:11px;text-transform:uppercase;letter-spacing:.16em;margin-bottom:8px;font-weight:700}.header-copy{margin:7px 0 0;font-size:13px}.status-pill{display:flex;align-items:center;gap:8px;border:1px solid var(--border);background:rgba(15,23,34,.78);border-radius:999px;padding:8px 12px;font-size:12px;font-weight:750;letter-spacing:.035em}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--red);box-shadow:0 0 0 4px rgba(255,110,123,.09)}.status-pill.live .status-dot{background:var(--green);box-shadow:0 0 0 4px rgba(67,214,129,.09)}.hero{margin:20px 0 22px;border:1px solid var(--border);border-radius:18px;background:linear-gradient(180deg,rgba(18,27,39,.96),rgba(11,18,27,.96));box-shadow:0 18px 45px rgba(0,0,0,.18);overflow:hidden}.hero-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr))}.hero-card{position:relative;padding:21px 20px 19px;min-height:112px;border-right:1px solid var(--border-soft)}.hero-card:last-child{border-right:0}.hero-card:before{content:"";position:absolute;left:20px;right:20px;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(120,184,255,.5),transparent);opacity:.5}.metric-label{font-size:11px;text-transform:uppercase;letter-spacing:.095em;color:#8195aa;font-weight:700}.metric-value{font-size:34px;line-height:1;font-weight:780;letter-spacing:-.035em;margin-top:11px;font-variant-numeric:tabular-nums}.metric-note{font-size:11.5px;color:#73879c;margin-top:8px}.hero-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 18px;border-top:1px solid var(--border-soft);background:rgba(7,12,18,.32)}.ops{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.op{display:inline-flex;align-items:center;gap:6px;color:#8396aa;font-size:11.5px}.op strong{color:#d9e3ec;font-weight:700;font-variant-numeric:tabular-nums}.hero-freshness{color:#718499;font-size:11.5px}.card,.panel{border:1px solid var(--border);border-radius:14px;background:linear-gradient(180deg,var(--panel),var(--panel2));box-shadow:0 8px 28px rgba(0,0,0,.16)}.active{color:var(--green)}.inactive{color:var(--red)}.panel{padding:20px;margin-top:18px}.section-head{margin-bottom:14px}.section-head p{margin:5px 0 0}.queue-form{display:flex;gap:10px;align-items:center;margin:14px 0 18px}.queue-form input[type=text]{flex:1;min-width:220px;background:#0a111a;color:var(--text);border:1px solid #334154;border-radius:10px;padding:11px 12px;font:inherit}.button{border:1px solid #3d536c;background:#182536;color:var(--text);padding:9px 12px;border-radius:9px;font-weight:650;cursor:pointer}.button.primary{background:#1c5ca0;border-color:#2876c7}.button.danger{background:#29171b;border-color:#66313b;color:#ffb3bb;padding:6px 9px;font-size:12px}.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:11px;background:#0c121a}table{width:100%;min-width:1050px;border-collapse:collapse}th,td{padding:11px 12px;border-bottom:1px solid #1f2a37;text-align:left;font-size:12.5px;white-space:nowrap;vertical-align:middle}th{color:#91a4b8;background:#0f1721;font-weight:650}tr:last-child td{border-bottom:0}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.token-label{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:var(--muted);font-size:11px;margin-top:4px}.badge{display:inline-flex;border:1px solid #3d526a;background:#172331;border-radius:999px;padding:3px 8px;color:#b8c8d8}.badge.priority{border-color:#6355a2;background:#211d38;color:#d5c9ff}.badge.new{border-color:#276345;background:#10291c;color:#a8ebc2}.badge.rescan{border-color:#34567a;background:#122339;color:#b8d9ff}.badge.warn{border-color:#6b5631;background:#2a2112;color:#ffd88b}.badge.done{border-color:#285f41;background:#10271b;color:#aee8c5}.error-text{max-width:260px;overflow:hidden;text-overflow:ellipsis;color:#e9a4aa;margin-top:4px}.filters{display:flex;gap:7px;flex-wrap:wrap}.filter{display:inline-block;text-decoration:none;color:#a9bbce;border:1px solid #334154;background:#111a25;padding:6px 10px;border-radius:999px;font-size:12px}.filter.selected{background:#1a4d7e;border-color:#3476b4;color:white}a{color:var(--link)}.notice{margin:18px 0 0;border-radius:10px;padding:10px 12px;font-size:13px}.notice-ok{border:1px solid #285f41;background:#10271b;color:#aee8c5}.notice-error{border:1px solid #6c303a;background:#2a1217;color:#ffb6bf}.footer{margin-top:18px;font-size:12px;color:var(--muted)}@media(max-width:1100px){.hero-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.hero-card:nth-child(3){border-right:0}.hero-card:nth-child(-n+3){border-bottom:1px solid var(--border-soft)}}@media(max-width:700px){main{padding:20px 14px 48px}.header,.section-head,.queue-form,.hero-footer{align-items:stretch;flex-direction:column}.queue-form input[type=text]{width:100%}.hero-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.hero-card{border-right:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft)}.hero-card:nth-child(2n){border-right:0}.hero-card:last-child{grid-column:1/-1;border-right:0}.metric-value{font-size:30px}.status-pill{align-self:flex-start}}
</style></head><body><main><div class="header"><div><div class="eyebrow">Consensus · Phase 1</div><h1>Smart-wallet discovery</h1><p class="muted header-copy">Live recurrence collection across Solana token trader data.</p></div><div class="status-pill ${activity.active ? "live" : ""}"><span class="status-dot"></span><span>${activity.label}</span><span class="muted">· ${escapeHtml(activity.reason)}</span></div></div>${noticeHtml}<section class="hero"><div class="hero-grid">${primaryCards.map(([label, value, note]) => `<div class="hero-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${formatNumber(value)}</div><div class="metric-note">${escapeHtml(note)}</div></div>`).join("")}</div><div class="hero-footer"><div class="ops">${secondaryStats.map(([label, value], index) => `${index ? '<span class="muted">•</span>' : ''}<span class="op">${escapeHtml(label)} <strong>${formatNumber(value)}</strong></span>`).join("")}</div><div class="hero-freshness">Updated automatically every 30s</div></div></section><details class="panel queue-panel"><summary class="queue-summary"><div><h2>Scanner queue & recent activity</h2><p class="muted">Waiting tokens appear first. Expand when you want to inspect or manage them.</p></div><div class="queue-summary-meta"><span class="queue-count">${formatNumber(stats.queuedTokens)} queued · ${formatNumber(newQueuedTokens)} new · ${formatNumber(rescanQueuedTokens)} rescans</span><span class="queue-action"></span><span class="queue-chevron" aria-hidden="true">⌄</span></div></summary><div class="queue-content"><div class="queue-tools"><a href="/api/queue">Queue JSON</a></div><form class="queue-form" method="post" action="/actions/token/add"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="text" name="token" maxlength="44" autocomplete="off" spellcheck="false" placeholder="Paste a Solana token CA" required><button class="button primary" type="submit">Add priority scan</button></form><div class="table-wrap"><table><thead><tr><th>#</th><th>Token</th><th>State</th><th>Source</th><th>Scans</th><th>State age</th><th>Last seen</th><th></th></tr></thead><tbody>${queueRows}</tbody></table></div></div></details><section class="panel"><div class="section-head"><div><h2>Recurring wallets — ${minDistinctTokens}+ distinct tokens</h2><p class="muted">Recurrence is a discovery signal, not yet a trust score. Creator/insider flags remain visible.</p></div><div class="filters">${thresholds}</div></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Wallet</th><th>Distinct tokens</th><th>Appearances</th><th>Top 10</th><th>Top 25</th><th>Best rank</th><th>Avg best rank</th><th>Flags</th><th>Last seen</th></tr></thead><tbody>${walletRows}</tbody></table></div></section><div class="footer">Private data: <a href="/api/wallets?min=${encodeURIComponent(minDistinctTokens)}">wallet JSON</a> · <a href="/api/queue">queue/activity JSON</a> · public identity-free status: <a href="/health">health</a></div></main></body></html>`;
}

module.exports = {
  activityState,
  createRecurrenceDashboardStore,
  dashboardCredentials,
  formatNumber,
  isAuthorized,
  renderPrivateDashboard,
  throughputState,
};
