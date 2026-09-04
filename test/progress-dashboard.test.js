"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { once } = require("events");
const Database = require("better-sqlite3");
const {
  createProgressStore,
  isPrivateRequestAuthorized,
  renderDashboard,
  renderWalletsPage,
  startProgressDashboard,
  walletVerdict,
} = require("../src/progress-dashboard");

function makeDb(filename = ":memory:") {
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE token_discovery_state (
      token_address TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_scanned_at INTEGER,
      scan_count INTEGER NOT NULL DEFAULT 0,
      last_candidate_count INTEGER NOT NULL DEFAULT 0,
      last_consensus_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE consensus_alerts (
      token_address TEXT PRIMARY KEY,
      sent_at INTEGER NOT NULL,
      wallet_count INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE seed_token_queue (
      token_address TEXT NOT NULL,
      source_wallet TEXT NOT NULL,
      discovered_at INTEGER NOT NULL,
      activity_at INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(token_address, source_wallet)
    );
    CREATE TABLE wallet_profiles (
      wallet_address TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      observations INTEGER NOT NULL DEFAULT 0,
      positive_signals INTEGER NOT NULL DEFAULT 0,
      negative_signals INTEGER NOT NULL DEFAULT 0,
      early_entries INTEGER NOT NULL DEFAULT 0,
      profitable_entries INTEGER NOT NULL DEFAULT 0,
      rug_or_bad_token_hits INTEGER NOT NULL DEFAULT 0,
      avg_entry_delay_sec REAL,
      avg_hold_sec REAL,
      avg_token_score REAL,
      reputation_score REAL NOT NULL DEFAULT 0,
      confidence_score REAL NOT NULL DEFAULT 0,
      confidence_label TEXT NOT NULL DEFAULT 'low',
      distinct_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE wallet_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      token_address TEXT NOT NULL
    );
  `);
  return db;
}

function request(port, pathname, authorization = null) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      headers: authorization ? { authorization } : {},
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
  });
}

test("progress snapshot counts trusted wallets without exposing their identities", () => {
  const db = makeDb();
  db.prepare("INSERT INTO meta(key, value) VALUES ('discovery_cycle_number', '14')").run();
  db.prepare("INSERT INTO meta(key, value) VALUES ('gmgn_blocked_until', ?)")
    .run(String(Date.now() + 60_000));
  db.prepare(`
    INSERT INTO token_discovery_state(
      token_address, first_seen_at, last_seen_at, last_scanned_at,
      scan_count, last_candidate_count, last_consensus_count
    ) VALUES (?, 1, 1, ?, ?, ?, ?)
  `).run("token-a", 1000, 3, 5, 2);
  db.prepare(`
    INSERT INTO token_discovery_state(
      token_address, first_seen_at, last_seen_at, last_scanned_at,
      scan_count, last_candidate_count, last_consensus_count
    ) VALUES (?, 1, 1, ?, ?, ?, ?)
  `).run("token-b", 2000, 1, 1, 0);
  db.prepare(`
    INSERT INTO wallet_profiles(
      wallet_address, first_seen_at, last_seen_at, observations, distinct_tokens,
      positive_signals, negative_signals, early_entries, profitable_entries,
      rug_or_bad_token_hits, avg_token_score, reputation_score, confidence_score,
      confidence_label
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("secret-smart-wallet", 100, 2000, 8, 8, 7, 1, 6, 7, 1, 78, 82, 71, "medium");
  db.prepare(`
    INSERT INTO wallet_profiles(
      wallet_address, first_seen_at, last_seen_at, observations, distinct_tokens,
      positive_signals, negative_signals, early_entries, profitable_entries,
      rug_or_bad_token_hits, avg_token_score, reputation_score, confidence_score,
      confidence_label
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("not-yet-trusted", 100, 1500, 10, 10, 4, 6, 2, 4, 3, 42, 90, 20, "low");
  db.prepare("INSERT INTO wallet_evidence(wallet_address, token_address) VALUES (?, ?)").run("secret-smart-wallet", "token-a");
  db.prepare("INSERT INTO wallet_evidence(wallet_address, token_address) VALUES (?, ?)").run("not-yet-trusted", "token-b");
  db.prepare("INSERT INTO consensus_alerts VALUES (?, ?, ?, ?)").run("token-a", 2000, 2, "{}");
  db.prepare("INSERT INTO seed_token_queue(token_address, source_wallet, discovered_at, status) VALUES (?, ?, ?, ?)")
    .run("token-c", "seed-secret", 2000, "pending");

  const store = createProgressStore(db, {
    env: {
      TRUSTED_REPUTATION: "65",
      TRUSTED_CONFIDENCE: "50",
      TRUSTED_DISTINCT_TOKENS: "4",
    },
    gmgnGuard: {
      snapshot: () => ({
        freshCalls: 3,
        maxFreshCalls: 5,
        effectiveMaxFreshCalls: 4,
        remaining: 1,
        cacheHits: 6,
        coalesced: 2,
        rateLimitEvents: 1,
        cooldownRemainingMs: 1500,
      }),
    },
  });
  const snapshot = store.snapshot();

  assert.equal(snapshot.discoveryCycle, 14);
  assert.deepEqual(snapshot.totals, {
    tokensScanned: 2,
    totalScans: 4,
    evidenceObservations: 2,
    walletsObserved: 2,
    smartWalletsFound: 1,
    consensusAlerts: 1,
    queuedTokens: 1,
  });
  assert.equal(snapshot.recent[0].scannedAt, 2000);
  assert.equal(snapshot.recent[1].candidatesFound, 5);
  assert.equal(snapshot.gmgn.effectiveMax, 4);
  assert.equal(snapshot.gmgn.cacheHits + snapshot.gmgn.coalesced, 8);
  assert.ok(snapshot.gmgn.cooldownRemainingMs > 50_000);

  const html = renderDashboard(snapshot);
  assert.match(html, /Smart wallets found/);
  assert.match(html, /Recent successful token scans/);
  assert.match(html, /GMGN calls \/ window/);
  assert.match(html, /GMGN cooldown/);
  assert.match(html, /baseline warming up/);
  assert.match(html, /not sample data/);
  assert.doesNotMatch(html, /secret-smart-wallet|not-yet-trusted|seed-secret|token-a|token-b/);

  const wallets = store.wallets();
  assert.equal(wallets[0].walletAddress, "secret-smart-wallet");
  assert.equal(wallets[0].trusted, true);
  assert.equal(wallets[0].distinctTokens, 8);

  const privateHtml = renderWalletsPage(wallets, snapshot.thresholds);
  assert.match(privateHtml, /secret-smart-wallet/);
  assert.match(privateHtml, /Trusted/);
  assert.match(privateHtml, /Bad hits/);
  db.close();
});

test("private wallet authentication rejects missing and incorrect credentials", () => {
  const env = { DASHBOARD_USERNAME: "owner", DASHBOARD_PASSWORD: "correct horse" };
  const request = (authorization) => ({ headers: authorization ? { authorization } : {} });
  const basic = (value) => `Basic ${Buffer.from(value).toString("base64")}`;

  assert.equal(isPrivateRequestAuthorized(request(), env), false);
  assert.equal(isPrivateRequestAuthorized(request(basic("owner:wrong")), env), false);
  assert.equal(isPrivateRequestAuthorized(request(basic("wrong:correct horse")), env), false);
  assert.equal(isPrivateRequestAuthorized(request(basic("owner:correct horse")), env), true);
  assert.equal(isPrivateRequestAuthorized(request(basic("owner:correct horse")), {}), false);
});

test("wallet verdicts distinguish trusted, building, and risky evidence", () => {
  const thresholds = { reputation: 65, confidence: 50, distinctTokens: 4 };
  assert.equal(walletVerdict({ trusted: true }, thresholds).label, "Trusted");
  assert.match(
    walletVerdict({ trusted: false, reputation: 60, confidence: 40, distinctTokens: 3, badTokenHits: 0 }, thresholds).label,
    /Building/
  );
  assert.equal(
    walletVerdict({ trusted: false, reputation: 35, confidence: 60, distinctTokens: 8, badTokenHits: 1 }, thresholds).label,
    "Risk watch"
  );
});

test("dashboard persists signed changes for each completed 30-minute window", () => {
  const db = makeDb();
  let now = 1_000_000;
  db.prepare("INSERT INTO meta(key, value) VALUES ('discovery_cycle_number', '1')").run();
  db.prepare("INSERT INTO meta(key, value) VALUES ('gmgn_blocked_until', '0')").run();
  const store = createProgressStore(db, { now: () => now });

  const baseline = store.snapshot();
  assert.equal(baseline.changes.ready, false);

  db.prepare(`
    INSERT INTO token_discovery_state(
      token_address, first_seen_at, last_seen_at, last_scanned_at,
      scan_count, last_candidate_count, last_consensus_count
    ) VALUES ('new-token', 1, 1, ?, 1, 2, 0)
  `).run(now);
  db.prepare("UPDATE meta SET value = '3' WHERE key = 'discovery_cycle_number'").run();
  now += 30 * 60 * 1000;

  const changed = store.snapshot();
  assert.equal(changed.changes.ready, true);
  assert.equal(changed.changes.deltas.tokensScanned, 1);
  assert.equal(changed.changes.deltas.discoveryCycle, 2);
  assert.equal(changed.changes.deltas.queuedTokens, 0);
  const html = renderDashboard(changed);
  assert.match(html, /↑ \+1 \/ 30m/);
  assert.match(html, /→ 0 \/ 30m/);
  db.close();
});

test("wallet identities are served only after private dashboard authentication", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "consensus-dashboard-"));
  const dbPath = path.join(directory, "wallets.db");
  const setupDb = makeDb(dbPath);
  setupDb.prepare(`
    INSERT INTO wallet_profiles(
      wallet_address, first_seen_at, last_seen_at, observations, distinct_tokens,
      positive_signals, negative_signals, early_entries, profitable_entries,
      rug_or_bad_token_hits, avg_token_score, reputation_score, confidence_score,
      confidence_label
    ) VALUES (?, 1, 2, 8, 8, 7, 1, 6, 7, 1, 78, 82, 71, 'medium')
  `).run("private-wallet-address");
  setupDb.close();

  const dashboard = startProgressDashboard({
    dbPath,
    host: "127.0.0.1",
    port: 0,
    env: { DASHBOARD_USERNAME: "owner", DASHBOARD_PASSWORD: "test-password" },
  });
  t.after(async () => {
    if (dashboard.server.listening) {
      await new Promise((resolve) => dashboard.server.close(resolve));
    }
    dashboard.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await once(dashboard.server, "listening");
  const port = dashboard.server.address().port;

  const publicPage = await request(port, "/");
  assert.equal(publicPage.statusCode, 200);
  assert.doesNotMatch(publicPage.body, /private-wallet-address/);

  const unauthorized = await request(port, "/wallets");
  assert.equal(unauthorized.statusCode, 401);
  assert.match(unauthorized.headers["www-authenticate"], /Basic/);
  assert.doesNotMatch(unauthorized.body, /private-wallet-address/);

  const authorization = `Basic ${Buffer.from("owner:test-password").toString("base64")}`;
  const privatePage = await request(port, "/wallets", authorization);
  assert.equal(privatePage.statusCode, 200);
  assert.match(privatePage.headers["cache-control"], /no-store/);
  assert.match(privatePage.body, /private-wallet-address/);

  const privateApi = await request(port, "/api/wallets", authorization);
  assert.equal(privateApi.statusCode, 200);
  assert.equal(JSON.parse(privateApi.body).wallets[0].walletAddress, "private-wallet-address");
});
