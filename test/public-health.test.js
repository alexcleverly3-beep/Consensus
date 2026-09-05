"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { once } = require("events");
const {
  installPublicHealthEndpoint,
  publicHealthSnapshot,
} = require("../src/public-health");

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
  });
}

test("public health snapshot exposes live collection counters but strips identities", () => {
  const health = publicHealthSnapshot({
    generatedAt: 2_000_000,
    discoveryCycle: 19,
    totals: {
      tokensScanned: 12,
      totalScans: 18,
      evidenceObservations: 420,
      walletsObserved: 83,
      smartWalletsFound: 4,
      queuedTokens: 7,
      consensusAlerts: 2,
      secretWalletAddress: "wallet-secret",
      secretTokenAddress: "token-secret",
    },
    recent: [{
      scannedAt: 1_900_000,
      candidatesFound: 5,
      consensusWallets: 2,
      tokenAddress: "token-secret",
      walletAddress: "wallet-secret",
    }],
    gmgn: {
      freshCalls: 3,
      configuredMax: 8,
      effectiveMax: 6,
      remaining: 3,
      cacheHits: 9,
      coalesced: 2,
      rejected: 1,
      rateLimitEvents: 1,
      cooldownRemainingMs: 5000,
      persistenceErrors: 0,
      request: "gmgn token traders --address token-secret",
    },
    walletAddress: "wallet-secret",
    tokenAddress: "token-secret",
  });

  assert.equal(health.ok, true);
  assert.equal(health.status, "running");
  assert.equal(health.collection.discoveryCycle, 19);
  assert.equal(health.collection.lastSuccessfulScanAt, 1_900_000);
  assert.equal(health.collection.lastSuccessfulScanAgeMs, 100_000);
  assert.equal(health.collection.recentSuccessfulScan, true);
  assert.equal(health.collection.tokensScanned, 12);
  assert.equal(health.collection.totalScans, 18);
  assert.equal(health.collection.evidenceObservations, 420);
  assert.equal(health.collection.walletsObserved, 83);
  assert.equal(health.collection.strongWalletsFound, 4);
  assert.equal(health.collection.queuedTokens, 7);
  assert.equal(health.collection.consensusAlerts, 2);
  assert.equal(health.gmgn.effectiveMax, 6);
  assert.equal(health.gmgn.cacheHits, 9);

  const serialized = JSON.stringify(health);
  assert.doesNotMatch(serialized, /wallet-secret|token-secret|tokenAddress|walletAddress|request/);
});

test("installed /health endpoint serves safe metrics and preserves dashboard routes", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, legacy: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("dashboard-route");
  });
  const store = {
    snapshot: () => ({
      generatedAt: 10_000,
      discoveryCycle: 3,
      totals: {
        tokensScanned: 2,
        totalScans: 4,
        evidenceObservations: 20,
        walletsObserved: 8,
        smartWalletsFound: 1,
        queuedTokens: 5,
        consensusAlerts: 0,
      },
      recent: [{ scannedAt: 9_000, tokenAddress: "must-not-leak" }],
      gmgn: { freshCalls: 1, configuredMax: 8, effectiveMax: 8, remaining: 7 },
    }),
  };

  installPublicHealthEndpoint({ server, store });
  server.listen(0, "127.0.0.1");
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await once(server, "listening");
  const port = server.address().port;

  const healthResponse = await request(port, "/health");
  assert.equal(healthResponse.statusCode, 200);
  assert.match(healthResponse.headers["cache-control"], /no-store/);
  const health = JSON.parse(healthResponse.body);
  assert.equal(health.collection.discoveryCycle, 3);
  assert.equal(health.collection.tokensScanned, 2);
  assert.equal(health.collection.lastSuccessfulScanAt, 9_000);
  assert.equal(health.legacy, undefined);
  assert.doesNotMatch(healthResponse.body, /must-not-leak/);

  const dashboardResponse = await request(port, "/");
  assert.equal(dashboardResponse.statusCode, 200);
  assert.equal(dashboardResponse.body, "dashboard-route");
});
