"use strict";

function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function publicHealthSnapshot(snapshot = {}) {
  const totals = snapshot.totals || {};
  const gmgn = snapshot.gmgn || {};
  const recent = Array.isArray(snapshot.recent) ? snapshot.recent : [];
  const lastSuccessfulScanAt = int(recent[0]?.scannedAt, 0) || null;
  const generatedAt = int(snapshot.generatedAt, Date.now());
  const lastSuccessfulScanAgeMs = lastSuccessfulScanAt == null
    ? null
    : Math.max(0, generatedAt - lastSuccessfulScanAt);

  return {
    ok: true,
    status: "running",
    generatedAt,
    collection: {
      discoveryCycle: int(snapshot.discoveryCycle),
      lastSuccessfulScanAt,
      lastSuccessfulScanAgeMs,
      recentSuccessfulScan: lastSuccessfulScanAgeMs != null && lastSuccessfulScanAgeMs <= 30 * 60 * 1000,
      tokensScanned: int(totals.tokensScanned),
      totalScans: int(totals.totalScans),
      evidenceObservations: int(totals.evidenceObservations),
      walletsObserved: int(totals.walletsObserved),
      strongWalletsFound: int(totals.smartWalletsFound),
      queuedTokens: int(totals.queuedTokens),
      consensusAlerts: int(totals.consensusAlerts),
    },
    gmgn: {
      freshCalls: int(gmgn.freshCalls),
      configuredMax: int(gmgn.configuredMax),
      effectiveMax: int(gmgn.effectiveMax),
      remaining: int(gmgn.remaining),
      cacheHits: int(gmgn.cacheHits),
      coalesced: int(gmgn.coalesced),
      rejected: int(gmgn.rejected),
      rateLimitEvents: int(gmgn.rateLimitEvents),
      cooldownRemainingMs: int(gmgn.cooldownRemainingMs),
      persistenceErrors: int(gmgn.persistenceErrors),
    },
  };
}

function installPublicHealthEndpoint({ server, store } = {}) {
  if (!server || typeof server.listeners !== "function") {
    throw new Error("installPublicHealthEndpoint requires an HTTP server");
  }
  if (!store || typeof store.snapshot !== "function") {
    throw new Error("installPublicHealthEndpoint requires a progress store");
  }

  const requestListeners = server.listeners("request");
  if (requestListeners.length !== 1) {
    throw new Error("expected exactly one dashboard request listener");
  }

  const dashboardHandler = requestListeners[0];
  server.removeListener("request", dashboardHandler);
  server.on("request", function publicHealthHandler(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, "http://health.local").pathname;
    } catch {
      pathname = req.url;
    }

    if (pathname !== "/health") {
      return dashboardHandler.call(server, req, res);
    }

    try {
      const health = publicHealthSnapshot(store.snapshot({ recentLimit: 1 }));
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(health));
    } catch {
      res.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: false, status: "unavailable" }));
    }
  });

  return server;
}

module.exports = {
  installPublicHealthEndpoint,
  publicHealthSnapshot,
};
