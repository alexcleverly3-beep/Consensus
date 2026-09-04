"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const Database = require("better-sqlite3");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const { initIntelligence } = require("./intelligence");
const { createDiscoveryEngine } = require("./discovery-engine");
const { extractTokenCandidates, shouldScanToken } = require("./market-discovery");
const { boundedSeedQueueSelection, nextDueSeedWallet, parseSeedWallets } = require("./seed-discovery");
const { collectSeedHistory } = require("./seed-history");
const { initTokenOutcomes, hasSnapshotData } = require("./token-outcomes");
const { initOutcomeRescan } = require("./outcome-rescan");
const { resolveDbPath, resolveDiscoveryIntervalMinutes } = require("./runtime-config");

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOL_ADDR_IN_TEXT = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const DEFAULT_SEED_WALLETS = ["CaHbjM1AGhDPBR6JwiNHaUZAJBykqvj9LPxDouxXbiWB"];

const DB_PATH = resolveDbPath();
const DISCORD_CHANNEL_ID = String(process.env.DISCORD_CHANNEL_ID || "").trim();
const MIN_GMGN_GAP_MS = clampInt(process.env.GMGN_MIN_REQUEST_GAP_MS, 12000, 3000, 60000);
const DISCOVERY_INTERVAL_MS = resolveDiscoveryIntervalMinutes() * 60 * 1000;
const TOKEN_RESCAN_MS = clampInt(process.env.TOKEN_RESCAN_HOURS, 12, 1, 168) * 60 * 60 * 1000;
const TOKEN_SCANS_PER_CYCLE = clampInt(process.env.TOKENS_PER_CYCLE, 1, 1, 3);
const TRENDING_LIMIT = clampInt(process.env.TRENDING_LIMIT, 12, 5, 50);
const CONSENSUS_WALLETS = clampInt(process.env.CONSENSUS_WALLETS, 2, 2, 5);
const TRUSTED_REPUTATION = clampInt(process.env.TRUSTED_REPUTATION, 65, 40, 95);
const TRUSTED_CONFIDENCE = clampInt(process.env.TRUSTED_CONFIDENCE, 50, 20, 95);
const TRUSTED_DISTINCT_TOKENS = clampInt(process.env.TRUSTED_DISTINCT_TOKENS, 4, 2, 100);
const TRUSTED_SEED_LIMIT = clampInt(process.env.TRUSTED_SEED_LIMIT, 20, 1, 100);
const TRUSTED_SEED_MAX_BAD_RATE = clampNumber(process.env.TRUSTED_SEED_MAX_BAD_RATE, 0.25, 0, 1);
const SEED_WALLETS = parseSeedWallets(process.env.SEED_WALLETS, DEFAULT_SEED_WALLETS);
const SEED_REFRESH_MS = clampInt(process.env.SEED_REFRESH_HOURS, 6, 6, 168) * 60 * 60 * 1000;
const SEED_ACTIVITY_LIMIT = clampInt(process.env.SEED_ACTIVITY_LIMIT, 100, 20, 100);
const SEED_TOKEN_LIMIT = clampInt(process.env.SEED_TOKEN_LIMIT, 250, 10, 1000);
const SEED_HISTORY_PAGES = clampInt(process.env.SEED_HISTORY_PAGES, 1, 1, 3);
const SEED_SCAN_EVERY_CYCLES = clampInt(process.env.SEED_SCAN_EVERY_CYCLES, 2, 1, 12);
const MAX_PENDING_SEED_TOKENS = clampInt(process.env.MAX_PENDING_SEED_TOKENS, 1000, 100, 10000);
const OUTCOME_RESCAN_EVERY_CYCLES = clampInt(process.env.OUTCOME_RESCAN_EVERY_CYCLES, 3, 1, 12);

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function short(address) {
  return `${String(address).slice(0, 4)}…${String(address).slice(-4)}`;
}

function findSolAddress(text) {
  return (String(text || "").match(SOL_ADDR_IN_TEXT) || []).find((x) => SOL_ADDR.test(x)) || null;
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS token_discovery_state (
    token_address TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    last_scanned_at INTEGER,
    scan_count INTEGER NOT NULL DEFAULT 0,
    last_candidate_count INTEGER NOT NULL DEFAULT 0,
    last_consensus_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS consensus_alerts (
    token_address TEXT PRIMARY KEY,
    sent_at INTEGER NOT NULL,
    wallet_count INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seed_wallet_state (
    wallet_address TEXT PRIMARY KEY,
    last_refreshed_at INTEGER,
    last_token_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    history_cursor TEXT,
    history_exhausted INTEGER NOT NULL DEFAULT 0,
    last_history_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS seed_token_queue (
    token_address TEXT NOT NULL,
    source_wallet TEXT NOT NULL,
    discovered_at INTEGER NOT NULL,
    activity_at INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    last_error TEXT,
    PRIMARY KEY(token_address, source_wallet)
  );
  CREATE INDEX IF NOT EXISTS idx_seed_token_queue_status
    ON seed_token_queue(status, activity_at DESC);
`);

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

ensureColumn("seed_wallet_state", "history_cursor", "TEXT");
ensureColumn("seed_wallet_state", "history_exhausted", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("seed_wallet_state", "last_history_at", "INTEGER");

const getMetaStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
const putMetaStmt = db.prepare(`
  INSERT INTO meta(key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const getTokenStateStmt = db.prepare("SELECT * FROM token_discovery_state WHERE token_address = ?");
const upsertTokenSeenStmt = db.prepare(`
  INSERT INTO token_discovery_state(token_address, first_seen_at, last_seen_at)
  VALUES (?, ?, ?)
  ON CONFLICT(token_address) DO UPDATE SET last_seen_at = excluded.last_seen_at
`);
const markTokenScannedStmt = db.prepare(`
  UPDATE token_discovery_state
  SET last_scanned_at = ?, scan_count = scan_count + 1,
      last_candidate_count = ?, last_consensus_count = ?
  WHERE token_address = ?
`);
const getConsensusAlertStmt = db.prepare("SELECT * FROM consensus_alerts WHERE token_address = ?");
const putConsensusAlertStmt = db.prepare(`
  INSERT INTO consensus_alerts(token_address, sent_at, wallet_count, payload_json)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(token_address) DO UPDATE SET
    sent_at = excluded.sent_at,
    wallet_count = excluded.wallet_count,
    payload_json = excluded.payload_json
`);
const getSeedStateStmt = db.prepare("SELECT * FROM seed_wallet_state WHERE wallet_address = ?");
const putSeedStateStmt = db.prepare(`
  INSERT INTO seed_wallet_state(
    wallet_address, last_refreshed_at, last_token_count, last_error,
    history_cursor, history_exhausted, last_history_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(wallet_address) DO UPDATE SET
    last_refreshed_at = excluded.last_refreshed_at,
    last_token_count = excluded.last_token_count,
    last_error = excluded.last_error,
    history_cursor = excluded.history_cursor,
    history_exhausted = excluded.history_exhausted,
    last_history_at = excluded.last_history_at
`);
const enqueueSeedTokenStmt = db.prepare(`
  INSERT INTO seed_token_queue(token_address, source_wallet, discovered_at, activity_at, status)
  VALUES (?, ?, ?, ?, 'pending')
  ON CONFLICT(token_address, source_wallet) DO UPDATE SET
    activity_at = MAX(seed_token_queue.activity_at, excluded.activity_at)
`);
const getSeedTokenStmt = db.prepare(`
  SELECT status FROM seed_token_queue
  WHERE token_address = ? AND source_wallet = ?
`);
const nextSeedTokenStmt = db.prepare(`
  SELECT * FROM seed_token_queue
  WHERE status = 'pending'
  ORDER BY activity_at DESC, discovered_at ASC
  LIMIT 1
`);
const markSeedTokenStmt = db.prepare(`
  UPDATE seed_token_queue
  SET status = ?, attempt_count = attempt_count + 1,
      last_attempt_at = ?, last_error = ?
  WHERE token_address = ? AND source_wallet = ?
`);
const seedQueueCountStmt = db.prepare(`
  SELECT
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
  FROM seed_token_queue
`);

function metaNumber(key, fallback = 0) {
  const n = Number(getMetaStmt.get(key)?.value);
  return Number.isFinite(n) ? n : fallback;
}

let cliQueue = Promise.resolve();
let lastCliFinishedAt = 0;
let gmgnBlockedUntil = metaNumber("gmgn_blocked_until", 0);

function rateLimitReset(message) {
  const text = String(message || "");
  const unix = text.match(/(?:x-ratelimit-reset|"?reset_at"?)\s*[:=]\s*"?(\d{10,13})/i);
  if (unix) {
    const n = Number(unix[1]);
    return n < 1e12 ? n * 1000 : n;
  }
  const seconds = text.match(/~?(\d+)s remaining/i);
  return seconds ? Date.now() + Number(seconds[1]) * 1000 : null;
}

function isRateLimitError(error) {
  return /RATE_LIMIT_EXCEEDED|RATE_LIMIT_BANNED|IP rate limit exceeded|\b429\b|rate[ _-]?limit/i.test(
    error instanceof Error ? error.message : String(error || "")
  );
}

function rawCli(args) {
  return new Promise((resolve, reject) => {
    execFile("gmgn-cli", args, {
      shell: false,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60000,
      env: process.env,
    }, (err, stdout, stderr) => {
      if (err) {
        const message = [stderr, stdout, err.message]
          .filter(Boolean).map(String).map((x) => x.trim()).filter(Boolean).join("\n");
        if (isRateLimitError(message)) {
          gmgnBlockedUntil = Math.max(
            gmgnBlockedUntil,
            (rateLimitReset(message) || Date.now() + 5 * 60 * 1000) + 5000
          );
          putMetaStmt.run("gmgn_blocked_until", String(gmgnBlockedUntil));
        }
        reject(new Error(message || "gmgn-cli failed"));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Unparseable gmgn-cli output: ${String(stdout).slice(0, 300)}`));
      }
    });
  });
}

function cli(args) {
  for (const arg of args) {
    if (typeof arg !== "string" || /[;&|`$()<>"'\\\n]/.test(arg)) {
      return Promise.reject(new Error(`Rejected unsafe CLI arg: ${arg}`));
    }
  }
  const job = cliQueue.then(async () => {
    if (Date.now() < gmgnBlockedUntil) {
      throw new Error(`GMGN cooldown active for ${Math.ceil((gmgnBlockedUntil - Date.now()) / 1000)}s`);
    }
    const gap = lastCliFinishedAt + MIN_GMGN_GAP_MS - Date.now();
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    try {
      return await rawCli(args);
    } finally {
      lastCliFinishedAt = Date.now();
    }
  });
  cliQueue = job.catch(() => {});
  return job;
}

async function getTopTraders(address) {
  const response = await cli([
    "token", "traders", "--chain", "sol", "--address", address,
    "--order-by", "profit", "--direction", "desc", "--limit", "100", "--raw",
  ]);
  const payload = response?.data ?? response ?? {};
  const rows = Array.isArray(payload) ? payload : payload.list || response?.list || [];
  return Array.isArray(rows) ? rows : [];
}

async function getTokenInfo(address) {
  const response = await cli(["token", "info", "--chain", "sol", "--address", address, "--raw"]);
  return response?.data ?? response ?? {};
}

async function getTrending() {
  return cli([
    "market", "trending", "--chain", "sol", "--interval", "1h",
    "--min-liquidity", "10000", "--min-marketcap", "50000",
    "--max-insider-rate", "0.35", "--max-bundler-rate", "0.35",
    "--order-by", "volume", "--limit", String(TRENDING_LIMIT), "--raw",
  ]);
}

async function getWalletActivity(walletAddress, cursor = null) {
  const args = [
    "portfolio", "activity", "--chain", "sol", "--wallet", walletAddress,
    "--limit", String(SEED_ACTIVITY_LIMIT),
  ];
  if (cursor) args.push("--cursor", String(cursor));
  args.push("--raw");
  return cli(args);
}

const intelligence = initIntelligence(db);
const outcomes = initTokenOutcomes(db);
const outcomeRescan = initOutcomeRescan(db);
const engine = createDiscoveryEngine({
  intelligence,
  maxFreshCalls: 0,
  maxEnrichments: 0,
  minTrustedReputation: TRUSTED_REPUTATION,
  minTrustedConfidence: TRUSTED_CONFIDENCE,
  minTrustedDistinctTokens: TRUSTED_DISTINCT_TOKENS,
  minConsensusWallets: CONSENSUS_WALLETS,
});

let client = null;
let cycleRunning = false;
let cycleNumber = metaNumber("discovery_cycle_number", 0);

async function processToken(tokenAddress, source = "autonomous") {
  const state = getTokenStateStmt.get(tokenAddress);
  const now = Date.now();
  upsertTokenSeenStmt.run(tokenAddress, now, now);

  if (source === "autonomous" && !shouldScanToken(state?.last_scanned_at, now, TOKEN_RESCAN_MS)) {
    return { skipped: true, reason: "recently-scanned", tokenAddress };
  }

  const traders = await getTopTraders(tokenAddress);
  if (!traders.length) {
    markTokenScannedStmt.run(now, 0, 0, tokenAddress);
    return { tokenAddress, candidates: [], trusted: [], consensus: null, skipped: false };
  }

  let tokenInfo = {};
  try {
    tokenInfo = await getTokenInfo(tokenAddress);
  } catch (error) {
    if (isRateLimitError(error)) throw error;
    console.warn(`Token info failed for ${short(tokenAddress)}: ${error.message}`);
  }

  const result = await engine.processToken({ tokenAddress, tokenInfo, traders, source });
  markTokenScannedStmt.run(now, result.candidates.length, result.trusted.length, tokenAddress);
  return { ...result, tokenInfo, skipped: false };
}

async function processOneOutcomeFollowup() {
  const due = outcomeRescan.nextDue();
  if (!due) return false;
  const attemptedAt = Date.now();

  try {
    const tokenInfo = await getTokenInfo(due.token_address);
    if (!hasSnapshotData(tokenInfo)) {
      throw new Error("token info contained no price, market-cap, or liquidity data");
    }
    const tokenOutcome = outcomes.recordSnapshot({
      tokenAddress: due.token_address,
      tokenInfo,
      observedAt: attemptedAt,
    });
    let feedback = null;
    if (tokenOutcome.outcome_score != null &&
        !["unknown", "immature"].includes(String(tokenOutcome.outcome_status))) {
      feedback = intelligence.applyTokenOutcome({
        tokenAddress: due.token_address,
        outcomeScore: tokenOutcome.outcome_score,
        status: tokenOutcome.outcome_status,
      });
    }
    outcomeRescan.markAttempt(due.token_address, { attemptedAt });
    console.log(
      `[outcome] ${short(due.token_address)} stage=${due.stage} status=${tokenOutcome.outcome_status} ` +
      `multiple=${tokenOutcome.best_multiple == null ? "n/a" : Number(tokenOutcome.best_multiple).toFixed(2)} ` +
      `wallets=${feedback?.updatedWallets || 0}`
    );
    return true;
  } catch (error) {
    outcomeRescan.markAttempt(due.token_address, {
      attemptedAt,
      error: String(error.message || error),
    });
    if (isRateLimitError(error)) throw error;
    console.warn(`[outcome] ${short(due.token_address)} follow-up failed: ${error.message}`);
    return false;
  }
}

function consensusEmbed(result) {
  const symbol = result.tokenInfo?.symbol ? String(result.tokenInfo.symbol) : short(result.tokenAddress);
  const wallets = result.consensus.wallets.slice(0, 8).map((wallet) =>
    `\`${wallet.walletAddress}\` — rep **${wallet.reputation}**, confidence **${wallet.confidence}**, token **${wallet.tokenScore}**`
  );
  return new EmbedBuilder()
    .setTitle(`🧠 Consensus: ${symbol}`)
    .setDescription(`**${result.consensus.walletCount} trusted wallets** independently appeared among profitable traders.\n\n${wallets.join("\n")}`)
    .addFields({ name: "Token", value: `\`${result.tokenAddress}\`` })
    .setFooter({ text: "Consensus V1 • longitudinal wallet evidence" })
    .setTimestamp(new Date());
}

async function maybeSendConsensus(result) {
  if (!result?.consensus || !client || !DISCORD_CHANNEL_ID) return false;
  const previous = getConsensusAlertStmt.get(result.tokenAddress);
  if (previous && Date.now() - previous.sent_at < 24 * 60 * 60 * 1000 && previous.wallet_count >= result.consensus.walletCount) {
    return false;
  }
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID).catch(() => null);
  if (!channel?.send) return false;
  await channel.send({ embeds: [consensusEmbed(result)] });
  putConsensusAlertStmt.run(
    result.tokenAddress,
    Date.now(),
    result.consensus.walletCount,
    JSON.stringify(result.consensus)
  );
  return true;
}

async function refreshOneSeedWallet() {
  const now = Date.now();
  const selected = nextDueSeedWallet({
    configuredWallets: SEED_WALLETS,
    trustedProfiles: intelligence.getTopProfiles({
      limit: Math.min(500, TRUSTED_SEED_LIMIT * 5),
      minObservations: 1,
    }),
    stateByWallet: (walletAddress) => getSeedStateStmt.get(walletAddress),
    now,
    refreshMs: SEED_REFRESH_MS,
    trustedOptions: {
      minReputation: TRUSTED_REPUTATION,
      minConfidence: TRUSTED_CONFIDENCE,
      minDistinctTokens: TRUSTED_DISTINCT_TOKENS,
      maxBadTokenRate: TRUSTED_SEED_MAX_BAD_RATE,
      limit: TRUSTED_SEED_LIMIT,
    },
  });
  if (!selected) return null;

  const wallet = selected.walletAddress;

  const previous = getSeedStateStmt.get(wallet);
  const historyAlreadyExhausted = Number(previous?.history_exhausted || 0) === 1;
  const startCursor = historyAlreadyExhausted ? null : previous?.history_cursor || null;

  try {
    const history = await collectSeedHistory({
      walletAddress: wallet,
      startCursor,
      maxPages: historyAlreadyExhausted ? 1 : SEED_HISTORY_PAGES,
      tokenLimit: SEED_TOKEN_LIMIT,
      fetchPage: ({ walletAddress, cursor }) => getWalletActivity(walletAddress, cursor),
    });
    const insert = db.transaction((items) => {
      const queue = seedQueueCountStmt.get() || {};
      const selection = boundedSeedQueueSelection(items, {
        pendingCount: Number(queue.pending || 0),
        maxPending: MAX_PENDING_SEED_TOKENS,
        exists: (token) => Boolean(getSeedTokenStmt.get(token.address, wallet)),
      });
      for (const token of selection.selected) {
        enqueueSeedTokenStmt.run(token.address, wallet, now, token.lastActivityAt || 0);
      }
      return selection;
    });
    const queued = insert(history.tokens);

    const nextHistoryCursor = historyAlreadyExhausted ? null : history.nextCursor;
    const historyExhausted = historyAlreadyExhausted || history.exhausted ? 1 : 0;
    putSeedStateStmt.run(
      wallet,
      now,
      history.tokens.length,
      null,
      nextHistoryCursor,
      historyExhausted,
      now
    );
    console.log(
      `[seed:${selected.source}] ${short(wallet)} history pages=${history.pagesFetched} tokens=${history.tokens.length} ` +
      `queued=${queued.selected.length} queue-skipped=${queued.skipped} ` +
      `backfill=${historyExhausted ? "complete" : "continuing"}`
    );
    return {
      wallet,
      source: selected.source,
      tokenCount: history.tokens.length,
      pagesFetched: history.pagesFetched,
      historyExhausted: Boolean(historyExhausted),
    };
  } catch (error) {
    const message = String(error.message || error).slice(0, 1000);
    putSeedStateStmt.run(
      wallet,
      now,
      Number(previous?.last_token_count || 0),
      message,
      previous?.history_cursor || null,
      Number(previous?.history_exhausted || 0),
      previous?.last_history_at || null
    );
    if (isRateLimitError(error)) throw error;
    console.warn(`[seed] ${short(wallet)} refresh failed: ${message}`);
    return { wallet, tokenCount: 0, error: message };
  }
}

async function processOneSeedToken() {
  const queued = nextSeedTokenStmt.get();
  if (!queued) return false;
  const now = Date.now();
  const state = getTokenStateStmt.get(queued.token_address);

  if (!shouldScanToken(state?.last_scanned_at, now, TOKEN_RESCAN_MS)) {
    markSeedTokenStmt.run("done", now, null, queued.token_address, queued.source_wallet);
    return false;
  }

  try {
    const result = await processToken(queued.token_address, `seed:${queued.source_wallet}`);
    markSeedTokenStmt.run("done", Date.now(), null, queued.token_address, queued.source_wallet);
    await maybeSendConsensus(result);
    console.log(
      `[seed] ${short(queued.source_wallet)} -> ${short(queued.token_address)} candidates=${result.candidates?.length || 0} trusted=${result.trusted?.length || 0}`
    );
    return true;
  } catch (error) {
    const attempts = Number(queued.attempt_count || 0) + 1;
    const status = attempts >= 3 && !isRateLimitError(error) ? "failed" : "pending";
    markSeedTokenStmt.run(
      status,
      Date.now(),
      String(error.message || error).slice(0, 1000),
      queued.token_address,
      queued.source_wallet
    );
    throw error;
  }
}

async function processMarketToken() {
  const trending = await getTrending();
  const candidates = extractTokenCandidates(trending, { limit: TRENDING_LIMIT });
  let scanned = 0;
  for (const candidate of candidates) {
    if (scanned >= TOKEN_SCANS_PER_CYCLE) break;
    const state = getTokenStateStmt.get(candidate.address);
    upsertTokenSeenStmt.run(candidate.address, Date.now(), Date.now());
    if (!shouldScanToken(state?.last_scanned_at, Date.now(), TOKEN_RESCAN_MS)) continue;
    const result = await processToken(candidate.address, "autonomous");
    scanned += 1;
    await maybeSendConsensus(result);
    console.log(
      `[discovery] ${short(candidate.address)} candidates=${result.candidates?.length || 0} trusted=${result.trusted?.length || 0}`
    );
  }
  return scanned;
}

async function discoveryCycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  cycleNumber += 1;
  putMetaStmt.run("discovery_cycle_number", String(cycleNumber));

  try {
    await refreshOneSeedWallet();

    // Outcome follow-ups intentionally replace, rather than add to, a normal token
    // scan on their turn. Each costs only one token-info request and is bounded to
    // at most one due token every configured number of cycles.
    if (cycleNumber % OUTCOME_RESCAN_EVERY_CYCLES === 0) {
      const followedUp = await processOneOutcomeFollowup();
      if (followedUp) return;
    }

    const seedTurn = cycleNumber % SEED_SCAN_EVERY_CYCLES === 0;
    if (seedTurn) {
      const scannedSeed = await processOneSeedToken();
      if (scannedSeed) return;
    }

    await processMarketToken();
  } catch (error) {
    console.warn(`[discovery] cycle failed: ${error.message}`);
  } finally {
    cycleRunning = false;
  }
}

function statusEmbed() {
  const profiles = intelligence.getTopProfiles({ limit: 10, minObservations: 2 });
  const queue = seedQueueCountStmt.get() || {};
  const rows = profiles.length
    ? profiles.map((p, i) => `${i + 1}. \`${p.wallet_address}\` — rep **${Math.round(p.reputation_score)}**, conf **${Math.round(p.confidence_score)}**, ${p.distinct_tokens} tokens`).join("\n")
    : "Evidence is still accumulating; no wallet has two distinct observations yet.";
  return new EmbedBuilder()
    .setTitle("🧠 Consensus V1 intelligence")
    .setDescription(rows)
    .addFields({
      name: "Seed backfill",
      value: `${SEED_WALLETS.length} configured seed wallet(s) • learned trusted seeds enabled • ${Number(queue.pending || 0)} pending • ${Number(queue.done || 0)} scanned`,
    })
    .setFooter({
      text: `Discovery every ${Math.round(DISCOVERY_INTERVAL_MS / 60000)}m • max ${TOKEN_SCANS_PER_CYCLE} trader scan/cycle • outcome follow-up every ${OUTCOME_RESCAN_EVERY_CYCLES} cycles`,
    })
    .setTimestamp(new Date());
}

async function handleMessage(message) {
  if (message.author?.bot) return;
  if (DISCORD_CHANNEL_ID && message.channelId !== DISCORD_CHANNEL_ID) return;
  const text = String(message.content || "").trim();
  if (/^!?status$/i.test(text) || /^!?consensus$/i.test(text)) {
    await message.reply({ embeds: [statusEmbed()] });
    return;
  }
  const address = findSolAddress(text);
  if (!address) return;
  const progress = await message.reply(`🔎 Scanning ${short(address)} with the V1 evidence engine…`);
  try {
    const result = await processToken(address, "manual");
    if (result.consensus) {
      await progress.edit({ content: "", embeds: [consensusEmbed(result)] });
      await maybeSendConsensus(result);
    } else {
      await progress.edit(
        `🧠 ${short(address)}: saved evidence from **${result.candidates?.length || 0}** promising traders; **${result.trusted?.length || 0}** currently meet trusted-wallet thresholds. The database keeps this evidence for future consensus.`
      );
    }
  } catch (error) {
    await progress.edit(`Scan failed: ${String(error.message || error).slice(0, 1500)}`);
  }
}

async function start() {
  if (process.env.DISCORD_TOKEN) {
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    client.on("messageCreate", handleMessage);
    client.once("ready", () => console.log(`Consensus V1 logged in as ${client.user?.tag || "Discord bot"}`));
    await client.login(process.env.DISCORD_TOKEN);
  } else {
    console.warn("DISCORD_TOKEN is not set; autonomous discovery will run without Discord alerts.");
  }

  console.log(
    `[startup] ${SEED_WALLETS.length} configured seed wallet(s); trusted seed feedback enabled; GMGN gap=${MIN_GMGN_GAP_MS}ms; ` +
    `cycle=${Math.round(DISCOVERY_INTERVAL_MS / 60000)}m; seed refresh=${Math.round(SEED_REFRESH_MS / 3600000)}h; ` +
    `outcome follow-up every ${OUTCOME_RESCAN_EVERY_CYCLES} cycles`
  );
  await discoveryCycle();
  setInterval(discoveryCycle, DISCOVERY_INTERVAL_MS).unref();
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
