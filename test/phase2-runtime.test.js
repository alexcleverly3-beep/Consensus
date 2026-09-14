"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initPhase2Runtime, normalizePublicBaseUrl, secureEqual } = require("../src/phase2-runtime");

const WALLET_A = "CaHbjM1AGhDPBR6JwiNHaUZAJBykqvj9LPxDouxXbiWB";
const WALLET_B = "7YttLkHDo4yisJ9fsgFj6aNfA7SKz3JcM1wQh2Ve8XrP";
const TOKEN = "9YttLkHDo4yisJ9fsgFj6aNfA7SKz3JcM1wQh2Ve8XrR";

function profiles() {
  return [
    { walletAddress: WALLET_A, reputation: 92, confidence: 90, points: 3, source: "test", scoreVersion: "v1" },
    { walletAddress: WALLET_B, reputation: 82, confidence: 85, points: 2, source: "test", scoreVersion: "v1" },
  ];
}

test("webhook authorization uses exact constant-time-compatible comparison", () => {
  assert.equal(secureEqual("secret", "secret"), true);
  assert.equal(secureEqual("secret", "Secret"), false);
  assert.equal(secureEqual("", ""), false);
  assert.equal(secureEqual("short", "longer"), false);
});

test("public callback URL must be HTTPS and free of credentials or query strings", () => {
  assert.equal(normalizePublicBaseUrl("https://example.test/"), "https://example.test");
  assert.equal(normalizePublicBaseUrl("http://example.test"), "");
  assert.equal(normalizePublicBaseUrl("https://user:pass@example.test"), "");
  assert.equal(normalizePublicBaseUrl("https://example.test?secret=yes"), "");
});

test("runtime authenticates batches and suppresses duplicate deliveries", () => {
  const db = new Database(":memory:");
  let clock = 1_000;
  const runtime = initPhase2Runtime(db, { env: { HELIUS_WEBHOOK_AUTH_SECRET: "unit-secret" }, now: () => clock, autoStart: false });
  runtime.store.refreshTrackedWallets(profiles(), clock);
  const event = {
    type: "SWAP", signature: "event-1", timestamp: 2, feePayer: WALLET_A,
    events: { swap: { nativeInput: { account: WALLET_A, amount: 50_000_000 }, tokenOutputs: [{ userAccount: WALLET_A, mint: TOKEN, rawTokenAmount: { tokenAmount: "10" } }] } },
  };
  assert.throws(() => runtime.acceptWebhook("wrong", [event]), /unauthorized/);
  clock = 2_000;
  assert.deepEqual(runtime.acceptWebhook("unit-secret", [event]), { received: 1, inserted: 1 });
  assert.deepEqual(runtime.acceptWebhook("unit-secret", [event]), { received: 1, inserted: 0 });
});

test("webhook provisioning is batched and unchanged configuration does not spend another request", async () => {
  const db = new Database(":memory:");
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === "GET") return new Response(JSON.stringify([]), { status: 200 });
    return new Response(JSON.stringify({ webhookID: "hook-1" }), { status: 200 });
  };
  const runtime = initPhase2Runtime(db, {
    env: { HELIUS_API_KEY: "api-key", HELIUS_WEBHOOK_AUTH_SECRET: "auth-secret", PUBLIC_BASE_URL: "https://example.test" },
    fetchImpl, autoStart: false,
  });
  runtime.store.refreshTrackedWallets(profiles(), 1_000);
  const first = await runtime.syncWebhook();
  assert.equal(first.active, true);
  assert.equal(calls.length, 2);
  const created = JSON.parse(calls[1].options.body);
  assert.equal(created.webhookURL, "https://example.test/webhooks/helius");
  assert.deepEqual(created.transactionTypes, ["SWAP"]);
  assert.deepEqual(created.accountAddresses.sort(), [WALLET_A, WALLET_B].sort());
  const second = await runtime.syncWebhook();
  assert.equal(second.unchanged, true);
  assert.equal(calls.length, 2);
});

test("Railway's public domain is used when an explicit public base URL is absent", async () => {
  const db = new Database(":memory:");
  const calls = [];
  const runtime = initPhase2Runtime(db, {
    env: {
      HELIUS_API_KEY: "api-key",
      HELIUS_WEBHOOK_AUTH_SECRET: "auth-secret",
      RAILWAY_PUBLIC_DOMAIN: "consensus.example.test",
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (options.method === "GET") return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ webhookID: "hook-railway" }), { status: 200 });
    },
    autoStart: false,
  });
  runtime.store.refreshTrackedWallets(profiles(), 1_000);
  assert.equal((await runtime.syncWebhook()).active, true);
  assert.equal(JSON.parse(calls[1].options.body).webhookURL, "https://consensus.example.test/webhooks/helius");
  assert.deepEqual(runtime.status().configuration.missing, []);
});

test("configuration diagnostics name missing variables without exposing secret values", async () => {
  const db = new Database(":memory:");
  const runtime = initPhase2Runtime(db, {
    env: { PUBLIC_BASE_URL: "not-a-valid-url" },
    autoStart: false,
  });
  const result = await runtime.syncWebhook();
  assert.deepEqual(result.missing, [
    "HELIUS_API_KEY",
    "HELIUS_WEBHOOK_AUTH_SECRET",
    "PUBLIC_BASE_URL or RAILWAY_PUBLIC_DOMAIN",
  ]);
  const status = runtime.status();
  assert.deepEqual(status.configuration.missing, result.missing);
  assert.match(status.provider.last_error, /HELIUS_API_KEY/);
  assert.match(status.provider.last_error, /HELIUS_WEBHOOK_AUTH_SECRET/);
  assert.match(status.provider.last_error, /PUBLIC_BASE_URL or RAILWAY_PUBLIC_DOMAIN/);
});

test("rotating the webhook secret updates Helius without storing the secret", async () => {
  const db = new Database(":memory:");
  const firstCalls = [];
  const firstFetch = async (url, options = {}) => {
    firstCalls.push({ url: String(url), options });
    if (options.method === "GET") return new Response(JSON.stringify([]), { status: 200 });
    return new Response(JSON.stringify({ webhookID: "hook-rotate" }), { status: 200 });
  };
  const first = initPhase2Runtime(db, {
    env: { HELIUS_API_KEY: "api-key", HELIUS_WEBHOOK_AUTH_SECRET: "old-secret", PUBLIC_BASE_URL: "https://example.test" },
    fetchImpl: firstFetch, autoStart: false,
  });
  first.store.refreshTrackedWallets(profiles(), 1_000);
  await first.syncWebhook();

  const rotatedCalls = [];
  const rotated = initPhase2Runtime(db, {
    env: { HELIUS_API_KEY: "api-key", HELIUS_WEBHOOK_AUTH_SECRET: "new-secret", PUBLIC_BASE_URL: "https://example.test" },
    fetchImpl: async (url, options = {}) => {
      rotatedCalls.push({ url: String(url), options });
      return new Response(JSON.stringify({ webhookID: "hook-rotate" }), { status: 200 });
    },
    autoStart: false,
  });
  const result = await rotated.syncWebhook();
  assert.equal(result.active, true);
  assert.equal(result.unchanged, undefined);
  assert.equal(rotatedCalls.length, 1);
  assert.equal(rotatedCalls[0].options.method, "PUT");
  assert.equal(JSON.parse(rotatedCalls[0].options.body).authHeader, "new-secret");
  const provider = db.prepare("SELECT auth_hash FROM phase2_provider_state WHERE provider='helius'").get();
  assert.notEqual(provider.auth_hash, "new-secret");
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM phase2_provider_state").all()).includes("new-secret"), false);
});

test("earned signal is delivered by the existing Discord client and test messages create no fake alerts", async () => {
  const db = new Database(":memory:");
  let clock = 1_000;
  const sent = [];
  const runtime = initPhase2Runtime(db, { env: { DISCORD_ALERT_CHANNEL_ID: "alerts" }, now: () => clock, autoStart: false });
  runtime.store.refreshTrackedWallets(profiles(), clock);
  runtime.attachDiscordClient({ channels: { fetch: async (id) => ({ send: async (message) => { sent.push({ id, message }); } }) } });
  clock = 2_000;
  runtime.store.recordBuy({ signature: "a", walletAddress: WALLET_A, tokenMint: TOKEN, boughtAt: clock, source: "test" });
  clock = 3_000;
  runtime.store.recordBuy({ signature: "b", walletAddress: WALLET_B, tokenMint: TOKEN, boughtAt: clock, source: "test" });
  await runtime.pumpOutbox();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "alerts");
  assert.match(sent[0].message.embeds[0].description, /2 distinct wallets · 5 total points/);
  assert.doesNotMatch(JSON.stringify(sent[0].message), /amount|position size|sold/i);
  assert.equal(runtime.status().sent_alerts, 1);

  const before = db.prepare("SELECT COUNT(*) n FROM phase2_signal_alerts").get().n;
  await runtime.sendTestDiscord();
  assert.equal(sent.length, 2);
  assert.match(sent[1].message.embeds[0].title, /test/i);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM phase2_signal_alerts").get().n, before);
});

test("temporary Discord failure leaves an earned alert in the durable retry queue", async () => {
  const db = new Database(":memory:");
  let clock = 1_000;
  const runtime = initPhase2Runtime(db, { env: { DISCORD_ALERT_CHANNEL_ID: "alerts" }, now: () => clock, autoStart: false });
  runtime.store.refreshTrackedWallets(profiles(), clock);
  runtime.attachDiscordClient({ channels: { fetch: async () => ({ send: async () => { throw new Error("temporary network failure"); } }) } });
  clock = 2_000;
  runtime.store.recordBuy({ signature: "a", walletAddress: WALLET_A, tokenMint: TOKEN, boughtAt: clock, source: "test" });
  clock = 3_000;
  runtime.store.recordBuy({ signature: "b", walletAddress: WALLET_B, tokenMint: TOKEN, boughtAt: clock, source: "test" });
  await runtime.pumpOutbox();
  const row = db.prepare("SELECT status,attempts,last_error FROM phase2_discord_outbox").get();
  assert.equal(row.status, "retry");
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /temporary network failure/);
});

test("bounded Helius reconciliation bootstraps without history then recovers a missed transaction", async () => {
  const db = new Database(":memory:");
  let clock = 1_000;
  let signatureRound = 0;
  const fetchImpl = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    if (body.method === "getSignaturesForAddress") {
      signatureRound += 1;
      if (signatureRound === 1) return new Response(JSON.stringify({ result: [{ signature: "cursor", err: null }] }), { status: 200 });
      return new Response(JSON.stringify({ result: [{ signature: "missed", err: null }] }), { status: 200 });
    }
    if (body.method === "getTransaction") {
      return new Response(JSON.stringify({ result: {
        blockTime: 3,
        transaction: { signatures: ["missed"], message: { accountKeys: [{ pubkey: WALLET_A, signer: true }] } },
        meta: {
          err: null, fee: 5_000, preBalances: [100_000_000], postBalances: [49_995_000],
          preTokenBalances: [{ owner: WALLET_A, mint: TOKEN, uiTokenAmount: { amount: "0" } }],
          postTokenBalances: [{ owner: WALLET_A, mint: TOKEN, uiTokenAmount: { amount: "100" } }],
        },
      } }), { status: 200 });
    }
    throw new Error(`unexpected RPC method ${body.method}`);
  };
  const runtime = initPhase2Runtime(db, { env: { HELIUS_API_KEY: "key" }, fetchImpl, now: () => clock, autoStart: false });
  runtime.store.refreshTrackedWallets([profiles()[0]], clock);
  assert.deepEqual(await runtime.reconcile(), { recovered: 0, failures: 0 });
  clock = 3_000;
  assert.deepEqual(await runtime.reconcile(), { recovered: 1, failures: 0 });
  assert.equal(runtime.store.stats().genuine_buys, 1);
  assert.equal(runtime.store.stats().last_webhook_at, null);
});

test("monthly Helius budget pauses reconciliation before provider limits are exhausted", async () => {
  const db = new Database(":memory:");
  const runtime = initPhase2Runtime(db, {
    env: { HELIUS_API_KEY: "key", HELIUS_MONTHLY_CREDIT_BUDGET: "10000" },
    fetchImpl: async () => { throw new Error("RPC should not run"); },
    autoStart: false,
  });
  runtime.store.recordHeliusUsage("test", 10_000);
  assert.deepEqual(await runtime.reconcile(), { skipped: true, reason: "monthly-credit-budget" });
  assert.equal(runtime.status().heliusCreditsRemaining, 0);
});
