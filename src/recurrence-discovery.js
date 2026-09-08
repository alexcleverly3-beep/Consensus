"use strict";

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolFlag(value) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function canonicalAddress(value) {
  return typeof value === "string" ? value.trim() : "";
}

function traderAddress(trader) {
  const value = trader?.address || trader?.wallet_address || trader?.wallet || "";
  const wallet = canonicalAddress(value);
  return SOL_ADDR.test(wallet) ? wallet : null;
}

function tokenAddress(row) {
  const value = row?.address || row?.token_address || row?.token?.address ||
    row?.base_token?.address || row?.base_token_address || "";
  const address = canonicalAddress(value);
  return SOL_ADDR.test(address) ? address : null;
}

function unwrapRows(response) {
  const payload = response?.data ?? response ?? {};
  if (Array.isArray(payload)) return payload;
  for (const key of ["list", "rank", "tokens", "items", "data"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function traderTags(trader) {
  return [
    ...(Array.isArray(trader?.tags) ? trader.tags : []),
    ...(Array.isArray(trader?.maker_token_tags) ? trader.maker_token_tags : []),
  ].map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
}

function recurrenceTraderExclusion(trader) {
  const wallet = traderAddress(trader);
  if (!wallet) return "invalid-wallet";
  if (Number(trader?.addr_type) === 2) return "exchange-or-pool";
  if (boolFlag(trader?.is_bot) || boolFlag(trader?.bot)) return "bot-flag";

  const tags = traderTags(trader);
  const botTags = new Set([
    "bundler", "dex_bot", "arbitrager", "mev_bot", "sniper_bot",
    "sandwich_bot", "trading_bot", "high_frequency_trader",
  ]);
  const botTag = tags.find((tag) => botTags.has(tag));
  if (botTag) return `tag:${botTag}`;

  const buyCount = Math.max(0, num(trader?.buy_tx_count_cur));
  const sellCount = Math.max(0, num(trader?.sell_tx_count_cur));
  if (trader?.buy_tx_count_cur != null && buyCount === 0) return "no-buy-activity";
  if (buyCount + sellCount >= 50) return "high-frequency-trading";
  return null;
}

function creatorAddressFromToken(row) {
  return canonicalAddress(
    row?.creator_address || row?.creator || row?.dev?.creator_address ||
    row?.token?.creator_address || row?.base_token?.creator_address || ""
  );
}

function insiderLike(trader, walletAddress, creatorAddress = "") {
  if (creatorAddress && walletAddress === creatorAddress) return true;
  if (boolFlag(trader?.transfer_in) || boolFlag(trader?.is_suspicious)) return true;
  const tags = traderTags(trader);
  return tags.some((tag) => ["dev", "developer", "creator", "insider", "rat_trader"].includes(tag));
}

function initRecurrenceStore(db, { rescanMs = 24 * 60 * 60 * 1000 } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurrence_token_queue (
      token_address TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_scanned_at INTEGER,
      scan_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      trend_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_recurrence_token_queue_status
      ON recurrence_token_queue(status, first_seen_at ASC);

    CREATE TABLE IF NOT EXISTS recurrence_wallet_tokens (
      wallet_address TEXT NOT NULL,
      token_address TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      scan_appearances INTEGER NOT NULL DEFAULT 1,
      best_rank INTEGER NOT NULL,
      latest_rank INTEGER NOT NULL,
      latest_profit REAL,
      latest_profit_change REAL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      is_creator INTEGER NOT NULL DEFAULT 0,
      is_insider INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(wallet_address, token_address)
    );
    CREATE INDEX IF NOT EXISTS idx_recurrence_wallet_tokens_wallet
      ON recurrence_wallet_tokens(wallet_address, last_seen_at DESC);
  `);

  const getToken = db.prepare("SELECT * FROM recurrence_token_queue WHERE token_address = ?");
  const insertToken = db.prepare(`
    INSERT INTO recurrence_token_queue(
      token_address, first_seen_at, last_seen_at, status, trend_json
    ) VALUES (?, ?, ?, 'pending', ?)
  `);
  const updateTokenSeen = db.prepare(`
    UPDATE recurrence_token_queue
    SET last_seen_at = ?, trend_json = ?,
        status = CASE
          WHEN last_scanned_at IS NULL OR last_scanned_at <= ? THEN 'pending'
          ELSE status
        END
    WHERE token_address = ?
  `);
  const nextToken = db.prepare(`
    SELECT * FROM recurrence_token_queue
    WHERE status = 'pending'
    ORDER BY first_seen_at ASC, last_seen_at ASC
    LIMIT 1
  `);
  const markScanned = db.prepare(`
    UPDATE recurrence_token_queue
    SET last_scanned_at = ?, scan_count = scan_count + 1,
        status = 'done', last_error = NULL
    WHERE token_address = ?
  `);
  const markFailed = db.prepare(`
    UPDATE recurrence_token_queue
    SET status = 'pending', last_error = ?
    WHERE token_address = ?
  `);
  const getWalletToken = db.prepare(`
    SELECT * FROM recurrence_wallet_tokens
    WHERE wallet_address = ? AND token_address = ?
  `);
  const insertWalletToken = db.prepare(`
    INSERT INTO recurrence_wallet_tokens(
      wallet_address, token_address, first_seen_at, last_seen_at,
      scan_appearances, best_rank, latest_rank, latest_profit,
      latest_profit_change, tags_json, is_creator, is_insider
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateWalletToken = db.prepare(`
    UPDATE recurrence_wallet_tokens
    SET last_seen_at = ?, scan_appearances = scan_appearances + 1,
        best_rank = MIN(best_rank, ?), latest_rank = ?,
        latest_profit = ?, latest_profit_change = ?, tags_json = ?,
        is_creator = MAX(is_creator, ?), is_insider = MAX(is_insider, ?)
    WHERE wallet_address = ? AND token_address = ?
  `);
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM recurrence_token_queue) AS tokens_seen,
      (SELECT COUNT(*) FROM recurrence_token_queue WHERE scan_count > 0) AS tokens_scanned,
      (SELECT COALESCE(SUM(scan_count), 0) FROM recurrence_token_queue) AS total_token_scans,
      (SELECT COUNT(*) FROM recurrence_token_queue WHERE status = 'pending') AS queued_tokens,
      (SELECT COUNT(*) FROM recurrence_wallet_tokens) AS wallet_token_links,
      (SELECT COUNT(DISTINCT wallet_address) FROM recurrence_wallet_tokens) AS wallets_seen,
      (SELECT COUNT(*) FROM (
        SELECT wallet_address FROM recurrence_wallet_tokens
        GROUP BY wallet_address HAVING COUNT(*) >= 2
      )) AS repeat_wallets,
      (SELECT MAX(last_scanned_at) FROM recurrence_token_queue) AS last_scan_at
  `);
  const topWallets = db.prepare(`
    SELECT wallet_address,
      COUNT(*) AS distinct_tokens,
      SUM(scan_appearances) AS total_appearances,
      SUM(CASE WHEN best_rank <= 10 THEN 1 ELSE 0 END) AS top10_tokens,
      SUM(CASE WHEN best_rank <= 25 THEN 1 ELSE 0 END) AS top25_tokens,
      MIN(best_rank) AS best_rank,
      MIN(first_seen_at) AS first_seen_at,
      MAX(last_seen_at) AS last_seen_at,
      MAX(is_creator) AS ever_creator,
      MAX(is_insider) AS ever_insider
    FROM recurrence_wallet_tokens
    GROUP BY wallet_address
    ORDER BY distinct_tokens DESC, top10_tokens DESC, best_rank ASC, last_seen_at DESC
    LIMIT ?
  `);

  function enqueueTrending(response, observedAt = Date.now()) {
    const rows = unwrapRows(response);
    const seen = new Set();
    let added = 0;
    let refreshed = 0;
    let invalid = 0;
    for (const row of rows) {
      const address = tokenAddress(row);
      if (!address) { invalid += 1; continue; }
      if (seen.has(address)) continue;
      seen.add(address);
      const existing = getToken.get(address);
      const trendJson = JSON.stringify(row);
      if (!existing) {
        insertToken.run(address, observedAt, observedAt, trendJson);
        added += 1;
      } else {
        updateTokenSeen.run(observedAt, trendJson, observedAt - rescanMs, address);
        refreshed += 1;
      }
    }
    return { rows: rows.length, uniqueTokens: seen.size, added, refreshed, invalid };
  }

  const ingestTx = db.transaction(({ tokenAddress: address, traders, tokenMeta, observedAt }) => {
    const creatorAddress = creatorAddressFromToken(tokenMeta || {});
    const seenWallets = new Set();
    let accepted = 0;
    let rejected = 0;
    const rejectedByReason = {};

    for (let index = 0; index < traders.length; index += 1) {
      const trader = traders[index];
      const wallet = traderAddress(trader);
      const exclusion = recurrenceTraderExclusion(trader);
      if (exclusion) {
        rejected += 1;
        rejectedByReason[exclusion] = (rejectedByReason[exclusion] || 0) + 1;
        continue;
      }
      if (seenWallets.has(wallet)) {
        rejected += 1;
        rejectedByReason["duplicate-wallet"] = (rejectedByReason["duplicate-wallet"] || 0) + 1;
        continue;
      }
      seenWallets.add(wallet);

      const rank = index + 1;
      const tags = traderTags(trader);
      const isCreator = creatorAddress && wallet === creatorAddress ? 1 : 0;
      const isInsider = insiderLike(trader, wallet, creatorAddress) ? 1 : 0;
      const profit = num(trader?.profit, num(trader?.realized_profit) + num(trader?.unrealized_profit));
      const profitChange = num(trader?.profit_change ?? trader?.realized_pnl, 0);
      const existing = getWalletToken.get(wallet, address);

      if (!existing) {
        insertWalletToken.run(
          wallet, address, observedAt, observedAt, rank, rank,
          profit, profitChange, JSON.stringify(tags), isCreator, isInsider
        );
      } else {
        updateWalletToken.run(
          observedAt, rank, rank, profit, profitChange, JSON.stringify(tags),
          isCreator, isInsider, wallet, address
        );
      }
      accepted += 1;
    }

    markScanned.run(observedAt, address);
    return { accepted, rejected, rejectedByReason, uniqueWallets: seenWallets.size };
  });

  return {
    enqueueTrending,
    nextToken: () => nextToken.get() || null,
    markFailed(token, error) {
      markFailed.run(String(error?.message || error || "scan failed").slice(0, 1000), token);
    },
    ingestTokenTraders({ tokenAddress: address, traders = [], tokenMeta = {}, observedAt = Date.now() }) {
      if (!SOL_ADDR.test(canonicalAddress(address))) throw new Error("valid tokenAddress is required");
      if (!Array.isArray(traders)) throw new Error("traders must be an array");
      return ingestTx({ tokenAddress: canonicalAddress(address), traders, tokenMeta, observedAt });
    },
    summary() {
      const row = totals.get() || {};
      return {
        tokensSeen: num(row.tokens_seen),
        tokensScanned: num(row.tokens_scanned),
        totalTokenScans: num(row.total_token_scans),
        queuedTokens: num(row.queued_tokens),
        walletTokenLinks: num(row.wallet_token_links),
        walletsSeen: num(row.wallets_seen),
        repeatWallets: num(row.repeat_wallets),
        lastScanAt: row.last_scan_at == null ? null : num(row.last_scan_at),
      };
    },
    topWallets(limit = 100) {
      const bounded = Math.max(1, Math.min(1000, Number(limit) || 100));
      return topWallets.all(bounded).map((row) => ({
        walletAddress: row.wallet_address,
        distinctTokens: num(row.distinct_tokens),
        totalAppearances: num(row.total_appearances),
        top10Tokens: num(row.top10_tokens),
        top25Tokens: num(row.top25_tokens),
        bestRank: num(row.best_rank),
        firstSeenAt: num(row.first_seen_at),
        lastSeenAt: num(row.last_seen_at),
        everCreator: Boolean(row.ever_creator),
        everInsider: Boolean(row.ever_insider),
      }));
    },
  };
}

module.exports = {
  canonicalAddress,
  initRecurrenceStore,
  recurrenceTraderExclusion,
  traderAddress,
  traderTags,
  tokenAddress,
  unwrapRows,
};
