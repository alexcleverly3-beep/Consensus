"use strict";

const { trustedProfileQuality } = require("./wallet-quality");

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SCORE_VERSION = "trusted-reputation-points-v1";
const LEADERBOARD_SCORE_VERSION = "phase1-leaderboard-v2";
const PHASE1_LEADERBOARD_GATE = Object.freeze({
  minDistinctTokens: 10,
  minTop10Tokens: 1,
  maxAverageRank: 50,
  excludeCreators: false,
  excludeInsiders: false,
});
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedInt(value, fallback, min, max) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function phase2Config(env = process.env) {
  return {
    trackedWalletLimit: boundedInt(env.TRACKED_WALLET_LIMIT, 100, 1, 100),
    signalWindowMs: boundedInt(env.SIGNAL_WINDOW_MINUTES, 60, 5, 1440) * 60_000,
    minDistinctWallets: boundedInt(env.SIGNAL_MIN_DISTINCT_WALLETS, 3, 2, 20),
    pointsThreshold: boundedInt(env.SIGNAL_POINTS_THRESHOLD, 6, 2, 100),
    realertPointsDelta: boundedInt(env.SIGNAL_REALERT_MIN_ADDITIONAL_POINTS, 3, 1, 100),
    minBuyLamports: boundedInt(env.SIGNAL_MIN_BUY_LAMPORTS, 10_000_000, 1_000_000, 10_000_000_000),
    minStableRaw: boundedInt(env.SIGNAL_MIN_STABLE_RAW, 1_000_000, 100_000, 1_000_000_000),
    phase1LeaderboardGate: { ...PHASE1_LEADERBOARD_GATE },
  };
}

function signalPoints(reputation) {
  const value = num(reputation);
  if (value < 70) return 0;
  if (value < 80) return 1;
  if (value < 90) return 2;
  return 3;
}

function eventTimeMs(event, fallback = Date.now()) {
  const value = num(event?.timestamp ?? event?.blockTime ?? event?.block_time, 0);
  if (!value) return fallback;
  return value < 1e12 ? value * 1000 : value;
}

function rawAmount(item) {
  return num(item?.rawTokenAmount?.tokenAmount ?? item?.rawTokenAmount?.amount ?? item?.tokenAmount ?? item?.amount, 0);
}

function enhancedSwapBuys(event, trackedWallets, config = phase2Config()) {
  const eventType = String(event?.type || "").toUpperCase();
  if (eventType !== "SWAP" && eventType !== "BUY") return [];
  if (event?.transactionError || event?.transaction_error) return [];
  const signature = String(event?.signature || "").trim();
  if (!signature) return [];
  const swap = event?.events?.swap;
  const tracked = trackedWallets instanceof Set ? trackedWallets : new Set(trackedWallets || []);
  const feePayer = String(event?.feePayer || event?.fee_payer || "").trim();
  if (!swap || typeof swap !== "object") {
    if (eventType !== "BUY" || !tracked.has(feePayer)) return [];
    const nativeSpent = (event?.nativeTransfers || []).some((item) =>
      String(item?.fromUserAccount || "").trim() === feePayer && num(item?.amount) >= config.minBuyLamports
    );
    const quoteSpent = (event?.tokenTransfers || []).some((item) => {
      if (String(item?.fromUserAccount || "").trim() !== feePayer) return false;
      const mint = String(item?.mint || "").trim();
      const uiAmount = num(item?.tokenAmount);
      if (mint === WSOL_MINT) return uiAmount >= config.minBuyLamports / 1_000_000_000;
      if (mint === USDC_MINT || mint === USDT_MINT) return uiAmount >= config.minStableRaw / 1_000_000;
      return false;
    });
    if (!nativeSpent && !quoteSpent) return [];
    return (event?.tokenTransfers || []).filter((item) => {
      const mint = String(item?.mint || "").trim();
      return String(item?.toUserAccount || "").trim() === feePayer && SOL_ADDR.test(mint) &&
        !QUOTE_MINTS.has(mint) && num(item?.tokenAmount) > 0;
    }).map((item) => ({
      signature, walletAddress: feePayer, tokenMint: String(item.mint).trim(),
      boughtAt: eventTimeMs(event), source: "helius-enhanced",
    }));
  }

  const involved = new Set();
  if (tracked.has(feePayer)) involved.add(feePayer);
  for (const item of [...(swap.tokenInputs || []), ...(swap.tokenOutputs || [])]) {
    const owner = String(item?.userAccount || item?.user_account || item?.owner || "").trim();
    if (tracked.has(owner)) involved.add(owner);
  }
  for (const item of [swap.nativeInput, swap.nativeOutput]) {
    const owner = String(item?.account || item?.userAccount || item?.user_account || "").trim();
    if (tracked.has(owner)) involved.add(owner);
  }

  const boughtAt = eventTimeMs(event);
  const buys = [];
  for (const wallet of involved) {
    const nativeInput = swap.nativeInput;
    const nativeOwner = String(nativeInput?.account || nativeInput?.userAccount || nativeInput?.user_account || "").trim();
    const spentNative = nativeInput && (nativeOwner === wallet || (!nativeOwner && wallet === feePayer)) &&
      num(nativeInput?.amount, 0) >= config.minBuyLamports;
    const spentStable = (swap.tokenInputs || []).some((item) => {
      const owner = String(item?.userAccount || item?.user_account || item?.owner || "").trim();
      return owner === wallet && (item?.mint === USDC_MINT || item?.mint === USDT_MINT) && rawAmount(item) >= config.minStableRaw;
    });
    const spentWsol = (swap.tokenInputs || []).some((item) => {
      const owner = String(item?.userAccount || item?.user_account || item?.owner || "").trim();
      return owner === wallet && item?.mint === WSOL_MINT && rawAmount(item) >= config.minBuyLamports;
    });
    if (!spentNative && !spentStable && !spentWsol) continue;

    const outputs = (swap.tokenOutputs || []).filter((item) => {
      const owner = String(item?.userAccount || item?.user_account || item?.owner || "").trim();
      const mint = String(item?.mint || "").trim();
      return (owner === wallet || (!owner && wallet === feePayer && involved.size === 1)) &&
        SOL_ADDR.test(mint) && !QUOTE_MINTS.has(mint) && rawAmount(item) > 0;
    });
    for (const output of outputs) {
      buys.push({ signature, walletAddress: wallet, tokenMint: output.mint, boughtAt, source: "helius-enhanced" });
    }
  }
  return buys;
}

function accountKey(value) {
  return String(value?.pubkey || value || "").trim();
}

function rawTransactionBuys(payload, trackedWallets, config = phase2Config()) {
  const result = payload?.result ?? payload;
  const transaction = result?.transaction;
  const meta = result?.meta;
  if (!transaction || !meta || meta.err) return [];
  const keys = (transaction?.message?.accountKeys || []).map(accountKey);
  const signature = String(transaction?.signatures?.[0] || payload?.signature || "").trim();
  if (!signature) return [];
  const tracked = trackedWallets instanceof Set ? trackedWallets : new Set(trackedWallets || []);
  const signers = new Set((transaction?.message?.accountKeys || [])
    .filter((key, index) => (typeof key === "object" ? key.signer : index === 0))
    .map(accountKey));
  const wallets = keys.filter((key) => tracked.has(key) && signers.has(key));
  if (!wallets.length) return [];

  const preByOwnerMint = new Map();
  const postByOwnerMint = new Map();
  for (const item of meta.preTokenBalances || []) {
    preByOwnerMint.set(`${item.owner}:${item.mint}`, num(item?.uiTokenAmount?.amount, 0));
  }
  for (const item of meta.postTokenBalances || []) {
    postByOwnerMint.set(`${item.owner}:${item.mint}`, num(item?.uiTokenAmount?.amount, 0));
  }
  const ownerMints = new Map();
  for (const item of [...(meta.preTokenBalances || []), ...(meta.postTokenBalances || [])]) {
    if (!ownerMints.has(item.owner)) ownerMints.set(item.owner, new Set());
    ownerMints.get(item.owner).add(item.mint);
  }

  const boughtAt = eventTimeMs({ timestamp: result.blockTime ?? payload?.blockTime });
  const buys = [];
  for (const wallet of wallets) {
    const walletIndex = keys.indexOf(wallet);
    const nativeSpent = walletIndex >= 0 &&
      num(meta.preBalances?.[walletIndex], 0) - num(meta.postBalances?.[walletIndex], 0) - num(meta.fee, 0) >= config.minBuyLamports;
    let quoteSpent = nativeSpent;
    for (const mint of QUOTE_MINTS) {
      const key = `${wallet}:${mint}`;
      const delta = num(postByOwnerMint.get(key), 0) - num(preByOwnerMint.get(key), 0);
      const floor = mint === WSOL_MINT ? config.minBuyLamports : config.minStableRaw;
      if (delta <= -floor) quoteSpent = true;
    }
    if (!quoteSpent) continue;
    for (const mint of ownerMints.get(wallet) || []) {
      if (!SOL_ADDR.test(String(mint)) || QUOTE_MINTS.has(mint)) continue;
      const key = `${wallet}:${mint}`;
      if (num(postByOwnerMint.get(key), 0) > num(preByOwnerMint.get(key), 0)) {
        buys.push({ signature, walletAddress: wallet, tokenMint: mint, boughtAt, source: "helius-reconcile" });
      }
    }
  }
  return buys;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function tableColumns(db, name) {
  return tableExists(db, name)
    ? new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name))
    : new Set();
}

function phase1LeaderboardProfiles(db, limit = 100, gate = PHASE1_LEADERBOARD_GATE) {
  const columns = tableColumns(db, "recurrence_wallet_tokens");
  const required = ["wallet_address", "token_address", "scan_appearances", "best_rank", "is_creator", "is_insider"];
  if (required.some((column) => !columns.has(column))) return [];
  const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const rows = db.prepare(`
    SELECT wallet_address,
      COUNT(*) AS distinct_tokens,
      SUM(scan_appearances) AS total_appearances,
      SUM(CASE WHEN best_rank <= 10 THEN 1 ELSE 0 END) AS top10_tokens,
      SUM(CASE WHEN best_rank <= 25 THEN 1 ELSE 0 END) AS top25_tokens,
      MIN(best_rank) AS best_rank,
      AVG(best_rank) AS average_best_rank,
      MAX(is_creator) AS ever_creator,
      MAX(is_insider) AS ever_insider
    FROM recurrence_wallet_tokens
    GROUP BY wallet_address
    HAVING COUNT(*) >= ?
      AND SUM(CASE WHEN best_rank <= 10 THEN 1 ELSE 0 END) >= ?
      AND AVG(best_rank) <= ?
    ORDER BY distinct_tokens DESC, top10_tokens DESC, average_best_rank ASC, best_rank ASC, wallet_address ASC
    LIMIT ?
  `).all(gate.minDistinctTokens, gate.minTop10Tokens, gate.maxAverageRank, Math.min(1000, Math.max(boundedLimit, boundedLimit * 10)));
  return rows.map((row) => {
    const distinctTokens = Math.max(0, Math.floor(num(row.distinct_tokens)));
    const top10Tokens = Math.max(0, Math.floor(num(row.top10_tokens)));
    const top25Tokens = Math.max(0, Math.floor(num(row.top25_tokens)));
    const bestRank = Math.max(0, Math.floor(num(row.best_rank)));
    const averageBestRank = num(row.average_best_rank, Number.POSITIVE_INFINITY);
    const top10Rate = distinctTokens ? top10Tokens / distinctTokens : 0;
    // Recurrence is Phase 1 discovery evidence. Creator and insider flags are
    // retained as evidence but do not disqualify a wallet during calibration.
    if (!SOL_ADDR.test(String(row.wallet_address || "").trim())) return null;
    if (gate.excludeCreators && Boolean(row.ever_creator)) return null;
    if (gate.excludeInsiders && Boolean(row.ever_insider)) return null;
    if (distinctTokens < gate.minDistinctTokens ||
        top10Tokens < gate.minTop10Tokens ||
        averageBestRank > gate.maxAverageRank) return null;
    // Points describe the evidence itself, not how loose or strict the current
    // admission controls are, so dashboard edits cannot inflate a wallet score.
    const breadth = Math.min(15, Math.max(0, distinctTokens - 10) * 1.5);
    const rankStrength = Math.max(0, Math.min(1, (50 - averageBestRank) / 50));
    const reputation = Math.min(100, 70 + breadth + Math.min(10, top10Rate * 30) + rankStrength * 5);
    const confidence = Math.min(100, 72 + Math.min(18, distinctTokens) + Math.min(10, top25Tokens / 2));
    return {
      walletAddress: String(row.wallet_address).trim(),
      reputation: Math.round(reputation),
      confidence: Math.round(confidence),
      points: signalPoints(reputation),
      source: "phase1-leaderboard",
      scoreVersion: LEADERBOARD_SCORE_VERSION,
    };
  }).filter(Boolean).slice(0, boundedLimit);
}

function canonicalTrustedProfiles(db, limit = 100, { leaderboardGate = PHASE1_LEADERBOARD_GATE } = {}) {
  const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const profileCandidates = tableExists(db, "wallet_profiles")
    ? db.prepare("SELECT * FROM wallet_profiles ORDER BY reputation_score DESC, confidence_score DESC, distinct_tokens DESC LIMIT ?")
      .all(Math.min(1000, Math.max(boundedLimit, boundedLimit * 10)))
      .map((profile) => ({ profile, quality: trustedProfileQuality(profile) }))
      .filter((item) => item.quality.eligible)
      .map(({ profile }) => ({
        walletAddress: String(profile.wallet_address || "").trim(),
        reputation: num(profile.reputation_score),
        confidence: num(profile.confidence_score),
        points: signalPoints(profile.reputation_score),
        source: "trusted-profile",
        scoreVersion: SCORE_VERSION,
      }))
      .filter((item) => SOL_ADDR.test(item.walletAddress) && item.points > 0)
    : [];
  const merged = new Map();
  for (const profile of [...profileCandidates, ...phase1LeaderboardProfiles(db, boundedLimit, leaderboardGate)]) {
    if (!merged.has(profile.walletAddress)) merged.set(profile.walletAddress, profile);
  }
  return [...merged.values()]
    .sort((left, right) => right.points - left.points || right.reputation - left.reputation || right.confidence - left.confidence || left.walletAddress.localeCompare(right.walletAddress))
    .slice(0, boundedLimit);
}

function initPhase2SignalStore(db, { env = process.env, now = () => Date.now() } = {}) {
  const config = phase2Config(env);
  db.exec(`
    CREATE TABLE IF NOT EXISTS phase2_tracked_wallets (
      wallet_address TEXT PRIMARY KEY,
      reputation REAL NOT NULL,
      confidence REAL NOT NULL,
      points INTEGER NOT NULL,
      source TEXT NOT NULL,
      score_version TEXT NOT NULL,
      active_from INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS phase2_tracked_wallet_history (
      wallet_address TEXT NOT NULL,
      active_from INTEGER NOT NULL,
      active_to INTEGER,
      reputation REAL NOT NULL,
      confidence REAL NOT NULL,
      points INTEGER NOT NULL,
      source TEXT NOT NULL,
      score_version TEXT NOT NULL,
      PRIMARY KEY(wallet_address, active_from)
    );
    CREATE TABLE IF NOT EXISTS phase2_event_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      processed_at INTEGER,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS phase2_wallet_buys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      bought_at INTEGER NOT NULL,
      points INTEGER NOT NULL,
      score_version TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(signature, wallet_address, token_mint)
    );
    CREATE TABLE IF NOT EXISTS phase2_signal_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_mint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      wallet_count INTEGER NOT NULL,
      total_points INTEGER NOT NULL,
      first_buy_at INTEGER NOT NULL,
      last_buy_at INTEGER NOT NULL,
      score_version TEXT NOT NULL,
      config_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(token_mint, wallet_count, total_points)
    );
    CREATE TABLE IF NOT EXISTS phase2_discord_outbox (
      alert_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      sent_at INTEGER,
      last_error TEXT,
      FOREIGN KEY(alert_id) REFERENCES phase2_signal_alerts(id)
    );
    CREATE TABLE IF NOT EXISTS phase2_metrics (
      metric_key TEXT PRIMARY KEY,
      metric_value INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS phase2_helius_usage (
      usage_month TEXT NOT NULL,
      usage_kind TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      credits INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(usage_month, usage_kind)
    );
    CREATE TABLE IF NOT EXISTS phase2_helius_daily_usage (
      usage_day TEXT NOT NULL,
      usage_kind TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      credits INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(usage_day, usage_kind)
    );
    CREATE TABLE IF NOT EXISTS phase2_runtime_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_phase2_inbox_pending ON phase2_event_inbox(status, received_at);
    CREATE INDEX IF NOT EXISTS idx_phase2_buys_token_time ON phase2_wallet_buys(token_mint, bought_at DESC);
    CREATE INDEX IF NOT EXISTS idx_phase2_outbox_pending ON phase2_discord_outbox(status, next_attempt_at);
  `);

  const settingDefaults = {
    tracked_wallet_limit: config.trackedWalletLimit,
    signal_window_minutes: Math.round(config.signalWindowMs / 60_000),
    signal_min_distinct_wallets: config.minDistinctWallets,
    signal_points_threshold: config.pointsThreshold,
    leaderboard_min_distinct_tokens: config.phase1LeaderboardGate.minDistinctTokens,
    leaderboard_min_top10_tokens: config.phase1LeaderboardGate.minTop10Tokens,
    leaderboard_max_average_rank: config.phase1LeaderboardGate.maxAverageRank,
  };
  const insertSetting = db.prepare("INSERT OR IGNORE INTO phase2_runtime_settings(setting_key,setting_value,updated_at) VALUES (?,?,?)");
  for (const [key, value] of Object.entries(settingDefaults)) insertSetting.run(key, value, now());
  const readSettings = db.prepare("SELECT setting_key,setting_value FROM phase2_runtime_settings");
  const saveSetting = db.prepare("INSERT INTO phase2_runtime_settings(setting_key,setting_value,updated_at) VALUES (?,?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at");

  function loadSettings() {
    const values = Object.fromEntries(readSettings.all().map((row) => [row.setting_key, row.setting_value]));
    config.trackedWalletLimit = boundedInt(values.tracked_wallet_limit, 100, 1, 100);
    config.signalWindowMs = boundedInt(values.signal_window_minutes, 60, 5, 1440) * 60_000;
    config.minDistinctWallets = boundedInt(values.signal_min_distinct_wallets, 3, 2, 20);
    config.pointsThreshold = boundedInt(values.signal_points_threshold, 6, 2, 100);
    config.phase1LeaderboardGate = {
      minDistinctTokens: boundedInt(values.leaderboard_min_distinct_tokens, 10, 3, 100),
      minTop10Tokens: boundedInt(values.leaderboard_min_top10_tokens, 1, 0, 100),
      maxAverageRank: boundedInt(values.leaderboard_max_average_rank, 50, 1, 100),
      excludeCreators: false,
      excludeInsiders: false,
    };
    return config;
  }
  loadSettings();

  const metricIncrement = db.prepare(`
    INSERT INTO phase2_metrics(metric_key, metric_value, updated_at) VALUES (?, 1, ?)
    ON CONFLICT(metric_key) DO UPDATE SET metric_value=metric_value+1, updated_at=excluded.updated_at
  `);
  const metricSet = db.prepare(`
    INSERT INTO phase2_metrics(metric_key, metric_value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(metric_key) DO UPDATE SET metric_value=excluded.metric_value, updated_at=excluded.updated_at
  `);
  const usageUpsert = db.prepare(`
    INSERT INTO phase2_helius_usage(usage_month,usage_kind,calls,credits,updated_at) VALUES (?,?,1,?,?)
    ON CONFLICT(usage_month,usage_kind) DO UPDATE SET calls=calls+1,credits=credits+excluded.credits,updated_at=excluded.updated_at
  `);
  const dailyUsageUpsert = db.prepare(`
    INSERT INTO phase2_helius_daily_usage(usage_day,usage_kind,calls,credits,updated_at) VALUES (?,?,1,?,?)
    ON CONFLICT(usage_day,usage_kind) DO UPDATE SET calls=calls+1,credits=credits+excluded.credits,updated_at=excluded.updated_at
  `);
  const usageForMonth = db.prepare("SELECT COALESCE(SUM(calls),0) calls,COALESCE(SUM(credits),0) credits FROM phase2_helius_usage WHERE usage_month=?");
  const usageForDay = db.prepare("SELECT COALESCE(SUM(calls),0) calls,COALESCE(SUM(credits),0) credits FROM phase2_helius_daily_usage WHERE usage_day=?");
  const usageKindsForDay = db.prepare("SELECT usage_kind,calls,credits FROM phase2_helius_daily_usage WHERE usage_day=? ORDER BY usage_kind");
  const currentWallet = db.prepare("SELECT * FROM phase2_tracked_wallets WHERE wallet_address=?");
  const allCurrentWallets = db.prepare("SELECT * FROM phase2_tracked_wallets ORDER BY points DESC, reputation DESC, wallet_address");
  const allHistoricalWallets = db.prepare("SELECT DISTINCT wallet_address FROM phase2_tracked_wallet_history");
  const insertHistory = db.prepare(`INSERT INTO phase2_tracked_wallet_history(wallet_address,active_from,active_to,reputation,confidence,points,source,score_version) VALUES (?,?,NULL,?,?,?,?,?)`);
  const closeHistory = db.prepare("UPDATE phase2_tracked_wallet_history SET active_to=? WHERE wallet_address=? AND active_to IS NULL");
  const upsertCurrent = db.prepare(`INSERT INTO phase2_tracked_wallets VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(wallet_address) DO UPDATE SET reputation=excluded.reputation,confidence=excluded.confidence,points=excluded.points,source=excluded.source,score_version=excluded.score_version,active_from=excluded.active_from,updated_at=excluded.updated_at`);
  const deleteCurrent = db.prepare("DELETE FROM phase2_tracked_wallets WHERE wallet_address=?");
  const historyAt = db.prepare(`SELECT * FROM phase2_tracked_wallet_history WHERE wallet_address=? AND active_from<=? AND (active_to IS NULL OR active_to>=?) ORDER BY active_from DESC LIMIT 1`);
  const insertInbox = db.prepare("INSERT OR IGNORE INTO phase2_event_inbox(signature,source,received_at,payload_json) VALUES (?,?,?,?)");
  const hasInbox = db.prepare("SELECT 1 FROM phase2_event_inbox WHERE signature=?");
  const nextInbox = db.prepare("SELECT * FROM phase2_event_inbox WHERE status='pending' ORDER BY received_at,id LIMIT 1");
  const markInboxDone = db.prepare("UPDATE phase2_event_inbox SET status='done',attempts=attempts+1,processed_at=?,last_error=NULL WHERE id=?");
  const markInboxFailed = db.prepare("UPDATE phase2_event_inbox SET status='failed',attempts=attempts+1,processed_at=?,last_error=? WHERE id=?");
  const insertBuy = db.prepare(`INSERT OR IGNORE INTO phase2_wallet_buys(signature,wallet_address,token_mint,bought_at,points,score_version,source,created_at) VALUES (?,?,?,?,?,?,?,?)`);
  const recentBuys = db.prepare("SELECT * FROM phase2_wallet_buys WHERE token_mint=? AND bought_at>=? AND bought_at<=? ORDER BY bought_at,id");
  const lastAlert = db.prepare("SELECT * FROM phase2_signal_alerts WHERE token_mint=? ORDER BY created_at DESC,id DESC LIMIT 1");
  const insertAlert = db.prepare(`INSERT OR IGNORE INTO phase2_signal_alerts(token_mint,created_at,wallet_count,total_points,first_buy_at,last_buy_at,score_version,config_json,payload_json) VALUES (?,?,?,?,?,?,?,?,?)`);
  const alertByShape = db.prepare("SELECT * FROM phase2_signal_alerts WHERE token_mint=? AND wallet_count=? AND total_points=?");
  const insertOutbox = db.prepare("INSERT OR IGNORE INTO phase2_discord_outbox(alert_id,next_attempt_at) VALUES (?,?)");
  const nextOutbox = db.prepare(`SELECT o.*,a.payload_json FROM phase2_discord_outbox o JOIN phase2_signal_alerts a ON a.id=o.alert_id WHERE o.status IN ('pending','retry') AND o.next_attempt_at<=? ORDER BY o.next_attempt_at,o.alert_id LIMIT 1`);
  const markOutboxSent = db.prepare("UPDATE phase2_discord_outbox SET status='sent',attempts=attempts+1,sent_at=?,last_error=NULL WHERE alert_id=?");
  const markOutboxRetry = db.prepare("UPDATE phase2_discord_outbox SET status=?,attempts=attempts+1,next_attempt_at=?,last_error=? WHERE alert_id=?");

  const refreshWalletsTx = db.transaction((profiles, at) => {
    const desired = new Map(profiles.slice(0, config.trackedWalletLimit).map((profile) => [profile.walletAddress, profile]));
    for (const existing of allCurrentWallets.all()) {
      if (!desired.has(existing.wallet_address)) {
        closeHistory.run(at, existing.wallet_address);
        deleteCurrent.run(existing.wallet_address);
      }
    }
    for (const profile of desired.values()) {
      const existing = currentWallet.get(profile.walletAddress);
      const changed = !existing || existing.points !== profile.points || existing.reputation !== profile.reputation ||
        existing.confidence !== profile.confidence || existing.score_version !== profile.scoreVersion;
      const activeFrom = changed ? at : existing.active_from;
      if (changed) {
        if (existing) closeHistory.run(at - 1, profile.walletAddress);
        insertHistory.run(profile.walletAddress, at, profile.reputation, profile.confidence, profile.points, profile.source, profile.scoreVersion);
      }
      upsertCurrent.run(profile.walletAddress, profile.reputation, profile.confidence, profile.points, profile.source, profile.scoreVersion, activeFrom, at);
    }
    metricSet.run("wallet_refresh_at", at, at);
    return { tracked: desired.size };
  });

  const recordBuyTx = db.transaction((buy) => {
    const eligibility = historyAt.get(buy.walletAddress, buy.boughtAt, buy.boughtAt);
    if (!eligibility) return { accepted: false, reason: "wallet-not-tracked" };
    const inserted = insertBuy.run(buy.signature, buy.walletAddress, buy.tokenMint, buy.boughtAt, eligibility.points, eligibility.score_version, buy.source, now()).changes > 0;
    if (!inserted) return { accepted: false, reason: "duplicate-buy" };
    metricIncrement.run("genuine_buys", now());

    const rows = recentBuys.all(buy.tokenMint, buy.boughtAt - config.signalWindowMs, buy.boughtAt);
    const wallets = new Map();
    for (const row of rows) if (!wallets.has(row.wallet_address)) wallets.set(row.wallet_address, row);
    const contributions = [...wallets.values()].map((row) => ({ walletAddress: row.wallet_address, points: row.points, boughtAt: row.bought_at }));
    const walletCount = contributions.length;
    const totalPoints = contributions.reduce((sum, item) => sum + item.points, 0);
    const signal = {
      tokenMint: buy.tokenMint,
      walletCount,
      totalPoints,
      firstBuyAt: Math.min(...contributions.map((item) => item.boughtAt)),
      lastBuyAt: Math.max(...contributions.map((item) => item.boughtAt)),
      contributions,
      scoreVersion: SCORE_VERSION,
    };
    if (walletCount < config.minDistinctWallets || totalPoints < config.pointsThreshold) return { accepted: true, alerted: false, signal };
    const previous = lastAlert.get(buy.tokenMint);
    if (previous && (walletCount <= previous.wallet_count || totalPoints < previous.total_points + config.realertPointsDelta)) {
      return { accepted: true, alerted: false, signal, reason: "not-materially-stronger" };
    }
    const configJson = JSON.stringify({ windowMs: config.signalWindowMs, minDistinctWallets: config.minDistinctWallets, pointsThreshold: config.pointsThreshold, realertPointsDelta: config.realertPointsDelta });
    const payloadJson = JSON.stringify(signal);
    insertAlert.run(buy.tokenMint, now(), walletCount, totalPoints, signal.firstBuyAt, signal.lastBuyAt, SCORE_VERSION, configJson, payloadJson);
    const alert = alertByShape.get(buy.tokenMint, walletCount, totalPoints);
    if (!alert) return { accepted: true, alerted: false, signal, reason: "alert-race-suppressed" };
    insertOutbox.run(alert.id, now());
    return { accepted: true, alerted: true, alertId: alert.id, signal };
  });

  return {
    config,
    updateSettings(input = {}) {
      const values = {
        tracked_wallet_limit: boundedInt(input.trackedWalletLimit, config.trackedWalletLimit, 1, 100),
        signal_window_minutes: boundedInt(input.signalWindowMinutes, Math.round(config.signalWindowMs / 60_000), 5, 1440),
        signal_min_distinct_wallets: boundedInt(input.minDistinctWallets, config.minDistinctWallets, 2, 20),
        signal_points_threshold: boundedInt(input.pointsThreshold, config.pointsThreshold, 2, 100),
        leaderboard_min_distinct_tokens: boundedInt(input.minDistinctTokens, config.phase1LeaderboardGate.minDistinctTokens, 3, 100),
        leaderboard_min_top10_tokens: boundedInt(input.minTop10Tokens, config.phase1LeaderboardGate.minTop10Tokens, 0, 100),
        leaderboard_max_average_rank: boundedInt(input.maxAverageRank, config.phase1LeaderboardGate.maxAverageRank, 1, 100),
      };
      db.transaction(() => {
        for (const [key, value] of Object.entries(values)) saveSetting.run(key, value, now());
      })();
      return loadSettings();
    },
    refreshTrackedWallets(profiles = canonicalTrustedProfiles(db, config.trackedWalletLimit, { leaderboardGate: config.phase1LeaderboardGate }), at = now()) {
      return refreshWalletsTx(profiles, at);
    },
    trackedWallets() {
      return allCurrentWallets.all().map((row) => ({ walletAddress: row.wallet_address, reputation: row.reputation, confidence: row.confidence, points: row.points, scoreVersion: row.score_version, activeFrom: row.active_from }));
    },
    acceptEnvelope(event, { source = "helius-webhook", receivedAt = now() } = {}) {
      const signature = String(event?.signature || event?.result?.transaction?.signatures?.[0] || event?.transaction?.signatures?.[0] || "").trim();
      if (!signature) throw new Error("event signature is required");
      const inserted = insertInbox.run(signature, source, receivedAt, JSON.stringify(event)).changes > 0;
      if (!inserted) metricIncrement.run("duplicate_events", now());
      return { signature, inserted, duplicate: !inserted };
    },
    hasSignature(signature) { return Boolean(hasInbox.get(String(signature || "").trim())); },
    incrementMetric(key, at = now()) { metricIncrement.run(String(key), at); },
    setMetric(key, value, at = now()) { metricSet.run(String(key), Math.floor(num(value)), at); },
    recordHeliusUsage(kind, credits, at = now()) {
      const timestamp = new Date(at).toISOString();
      const safeKind = String(kind);
      const safeCredits = Math.max(0, Math.floor(num(credits)));
      db.transaction(() => {
        usageUpsert.run(timestamp.slice(0, 7), safeKind, safeCredits, at);
        dailyUsageUpsert.run(timestamp.slice(0, 10), safeKind, safeCredits, at);
      })();
    },
    heliusUsage(at = now()) {
      const timestamp = new Date(at).toISOString();
      const month = usageForMonth.get(timestamp.slice(0, 7));
      const day = usageForDay.get(timestamp.slice(0, 10));
      return {
        calls: num(month.calls),
        credits: num(month.credits),
        callsToday: num(day.calls),
        creditsToday: num(day.credits),
      };
    },
    processNext() {
      const row = nextInbox.get();
      if (!row) return null;
      try {
        const event = JSON.parse(row.payload_json);
        const wallets = new Set(allHistoricalWallets.all().map((item) => item.wallet_address));
        const buys = row.source === "helius-reconcile"
          ? rawTransactionBuys(event, wallets, config)
          : enhancedSwapBuys(event, wallets, config);
        const results = buys.map(recordBuyTx);
        markInboxDone.run(now(), row.id);
        metricSet.run("last_processed_at", now(), now());
        return { signature: row.signature, buys: results, parsedBuys: buys.length };
      } catch (error) {
        markInboxFailed.run(now(), String(error?.message || error).slice(0, 1000), row.id);
        throw error;
      }
    },
    recordBuy: recordBuyTx,
    nextOutbox(at = now()) {
      const row = nextOutbox.get(at);
      return row ? { ...row, payload: JSON.parse(row.payload_json) } : null;
    },
    markOutboxSent(alertId, at = now()) { markOutboxSent.run(at, alertId); },
    markOutboxFailed(alertId, error, { permanent = false, at = now() } = {}) {
      const current = db.prepare("SELECT attempts FROM phase2_discord_outbox WHERE alert_id=?").get(alertId);
      const attempts = num(current?.attempts) + 1;
      const delay = Math.min(30 * 60_000, 5_000 * (2 ** Math.min(8, attempts - 1)));
      markOutboxRetry.run(permanent ? "failed" : "retry", at + delay, String(error?.message || error).slice(0, 1000), alertId);
    },
    stats(at = now()) {
      const counts = db.prepare(`SELECT
        (SELECT COUNT(*) FROM phase2_tracked_wallets) tracked_wallets,
        (SELECT COUNT(*) FROM phase2_event_inbox) inbox_events,
        (SELECT COUNT(*) FROM phase2_wallet_buys) genuine_buys,
        (SELECT COUNT(*) FROM phase2_signal_alerts) signals,
        (SELECT COUNT(*) FROM phase2_discord_outbox WHERE status='sent') sent_alerts,
        (SELECT COUNT(*) FROM phase2_discord_outbox WHERE status IN ('retry','failed')) outbox_failures,
        (SELECT MAX(received_at) FROM phase2_event_inbox WHERE source='helius-webhook') last_webhook_at,
        (SELECT MAX(processed_at) FROM phase2_event_inbox WHERE status='done') last_processed_at
      `).get();
      const metrics = Object.fromEntries(db.prepare("SELECT metric_key,metric_value FROM phase2_metrics").all().map((row) => [row.metric_key, row.metric_value]));
      const open = db.prepare("SELECT COUNT(DISTINCT token_mint) n FROM phase2_wallet_buys WHERE bought_at>=?").get(at - config.signalWindowMs)?.n || 0;
      const usage = usageForMonth.get(new Date(at).toISOString().slice(0, 7));
      const dailyUsage = usageForDay.get(new Date(at).toISOString().slice(0, 10));
      const dailyUsageByKind = Object.fromEntries(usageKindsForDay.all(new Date(at).toISOString().slice(0, 10))
        .map((row) => [row.usage_kind, { calls: num(row.calls), credits: num(row.credits) }]));
      return {
        ...counts,
        openTokens: open,
        duplicateEvents: num(metrics.duplicate_events),
        recoveredEvents: num(metrics.recovered_events),
        reconcileOverflows: num(metrics.reconcile_overflows),
        heliusCallsThisMonth: num(usage.calls),
        estimatedHeliusCredits: num(usage.credits),
        heliusCallsToday: num(dailyUsage.calls),
        estimatedHeliusCreditsToday: num(dailyUsage.credits),
        heliusUsageTodayByKind: dailyUsageByKind,
        lastWalletRefreshAt: metrics.wallet_refresh_at == null ? null : num(metrics.wallet_refresh_at),
        config,
        scoreVersion: SCORE_VERSION,
      };
    },
    nearSignals(at = now(), limit = 20) {
      const rows = db.prepare("SELECT * FROM phase2_wallet_buys WHERE bought_at>=? AND bought_at<=? ORDER BY bought_at").all(at - config.signalWindowMs, at);
      const tokens = new Map();
      for (const row of rows) {
        if (!tokens.has(row.token_mint)) tokens.set(row.token_mint, new Map());
        if (!tokens.get(row.token_mint).has(row.wallet_address)) tokens.get(row.token_mint).set(row.wallet_address, row);
      }
      return [...tokens.entries()].map(([tokenMint, wallets]) => {
        const contributions = [...wallets.values()];
        return { tokenMint, walletCount: contributions.length, totalPoints: contributions.reduce((sum, row) => sum + row.points, 0), lastBuyAt: Math.max(...contributions.map((row) => row.bought_at)) };
      }).sort((a, b) => b.totalPoints - a.totalPoints || b.walletCount - a.walletCount || b.lastBuyAt - a.lastBuyAt).slice(0, Math.max(1, Math.min(100, limit)));
    },
  };
}

module.exports = {
  LEADERBOARD_SCORE_VERSION,
  PHASE1_LEADERBOARD_GATE,
  QUOTE_MINTS,
  SCORE_VERSION,
  USDC_MINT,
  USDT_MINT,
  WSOL_MINT,
  canonicalTrustedProfiles,
  enhancedSwapBuys,
  initPhase2SignalStore,
  phase1LeaderboardProfiles,
  phase2Config,
  rawTransactionBuys,
  signalPoints,
};
