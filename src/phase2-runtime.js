"use strict";

const crypto = require("crypto");
const { createHeliusClient } = require("./phase2-helius");
const { canonicalTrustedProfiles, initPhase2SignalStore } = require("./phase2-signal-engine");

function boundedInt(value, fallback, min, max) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function short(address) {
  const value = String(address || "");
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(Number(ms || 0) / 60_000));
  return minutes < 1 ? "under 1 minute" : `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function discordSignalMessage(signal) {
  const mint = signal.tokenMint;
  const contributions = (signal.contributions || []).map((item) =>
    `\`${short(item.walletAddress)}\` — **${item.points} point${item.points === 1 ? "" : "s"}**`
  ).join("\n");
  return {
    embeds: [{
      color: 0x43d681,
      title: "🚨 Consensus Buy Signal",
      description: `**${signal.walletCount} distinct wallets · ${signal.totalPoints} total points**\nDetected across ${formatDuration(signal.lastBuyAt - signal.firstBuyAt)}.`,
      fields: [
        { name: "Token contract", value: `\`${mint}\`` },
        { name: "Wallet contributions", value: contributions || "Unavailable" },
        { name: "Research links", value: `[DexScreener](https://dexscreener.com/solana/${mint}) · [Solscan](https://solscan.io/token/${mint})` },
      ],
      footer: { text: "Token safety has not been checked. This is a research signal, not trading advice." },
      timestamp: new Date(signal.lastBuyAt).toISOString(),
    }],
  };
}

function webhookBody(url, addresses, secret) {
  return {
    webhookURL: url,
    transactionTypes: ["SWAP"],
    accountAddresses: addresses,
    webhookType: "enhanced",
    authHeader: secret,
    txnStatus: "success",
  };
}

function addressHash(addresses) {
  return crypto.createHash("sha256").update([...addresses].sort().join("\n")).digest("hex");
}

function secretHash(secret) {
  return secret ? crypto.createHash("sha256").update(String(secret)).digest("hex") : "";
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/$/, "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return "";
    return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "")}`;
  } catch { return ""; }
}

function initPhase2Runtime(db, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  logger = console,
  autoStart = true,
} = {}) {
  const store = initPhase2SignalStore(db, { env, now });
  const apiKey = String(env.HELIUS_API_KEY || "").trim();
  const authSecret = String(env.HELIUS_WEBHOOK_AUTH_SECRET || "").trim();
  const railwayDomain = String(env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  const publicBaseUrl = normalizePublicBaseUrl(env.PUBLIC_BASE_URL)
    || normalizePublicBaseUrl(railwayDomain ? `https://${railwayDomain}` : "");
  const missingConfiguration = [];
  if (!apiKey) missingConfiguration.push("HELIUS_API_KEY");
  if (!authSecret) missingConfiguration.push("HELIUS_WEBHOOK_AUTH_SECRET");
  if (!publicBaseUrl) missingConfiguration.push("PUBLIC_BASE_URL or RAILWAY_PUBLIC_DOMAIN");
  const alertChannelId = String(env.DISCORD_ALERT_CHANNEL_ID || env.DISCORD_CHANNEL_ID || "").trim();
  // Phase 1 leaderboard entries are local SQLite data; refresh frequently
  // enough to pick up newly eligible wallets without spending provider calls.
  const refreshMs = boundedInt(env.TRACKED_WALLET_REFRESH_MINUTES, 30, 15, 1440) * 60_000;
  const reconcileMs = boundedInt(env.HELIUS_RECONCILE_INTERVAL_MINUTES, 30, 5, 1440) * 60_000;
  const maxReconcilePages = boundedInt(env.HELIUS_RECONCILE_MAX_PAGES, 3, 1, 10);
  const monthlyCreditBudget = boundedInt(env.HELIUS_MONTHLY_CREDIT_BUDGET, 800_000, 10_000, 100_000_000);
  const webhookUrl = publicBaseUrl ? `${publicBaseUrl}/webhooks/helius` : "";
  const helius = apiKey ? createHeliusClient({ apiKey, fetchImpl, logger }) : null;
  let discordClient = null;
  let reconcileRunning = false;
  let inboxRunning = false;
  let outboxRunning = false;
  const timers = [];

  db.exec(`
    CREATE TABLE IF NOT EXISTS phase2_provider_state (
      provider TEXT PRIMARY KEY,
      webhook_id TEXT,
      webhook_url TEXT,
      address_hash TEXT,
      auth_hash TEXT,
      status TEXT NOT NULL DEFAULT 'disabled',
      last_sync_at INTEGER,
      last_reconcile_at INTEGER,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS phase2_reconcile_cursors (
      wallet_address TEXT PRIMARY KEY,
      last_signature TEXT,
      last_run_at INTEGER,
      overflow_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);
  const providerColumns = db.prepare("PRAGMA table_info(phase2_provider_state)").all();
  if (!providerColumns.some((column) => column.name === "auth_hash")) db.exec("ALTER TABLE phase2_provider_state ADD COLUMN auth_hash TEXT");
  db.prepare("INSERT OR IGNORE INTO phase2_provider_state(provider,status) VALUES ('helius','disabled')").run();
  const providerState = db.prepare("SELECT * FROM phase2_provider_state WHERE provider='helius'");
  const updateProvider = db.prepare(`UPDATE phase2_provider_state SET webhook_id=COALESCE(?,webhook_id),webhook_url=COALESCE(?,webhook_url),address_hash=COALESCE(?,address_hash),auth_hash=COALESCE(?,auth_hash),status=?,last_sync_at=?,last_error=? WHERE provider='helius'`);
  const updateReconcileAt = db.prepare("UPDATE phase2_provider_state SET last_reconcile_at=?,last_error=? WHERE provider='helius'");
  const cursorGet = db.prepare("SELECT * FROM phase2_reconcile_cursors WHERE wallet_address=?");
  const cursorSave = db.prepare(`INSERT INTO phase2_reconcile_cursors(wallet_address,last_signature,last_run_at,overflow_count,last_error) VALUES (?,?,?,COALESCE(?,0),?) ON CONFLICT(wallet_address) DO UPDATE SET last_signature=excluded.last_signature,last_run_at=excluded.last_run_at,overflow_count=overflow_count+excluded.overflow_count,last_error=excluded.last_error`);

  function refreshTrackedWallets() {
    const profiles = canonicalTrustedProfiles(db, store.config.trackedWalletLimit);
    const result = store.refreshTrackedWallets(profiles, now());
    return { ...result, eligible: profiles.length };
  }

  async function syncWebhook() {
    const addresses = store.trackedWallets().map((item) => item.walletAddress).sort();
    if (missingConfiguration.length) {
      const detail = `Missing or invalid Railway variable${missingConfiguration.length === 1 ? "" : "s"}: ${missingConfiguration.join(", ")}`;
      updateProvider.run(null, webhookUrl || null, addressHash(addresses), secretHash(authSecret) || null, "needs-configuration", now(), detail);
      return { active: false, reason: "needs-configuration", missing: [...missingConfiguration] };
    }
    if (!addresses.length) {
      updateProvider.run(null, webhookUrl, addressHash(addresses), secretHash(authSecret), "awaiting-trusted-wallets", now(), null);
      return { active: false, reason: "awaiting-trusted-wallets" };
    }
    const desiredHash = addressHash(addresses);
    const current = providerState.get();
    const desiredAuthHash = secretHash(authSecret);
    if (current?.status === "active" && current.webhook_id && current.webhook_url === webhookUrl && current.address_hash === desiredHash && current.auth_hash === desiredAuthHash) {
      return { active: true, unchanged: true, webhookId: current.webhook_id };
    }
    try {
      let webhookId = current?.webhook_id;
      if (!webhookId) {
        store.recordHeliusUsage("webhook-management", 100);
        const existing = await helius.listWebhooks();
        const match = (Array.isArray(existing) ? existing : []).find((item) => item.webhookURL === webhookUrl);
        webhookId = match?.webhookID || match?.webhookId || null;
      }
      const body = webhookBody(webhookUrl, addresses, authSecret);
      store.recordHeliusUsage("webhook-management", 100);
      const result = webhookId ? await helius.updateWebhook(webhookId, body) : await helius.createWebhook(body);
      webhookId = result?.webhookID || result?.webhookId || webhookId;
      if (!webhookId) throw new Error("Helius did not return a webhook ID");
      updateProvider.run(webhookId, webhookUrl, desiredHash, desiredAuthHash, "active", now(), null);
      logger.log(`[phase2] Helius webhook active for ${addresses.length} Phase 1 trusted wallet(s)`);
      return { active: true, webhookId, tracked: addresses.length };
    } catch (error) {
      updateProvider.run(null, webhookUrl, desiredHash, desiredAuthHash, "error", now(), String(error?.message || error).slice(0, 1000));
      logger.warn(`[phase2] Helius webhook sync failed: ${String(error?.message || error).slice(0, 300)}`);
      return { active: false, reason: "error", error };
    }
  }

  function acceptWebhook(authorization, payload) {
    if (!authSecret || !secureEqual(authorization, authSecret)) {
      store.incrementMetric("webhook_auth_failures");
      const error = new Error("unauthorized webhook");
      error.status = 401;
      throw error;
    }
    const events = Array.isArray(payload) ? payload : [payload];
    if (!events.length || events.length > 1000) {
      const error = new Error("invalid webhook event batch");
      error.status = 400;
      throw error;
    }
    for (let index = 0; index < events.length; index += 1) store.recordHeliusUsage("webhook-delivery", 1);
    const accepted = events.map((event) => store.acceptEnvelope(event, { source: "helius-webhook", receivedAt: now() }));
    queueMicrotask(() => drainInbox().catch((error) => logger.warn(`[phase2] inbox drain failed: ${String(error?.message || error).slice(0, 300)}`)));
    return { received: accepted.length, inserted: accepted.filter((item) => item.inserted).length };
  }

  async function drainInbox(limit = 100) {
    if (inboxRunning) return { skipped: true };
    inboxRunning = true;
    let processed = 0;
    try {
      while (processed < limit) {
        const result = store.processNext();
        if (!result) break;
        processed += 1;
      }
      return { processed };
    } finally { inboxRunning = false; }
  }

  async function pumpOutbox(limit = 20) {
    if (outboxRunning || !discordClient || !alertChannelId) return { skipped: true };
    outboxRunning = true;
    let sent = 0;
    try {
      while (sent < limit) {
        const item = store.nextOutbox(now());
        if (!item) break;
        try {
          const channel = await discordClient.channels.fetch(alertChannelId).catch(() => null);
          if (!channel || typeof channel.send !== "function") {
            store.markOutboxFailed(item.alert_id, new Error("Discord alert channel is unavailable"), { permanent: true, at: now() });
            break;
          }
          await channel.send(discordSignalMessage(item.payload));
          store.markOutboxSent(item.alert_id, now());
          sent += 1;
        } catch (error) {
          const permanent = [10003, 50001, 50013].includes(Number(error?.code));
          store.markOutboxFailed(item.alert_id, error, { permanent, at: now() });
          if (permanent) break;
        }
      }
      return { sent };
    } finally { outboxRunning = false; }
  }

  async function reconcileWallet(wallet) {
    const cursor = cursorGet.get(wallet);
    if (!cursor?.last_signature) {
      store.recordHeliusUsage("rpc", 1);
      const latest = await helius.getSignaturesForAddress(wallet, { limit: 1 });
      cursorSave.run(wallet, latest?.[0]?.signature || null, now(), 0, null);
      return { wallet, bootstrapped: true, recovered: 0 };
    }
    const signatures = [];
    let before;
    let overflow = 0;
    for (let page = 0; page < maxReconcilePages; page += 1) {
      store.recordHeliusUsage("rpc", 1);
      const batch = await helius.getSignaturesForAddress(wallet, { until: cursor.last_signature, before, limit: 100 });
      if (!Array.isArray(batch) || !batch.length) break;
      signatures.push(...batch.filter((item) => !item.err));
      if (batch.length < 100) break;
      before = batch[batch.length - 1].signature;
      if (page === maxReconcilePages - 1) overflow = 1;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
    const newest = signatures[0]?.signature || cursor.last_signature;
    let recovered = 0;
    for (const item of signatures.reverse()) {
      if (store.hasSignature(item.signature)) continue;
      store.recordHeliusUsage("rpc", 1);
      const transaction = await helius.getTransaction(item.signature);
      if (!transaction) continue;
      store.acceptEnvelope({ result: transaction, signature: item.signature }, { source: "helius-reconcile", receivedAt: now() });
      recovered += 1;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
    cursorSave.run(wallet, newest, now(), overflow, null);
    if (overflow) store.incrementMetric("reconcile_overflows");
    for (let index = 0; index < recovered; index += 1) store.incrementMetric("recovered_events");
    return { wallet, recovered, overflow: Boolean(overflow) };
  }

  async function reconcile() {
    if (reconcileRunning || !helius) return { skipped: true };
    if (store.heliusUsage(now()).credits >= monthlyCreditBudget) {
      return { skipped: true, reason: "monthly-credit-budget" };
    }
    reconcileRunning = true;
    let recovered = 0;
    let failures = 0;
    try {
      for (const item of store.trackedWallets()) {
        try {
          const result = await reconcileWallet(item.walletAddress);
          recovered += result.recovered || 0;
        } catch (error) {
          failures += 1;
          const cursor = cursorGet.get(item.walletAddress);
          cursorSave.run(item.walletAddress, cursor?.last_signature || null, now(), 0, String(error?.message || error).slice(0, 1000));
        }
        await new Promise((resolve) => setTimeout(resolve, 125));
      }
      await drainInbox();
      updateReconcileAt.run(now(), failures ? `${failures} wallet reconciliation failure(s)` : null);
      store.setMetric("last_reconcile_at", now());
      return { recovered, failures };
    } finally { reconcileRunning = false; }
  }

  async function refreshAndSync() {
    const result = refreshTrackedWallets();
    await syncWebhook();
    return result;
  }

  async function sendTestDiscord() {
    if (!discordClient || !alertChannelId) throw new Error("Discord alert delivery is not configured");
    const channel = await discordClient.channels.fetch(alertChannelId).catch(() => null);
    if (!channel || typeof channel.send !== "function") throw new Error("Discord alert channel is unavailable");
    await channel.send({ embeds: [{ color: 0x69b5ff, title: "✅ Consensus Phase 2 test", description: "Discord alert delivery is connected. This is a test only—no wallet buy or signal was recorded.", timestamp: new Date(now()).toISOString() }] });
    return { sent: true };
  }

  function attachDiscordClient(client) {
    discordClient = client;
    queueMicrotask(() => pumpOutbox().catch((error) => logger.warn(`[phase2] Discord outbox failed: ${String(error?.message || error).slice(0, 300)}`)));
  }

  function status() {
    const result = store.stats(now());
    return {
      ...result,
      monthlyCreditBudget,
      heliusCreditsRemaining: Math.max(0, monthlyCreditBudget - result.estimatedHeliusCredits),
      provider: providerState.get(),
      configuration: {
        heliusApiKeyConfigured: Boolean(apiKey),
        webhookAuthSecretConfigured: Boolean(authSecret),
        publicBaseUrlConfigured: Boolean(publicBaseUrl),
        missing: [...missingConfiguration],
      },
      alertChannelConfigured: Boolean(alertChannelId),
      discordConnected: Boolean(discordClient),
    };
  }

  function start() {
    refreshTrackedWallets();
    queueMicrotask(() => syncWebhook().catch((error) => logger.warn(`[phase2] webhook startup failed: ${String(error?.message || error).slice(0, 300)}`)));
    queueMicrotask(() => drainInbox().catch((error) => logger.warn(`[phase2] inbox startup failed: ${String(error?.message || error).slice(0, 300)}`)));
    timers.push(setInterval(() => drainInbox().catch((error) => logger.warn(`[phase2] inbox failed: ${String(error?.message || error).slice(0, 300)}`)), 1_000));
    timers.push(setInterval(() => pumpOutbox().catch((error) => logger.warn(`[phase2] outbox failed: ${String(error?.message || error).slice(0, 300)}`)), 5_000));
    timers.push(setInterval(() => refreshAndSync().catch((error) => logger.warn(`[phase2] wallet refresh failed: ${String(error?.message || error).slice(0, 300)}`)), refreshMs));
    timers.push(setInterval(() => reconcile().catch((error) => logger.warn(`[phase2] reconciliation failed: ${String(error?.message || error).slice(0, 300)}`)), reconcileMs));
    for (const timer of timers) timer.unref?.();
  }

  function stop() { for (const timer of timers) clearInterval(timer); }

  const runtime = { acceptWebhook, attachDiscordClient, discordSignalMessage, drainInbox, pumpOutbox, reconcile, refreshAndSync, sendTestDiscord, start, status, stop, store, syncWebhook };
  if (autoStart) start();
  return runtime;
}

module.exports = { addressHash, discordSignalMessage, initPhase2Runtime, normalizePublicBaseUrl, secureEqual, webhookBody };
